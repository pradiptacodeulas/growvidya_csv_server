const xlsx = require('xlsx');

function normalizeHeader(header) {
  return String(header || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function formatCellValue(val) {
  if (val === undefined || val === null) return '';
  if (val instanceof Date && !isNaN(val.getTime())) {
    const year = val.getFullYear();
    const month = String(val.getMonth() + 1).padStart(2, '0');
    const day = String(val.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(val).trim();
}

function escapeCsvCell(val) {
  const str = val === undefined || val === null ? '' : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Dynamically reads an Excel (.xlsx, .xls) or CSV (.csv) buffer for User (user_master) uploads
 * and maps each row to the exact fields defined in the GrowVidya User Model (StaffModel).
 */
function parseUserCsvBuffer(buffer) {
  if (!buffer) return [];

  const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  const rawMatrix = xlsx.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: false,
  });

  if (!rawMatrix || rawMatrix.length < 2) {
    return [];
  }

  const headers = rawMatrix[0]
    .map(normalizeHeader)
    .filter((h) => h && h !== 'failure_reason');

  const rawHeaders = rawMatrix[0].map(normalizeHeader);
  const firstNameIdx = rawHeaders.indexOf('first_name');
  const ifscIdx = rawHeaders.indexOf('ifsc_code');
  const mappedRows = [];

  for (let i = 1; i < rawMatrix.length; i++) {
    const rowCells = rawMatrix[i];
    if (!Array.isArray(rowCells) || rowCells.every((c) => formatCellValue(c) === '')) {
      continue;
    }

    const raw = {};
    let schoolBranchFromHeader = '';
    let bankBranchFromHeader = '';

    rawHeaders.forEach((header, idx) => {
      if (header && header !== 'failure_reason') {
        const val = formatCellValue(rowCells[idx]);
        if (header === 'branch_name') {
          if (
            (firstNameIdx !== -1 && idx < firstNameIdx) ||
            (ifscIdx !== -1 && idx < ifscIdx) ||
            (ifscIdx === -1 && idx === 0)
          ) {
            schoolBranchFromHeader = val;
          } else {
            bankBranchFromHeader = val;
          }
        }
        raw[header] = val;
      }
    });

    if (Object.values(raw).every((v) => v === '')) {
      continue;
    }

    mappedRows.push({
      _rowNumber: i + 1,
      _headers: headers,
      _flatRow: {
        ...raw,
        _school_branch_name: schoolBranchFromHeader || raw.branch_id || raw.branch || '',
        _bank_branch_name: bankBranchFromHeader || '',
      },

      // 1. user_master fields
      branch_id: raw.branch_id || raw.branch || schoolBranchFromHeader || null,
      first_name: raw.first_name || null,
      last_name: raw.last_name || null,
      email: raw.email || raw.email_address || null,
      phone: raw.phone || raw.phone_number || raw.primary_contact_number || raw.mobile || null,
      password: raw.password || null,
      gender: raw.gender || null,
      blood_group: raw.blood_group || null,
      country: raw.country || raw.country_id || null,
      state: raw.state || raw.state_id || null,
      city: raw.city || null,
      role: raw.role || null,
      admin_type:
        raw.admin_type !== undefined && raw.admin_type !== '' && !isNaN(Number(raw.admin_type))
          ? Number(raw.admin_type)
          : null,
      status: 1,

      // 2. user_bank & beneficiary_master fields
      account_name: raw.account_name || null,
      account_number: raw.account_number || null,
      bank_name: raw.bank_name || null,
      ifsc_code: raw.ifsc_code || null,
      branch_name: bankBranchFromHeader || (schoolBranchFromHeader ? null : raw.branch_name) || null,
      basic_salary:
        raw.basic_salary !== undefined &&
        raw.basic_salary !== '' &&
        !isNaN(Number(String(raw.basic_salary).replace(/,/g, '')))
          ? Number(String(raw.basic_salary).replace(/,/g, ''))
          : null,

      // 3. user_transport fields
      route: raw.route || null,
      vehicle_number: raw.vehicle_number || null,
      pickup_point: raw.pickup_point || null,
      drop_point: raw.drop_point || null,

      // 4. user_hostel fields
      hostel_name: raw.hostel_name || null,
      room_number: raw.room_number || null,
    });
  }

  return mappedRows;
}

/**
 * Generates an Excel (.xlsx) workbook buffer from the dynamic User Model database column headers.
 */
function generateUserExcelTemplateBuffer(headers = []) {
  const workbook = xlsx.utils.book_new();
  const worksheet = xlsx.utils.aoa_to_sheet([headers]);
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Users');
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Generates a CSV template buffer from the dynamic User Model database column headers.
 */
function generateUserCsvTemplateBuffer(headers = []) {
  const line = headers.map(escapeCsvCell).join(',');
  return Buffer.from(line + '\r\n', 'utf8');
}

/**
 * Generates a CSV buffer dynamically from the failed user records' columns + `failure_reason`.
 */
function generateFailedUsersCsvBuffer(failedRecords = [], dynamicHeaders = []) {
  const baseHeaders =
    dynamicHeaders && dynamicHeaders.length > 0
      ? dynamicHeaders
      : failedRecords.length > 0 && failedRecords[0].user_data
      ? Object.keys(failedRecords[0].user_data)
      : [];

  const headers = [...baseHeaders, 'failure_reason'];
  const lines = [headers.map(escapeCsvCell).join(',')];

  const firstNameIdx = baseHeaders.indexOf('first_name');

  for (const item of failedRecords) {
    const flat = item.user_data || {};
    const rowCells = baseHeaders.map((col, idx) => {
      if (col === 'branch_name') {
        const isSchoolBranchCol =
          (firstNameIdx !== -1 && idx < firstNameIdx) || (firstNameIdx === -1 && idx === 0);
        if (isSchoolBranchCol) {
          return escapeCsvCell(flat._school_branch_name ?? flat.branch_id ?? flat.branch ?? '');
        }
        return escapeCsvCell(flat._bank_branch_name ?? flat.branch_name ?? '');
      }
      return escapeCsvCell(flat[col] ?? '');
    });
    rowCells.push(escapeCsvCell(item.failure_reason || ''));
    lines.push(rowCells.join(','));
  }

  return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
}

module.exports = {
  parseUserCsvBuffer,
  generateUserExcelTemplateBuffer,
  generateUserCsvTemplateBuffer,
  generateFailedUsersCsvBuffer,
};
