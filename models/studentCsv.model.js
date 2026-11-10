const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db.config');
const { organizationHasMultipleBranches } = require('../utils/branchScope.util');

// Stores failed upload batches in memory keyed by batchId and schoolId for CSV download
const failedBatchesById = new Map();
const latestFailedBatchBySchool = new Map();

class StudentCsvModel {
  /**
   * Dynamically fetch student upload column headers from the live MySQL database schema.
   * Excludes `branch_id` if the organization has a single branch; includes it if the organization has multiple branches.
   */
  static async getDynamicTemplateHeaders(schoolIdOrReq = null) {
    const hasMultipleBranches = await organizationHasMultipleBranches(schoolIdOrReq);

    const excludedColumns = new Set([
      'id',
      'school_id',
      'student_id',
      'parent_id',
      'parent_type',
      'address_type',
      'created_at',
      'updated_at',
      'picture',
      'has_siblings',
      'has_transport',
      'has_hostel',
      'passcode',
      'otp',
      'otp_expires_at',
    ]);

    if (!hasMultipleBranches) {
      excludedColumns.add('branch_id');
    }

    const [studentCols] = await pool.query('SHOW COLUMNS FROM student_master');
    const [parentCols] = await pool.query('SHOW COLUMNS FROM parent_master');
    const [parentAddrCols] = await pool.query('SHOW COLUMNS FROM parent_master_address');
    const [studentAddrCols] = await pool.query('SHOW COLUMNS FROM student_address');
    const [transportCols] = await pool.query('SHOW COLUMNS FROM student_transport');
    const [hostelCols] = await pool.query('SHOW COLUMNS FROM student_hostel');
    const [medicalCols] = await pool.query('SHOW COLUMNS FROM student_medical_history');
    const [prevSchoolCols] = await pool.query('SHOW COLUMNS FROM previous_school_address');

    const headers = [];

    // 1. student_master columns
    for (const c of studentCols) {
      if (excludedColumns.has(c.Field)) continue;
      if (c.Field === 'class') headers.push('class_id');
      else if (c.Field === 'section') headers.push('section_id');
      else headers.push(c.Field);
    }

    // 2. Father & Mother columns from parent_master + parent_master_address
    for (const prefix of ['father', 'mother']) {
      for (const c of parentCols) {
        if (excludedColumns.has(c.Field) || c.Field === 'branch_id' || c.Field === 'password' || c.Field === 'status' || c.Field === 'relation') {
          continue;
        }
        headers.push(`${prefix}_${c.Field}`);
      }
      for (const c of parentAddrCols) {
        if (excludedColumns.has(c.Field) || c.Field === 'branch_id') continue;
        if (c.Field === 'address1') headers.push(`${prefix}_address_1`);
        else if (c.Field === 'address2') headers.push(`${prefix}_address_2`);
        else headers.push(`${prefix}_${c.Field}`);
      }
    }

    // 3. Guardian columns from parent_master
    headers.push('guardian_relation');
    for (const c of parentCols) {
      if (excludedColumns.has(c.Field) || c.Field === 'branch_id' || c.Field === 'password' || c.Field === 'status') {
        continue;
      }
      headers.push(`other_guardian_${c.Field}`);
    }

    // 4. Current & Permanent Address columns from student_address
    for (const prefix of ['current', 'permanent']) {
      for (const c of studentAddrCols) {
        if (excludedColumns.has(c.Field) || c.Field === 'branch_id') continue;
        if (c.Field === 'same_permanent') {
          if (prefix === 'current') headers.push('same_permanent');
          continue;
        }
        if (c.Field === 'address1') headers.push(`${prefix}_address_1`);
        else if (c.Field === 'address2') headers.push(`${prefix}_address_2`);
        else headers.push(`${prefix}_${c.Field}`);
      }
    }

    // 5. Transport columns from student_transport
    for (const c of transportCols) {
      if (excludedColumns.has(c.Field) || c.Field === 'branch_id' || c.Field === 'status') continue;
      headers.push(c.Field);
    }

    // 6. Hostel columns from student_hostel
    for (const c of hostelCols) {
      if (excludedColumns.has(c.Field) || c.Field === 'branch_id' || c.Field === 'academic_year' || c.Field === 'status') continue;
      if (c.Field === 'room_number') headers.push('hostel_room');
      else headers.push(c.Field);
    }

    // 7. Medical History columns from student_medical_history
    for (const c of medicalCols) {
      if (excludedColumns.has(c.Field) || c.Field === 'branch_id' || c.Field === 'status') continue;
      if (c.Field === 'description') headers.push('medical_description');
      else headers.push(c.Field);
    }

    // 8. Previous School columns from previous_school_address
    for (const c of prevSchoolCols) {
      if (excludedColumns.has(c.Field) || c.Field === 'branch_id') continue;
      if (c.Field === 'school_name') headers.push('previous_school_name');
      else if (c.Field === 'address1') headers.push('prev_school_address_1');
      else if (c.Field === 'address2') headers.push('prev_school_address_2');
      else headers.push(`prev_school_${c.Field}`);
    }

    return Array.from(new Set(headers));
  }

  /**
   * Save failed records batch so user can download the failed CSV file.
   */
  static saveFailedBatch(schoolId, failedRecords) {
    const batchId = crypto.randomUUID();
    const record = {
      batchId,
      schoolId: Number(schoolId),
      failedRecords,
      createdAt: Date.now(),
    };
    failedBatchesById.set(batchId, record);
    latestFailedBatchBySchool.set(Number(schoolId), record);
    return batchId;
  }

  /**
   * Retrieve failed records batch by batchId or latest for schoolId.
   */
  static getFailedBatch(batchId = null, schoolId = null) {
    if (batchId && failedBatchesById.has(batchId)) {
      return failedBatchesById.get(batchId);
    }
    if (schoolId && latestFailedBatchBySchool.has(Number(schoolId))) {
      return latestFailedBatchBySchool.get(Number(schoolId));
    }
    return null;
  }

  /**
   * Fetch the school's active subscription plan and student limit from the database.
   */
  static async getSchoolPackageLimit(schoolId) {
    const targetSchoolId = parseInt(schoolId, 10);
    if (!targetSchoolId) return null;

    const query = `
      SELECT 
        s.id AS subscription_id,
        s.school_id,
        s.plan_id,
        s.status,
        s.start_date,
        s.end_date,
        p.plan_name,
        p.plan_code,
        p.max_students
      FROM school_subscriptions s
      JOIN subscription_plans p ON s.plan_id = p.id
      WHERE s.school_id = ?
        AND s.status IN ('active', 'trial')
        AND DATEDIFF(DATE(s.end_date), CURDATE()) >= 0
      ORDER BY 
        CASE 
          WHEN s.status = 'active' AND LOWER(p.billing_cycle) != 'trial' THEN 1
          ELSE 2
        END ASC,
        s.id DESC
      LIMIT 1
    `;

    const [rows] = await pool.query(query, [targetSchoolId]);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Count existing active students for the school in student_master.
   */
  static async getCurrentStudentCount(schoolId) {
    const targetSchoolId = parseInt(schoolId, 10);
    const [rows] = await pool.query(
      'SELECT COUNT(id) AS count FROM student_master WHERE school_id = ? AND status NOT IN (0, 4)',
      [targetSchoolId]
    );
    return Number(rows[0]?.count || 0);
  }

  /**
   * One-step backend validation of student count against the purchased package limit.
   */
  static async validatePackageStudentLimit(schoolId, uploadedCount) {
    const subscription = await this.getSchoolPackageLimit(schoolId);

    if (!subscription) {
      return {
        allowed: false,
        statusCode: 402,
        code: 'SUBSCRIPTION_REQUIRED',
        message: 'No active subscription found for your school. Please select a subscription plan to continue.',
      };
    }

    const maxLimit = Number(subscription.max_students);
    const currentCount = await this.getCurrentStudentCount(schoolId);
    const totalAfterUpload = currentCount + uploadedCount;

    if (maxLimit > 0 && (uploadedCount > maxLimit || totalAfterUpload > maxLimit)) {
      const remainingLimit = Math.max(0, maxLimit - currentCount);

      const message =
        uploadedCount > maxLimit || currentCount === 0
          ? `Your current package allows a maximum of ${maxLimit} students. You cannot upload ${uploadedCount} students. Please upgrade your package to continue.`
          : `Your current package allows a maximum of ${maxLimit} students. You already have ${currentCount} students and cannot upload ${uploadedCount} students (remaining limit: ${remainingLimit}). Please upgrade your package to continue.`;

      return {
        allowed: false,
        statusCode: 403,
        code: 'STUDENT_QUOTA_EXCEEDED',
        planName: subscription.plan_name,
        maxLimit,
        currentCount,
        uploadedCount,
        remainingLimit,
        message,
      };
    }

    return {
      allowed: true,
      planName: subscription.plan_name,
      maxLimit,
      currentCount,
      uploadedCount,
      remainingLimit: maxLimit > 0 ? Math.max(0, maxLimit - totalAfterUpload) : null,
    };
  }

  /**
   * Resolve branch ID for the school from branch_master.
   */
  static async resolveBranchId(schoolId, branchId = null, connection = pool) {
    const hasMultipleBranches = await organizationHasMultipleBranches(schoolId, connection);
    if (hasMultipleBranches && branchId && branchId !== 'all' && branchId !== '0') {
      if (!isNaN(Number(branchId)) && Number(branchId) > 0) {
        const [idRows] = await connection.query(
          'SELECT id FROM branch_master WHERE id = ? AND school_id = ? AND status != 4 LIMIT 1',
          [Number(branchId), schoolId]
        );
        if (idRows.length > 0) return Number(idRows[0].id);
      } else {
        const cleanBranch = String(branchId).trim().toLowerCase();
        const [bRows] = await connection.query(
          'SELECT id FROM branch_master WHERE school_id = ? AND status != 4 AND (LOWER(TRIM(branch_name)) = ? OR LOWER(TRIM(branch_code)) = ?) LIMIT 1',
          [schoolId, cleanBranch, cleanBranch]
        );
        if (bRows.length > 0) return Number(bRows[0].id);
      }
    }
    const [rows] = await connection.query(
      'SELECT id FROM branch_master WHERE school_id = ? AND status != 4 ORDER BY is_main_branch DESC, id ASC LIMIT 1',
      [schoolId]
    );
    return rows.length > 0 ? Number(rows[0].id) : null;
  }

  /**
   * Resolve master table lookup values when either an ID or a display name is provided.
   */
  static async resolveMasterValue(connection, table, nameColumn, value, schoolId = null, idColumn = 'id') {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const trimmed = String(value).trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);

    try {
      let sql = `SELECT \`${idColumn}\` AS id FROM \`${table}\` WHERE LOWER(TRIM(\`${nameColumn}\`)) = ?`;
      const params = [trimmed.toLowerCase()];
      if (schoolId !== null) {
        sql += ` AND (school_id = ? OR school_id IS NULL)`;
        params.push(schoolId);
      }
      sql += ` LIMIT 1`;
      const [rows] = await connection.query(sql, params);
      if (rows && rows.length > 0) return rows[0].id;
    } catch (_) {}

    return trimmed;
  }

  /**
   * Check which admission numbers, email addresses, or phone numbers already exist in student_master.
   */
  static async checkExistingDuplicates(schoolId, admissionNumbers = [], emails = [], phones = []) {
    const duplicateAdmissions = new Set();
    const duplicateEmails = new Set();
    const duplicatePhones = new Set();

    if (admissionNumbers.length > 0) {
      const [admRows] = await pool.query(
        `SELECT LOWER(TRIM(admission_number)) AS adm FROM student_master 
         WHERE school_id = ? AND status != 4 AND LOWER(TRIM(admission_number)) IN (?)`,
        [schoolId, admissionNumbers]
      );
      for (const r of admRows) {
        if (r.adm) duplicateAdmissions.add(r.adm);
      }
    }

    if (emails.length > 0) {
      const [emailRows] = await pool.query(
        `SELECT LOWER(TRIM(email_address)) AS email FROM student_master 
         WHERE school_id = ? AND status != 4 AND LOWER(TRIM(email_address)) IN (?)`,
        [schoolId, emails]
      );
      for (const r of emailRows) {
        if (r.email) duplicateEmails.add(r.email);
      }
    }

    if (phones.length > 0) {
      const [phoneRows] = await pool.query(
        `SELECT LOWER(TRIM(primary_contact_number)) AS phone FROM student_master 
         WHERE school_id = ? AND status != 4 AND LOWER(TRIM(primary_contact_number)) IN (?)`,
        [schoolId, phones]
      );
      for (const r of phoneRows) {
        if (r.phone) duplicatePhones.add(r.phone);
      }
    }

    return {
      duplicateAdmissions,
      duplicateEmails,
      duplicatePhones,
    };
  }

  /**
   * Sync Father, Mother, and Guardian records into parent_master, parent_master_address,
   * and student_to_parent (matching StudentModel.syncParents in growvidya_server).
   */
  static async syncParents(connection, studentId, schoolId, branchId, data) {
    let fatherId = null;
    let motherId = null;
    let guardianId = null;

    // 1. Father
    const fInfo = data.father_info || {};
    const fFirst = fInfo.father_first_name || null;
    const fLast = fInfo.father_last_name || null;
    const fPhone = fInfo.father_phone || null;
    const fEmail = fInfo.father_email || null;
    const fOcc = fInfo.father_occupation || null;

    if (fFirst || fPhone || fEmail) {
      let existingFatherId = null;
      if (fPhone || fEmail) {
        const [match] = await connection.execute(
          `SELECT id FROM parent_master WHERE school_id = ? AND ((phone = ? AND ? IS NOT NULL) OR (email = ? AND ? IS NOT NULL)) AND status != 4 LIMIT 1`,
          [schoolId, fPhone, fPhone, fEmail, fEmail]
        );
        if (match && match.length > 0) {
          existingFatherId = match[0].id;
        }
      }

      if (existingFatherId) {
        fatherId = existingFatherId;
        await connection.execute(
          `UPDATE parent_master SET first_name = ?, last_name = ?, occupation = ? WHERE id = ? AND school_id = ?`,
          [fFirst, fLast, fOcc, fatherId, schoolId]
        );
      } else {
        const fPlainPass = fPhone ? String(fPhone).trim() : null;
        const hashedFatherPass = fPlainPass ? await bcrypt.hash(fPlainPass, 10) : null;
        const [fRes] = await connection.execute(
          `INSERT INTO parent_master (school_id, branch_id, first_name, last_name, phone, email, occupation, relation, parent_type, picture, password, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Father', 1, NULL, ?, 1, NOW())`,
          [schoolId, branchId, fFirst, fLast, fPhone, fEmail, fOcc, hashedFatherPass]
        );
        fatherId = fRes.insertId;

        const fCountry = await this.resolveMasterValue(connection, 'countries', 'name', fInfo.father_country);
        const fState = await this.resolveMasterValue(connection, 'states', 'state', fInfo.father_state, null, 'id_state');
        const fCity = await this.resolveMasterValue(connection, 'cities', 'name', fInfo.father_city);

        await connection.execute(
          `INSERT INTO parent_master_address (school_id, branch_id, parent_id, parent_type, country, state, city, postal_code, address1, address2, created_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            schoolId,
            branchId,
            fatherId,
            fCountry,
            fState,
            fCity,
            fInfo.father_postal_code,
            fInfo.father_address_1,
            fInfo.father_address_2,
          ]
        );
      }
    }

    // 2. Mother
    const mInfo = data.mother_info || {};
    const mFirst = mInfo.mother_first_name || null;
    const mLast = mInfo.mother_last_name || null;
    const mPhone = mInfo.mother_phone || null;
    const mEmail = mInfo.mother_email || null;
    const mOcc = mInfo.mother_occupation || null;

    if (mFirst || mPhone || mEmail) {
      let existingMotherId = null;
      if (mPhone || mEmail) {
        const [match] = await connection.execute(
          `SELECT id FROM parent_master WHERE school_id = ? AND ((phone = ? AND ? IS NOT NULL) OR (email = ? AND ? IS NOT NULL)) AND status != 4 LIMIT 1`,
          [schoolId, mPhone, mPhone, mEmail, mEmail]
        );
        if (match && match.length > 0) {
          existingMotherId = match[0].id;
        }
      }

      if (existingMotherId) {
        motherId = existingMotherId;
        await connection.execute(
          `UPDATE parent_master SET first_name = ?, last_name = ?, occupation = ? WHERE id = ? AND school_id = ?`,
          [mFirst, mLast, mOcc, motherId, schoolId]
        );
      } else {
        const mPlainPass = mPhone ? String(mPhone).trim() : null;
        const hashedMotherPass = mPlainPass ? await bcrypt.hash(mPlainPass, 10) : null;
        const [mRes] = await connection.execute(
          `INSERT INTO parent_master (school_id, branch_id, first_name, last_name, phone, email, occupation, relation, parent_type, picture, password, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'Mother', 2, NULL, ?, 1, NOW())`,
          [schoolId, branchId, mFirst, mLast, mPhone, mEmail, mOcc, hashedMotherPass]
        );
        motherId = mRes.insertId;

        const mCountry = await this.resolveMasterValue(connection, 'countries', 'name', mInfo.mother_country);
        const mState = await this.resolveMasterValue(connection, 'states', 'state', mInfo.mother_state, null, 'id_state');
        const mCity = await this.resolveMasterValue(connection, 'cities', 'name', mInfo.mother_city);

        await connection.execute(
          `INSERT INTO parent_master_address (school_id, branch_id, parent_id, parent_type, country, state, city, postal_code, address1, address2, created_at)
           VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            schoolId,
            branchId,
            motherId,
            mCountry,
            mState,
            mCity,
            mInfo.mother_postal_code,
            mInfo.mother_address_1,
            mInfo.mother_address_2,
          ]
        );
      }
    }

    // 3. Guardian
    const gRel = data.guardian_relation ? String(data.guardian_relation).toLowerCase() : null;
    if (gRel === '1' || gRel === 'father') {
      guardianId = fatherId;
    } else if (gRel === '2' || gRel === 'mother') {
      guardianId = motherId;
    } else if (gRel === '3' || gRel === 'other' || gRel === 'others') {
      const ogInfo = data.other_guardian_info || {};
      if (ogInfo.first_name || ogInfo.phone) {
        let existingGuardianId = null;
        if (ogInfo.phone || ogInfo.email) {
          const [match] = await connection.execute(
            `SELECT id FROM parent_master WHERE school_id = ? AND ((phone = ? AND ? IS NOT NULL) OR (email = ? AND ? IS NOT NULL)) AND status != 4 LIMIT 1`,
            [schoolId, ogInfo.phone, ogInfo.phone, ogInfo.email, ogInfo.email]
          );
          if (match && match.length > 0) {
            existingGuardianId = match[0].id;
          }
        }

        if (existingGuardianId) {
          guardianId = existingGuardianId;
        } else {
          const gPlainPass = ogInfo.phone ? String(ogInfo.phone).trim() : null;
          const hashedGuardianPass = gPlainPass ? await bcrypt.hash(gPlainPass, 10) : null;
          const [gRes] = await connection.execute(
            `INSERT INTO parent_master (school_id, branch_id, first_name, last_name, phone, email, occupation, relation, parent_type, password, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3, ?, 1, NOW())`,
            [
              schoolId,
              branchId,
              ogInfo.first_name,
              ogInfo.last_name,
              ogInfo.phone,
              ogInfo.email,
              ogInfo.occupation,
              ogInfo.relation,
              hashedGuardianPass,
            ]
          );
          guardianId = gRes.insertId;
        }
      }
    }

    if (!guardianId) guardianId = fatherId || motherId || null;

    // 4. Link in student_to_parent
    if (fatherId || motherId || guardianId) {
      await connection.execute(
        `INSERT INTO student_to_parent (school_id, branch_id, student_id, father_id, mother_id, guardian_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [schoolId, branchId ? Number(branchId) : null, studentId, fatherId, motherId, guardianId]
      );
    }
  }

  /**
   * Sync Current and Permanent Student Addresses into student_address
   * (matching StudentModel.syncAddresses in growvidya_server).
   */
  static async syncAddresses(connection, studentId, schoolId, branchId, data) {
    const cAddr = data.current_address || {};
    const samePerm = data.same_permanent === 1 || data.same_permanent === '1' || data.same_permanent === true ? 1 : 0;
    const pAddr = samePerm ? cAddr : (data.permanent_address || {});

    const cCountry = await this.resolveMasterValue(connection, 'countries', 'name', cAddr.current_country);
    const cState = await this.resolveMasterValue(connection, 'states', 'state', cAddr.current_state, null, 'id_state');
    const cCity = await this.resolveMasterValue(connection, 'cities', 'name', cAddr.current_city);
    const cPostal = cAddr.current_postal_code;
    const cAddr1 = cAddr.current_address_1;
    const cAddr2 = cAddr.current_address_2;

    const pCountry = samePerm
      ? cCountry
      : (await this.resolveMasterValue(connection, 'countries', 'name', pAddr.permanent_country)) || cCountry;
    const pState = samePerm
      ? cState
      : (await this.resolveMasterValue(connection, 'states', 'state', pAddr.permanent_state, null, 'id_state')) || cState;
    const pCity = samePerm
      ? cCity
      : (await this.resolveMasterValue(connection, 'cities', 'name', pAddr.permanent_city)) || cCity;
    const pPostal = pAddr.permanent_postal_code || cPostal;
    const pAddr1 = pAddr.permanent_address_1 || cAddr1;
    const pAddr2 = pAddr.permanent_address_2 || cAddr2;

    if (cCountry || cState || cCity || cAddr1 || cPostal) {
      await connection.execute(
        `INSERT INTO student_address (school_id, branch_id, student_id, address_type, same_permanent, country, state, city, postal_code, address1, address2, created_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [schoolId, branchId ? Number(branchId) : null, studentId, samePerm, cCountry, cState, cCity, cPostal, cAddr1, cAddr2]
      );
    }

    if (pCountry || pState || pCity || pAddr1 || pPostal) {
      await connection.execute(
        `INSERT INTO student_address (school_id, branch_id, student_id, address_type, same_permanent, country, state, city, postal_code, address1, address2, created_at)
         VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [schoolId, branchId ? Number(branchId) : null, studentId, samePerm, pCountry, pState, pCity, pPostal, pAddr1, pAddr2]
      );
    }
  }

  /**
   * Insert a single validated student record inside its own transaction using StudentModel.create logic.
   */
  static async insertSingleStudent(connection, schoolId, defaultBranchId, data) {
    await connection.beginTransaction();

    try {
      const branchId = await this.resolveBranchId(schoolId, data.branch_id || defaultBranchId, connection);

      const academicYear = await this.resolveMasterValue(connection, 'academic_year_master', 'academic_year', data.academic_year, schoolId);
      const classId = await this.resolveMasterValue(connection, 'class_master', 'class_name', data.class_id, schoolId);
      const sectionId = await this.resolveMasterValue(connection, 'section_master', 'section_name', data.section_id, schoolId);
      const genderId = await this.resolveMasterValue(connection, 'gender_master', 'gender', data.gender);
      const bloodGroupId = await this.resolveMasterValue(connection, 'blood_group_master', 'blood_group', data.blood_group);
      const houseId = await this.resolveMasterValue(connection, 'house_master', 'house_name', data.house, schoolId);
      const religionId = await this.resolveMasterValue(connection, 'religion_master', 'religion', data.religion);
      const categoryId = await this.resolveMasterValue(connection, 'student_category_master', 'category', data.category);
      const motherTongueId = await this.resolveMasterValue(connection, 'mother_tongue_master', 'mother_tongue', data.mother_tongue);

      const trimmedEmail =
        data.email_address && String(data.email_address).trim() ? String(data.email_address).trim() : null;
      const trimmedPhone =
        data.primary_contact_number && String(data.primary_contact_number).trim()
          ? String(data.primary_contact_number).trim()
          : null;

      if (trimmedEmail) {
        const [emailRows] = await connection.query(
          'SELECT id FROM student_master WHERE school_id = ? AND status != 4 AND LOWER(TRIM(email_address)) = LOWER(TRIM(?)) LIMIT 1',
          [schoolId, trimmedEmail]
        );
        if (emailRows.length > 0) {
          throw new Error(`Email address "${trimmedEmail}" already exists in the system.`);
        }
      }

      if (trimmedPhone) {
        const [phoneRows] = await connection.query(
          'SELECT id FROM student_master WHERE school_id = ? AND status != 4 AND LOWER(TRIM(primary_contact_number)) = LOWER(TRIM(?)) LIMIT 1',
          [schoolId, trimmedPhone]
        );
        if (phoneRows.length > 0) {
          throw new Error(`Primary contact number "${trimmedPhone}" already exists in the system.`);
        }
      }

      let defaultPlainPassword = null;
      if (data.password && String(data.password).trim()) {
        defaultPlainPassword = String(data.password).trim();
      } else if (data.date_of_birth && String(data.date_of_birth).trim()) {
        defaultPlainPassword = String(data.date_of_birth).trim();
      } else if (trimmedPhone) {
        defaultPlainPassword = trimmedPhone;
      }
      const studentHashedPassword = defaultPlainPassword ? await bcrypt.hash(defaultPlainPassword, 10) : null;

      const sql = `
        INSERT INTO student_master (
          school_id, branch_id, academic_year, admission_number, admission_date, roll_number,
          first_name, last_name, class, section, gender, date_of_birth,
          password, primary_contact_number, email_address, blood_group, house, religion, category,
          caste, mother_tongue, language_known, status, picture
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const [result] = await connection.execute(sql, [
        schoolId,
        branchId,
        academicYear,
        data.admission_number,
        data.admission_date,
        data.roll_number,
        data.first_name,
        data.last_name,
        classId,
        sectionId,
        genderId,
        data.date_of_birth,
        studentHashedPassword,
        trimmedPhone,
        trimmedEmail,
        bloodGroupId,
        houseId,
        religionId,
        categoryId,
        data.caste,
        motherTongueId,
        data.language_known,
        Number(data.status) === 2 ? 2 : 1,
        null,
      ]);

      const studentId = result.insertId;

      if (data.transport_required === '1' && data.transport_info && data.transport_info.route) {
        const routeId = await this.resolveMasterValue(
          connection,
          'trans_route_master',
          'transport_route',
          data.transport_info.route,
          schoolId
        );
        await connection.execute(
          `INSERT INTO student_transport (school_id, branch_id, student_id, route, vehicle_number, pickup_point, drop_point, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            schoolId,
            branchId,
            studentId,
            routeId,
            data.transport_info.vehicle_number,
            data.transport_info.pickup_point,
            data.transport_info.drop_point,
          ]
        );
      }

      if (data.hostel_required === '1' && data.hostel_info && data.hostel_info.hostel_name) {
        const hostelNameId = await this.resolveMasterValue(
          connection,
          'hostel_name_master',
          'hostel_name',
          data.hostel_info.hostel_name,
          schoolId
        );
        const hostelRoomId = await this.resolveMasterValue(
          connection,
          'hostel_room_master',
          'room_number',
          data.hostel_info.hostel_room,
          schoolId
        );
        await connection.execute(
          `INSERT INTO student_hostel (school_id, branch_id, student_id, hostel_name, room_number, academic_year, status)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
          [
            schoolId,
            branchId,
            studentId,
            hostelNameId,
            hostelRoomId,
            academicYear,
          ]
        );
      }

      if (data.medical_history && Array.isArray(data.medical_history) && data.medical_history.length > 0) {
        for (const med of data.medical_history) {
          let medTime = null;
          if (med.medical_time) {
            const str = String(med.medical_time).trim();
            const dmy = str.match(/^(\d{1,2})[\-/](\d{1,2})[\-/](\d{4})/);
            const ymd = str.match(/^(\d{4})[\-/](\d{1,2})[\-/](\d{1,2})/);
            if (dmy) {
              medTime = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')} 00:00:00`;
            } else if (ymd) {
              medTime = `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')} 00:00:00`;
            }
          }
          await connection.execute(
            `INSERT INTO student_medical_history (school_id, branch_id, student_id, medical_condition, description, medical_time, is_informed, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
            [
              schoolId,
              branchId,
              studentId,
              med.medical_condition,
              med.description,
              medTime,
              med.is_informed ? 1 : 0,
            ]
          );
        }
      }

      const prevSchool = data.previous_school_info;
      if (prevSchool && prevSchool.previous_school_name) {
        const psCountry = await this.resolveMasterValue(connection, 'countries', 'name', prevSchool.prev_school_country);
        const psState = await this.resolveMasterValue(connection, 'states', 'state', prevSchool.prev_school_state, null, 'id_state');
        const psCity = await this.resolveMasterValue(connection, 'cities', 'name', prevSchool.prev_school_city);

        await connection.execute(
          `INSERT INTO previous_school_address (school_id, branch_id, student_id, school_name, address1, address2, country, state, city, postal_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            schoolId,
            branchId,
            studentId,
            prevSchool.previous_school_name,
            prevSchool.prev_school_address_1,
            prevSchool.prev_school_address_2,
            psCountry,
            psState,
            psCity,
            prevSchool.prev_school_postal_code,
          ]
        );
      }

      await this.syncParents(connection, studentId, schoolId, branchId, data);
      await this.syncAddresses(connection, studentId, schoolId, branchId, data);

      await connection.commit();
      return studentId;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  /**
   * Process and insert student rows, tracking successfully uploaded records
   * and collecting failed records with their specific failure_reason.
   */
  static async processAndInsertStudents(schoolId, defaultBranchId, rows) {
    const allAdmissionNumbers = rows
      .map((r) => (r.admission_number ? String(r.admission_number).trim().toLowerCase() : ''))
      .filter(Boolean);
    const allEmails = rows
      .map((r) => (r.email_address ? String(r.email_address).trim().toLowerCase() : ''))
      .filter(Boolean);
    const allPhones = rows
      .map((r) => (r.primary_contact_number ? String(r.primary_contact_number).trim().toLowerCase() : ''))
      .filter(Boolean);

    const { duplicateAdmissions, duplicateEmails, duplicatePhones } = await this.checkExistingDuplicates(
      schoolId,
      allAdmissionNumbers,
      allEmails,
      allPhones
    );

    const seenAdmissions = new Set();
    const seenEmails = new Set();
    const seenPhones = new Set();
    const insertedIds = [];
    const failedRecords = [];

    const connection = await pool.getConnection();

    try {
      for (const row of rows) {
        const reasons = [];

        if (!row.first_name) {
          reasons.push('First name (first_name) is required.');
        }
        if (!row.class_id) {
          reasons.push('Class (class_id) is required.');
        }

        const lowerAdm = row.admission_number ? String(row.admission_number).trim().toLowerCase() : '';
        if (lowerAdm) {
          if (duplicateAdmissions.has(lowerAdm)) {
            reasons.push(`Admission number "${row.admission_number}" already exists in the system.`);
          } else if (seenAdmissions.has(lowerAdm)) {
            reasons.push(`Duplicate admission number "${row.admission_number}" in uploaded file.`);
          }
        }

        const lowerEmail = row.email_address ? String(row.email_address).trim().toLowerCase() : '';
        if (lowerEmail) {
          if (duplicateEmails.has(lowerEmail)) {
            reasons.push(`Email address "${row.email_address}" already exists in the system.`);
          } else if (seenEmails.has(lowerEmail)) {
            reasons.push(`Duplicate email address "${row.email_address}" in uploaded file.`);
          }
        }

        const lowerPhone = row.primary_contact_number
          ? String(row.primary_contact_number).trim().toLowerCase()
          : '';
        if (lowerPhone) {
          if (duplicatePhones.has(lowerPhone)) {
            reasons.push(`Primary contact number "${row.primary_contact_number}" already exists in the system.`);
          } else if (seenPhones.has(lowerPhone)) {
            reasons.push(`Duplicate primary contact number "${row.primary_contact_number}" in uploaded file.`);
          }
        }

        if (reasons.length > 0) {
          failedRecords.push({
            row_number: row._rowNumber,
            admission_number: row.admission_number,
            first_name: row.first_name,
            last_name: row.last_name,
            email_address: row.email_address,
            primary_contact_number: row.primary_contact_number,
            failure_reason: reasons.join(' '),
            student_data: row._flatRow,
          });
          continue;
        }

        try {
          const newStudentId = await this.insertSingleStudent(connection, schoolId, defaultBranchId, row);
          insertedIds.push(newStudentId);
          if (lowerAdm) seenAdmissions.add(lowerAdm);
          if (lowerEmail) seenEmails.add(lowerEmail);
          if (lowerPhone) seenPhones.add(lowerPhone);
        } catch (dbErr) {
          failedRecords.push({
            row_number: row._rowNumber,
            admission_number: row.admission_number,
            first_name: row.first_name,
            last_name: row.last_name,
            email_address: row.email_address,
            primary_contact_number: row.primary_contact_number,
            failure_reason: dbErr.message,
            student_data: row._flatRow,
          });
        }
      }
    } finally {
      connection.release();
    }

    let failedBatchId = null;
    if (failedRecords.length > 0) {
      failedBatchId = this.saveFailedBatch(schoolId, failedRecords);
    }

    return {
      totalStudents: rows.length,
      successfullyUploaded: insertedIds.length,
      remainingFailed: failedRecords.length,
      studentIds: insertedIds,
      failedRecords,
      failedBatchId,
    };
  }
}

module.exports = StudentCsvModel;
