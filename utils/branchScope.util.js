const jwt = require('jsonwebtoken');
const { pool } = require('../config/db.config');

/**
 * Extracts schoolId from an Express request if available (via req.user, query, headers, body, or JWT token/cookies).
 */
function extractSchoolIdFromRequest(req) {
  if (!req || typeof req !== 'object') return null;

  const directUserSchoolId = req.user?.schoolId || req.user?.school_id;
  if (directUserSchoolId && !isNaN(Number(directUserSchoolId)) && Number(directUserSchoolId) > 0) {
    return Number(directUserSchoolId);
  }

  const paramSchoolId =
    req.query?.school_id ||
    req.query?.schoolId ||
    req.headers?.['x-school-id'] ||
    req.body?.school_id ||
    req.body?.schoolId;
  if (paramSchoolId && !isNaN(Number(paramSchoolId)) && Number(paramSchoolId) > 0) {
    return Number(paramSchoolId);
  }

  let token = null;
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (authHeader && typeof authHeader === 'string') {
    const trimmed = authHeader.trim();
    token = /^bearer\s+/i.test(trimmed) ? trimmed.replace(/^bearer\s+/i, '').trim() : trimmed;
  } else if (req.headers?.['x-access-token'] || req.headers?.token) {
    token = String(req.headers['x-access-token'] || req.headers.token).trim();
  } else if (req.query?.token) {
    token = String(req.query.token).trim();
  } else if (req.cookies || req.signedCookies) {
    const getCookie = (name) => (name ? req.cookies?.[name] || req.signedCookies?.[name] : null);
    token =
      getCookie(process.env.COOKIE_NAME) ||
      getCookie('growvidya_admin_session') ||
      getCookie('growvidya_session') ||
      getCookie('token') ||
      getCookie('session_token') ||
      null;
  }

  if (token) {
    let decoded = null;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_) {
      try {
        decoded = jwt.decode(token);
      } catch (__) {
        decoded = null;
      }
    }
    const tokenSchoolId = decoded?.schoolId || decoded?.school_id;
    if (tokenSchoolId && !isNaN(Number(tokenSchoolId)) && Number(tokenSchoolId) > 0) {
      return Number(tokenSchoolId);
    }
  }

  return null;
}

/**
 * Resolves a target school_id from a numeric value, an Express request, or falls back to the primary active school.
 */
async function resolveSchoolId(schoolIdOrReq = null, connection = pool) {
  if (
    typeof schoolIdOrReq === 'number' ||
    (typeof schoolIdOrReq === 'string' && /^\d+$/.test(schoolIdOrReq.trim()))
  ) {
    const parsed = Number(schoolIdOrReq);
    if (parsed > 0) return parsed;
  }

  if (schoolIdOrReq && typeof schoolIdOrReq === 'object') {
    const extracted = extractSchoolIdFromRequest(schoolIdOrReq);
    if (extracted) return extracted;
  }

  const [rows] = await connection.query(
    'SELECT id FROM school_master WHERE status != 4 ORDER BY CASE WHEN status = 1 THEN 0 ELSE 1 END, id ASC LIMIT 1'
  );
  return rows.length > 0 ? Number(rows[0].id) : null;
}

/**
 * Checks whether the organization has multiple branches.
 * Returns false if the organization has a single branch, or true if it has multiple branches.
 */
async function organizationHasMultipleBranches(schoolIdOrReq = null, connection = pool) {
  const schoolId = await resolveSchoolId(schoolIdOrReq, connection);

  if (schoolId) {
    const [schoolRows] = await connection.query(
      'SELECT registration_type FROM school_master WHERE id = ? AND status != 4 LIMIT 1',
      [schoolId]
    );
    const [branchRows] = await connection.query(
      'SELECT COUNT(id) AS branch_count FROM branch_master WHERE school_id = ? AND status != 4',
      [schoolId]
    );

    const registrationType = String(schoolRows[0]?.registration_type || 'single')
      .trim()
      .toLowerCase();
    const branchCount = Number(branchRows[0]?.branch_count || 0);

    return registrationType === 'multiple' || branchCount > 1;
  }

  const [branchRows] = await connection.query(
    'SELECT COUNT(id) AS branch_count FROM branch_master WHERE status != 4'
  );
  return Number(branchRows[0]?.branch_count || 0) > 1;
}

module.exports = {
  extractSchoolIdFromRequest,
  resolveSchoolId,
  organizationHasMultipleBranches,
};
