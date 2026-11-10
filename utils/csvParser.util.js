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
  if (s === '1' || s === 'yes' || s === 'true' || s === 'y') return '1';
  if (s === '0' || s === 'no' || s === 'false' || s === 'n') return '0';
  return null;
}

/**
 * Dynamically reads an Excel (.xlsx, .xls) or CSV (.csv) buffer
 * and maps each row using the columns present in the file.
 */
function parseExcelBuffer(buffer) {
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

    const routeVal = raw.route || raw.transport_route || null;
    const transportRequired = toFlag(raw.transport_required) ?? (routeVal ? '1' : '0');

    const hostelNameVal = raw.hostel_name || null;
    const hostelRequired = toFlag(raw.hostel_required) ?? (hostelNameVal ? '1' : '0');

    const samePermanentVal = toFlag(raw.same_permanent);
    const samePermanentFlag = samePermanentVal !== null ? Number(samePermanentVal) : 0;

    const medicalHistory = [];
    if (raw.medical_condition || raw.medical_description || raw.description) {
      medicalHistory.push({
        medical_condition: raw.medical_condition || null,
        description: raw.medical_description || raw.description || null,
        medical_time: raw.medical_time || null,
        is_informed: toFlag(raw.is_informed) === '1' ? 1 : 0,
      });
    }

    mappedRows.push({
      _rowNumber: i + 1,
      _headers: headers,
      _flatRow: raw,
      branch_id: raw.branch_id || raw.branch || null,
      academic_year: raw.academic_year || raw.academic_year_id || null,
      admission_number: raw.admission_number || raw.admission_no || null,
      admission_date: formatDateValue(raw.admission_date),
      roll_number: raw.roll_number || raw.roll_no || null,
      first_name: raw.first_name || null,
      last_name: raw.last_name || null,
      class_id: raw.class_id || raw.class || raw.class_student || null,
      section_id: raw.section_id || raw.section || raw.section_student || null,
      gender: raw.gender || raw.gender_id || null,
      date_of_birth: formatDateValue(raw.date_of_birth || raw.dob),
      password: raw.password || null,
      primary_contact_number: raw.primary_contact_number || raw.phone || raw.contact_number || null,
      email_address: raw.email_address || raw.email || null,
      blood_group: raw.blood_group || raw.blood_group_id || null,
      house: raw.house || raw.house_id || raw.house_name || null,
      religion: raw.religion || raw.religion_id || null,
      category: raw.category || raw.category_id || null,
      caste: raw.caste || null,
      mother_tongue: raw.mother_tongue || raw.mother_tongue_id || null,
      language_known: raw.language_known || null,
      status: raw.status !== undefined && raw.status !== '' ? Number(raw.status) : null,

      father_info: {
        father_first_name: raw.father_first_name || null,
        father_last_name: raw.father_last_name || null,
        father_phone: raw.father_phone || null,
        father_email: raw.father_email || null,
        father_occupation: raw.father_occupation || null,
        father_country: raw.father_country || null,
        father_state: raw.father_state || null,
        father_city: raw.father_city || null,
        father_postal_code: raw.father_postal_code || null,
        father_address_1: raw.father_address_1 || raw.father_address1 || null,
        father_address_2: raw.father_address_2 || raw.father_address2 || null,
      },

      mother_info: {
        mother_first_name: raw.mother_first_name || null,
        mother_last_name: raw.mother_last_name || null,
        mother_phone: raw.mother_phone || null,
        mother_email: raw.mother_email || null,
        mother_occupation: raw.mother_occupation || null,
        mother_country: raw.mother_country || null,
        mother_state: raw.mother_state || null,
        mother_city: raw.mother_city || null,
        mother_postal_code: raw.mother_postal_code || null,
        mother_address_1: raw.mother_address_1 || raw.mother_address1 || null,
        mother_address_2: raw.mother_address_2 || raw.mother_address2 || null,
      },

      guardian_relation: raw.guardian_relation || null,
      other_guardian_info: {
        first_name: raw.other_guardian_first_name || raw.guardian_first_name || null,
        last_name: raw.other_guardian_last_name || raw.guardian_last_name || null,
        phone: raw.other_guardian_phone || raw.guardian_phone || null,
        email: raw.other_guardian_email || raw.guardian_email || null,
        occupation: raw.other_guardian_occupation || raw.guardian_occupation || null,
        relation: raw.other_guardian_relation || raw.guardian_relation_type || null,
      },

      current_address: {
        current_country: raw.current_country || null,
        current_state: raw.current_state || null,
        current_city: raw.current_city || null,
        current_postal_code: raw.current_postal_code || null,
        current_address_1: raw.current_address_1 || raw.current_address1 || null,
        current_address_2: raw.current_address_2 || raw.current_address2 || null,
      },
      same_permanent: samePermanentFlag,
      permanent_address: {
        permanent_country: raw.permanent_country || null,
        permanent_state: raw.permanent_state || null,
        permanent_city: raw.permanent_city || null,
        permanent_postal_code: raw.permanent_postal_code || null,
        permanent_address_1: raw.permanent_address_1 || raw.permanent_address1 || null,
        permanent_address_2: raw.permanent_address_2 || raw.permanent_address2 || null,
      },

      transport_required: transportRequired,
      transport_info: {
        route: routeVal,
        vehicle_number: raw.vehicle_number || null,
        pickup_point: raw.pickup_point || null,
        drop_point: raw.drop_point || null,
      },

      hostel_required: hostelRequired,
      hostel_info: {
        hostel_name: hostelNameVal,
        hostel_room: raw.hostel_room || raw.room_number || null,
      },

      medical_history: medicalHistory,

      previous_school_info: {
        previous_school_name: raw.previous_school_name || raw.school_name || null,
        prev_school_address_1: raw.prev_school_address_1 || raw.prev_school_address1 || null,
        prev_school_address_2: raw.prev_school_address_2 || raw.prev_school_address2 || null,
        prev_school_country: raw.prev_school_country || null,
        prev_school_state: raw.prev_school_state || null,
        prev_school_city: raw.prev_school_city || null,
        prev_school_postal_code: raw.prev_school_postal_code || null,
      },
    });
  }

  return mappedRows;
}

/**
 * Generates an Excel (.xlsx) workbook buffer from the dynamic database column headers.
 */
function generateExcelTemplateBuffer(headers = []) {
  const workbook = xlsx.utils.book_new();
  const worksheet = xlsx.utils.aoa_to_sheet([headers]);
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Students');
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function escapeCsvCell(val) {
  const str = val === undefined || val === null ? '' : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates a CSV buffer dynamically from the failed records' columns + `failure_reason`.
 */
function generateFailedRecordsCsvBuffer(failedRecords = [], dynamicHeaders = []) {
  const baseHeaders =
    dynamicHeaders && dynamicHeaders.length > 0
      ? dynamicHeaders
      : failedRecords.length > 0 && failedRecords[0].student_data
      ? Object.keys(failedRecords[0].student_data)
      : [];

  const headers = [...baseHeaders, 'failure_reason'];
  const lines = [headers.map(escapeCsvCell).join(',')];

  for (const item of failedRecords) {
    const flat = item.student_data || {};
    const rowCells = baseHeaders.map((col) => escapeCsvCell(flat[col] ?? ''));
    rowCells.push(escapeCsvCell(item.failure_reason || ''));
    lines.push(rowCells.join(','));
  }

  return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
}

module.exports = {
  parseExcelBuffer,
  parseCsvBuffer: parseExcelBuffer,
  generateExcelTemplateBuffer,
  generateFailedRecordsCsvBuffer,
};
