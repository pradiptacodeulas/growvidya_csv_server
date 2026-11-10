const multer = require('multer');
const path = require('path');
const ApiResponse = require('../utils/api.response');

const storage = multer.memoryStorage();

const ALLOWED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const ALLOWED_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
  'text/plain',
  'application/octet-stream',
]);

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext) && !ALLOWED_MIMES.has(mime)) {
      return cb(new Error('Only Excel (.xlsx, .xls) or CSV (.csv) files are allowed.'));
    }
    cb(null, true);
  },
});

function uploadExcelMiddleware(req, res, next) {
  upload.any()(req, res, (err) => {
    if (err) {
      return ApiResponse.error(res, err.message, null, 400);
    }
    if (!req.file && Array.isArray(req.files) && req.files.length > 0) {
      req.file = req.files[0];
    }
    return next();
  });
}

module.exports = uploadExcelMiddleware;
