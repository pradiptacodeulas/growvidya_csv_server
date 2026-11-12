const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db.config');
const { organizationHasMultipleBranches } = require('../utils/branchScope.util');

const failedUserBatchesById = new Map();
const latestFailedUserBatchBySchool = new Map();

class UserCsvModel {
  /**
   * Dynamically fetch User Model column headers directly from the live MySQL database schema:
   * - user_master
   * - user_bank
   * - beneficiary_master (basic_salary)
   * - user_transport
   * - user_hostel
   * Excludes `branch_id` if the organization has a single branch; includes it if the organization has multiple branches.
   */
  static async getDynamicHeaders(schoolIdOrReq = null) {
    const hasMultipleBranches = await organizationHasMultipleBranches(schoolIdOrReq);

    const excludedUserCols = new Set([
      'id',
      'school_id',
      'picture',
      'otp',
      'otp_expires_at',
      'verification_code',
      'date',
      'admin_type',
      'status',
    ]);

    if (!hasMultipleBranches) {
      excludedUserCols.add('branch_id');
    }

    const excludedRelatedCols = new Set([
      'id',
      'school_id',
      'branch_id',
      'user_id',
      'user_type',
      'employee_id',
      'status',
      'staus',
      'created_at',
      'updated_at',
      'created_on',
    ]);

    const [userCols] = await pool.query('SHOW COLUMNS FROM user_master');
    const [bankCols] = await pool.query('SHOW COLUMNS FROM user_bank');
    const [beneficiaryCols] = await pool.query('SHOW COLUMNS FROM beneficiary_master');
    const [transportCols] = await pool.query('SHOW COLUMNS FROM user_transport');
    const [hostelCols] = await pool.query('SHOW COLUMNS FROM user_hostel');

    const headers = [];

    // 1. user_master columns
    for (const c of userCols) {
      if (excludedUserCols.has(c.Field)) continue;
      if (c.Field === 'branch_id') {
        headers.push('branch_name');
      } else if (c.Field === 'country_id') {
        headers.push('country');
      } else if (c.Field === 'state_id') {
        headers.push('state');
      } else {
        headers.push(c.Field);
      }
    }

    // 2. user_bank columns
    for (const c of bankCols) {
      if (!excludedRelatedCols.has(c.Field)) {
        headers.push(c.Field);
      }
    }

    // 3. beneficiary_master columns (basic_salary)
    for (const c of beneficiaryCols) {
      if (!excludedRelatedCols.has(c.Field)) {
        headers.push(c.Field);
      }
    }

    // 4. user_transport columns
    for (const c of transportCols) {
      if (!excludedRelatedCols.has(c.Field)) {
        headers.push(c.Field);
      }
    }

    // 5. user_hostel columns
    for (const c of hostelCols) {
      if (!excludedRelatedCols.has(c.Field)) {
        headers.push(c.Field);
      }
    }

    return headers;
  }

  /**
   * Save failed user records batch so the user can download the failed CSV file.
   */
  static saveFailedBatch(schoolId, failedRecords) {
    const batchId = crypto.randomUUID();
    const record = {
      batchId,
      schoolId: Number(schoolId),
      failedRecords,
      createdAt: Date.now(),
    };
    failedUserBatchesById.set(batchId, record);
    latestFailedUserBatchBySchool.set(Number(schoolId), record);
    return batchId;
  }

  /**
   * Retrieve failed user records batch by batchId or latest for schoolId.
   */
  static getFailedBatch(batchId = null, schoolId = null) {
    if (batchId && failedUserBatchesById.has(batchId)) {
      return failedUserBatchesById.get(batchId);
    }
    if (schoolId && latestFailedUserBatchBySchool.has(Number(schoolId))) {
      return latestFailedUserBatchBySchool.get(Number(schoolId));
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
   * Count existing active users for the school in user_master (excluding Super Admin and deleted).
   */
  static async getCurrentUserCount(schoolId) {
    const targetSchoolId = parseInt(schoolId, 10);
    const [rows] = await pool.query(
      'SELECT COUNT(id) AS count FROM user_master WHERE school_id = ? AND admin_type != 1 AND status != 4',
      [targetSchoolId]
    );
    return Number(rows[0]?.count || 0);
  }

  /**
   * Validate active subscription and user package limit before processing.
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
    const currentCount = await this.getCurrentUserCount(schoolId);
    const totalAfterUpload = currentCount + uploadedCount;

    if (maxLimit > 0 && (uploadedCount > maxLimit || totalAfterUpload > maxLimit)) {
      const remainingLimit = Math.max(0, maxLimit - currentCount);

      const message =
        uploadedCount > maxLimit || currentCount === 0
          ? `Your current package allows a maximum of ${maxLimit} users. You cannot upload ${uploadedCount} users. Please upgrade your package to continue.`
          : `Your current package allows a maximum of ${maxLimit} users. You already have ${currentCount} users and cannot upload ${uploadedCount} users (remaining limit: ${remainingLimit}). Please upgrade your package to continue.`;

      return {
        allowed: false,
        statusCode: 403,
        code: 'USER_QUOTA_EXCEEDED',
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
   * Resolve and validate branch ID for the school from branch_master:
   * - Single-branch organization:
   *   - If branch name is provided in CSV/Excel, validate it against the existing branch record.
   *   - If not provided, automatically assign the school's default/single branch.
   * - Multiple-branch organization:
   *   - Branch name must be provided in CSV/Excel and match an existing active branch record.
   *   - Never assigns a random or default branch if missing or invalid.
   */
  static async resolveBranchId(schoolId, branchValue = null, connection = pool) {
    const hasMultipleBranches = await organizationHasMultipleBranches(schoolId, connection);
    const cleanBranch =
      branchValue !== null && branchValue !== undefined ? String(branchValue).trim() : '';

    if (hasMultipleBranches && !cleanBranch) {
      throw new Error('Branch name (branch_name) is required.');
    }

    if (cleanBranch) {
      const lowerBranch = cleanBranch.toLowerCase();
      const isNumeric = /^\d+$/.test(cleanBranch);

      const [bRows] = await connection.query(
        `SELECT id FROM branch_master
         WHERE school_id = ? AND status != 4
           AND (
             ${isNumeric ? 'id = ? OR ' : ''}
             LOWER(TRIM(branch_name)) = ?
             OR LOWER(TRIM(REPLACE(branch_name, '(Main Campus)', ''))) = ?
             OR LOWER(TRIM(branch_code)) = ?
           )
         LIMIT 1`,
        isNumeric
          ? [schoolId, Number(cleanBranch), lowerBranch, lowerBranch, lowerBranch]
          : [schoolId, lowerBranch, lowerBranch, lowerBranch]
      );

      if (bRows.length === 0) {
        throw new Error(`Branch "${cleanBranch}" does not exist for this school.`);
      }

      return Number(bRows[0].id);
    }

    const [rows] = await connection.query(
      'SELECT id FROM branch_master WHERE school_id = ? AND status != 4 ORDER BY is_main_branch DESC, id ASC LIMIT 1',
      [schoolId]
    );
    if (rows.length === 0) {
      throw new Error('No active branch found for this school.');
    }
    return Number(rows[0].id);
  }

  /**
   * Resolve master table lookup values dynamically from the database by ID or display name.
   */
  static async resolveMasterValue(connection, table, nameColumn, value, schoolId = null, idColumn = 'id') {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const trimmed = String(value).trim();
    const lowerTrimmed = trimmed.toLowerCase();
    const isNumeric = /^\d+$/.test(trimmed);

    let sql = `SELECT \`${idColumn}\` AS id FROM \`${table}\` WHERE (${
      isNumeric ? `\`${idColumn}\` = ? OR ` : ''
    }LOWER(TRIM(\`${nameColumn}\`)) = ?)`;
    const params = isNumeric ? [Number(trimmed), lowerTrimmed] : [lowerTrimmed];

    if (schoolId !== null) {
      sql += ` AND (school_id = ? OR school_id IS NULL)`;
      params.push(schoolId);
    }
    sql += ` LIMIT 1`;

    const [rows] = await connection.query(sql, params);
    return rows && rows.length > 0 ? Number(rows[0].id) : null;
  }

  /**
   * Check which email addresses or phone numbers already exist in user_master for the school.
   */
  static async checkExistingDuplicates(schoolId, emails = [], phones = []) {
    const duplicateEmails = new Set();
    const duplicatePhones = new Set();

    if (emails.length > 0) {
      const placeholders = emails.map(() => '?').join(', ');
      const [rows] = await pool.query(
        `SELECT email FROM user_master WHERE school_id = ? AND status != 4 AND LOWER(TRIM(email)) IN (${placeholders})`,
        [schoolId, ...emails.map((v) => String(v).trim().toLowerCase())]
      );
      rows.forEach((r) => {
        if (r.email) duplicateEmails.add(String(r.email).trim().toLowerCase());
      });
    }

    if (phones.length > 0) {
      const placeholders = phones.map(() => '?').join(', ');
      const [rows] = await pool.query(
        `SELECT phone FROM user_master WHERE school_id = ? AND status != 4 AND LOWER(TRIM(phone)) IN (${placeholders})`,
        [schoolId, ...phones.map((v) => String(v).trim().toLowerCase())]
      );
      rows.forEach((r) => {
        if (r.phone) duplicatePhones.add(String(r.phone).trim().toLowerCase());
      });
    }

    return { duplicateEmails, duplicatePhones };
  }

  /**
   * Insert a single User record and its related tables inside a database transaction
   * matching StaffModel.create in the GrowVidya server:
   * - user_master
   * - user_bank & beneficiary_master
   * - user_transport
   * - user_hostel
   */
  static async insertSingleUser(connection, schoolId, defaultBranchId, row) {
    await connection.beginTransaction();

    try {
      const branchId =
        row._resolvedBranchId !== undefined
          ? row._resolvedBranchId
          : await this.resolveBranchId(schoolId, row.branch_id, connection);
      const genderId = await this.resolveMasterValue(connection, 'gender_master', 'gender', row.gender);
      const bloodGroupId = await this.resolveMasterValue(connection, 'blood_group_master', 'blood_group', row.blood_group);
      const countryId = await this.resolveMasterValue(connection, 'countries', 'name', row.country || row.country_id);
      const stateId = await this.resolveMasterValue(connection, 'states', 'state', row.state || row.state_id, null, 'id_state');
      const cityId = await this.resolveMasterValue(connection, 'cities', 'name', row.city);
      const resolvedRoleId = await this.resolveMasterValue(connection, 'role_master', 'role_name', row.role, schoolId);
      const roleId = resolvedRoleId !== null ? resolvedRoleId : 0;

      const trimmedEmail = row.email && String(row.email).trim() ? String(row.email).trim() : null;
      const trimmedPhone = row.phone && String(row.phone).trim() ? String(row.phone).trim() : null;

      if (trimmedEmail) {
        const [emailRows] = await connection.query(
          'SELECT id FROM user_master WHERE school_id = ? AND status != 4 AND LOWER(TRIM(email)) = LOWER(TRIM(?)) LIMIT 1',
          [schoolId, trimmedEmail]
        );
        if (emailRows.length > 0) {
          throw new Error(`Email address "${trimmedEmail}" already exists in the system.`);
        }
      }

      if (trimmedPhone) {
        const [phoneRows] = await connection.query(
          'SELECT id FROM user_master WHERE school_id = ? AND status != 4 AND LOWER(TRIM(phone)) = LOWER(TRIM(?)) LIMIT 1',
          [schoolId, trimmedPhone]
        );
        if (phoneRows.length > 0) {
          throw new Error(`Phone number "${trimmedPhone}" already exists in the system.`);
        }
      }

      const rawPassword = row.password && String(row.password).trim() ? String(row.password).trim() : null;
      const hashedPassword = rawPassword ? await bcrypt.hash(rawPassword, 10) : null;

      const insertCols = [
        'school_id',
        'branch_id',
        'first_name',
        'last_name',
        'email',
        'phone',
        'password',
        'blood_group',
        'country_id',
        'state_id',
        'city',
        'role',
        'status',
      ];
      const insertVals = [
        schoolId,
        branchId,
        row.first_name,
        row.last_name,
        trimmedEmail,
        trimmedPhone,
        hashedPassword,
        bloodGroupId,
        countryId,
        stateId,
        cityId,
        roleId,
        1,
      ];

      if (genderId !== null) {
        insertCols.push('gender');
        insertVals.push(genderId);
      }
      if (row.admin_type !== null && row.admin_type !== undefined && !isNaN(row.admin_type)) {
        insertCols.push('admin_type');
        insertVals.push(Number(row.admin_type));
      }

      // 1. Insert into user_master (relying on database schema defaults for omitted optional columns)
      const placeholders = insertCols.map(() => '?').join(', ');
      const [userResult] = await connection.query(
        `INSERT INTO user_master (${insertCols.join(', ')}) VALUES (${placeholders})`,
        insertVals
      );

      const userId = userResult.insertId;

      // 2. Insert into user_bank & beneficiary_master (user_type = 1)
      if (
        row.account_name ||
        row.account_number ||
        row.bank_name ||
        row.ifsc_code ||
        row.branch_name ||
        row.basic_salary !== null
      ) {
        await connection.query(
          `INSERT INTO user_bank (
            school_id, branch_id, user_id, account_name, account_number, bank_name, ifsc_code, branch_name
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            schoolId,
            branchId,
            userId,
            row.account_name,
            row.account_number,
            row.bank_name,
            row.ifsc_code,
            row.branch_name,
          ]
        );

        if ((row.bank_name && row.account_number) || row.basic_salary !== null) {
          await connection.query(
            `INSERT INTO beneficiary_master (
              school_id, branch_id, user_type, employee_id, basic_salary, status
            ) VALUES (?, ?, 1, ?, ?, 1)`,
            [schoolId, branchId, userId, row.basic_salary]
          );
        }
      }

      // 3. Insert into user_transport
      if (row.route || row.vehicle_number || row.pickup_point || row.drop_point) {
        const routeId = await this.resolveMasterValue(
          connection,
          'trans_route_master',
          'transport_route',
          row.route,
          schoolId
        );
        const vehicleId = await this.resolveMasterValue(
          connection,
          'trans_vehicle_master',
          'vehicle_number',
          row.vehicle_number,
          schoolId
        );

        await connection.query(
          `INSERT INTO user_transport (
            school_id, branch_id, user_id, route, vehicle_number, pickup_point, drop_point
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            schoolId,
            branchId,
            userId,
            routeId,
            vehicleId,
            row.pickup_point,
            row.drop_point,
          ]
        );
      }

      // 4. Insert into user_hostel
      if (row.hostel_name || row.room_number) {
        const hostelId = await this.resolveMasterValue(
          connection,
          'hostel_name_master',
          'hostel_name',
          row.hostel_name,
          schoolId
        );
        const roomId = await this.resolveMasterValue(
          connection,
          'hostel_room_master',
          'room_number',
          row.room_number,
          schoolId
        );

        await connection.query(
          `INSERT INTO user_hostel (
            school_id, branch_id, user_id, hostel_name, room_number
          ) VALUES (?, ?, ?, ?, ?)`,
          [schoolId, branchId, userId, hostelId, roomId]
        );
      }

      await connection.commit();
      return userId;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  /**
   * Process and store CSV user records step by step in small sequential batches.
   * Validates each record before inserting, saves valid records even if others fail,
   * and prevents duplicate insertions when failed records are corrected and re-uploaded.
   */
  static async processUsersInBatches(schoolId, defaultBranchId, rows, customBatchSize = null) {
    const parsedBatchSize = parseInt(customBatchSize || process.env.CSV_BATCH_SIZE, 10);
    const batchSize = parsedBatchSize > 0 ? parsedBatchSize : Math.max(1, Math.ceil(rows.length / 10));

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

        const batchEmails = batchRows
          .map((r) => (r.email ? String(r.email).trim().toLowerCase() : ''))
          .filter(Boolean);
        const batchPhones = batchRows
          .map((r) => (r.phone ? String(r.phone).trim().toLowerCase() : ''))
          .filter(Boolean);

        const { duplicateEmails, duplicatePhones } = await this.checkExistingDuplicates(
          schoolId,
          batchEmails,
          batchPhones
        );

        for (const row of batchRows) {
          const reasons = [];
          let resolvedBranchId = null;

          try {
            resolvedBranchId = await this.resolveBranchId(schoolId, row.branch_id, connection);
          } catch (branchErr) {
            reasons.push(branchErr.message);
          }

          if (!row.first_name) {
            reasons.push('First name (first_name) is required.');
          }
          if (!row.last_name) {
            reasons.push('Last name (last_name) is required.');
          }
          if (!row.email) {
            reasons.push('Email address (email) is required.');
          }

          const lowerEmail = row.email ? String(row.email).trim().toLowerCase() : '';
          if (lowerEmail) {
            if (duplicateEmails.has(lowerEmail)) {
              reasons.push(`Email address "${row.email}" already exists in the system.`);
            } else if (seenEmails.has(lowerEmail)) {
              reasons.push(`Duplicate email address "${row.email}" in uploaded file.`);
            }
          }

          const lowerPhone = row.phone ? String(row.phone).trim().toLowerCase() : '';
          if (lowerPhone) {
            if (duplicatePhones.has(lowerPhone)) {
              reasons.push(`Phone number "${row.phone}" already exists in the system.`);
            } else if (seenPhones.has(lowerPhone)) {
              reasons.push(`Duplicate phone number "${row.phone}" in uploaded file.`);
            }
          }

          if (reasons.length > 0) {
            failedRecords.push({
              row_number: row._rowNumber,
              first_name: row.first_name,
              last_name: row.last_name,
              email: row.email,
              phone: row.phone,
              failure_reason: reasons.join(' '),
              user_data: row._flatRow,
            });
            continue;
          }

          try {
            row._resolvedBranchId = resolvedBranchId;
            const newId = await this.insertSingleUser(
              connection,
              schoolId,
              defaultBranchId,
              row
            );
            insertedIds.push(newId);
            if (lowerEmail) seenEmails.add(lowerEmail);
            if (lowerPhone) seenPhones.add(lowerPhone);
          } catch (dbErr) {
            failedRecords.push({
              row_number: row._rowNumber,
              first_name: row.first_name,
              last_name: row.last_name,
              email: row.email,
              phone: row.phone,
              failure_reason: dbErr.sqlMessage || dbErr.message,
              user_data: row._flatRow,
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
      totalUsers: rows.length,
      successfullyUploaded: insertedIds.length,
      remainingFailed: failedRecords.length,
      batchesProcessed,
      userIds: insertedIds,
      failedRecords,
      failedBatchId,
    };
  }
}

module.exports = UserCsvModel;
