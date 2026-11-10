const express = require('express');
const router = express.Router();
const StudentCsvController = require('../controllers/studentCsv.controller');
const authMiddleware = require('../middlewares/auth.middleware');
const uploadExcelMiddleware = require('../middlewares/upload.middleware');

// GET /template or /template.xlsx — Download .xlsx Excel template with all student insertion column headers
router.get(['/template', '/template.xlsx'], StudentCsvController.downloadExcelTemplate);

// GET /failed-download/:batchId — Download CSV containing only failed student records + failure_reason
router.get('/failed-download/:batchId', StudentCsvController.downloadFailedStudentsCsv);
router.get(['/failed-download', '/failed-download.csv'], authMiddleware, StudentCsvController.downloadFailedStudentsCsv);

// POST /upload — Validate package limit in 1 step, process upload, and return summary + failed CSV link
router.post('/upload', authMiddleware, uploadExcelMiddleware, StudentCsvController.uploadStudentsExcel);

module.exports = router;
