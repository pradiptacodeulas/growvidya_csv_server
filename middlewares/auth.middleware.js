const jwt = require('jsonwebtoken');
const ApiResponse = require('../utils/api.response');
const { pool } = require('../config/db.config');

/**
 * Option 1: Shared Secret JWT Authentication Middleware
 * Validates JWT token issued by growvidya_server via Bearer header, token header, query param, or session cookies.
 */
async function authMiddleware(req, res, next) {
  try {
    let token = null;

    // 1. Check Authorization header
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (authHeader && typeof authHeader === 'string') {
      const trimmed = authHeader.trim();
      if (/^bearer\s+/i.test(trimmed)) {
        token = trimmed.replace(/^bearer\s+/i, '').trim();
      } else {
        token = trimmed;
      }
    }
    // 2. Check custom token headers or query parameter
    else if (req.headers['x-access-token'] || req.headers.token) {
      token = String(req.headers['x-access-token'] || req.headers.token).trim();
    } else if (req.query?.token) {
      token = String(req.query.token).trim();
    }
    // 3. Check cookies from GrowVidya client
    else if (req.cookies || req.signedCookies) {
      const getCookie = (name) => (name ? req.cookies?.[name] || req.signedCookies?.[name] : null);
      token =
        getCookie(process.env.COOKIE_NAME) ||
        getCookie('growvidya_admin_session') ||
        getCookie('token') ||
        getCookie('session_token') ||
        null;
    }

    if (!token) {
      return ApiResponse.error(
        res,
        'Access denied. Authentication required. Please provide a valid Bearer token or session.',
        null,
        401
      );
    }

    let decoded = null;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (_) {
      decoded = null;
    }

    if (!decoded) {
      return ApiResponse.error(res, 'Invalid or expired authentication token.', null, 401);
    }

    req.user = decoded;

    if (req.user.schoolId && !req.user.school_id) {
      req.user.school_id = req.user.schoolId;
    } else if (req.user.school_id && !req.user.schoolId) {
      req.user.schoolId = req.user.school_id;
    }

    if (req.user.userId && !req.user.id) {
      req.user.id = req.user.userId;
    } else if (req.user.id && !req.user.userId) {
      req.user.userId = req.user.id;
    }

    if (!req.user.schoolId) {
      return ApiResponse.error(res, 'School context required in authentication token.', null, 401);
    }

    // Verify school is active in database
    const [schoolRows] = await pool.query(
      'SELECT status FROM school_master WHERE id = ? LIMIT 1',
      [req.user.schoolId]
    );
    if (schoolRows.length > 0 && Number(schoolRows[0].status) !== 1) {
      return ApiResponse.error(
        res,
        'Your school account is inactive. Access is disabled until reactivated.',
        null,
        403
      );
    }

    return next();
  } catch (error) {
    return ApiResponse.error(res, 'Authentication failed.', null, 401);
  }
}

module.exports = authMiddleware;
