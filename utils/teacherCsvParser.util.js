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

function formatDateValue(val) {
  const str = formatCellValue(val);
  if (!str) return null;
  const dmy = str.match(/^(\d{1,2})[\-/](\d{1,2})[\-/](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  const ymd = str.match(/^(\d{4})[\-/](\d{1,2})[\-/](\d{1,2})/);
  if (ymd) {
    return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  }
  return str;
}

function toFlag(val) {
  const s = formatCellValue(val).toLowerCase();
  if (s === '1' || s === 'yes' || s === 'true' || s === 'y') return 1;
  if (s === '0' || s === 'no' || s === 'false' || s === 'n') return 0;
  return null;
}

function escapeCsvCell(val) {
  const str = val === undefined || val === null ? '' : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Dynamically reads an Excel (.xlsx, .xls) or CSV (.csv) buffer for Teacher (teacher_master) uploads
 * and maps each row to the exact fields defined in the GrowVidya Teacher Model (TeacherModel).
 */
function parseTeacherCsvBuffer(buffer) {
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
  const mappedRows = [];

  for (let i = 1; i < rawMatrix.length; i++) {
    const rowCells = rawMatrix[i];
    if (!Array.isArray(rowCells) || rowCells.every((c) => formatCellValue(c) === '')) {
      continue;
    }

    const raw = {};
    rawHeaders.forEach((header, idx) => {
      if (header && header !== 'failure_reason') {
        raw[header] = formatCellValue(rowCells[idx]);
      }
    });

    if (Object.values(raw).every((v) => v === '')) {
      continue;
    }

    const samePermanentFlag = toFlag(raw.same_permanent) ?? 1;

    mappedRows.push({
      _rowNumber: i + 1,
      _headers: headers,
      _flatRow: raw,

      // 1. teacher_master fields
      branch_id: raw.branch_id || raw.branch || null,
      academic_year: raw.academic_year || null,
      teacher_id: raw.teacher_id || null,
      first_name: raw.first_name || null,
      last_name: raw.last_name || null,
      class: raw.class || raw.class_id || null,
      section: raw.section || raw.section_id || null,
      subject: raw.subject || raw.subject_id || null,
      gender: raw.gender || null,
      primary_contact_number: raw.primary_contact_number || raw.phone || null,
      email_address: raw.email_address || raw.email || null,
      blood_group: raw.blood_group || null,
      date_of_joining: formatDateValue(raw.date_of_joining),
      father_name: raw.father_name || null,
      mother_name: raw.mother_name || null,
      date_of_birth: formatDateValue(raw.date_of_birth),
      marital_status: raw.marital_status || null,
      language_known: raw.language_known || null,
      qualification: raw.qualification || null,
      work_experience: raw.work_experience || null,
      previous_school_name: raw.previous_school_name || null,
      previous_school_address: raw.previous_school_address || null,
      previous_school_phone: raw.previous_school_phone || null,
      pan_number: raw.pan_number || null,
      notes: raw.notes || null,
      take_attendance:
        raw.take_attendance !== undefined && raw.take_attendance !== ''
          ? Number(raw.take_attendance)
          : 2,
      password: raw.password || null,
      status: raw.status !== undefined && raw.status !== '' ? Number(raw.status) : 1,

      // 2. teacher_address fields
      current_address: {
        address1: raw.current_address1 || raw.current_address_1 || raw.address1 || null,
        address2: raw.current_address2 || raw.current_address_2 || raw.address2 || null,
        country: raw.current_country || raw.country || null,
        state: raw.current_state || raw.state || null,
        city: raw.current_city || raw.city || null,
        postal_code: raw.current_postal_code || raw.postal_code || null,
      },
      same_permanent: samePermanentFlag,
      permanent_address: {
        address1: raw.permanent_address1 || raw.permanent_address_1 || null,
        address2: raw.permanent_address2 || raw.permanent_address_2 || null,
        country: raw.permanent_country || null,
        state: raw.permanent_state || null,
        city: raw.permanent_city || null,
        postal_code: raw.permanent_postal_code || null,
      },

      // 3. teacher_payroll fields
      payroll: {
        epf_no: raw.epf_no || null,
        basic_salary:
          raw.basic_salary !== undefined && raw.basic_salary !== ''
            ? Number(raw.basic_salary)
            : null,
        contract_type: raw.contract_type || null,
        work_shift: raw.work_shift || null,
        work_location: raw.work_location || null,
        date_of_leaving: formatDateValue(raw.date_of_leaving),
      },

      // 4. teacher_bank fields
      bank: {
        account_name: raw.account_name || null,
        account_number: raw.account_number || null,
        bank_name: raw.bank_name || null,
        ifsc_code: raw.ifsc_code || null,
        branch_name: raw.branch_name || null,
      },

      // 5. teacher_transport fields
      transport: {
        route: raw.route || null,
        vehicle_number: raw.vehicle_number || null,
        pickup_point: raw.pickup_point || null,
        drop_point: raw.drop_point || null,
      },

      // 6. teacher_hostel fields
      hostel: {
        hostel_name: raw.hostel_name || null,
        room_number: raw.room_number || null,
      },

      // 7. teacher_social_link fields
      social: {
        facebook_link: raw.facebook_link || null,
        instagram_link: raw.instagram_link || null,
        linkedin_link: raw.linkedin_link || null,
        youtube_link: raw.youtube_link || null,
        twitter_link: raw.twitter_link || null,
      },
    });
  }

  return mappedRows;
}

/**
 * Generates an Excel (.xlsx) workbook buffer from the dynamic Teacher Model database column headers.
 */
function generateTeacherExcelTemplateBuffer(headers = []) {
  const workbook = xlsx.utils.book_new();
  const worksheet = xlsx.utils.aoa_to_sheet([headers]);
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Teachers');
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Generates a CSV template buffer from the dynamic Teacher Model database column headers.
 */
function generateTeacherCsvTemplateBuffer(headers = []) {
  const line = headers.map(escapeCsvCell).join(',');
  return Buffer.from(line + '\r\n', 'utf8');
}

/**
 * Generates a CSV buffer dynamically from the failed teacher records' columns + `failure_reason`.
 */
function generateFailedTeachersCsvBuffer(failedRecords = [], dynamicHeaders = []) {
  const baseHeaders =
    dynamicHeaders && dynamicHeaders.length > 0
      ? dynamicHeaders
      : failedRecords.length > 0 && failedRecords[0].teacher_data
      ? Object.keys(failedRecords[0].teacher_data)
      : [];

  const headers = [...baseHeaders, 'failure_reason'];
  const lines = [headers.map(escapeCsvCell).join(',')];

  for (const item of failedRecords) {
    const flat = item.teacher_data || {};
    const rowCells = baseHeaders.map((col) => escapeCsvCell(flat[col] ?? ''));
    rowCells.push(escapeCsvCell(item.failure_reason || ''));
    lines.push(rowCells.join(','));
  }

  return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
}

module.exports = {
  parseTeacherCsvBuffer,
  generateTeacherExcelTemplateBuffer,
  generateTeacherCsvTemplateBuffer,
  generateFailedTeachersCsvBuffer,
};
