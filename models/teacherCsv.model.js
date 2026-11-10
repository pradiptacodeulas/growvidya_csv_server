const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db.config');
const { organizationHasMultipleBranches } = require('../utils/branchScope.util');

const failedTeacherBatchesById = new Map();
const latestFailedTeacherBatchBySchool = new Map();

function parsePostalCode(val) {
  if (val === null || val === undefined || val === '') return null;
  const cleaned = String(val).replace(/\D/g, '');
  return cleaned ? parseInt(cleaned, 10) : null;
}

class TeacherCsvModel {
  /**
   * Dynamically fetch Teacher Model column headers directly from the live MySQL database schema:
   * - teacher_master
   * - teacher_address
   * - teacher_payroll
   * - teacher_bank
   * - teacher_transport
   * - teacher_hostel
   * - teacher_social_link
   * Excludes `branch_id` if the organization has a single branch; includes it if the organization has multiple branches.
   */
  static async getDynamicHeaders(schoolIdOrReq = null) {
    const hasMultipleBranches = await organizationHasMultipleBranches(schoolIdOrReq);

    const excludedTeacherCols = new Set([
      'id',
      'school_id',
      'picture',
      'address1',
      'address2',
      'country',
      'state',
      'city',
      'postal_code',
      'created_on',
      'updated_on',
      'passcode',
      'otp',
      'otp_expires_at',
    ]);

    if (!hasMultipleBranches) {
      excludedTeacherCols.add('branch_id');
    }

    const excludedRelatedCols = new Set([
      'id',
      'school_id',
      'branch_id',
      'teacher_id',
      'academic_year',
      'address_type',
      'status',
      'staus',
      'created_at',
      'updated_at',
      'created_on',
      'updated_on',
    ]);

    const [teacherCols] = await pool.query('SHOW COLUMNS FROM teacher_master');
    const [addrCols] = await pool.query('SHOW COLUMNS FROM teacher_address');
    const [payrollCols] = await pool.query('SHOW COLUMNS FROM teacher_payroll');
    const [bankCols] = await pool.query('SHOW COLUMNS FROM teacher_bank');
    const [transportCols] = await pool.query('SHOW COLUMNS FROM teacher_transport');
    const [hostelCols] = await pool.query('SHOW COLUMNS FROM teacher_hostel');
    const [socialCols] = await pool.query('SHOW COLUMNS FROM teacher_social_link');

    const headers = [];

    // 1. teacher_master columns
    for (const c of teacherCols) {
      if (!excludedTeacherCols.has(c.Field)) {
        headers.push(c.Field);
      }
    }

    // 2. teacher_address columns (current & permanent)
    for (const prefix of ['current', 'permanent']) {
      for (const c of addrCols) {
        if (excludedRelatedCols.has(c.Field)) continue;
        if (c.Field === 'same_permanent') {
          if (prefix === 'current') headers.push('same_permanent');
          continue;
        }
        headers.push(`${prefix}_${c.Field}`);
      }
    }

    // 3. teacher_payroll columns
    for (const c of payrollCols) {
      if (!excludedRelatedCols.has(c.Field)) {
        headers.push(c.Field);
      }
    }

    // 4. teacher_bank columns
    for (const c of bankCols) {
      if (!excludedRelatedCols.has(c.Field)) {
        headers.push(c.Field);
      }
    }

    // 5. teacher_transport columns
    for (const c of transportCols) {
      if (!excludedRelatedCols.has(c.Field)) {
        headers.push(c.Field);
      }
    }

    // 6. teacher_hostel columns
    for (const c of hostelCols) {
      if (!excludedRelatedCols.has(c.Field)) {
        headers.push(c.Field);
      }
    }

    // 7. teacher_social_link columns
    for (const c of socialCols) {
      if (!excludedRelatedCols.has(c.Field)) {
        headers.push(c.Field);
      }
    }

    return Array.from(new Set(headers));
  }

  /**
   * Save failed teacher records batch so the user can download the failed CSV file.
   */
  static saveFailedBatch(schoolId, failedRecords) {
    const batchId = crypto.randomUUID();
    const record = {
      batchId,
      schoolId: Number(schoolId),
      failedRecords,
      createdAt: Date.now(),
    };
    failedTeacherBatchesById.set(batchId, record);
    latestFailedTeacherBatchBySchool.set(Number(schoolId), record);
    return batchId;
  }

  /**
   * Retrieve failed teacher records batch by batchId or latest for schoolId.
   */
  static getFailedBatch(batchId = null, schoolId = null) {
    if (batchId && failedTeacherBatchesById.has(batchId)) {
      return failedTeacherBatchesById.get(batchId);
    }
    if (schoolId && latestFailedTeacherBatchBySchool.has(Number(schoolId))) {
      return latestFailedTeacherBatchBySchool.get(Number(schoolId));
    }
    return null;
  }

  /**
   * Fetch the school's active subscription plan from the database.
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
        p.max_teachers
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
   * Count existing active teachers for the school in teacher_master.
   */
  static async getCurrentTeacherCount(schoolId) {
    const targetSchoolId = parseInt(schoolId, 10);
    const [rows] = await pool.query(
      'SELECT COUNT(id) AS count FROM teacher_master WHERE school_id = ? AND status != 4',
      [targetSchoolId]
    );
    return Number(rows[0]?.count || 0);
  }

  /**
   * Validate active subscription and teacher package limit before processing.
   */
  static async validatePackageLimit(schoolId, uploadedCount) {
    const subscription = await this.getSchoolPackageLimit(schoolId);

    if (!subscription) {
      return {
        allowed: false,
        statusCode: 402,
        code: 'SUBSCRIPTION_REQUIRED',
        message: 'No active subscription found for your school. Please select a subscription plan to continue.',
      };
    }

    const maxLimit = Number(subscription.max_teachers);
    const currentCount = await this.getCurrentTeacherCount(schoolId);
    const totalAfterUpload = currentCount + uploadedCount;

    if (maxLimit > 0 && (uploadedCount > maxLimit || totalAfterUpload > maxLimit)) {
      const remainingLimit = Math.max(0, maxLimit - currentCount);

      const message =
        uploadedCount > maxLimit || currentCount === 0
          ? `Your current package allows a maximum of ${maxLimit} teachers. You cannot upload ${uploadedCount} teachers. Please upgrade your package to continue.`
          : `Your current package allows a maximum of ${maxLimit} teachers. You already have ${currentCount} teachers and cannot upload ${uploadedCount} teachers (remaining limit: ${remainingLimit}). Please upgrade your package to continue.`;

      return {
        allowed: false,
        statusCode: 403,
        code: 'TEACHER_QUOTA_EXCEEDED',
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
   * Resolve current academic year ID if not provided.
   */
  static async resolveAcademicYearId(connection, schoolId, branchId, academicYearVal) {
    if (academicYearVal && /^\d+$/.test(String(academicYearVal).trim())) {
      return Number(academicYearVal);
    }
    const [rows] = await connection.query(
      'SELECT id FROM academic_year_master WHERE school_id = ? AND status = 1 AND (branch_id = ? OR branch_id IS NULL) ORDER BY is_current DESC, id DESC LIMIT 1',
      [schoolId, branchId]
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
   * Check which teacher_ids, email addresses, or phone numbers already exist in teacher_master.
   */
  static async checkExistingDuplicates(schoolId, teacherIds = [], emails = [], phones = []) {
    const duplicateTeacherIds = new Set();
    const duplicateEmails = new Set();
    const duplicatePhones = new Set();

    if (teacherIds.length > 0) {
      const placeholders = teacherIds.map(() => '?').join(', ');
      const [rows] = await pool.query(
        `SELECT teacher_id FROM teacher_master WHERE school_id = ? AND status != 4 AND LOWER(TRIM(teacher_id)) IN (${placeholders})`,
        [schoolId, ...teacherIds.map((v) => String(v).trim().toLowerCase())]
      );
      rows.forEach((r) => {
        if (r.teacher_id) duplicateTeacherIds.add(String(r.teacher_id).trim().toLowerCase());
      });
    }

    if (emails.length > 0) {
      const placeholders = emails.map(() => '?').join(', ');
      const [rows] = await pool.query(
        `SELECT email_address FROM teacher_master WHERE school_id = ? AND status != 4 AND LOWER(TRIM(email_address)) IN (${placeholders})`,
        [schoolId, ...emails.map((v) => String(v).trim().toLowerCase())]
      );
      rows.forEach((r) => {
        if (r.email_address) duplicateEmails.add(String(r.email_address).trim().toLowerCase());
      });
    }

    if (phones.length > 0) {
      const placeholders = phones.map(() => '?').join(', ');
      const [rows] = await pool.query(
        `SELECT primary_contact_number FROM teacher_master WHERE school_id = ? AND status != 4 AND LOWER(TRIM(primary_contact_number)) IN (${placeholders})`,
        [schoolId, ...phones.map((v) => String(v).trim().toLowerCase())]
      );
      rows.forEach((r) => {
        if (r.primary_contact_number) duplicatePhones.add(String(r.primary_contact_number).trim().toLowerCase());
      });
    }

    return { duplicateTeacherIds, duplicateEmails, duplicatePhones };
  }

  /**
   * Insert a single Teacher record and its related tables inside a database transaction
   * matching TeacherModel.createTeacher in the GrowVidya server:
   * - teacher_master
   * - teacher_address (current & permanent)
   * - teacher_class_assign
   * - teacher_payroll
   * - teacher_bank & beneficiary_master (user_type = 2)
   * - teacher_transport
   * - teacher_hostel
   * - teacher_social_link
   */
  static async insertSingleTeacher(connection, schoolId, defaultBranchId, row) {
    await connection.beginTransaction();

    try {
      const branchId = await this.resolveBranchId(schoolId, row.branch_id || defaultBranchId, connection);
      const academicYearId = await this.resolveAcademicYearId(connection, schoolId, branchId, row.academic_year);

      const classId = await this.resolveMasterValue(connection, 'class_master', 'class_name', row.class, schoolId);
      const sectionId = await this.resolveMasterValue(connection, 'section_master', 'section_name', row.section, schoolId);
      const subjectId = await this.resolveMasterValue(connection, 'subject_master', 'subject_name', row.subject, schoolId);
      const genderId = (await this.resolveMasterValue(connection, 'gender_master', 'gender', row.gender)) || 1;
      const bloodGroupId = await this.resolveMasterValue(connection, 'blood_group_master', 'blood_group', row.blood_group);
      const maritalId = await this.resolveMasterValue(connection, 'marital_master', 'marital_status', row.marital_status);

      const trimmedEmail =
        row.email_address && String(row.email_address).trim() ? String(row.email_address).trim() : null;
      const trimmedPhone =
        row.primary_contact_number && String(row.primary_contact_number).trim()
          ? String(row.primary_contact_number).trim()
          : null;

      if (trimmedEmail) {
        const [emailRows] = await connection.query(
          'SELECT id FROM teacher_master WHERE school_id = ? AND status != 4 AND LOWER(TRIM(email_address)) = LOWER(TRIM(?)) LIMIT 1',
          [schoolId, trimmedEmail]
        );
        if (emailRows.length > 0) {
          throw new Error(`Email address "${trimmedEmail}" already exists in the system.`);
        }
      }

      if (trimmedPhone) {
        const [phoneRows] = await connection.query(
          'SELECT id FROM teacher_master WHERE school_id = ? AND status != 4 AND LOWER(TRIM(primary_contact_number)) = LOWER(TRIM(?)) LIMIT 1',
          [schoolId, trimmedPhone]
        );
        if (phoneRows.length > 0) {
          throw new Error(`Primary contact number "${trimmedPhone}" already exists in the system.`);
        }
      }

      const rawPassword = row.password || trimmedPhone || null;
      const hashedPassword = rawPassword ? await bcrypt.hash(String(rawPassword), 10) : null;

      const teacherStatus =
        row.status !== null && row.status !== undefined && !isNaN(row.status) ? Number(row.status) : 1;
      const takeAttendance =
        row.take_attendance !== null && row.take_attendance !== undefined && !isNaN(row.take_attendance)
          ? Number(row.take_attendance)
          : 2;

      const teacherCode =
        row.teacher_id || `TCH${Math.floor(100000 + Math.random() * 900000)}`;

      // 1. Insert into teacher_master
      const [teacherResult] = await connection.query(
        `INSERT INTO teacher_master (
          school_id, branch_id, picture, academic_year, teacher_id, first_name, last_name, class, section, subject,
          gender, primary_contact_number, email_address, blood_group, date_of_joining, father_name, mother_name,
          date_of_birth, marital_status, language_known, qualification, work_experience, previous_school_name,
          previous_school_address, previous_school_phone, pan_number, status, notes,
          take_attendance, password, created_on
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          schoolId,
          branchId,
          academicYearId,
          teacherCode,
          row.first_name || '',
          row.last_name || '',
          classId || null,
          sectionId || null,
          subjectId || null,
          genderId,
          trimmedPhone,
          trimmedEmail,
          bloodGroupId || null,
          row.date_of_joining || null,
          row.father_name || null,
          row.mother_name || null,
          row.date_of_birth || null,
          maritalId || null,
          row.language_known || null,
          row.qualification || null,
          row.work_experience || null,
          row.previous_school_name || null,
          row.previous_school_address || null,
          row.previous_school_phone || null,
          row.pan_number || null,
          teacherStatus,
          row.notes || null,
          takeAttendance,
          hashedPassword,
        ]
      );

      const newTeacherId = teacherResult.insertId;

      // 2. Insert into teacher_address (Current & Permanent)
      const curAddr = row.current_address || {};
      const hasCurrentAddr = Object.values(curAddr).some((v) => v !== null && v !== '');
      if (hasCurrentAddr) {
        const curCountryId = await this.resolveMasterValue(connection, 'countries', 'name', curAddr.country);
        const curStateId = await this.resolveMasterValue(connection, 'states', 'state', curAddr.state, null, 'id_state');
        const curCityId = await this.resolveMasterValue(connection, 'cities', 'name', curAddr.city);
        const samePerm = row.same_permanent ? 1 : 0;

        await connection.query(
          `INSERT INTO teacher_address (
            school_id, branch_id, teacher_id, address1, address2, country, state, city, postal_code, same_permanent, address_type, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
          [
            schoolId,
            branchId,
            newTeacherId,
            curAddr.address1 || '',
            curAddr.address2 || '',
            curCountryId || null,
            curStateId || null,
            curCityId || null,
            parsePostalCode(curAddr.postal_code),
            samePerm,
          ]
        );

        const permAddr = row.permanent_address || {};
        const hasPermAddr = Object.values(permAddr).some((v) => v !== null && v !== '');
        if (!samePerm && hasPermAddr) {
          const permCountryId = await this.resolveMasterValue(connection, 'countries', 'name', permAddr.country);
          const permStateId = await this.resolveMasterValue(connection, 'states', 'state', permAddr.state, null, 'id_state');
          const permCityId = await this.resolveMasterValue(connection, 'cities', 'name', permAddr.city);

          await connection.query(
            `INSERT INTO teacher_address (
              school_id, branch_id, teacher_id, address1, address2, country, state, city, postal_code, same_permanent, address_type, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 2, 2)`,
            [
              schoolId,
              branchId,
              newTeacherId,
              permAddr.address1 || '',
              permAddr.address2 || '',
              permCountryId || null,
              permStateId || null,
              permCityId || null,
              parsePostalCode(permAddr.postal_code),
            ]
          );
        }
      }

      // 3. Insert into teacher_class_assign if class is provided
      if (classId) {
        const assignStatus = teacherStatus === 2 ? 4 : 1;
        await connection.query(
          `INSERT INTO teacher_class_assign (
            school_id, branch_id, teacher_id, class_id, subject_id, academic_year, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [schoolId, branchId, newTeacherId, classId, subjectId || 0, academicYearId, assignStatus]
        );
      }

      // 4. Insert into teacher_payroll
      const payroll = row.payroll || {};
      if (
        payroll.epf_no ||
        payroll.basic_salary !== null ||
        payroll.contract_type ||
        payroll.work_shift ||
        payroll.work_location ||
        payroll.date_of_leaving
      ) {
        const contractTypeId = await this.resolveMasterValue(
          connection,
          'contract_type_master',
          'contract_type',
          payroll.contract_type
        );
        const shiftId = await this.resolveMasterValue(
          connection,
          'shift_master',
          'shift_name',
          payroll.work_shift,
          schoolId
        );

        await connection.query(
          `INSERT INTO teacher_payroll (
            school_id, branch_id, teacher_id, academic_year, epf_no, basic_salary, contract_type, work_shift, work_location, date_of_leaving, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            schoolId,
            branchId,
            newTeacherId,
            academicYearId,
            payroll.epf_no || '',
            Number(payroll.basic_salary || 0),
            contractTypeId || null,
            shiftId || null,
            payroll.work_location || '',
            payroll.date_of_leaving || null,
          ]
        );
      }

      // 5. Insert into teacher_bank & beneficiary_master (user_type = 2)
      const bank = row.bank || {};
      if (bank.account_name || bank.account_number || bank.bank_name || bank.ifsc_code || bank.branch_name) {
        await connection.query(
          `INSERT INTO teacher_bank (
            school_id, branch_id, teacher_id, academic_year, account_name, account_number, bank_name, ifsc_code, branch_name, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            schoolId,
            branchId,
            newTeacherId,
            academicYearId,
            bank.account_name || `${row.first_name || ''} ${row.last_name || ''}`.trim(),
            bank.account_number || '',
            bank.bank_name || '',
            bank.ifsc_code || '',
            bank.branch_name || '',
          ]
        );

        if (bank.bank_name && bank.account_number) {
          await connection.query(
            `INSERT INTO beneficiary_master (
              school_id, branch_id, user_type, employee_id, basic_salary, status
            ) VALUES (?, ?, 2, ?, ?, 1)`,
            [schoolId, branchId, newTeacherId, Number(payroll.basic_salary || 0)]
          );
        }
      }

      // 6. Insert into teacher_transport
      const transport = row.transport || {};
      if (transport.route || transport.vehicle_number || transport.pickup_point || transport.drop_point) {
        const routeId = await this.resolveMasterValue(
          connection,
          'trans_route_master',
          'transport_route',
          transport.route,
          schoolId
        );
        const vehicleId = await this.resolveMasterValue(
          connection,
          'trans_vehicle_master',
          'vehicle_number',
          transport.vehicle_number,
          schoolId
        );

        await connection.query(
          `INSERT INTO teacher_transport (
            school_id, branch_id, teacher_id, academic_year, route, vehicle_number, pickup_point, drop_point, staus
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            schoolId,
            branchId,
            newTeacherId,
            academicYearId,
            routeId || null,
            vehicleId || 0,
            transport.pickup_point || '',
            transport.drop_point || '',
          ]
        );
      }

      // 7. Insert into teacher_hostel
      const hostel = row.hostel || {};
      if (hostel.hostel_name || hostel.room_number) {
        const hostelId = await this.resolveMasterValue(
          connection,
          'hostel_name_master',
          'hostel_name',
          hostel.hostel_name,
          schoolId
        );
        const roomId = await this.resolveMasterValue(
          connection,
          'hostel_room_master',
          'room_number',
          hostel.room_number,
          schoolId
        );

        await connection.query(
          `INSERT INTO teacher_hostel (
            school_id, branch_id, teacher_id, academic_year, hostel_name, room_number, status
          ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
          [schoolId, branchId, newTeacherId, academicYearId, hostelId || null, roomId || null]
        );
      }

      // 8. Insert into teacher_social_link
      const social = row.social || {};
      if (
        social.facebook_link ||
        social.instagram_link ||
        social.linkedin_link ||
        social.youtube_link ||
        social.twitter_link
      ) {
        await connection.query(
          `INSERT INTO teacher_social_link (
            school_id, branch_id, teacher_id, academic_year, facebook_link, instagram_link, linkedin_link, youtube_link, twitter_link, staus
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [
            schoolId,
            branchId,
            newTeacherId,
            academicYearId,
            social.facebook_link || '',
            social.instagram_link || '',
            social.linkedin_link || '',
            social.youtube_link || '',
            social.twitter_link || '',
          ]
        );
      }

      await connection.commit();
      return newTeacherId;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  /**
   * Process and store CSV teacher records step by step in small sequential batches.
   * Validates each record before inserting, saves valid records even if others fail,
   * and prevents duplicate insertions when failed records are corrected and re-uploaded.
   */
  static async processTeachersInBatches(schoolId, defaultBranchId, rows, customBatchSize = null) {
    const parsedBatchSize = parseInt(customBatchSize || process.env.CSV_BATCH_SIZE, 10);
    const batchSize = parsedBatchSize > 0 ? parsedBatchSize : Math.max(1, Math.ceil(rows.length / 10));

    const seenTeacherIds = new Set();
    const seenEmails = new Set();
    const seenPhones = new Set();
    const insertedIds = [];
    const failedRecords = [];
    let batchesProcessed = 0;

    const connection = await pool.getConnection();

    try {
      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batchRows = rows.slice(offset, offset + batchSize);
        batchesProcessed += 1;

        const batchTeacherIds = batchRows
          .map((r) => (r.teacher_id ? String(r.teacher_id).trim().toLowerCase() : ''))
          .filter(Boolean);
        const batchEmails = batchRows
          .map((r) => (r.email_address ? String(r.email_address).trim().toLowerCase() : ''))
          .filter(Boolean);
        const batchPhones = batchRows
          .map((r) => (r.primary_contact_number ? String(r.primary_contact_number).trim().toLowerCase() : ''))
          .filter(Boolean);

        const { duplicateTeacherIds, duplicateEmails, duplicatePhones } =
          await this.checkExistingDuplicates(schoolId, batchTeacherIds, batchEmails, batchPhones);

        for (const row of batchRows) {
          const reasons = [];

          if (!row.first_name) {
            reasons.push('First name (first_name) is required.');
          }
          if (!row.email_address) {
            reasons.push('Email address (email_address) is required.');
          }
          if (!row.primary_contact_number) {
            reasons.push('Primary contact number (primary_contact_number) is required.');
          }

          const lowerTeacherId = row.teacher_id ? String(row.teacher_id).trim().toLowerCase() : '';
          if (lowerTeacherId) {
            if (duplicateTeacherIds.has(lowerTeacherId)) {
              reasons.push(`Teacher ID "${row.teacher_id}" already exists in the system.`);
            } else if (seenTeacherIds.has(lowerTeacherId)) {
              reasons.push(`Duplicate Teacher ID "${row.teacher_id}" in uploaded file.`);
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
              teacher_id: row.teacher_id,
              first_name: row.first_name,
              last_name: row.last_name,
              email_address: row.email_address,
              primary_contact_number: row.primary_contact_number,
              failure_reason: reasons.join(' '),
              teacher_data: row._flatRow,
            });
            continue;
          }

          try {
            const newId = await this.insertSingleTeacher(
              connection,
              schoolId,
              defaultBranchId,
              row
            );
            insertedIds.push(newId);
            if (lowerTeacherId) seenTeacherIds.add(lowerTeacherId);
            if (lowerEmail) seenEmails.add(lowerEmail);
            if (lowerPhone) seenPhones.add(lowerPhone);
          } catch (dbErr) {
            failedRecords.push({
              row_number: row._rowNumber,
              teacher_id: row.teacher_id,
              first_name: row.first_name,
              last_name: row.last_name,
              email_address: row.email_address,
              primary_contact_number: row.primary_contact_number,
              failure_reason: dbErr.message,
              teacher_data: row._flatRow,
            });
          }
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
      totalTeachers: rows.length,
      successfullyUploaded: insertedIds.length,
      remainingFailed: failedRecords.length,
      batchesProcessed,
      teacherIds: insertedIds,
      failedRecords,
      failedBatchId,
    };
  }
}

module.exports = TeacherCsvModel;
