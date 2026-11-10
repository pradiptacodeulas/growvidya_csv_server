const express = require('express');
const router = express.Router();
const TeacherCsvController = require('../controllers/teacherCsv.controller');
const authMiddleware = require('../middlewares/auth.middleware');
const uploadExcelMiddleware = require('../middlewares/upload.middleware');

// GET /template, /template.xlsx, /template.csv — Download dynamic Teacher Model Excel/CSV upload template
router.get(['/template', '/template.xlsx', '/template.csv'], TeacherCsvController.downloadTeacherTemplate);

// GET /failed-download/:batchId — Download CSV containing only failed teacher records + failure_reason
router.get('/failed-download/:batchId', TeacherCsvController.downloadFailedTeachersCsv);
router.get(['/failed-download', '/failed-download.csv'], authMiddleware, TeacherCsvController.downloadFailedTeachersCsv);

// POST /upload — Step-by-step batch CSV/Excel teacher upload + immediate summary + failed records CSV link
router.post('/upload', authMiddleware, uploadExcelMiddleware, TeacherCsvController.uploadTeachersCsv);

module.exports = router;
