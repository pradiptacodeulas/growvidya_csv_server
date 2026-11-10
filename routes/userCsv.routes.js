const express = require('express');
const router = express.Router();
const UserCsvController = require('../controllers/userCsv.controller');
const authMiddleware = require('../middlewares/auth.middleware');
const uploadExcelMiddleware = require('../middlewares/upload.middleware');

// GET /template, /template.xlsx, /template.csv — Download dynamic User Model Excel/CSV upload template
router.get(['/template', '/template.xlsx', '/template.csv'], UserCsvController.downloadUserTemplate);

// GET /failed-download/:batchId — Download CSV containing only failed user records + failure_reason
router.get('/failed-download/:batchId', UserCsvController.downloadFailedUsersCsv);
router.get(['/failed-download', '/failed-download.csv'], authMiddleware, UserCsvController.downloadFailedUsersCsv);

// POST /upload — Step-by-step batch CSV/Excel user upload + immediate summary + failed records CSV link
router.post('/upload', authMiddleware, uploadExcelMiddleware, UserCsvController.uploadUsersCsv);

module.exports = router;
