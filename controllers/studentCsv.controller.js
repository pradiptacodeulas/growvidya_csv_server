const StudentCsvModel = require('../models/studentCsv.model');
const ApiResponse = require('../utils/api.response');
const { extractSchoolIdFromRequest } = require('../utils/branchScope.util');
const {
  parseExcelBuffer,
  generateExcelTemplateBuffer,
  generateFailedRecordsCsvBuffer,
} = require('../utils/csvParser.util');

class StudentCsvController {
  /**
   * GET /api/v1/admin/students/excel/template.xlsx
   * Dynamically fetches student insertion column headers from the database schema
   * and downloads a valid Excel (.xlsx) template.
   */
  static async downloadExcelTemplate(req, res, next) {
    try {
      const dynamicHeaders = await StudentCsvModel.getDynamicTemplateHeaders(req);
      const buffer = Buffer.from(generateExcelTemplateBuffer(dynamicHeaders));
      const fileName = 'student_bulk_upload_template.xlsx';

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=${fileName}; filename*=UTF-8''${fileName}`
      );
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

      return res.status(200).end(buffer);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/admin/students/csv/upload (and /api/v1/admin/students/excel/upload)
   * 1. Validates total student count against the purchased package limit in one step before inserting any records.
   * 2. Processes student records, inserts valid records, and collects failed records with failure reasons.
   * 3. Immediately returns the upload summary (Total Students, Successfully Uploaded, Remaining / Failed)
   *    and a download link for the failed records CSV file.
   */
  static async uploadStudentsExcel(req, res, next) {
    try {
      const schoolId = req.user?.schoolId || req.user?.school_id;
      const branchId =
        req.body?.branch_id ||
        req.body?.branchId ||
        req.query?.branch_id ||
        req.user?.branch_id ||
        req.user?.branchId ||
        null;

      if (!req.file || !req.file.buffer) {
        return ApiResponse.error(res, 'Please upload a valid CSV or Excel (.xlsx, .xls) file.', null, 400);
      }

      // 1. Parse the entire CSV/Excel sheet in memory first
      const rows = parseExcelBuffer(req.file.buffer);
      const uploadedCount = rows.length;

      if (uploadedCount === 0) {
        return ApiResponse.error(
          res,
          'The uploaded file is empty or contains no student records.',
          null,
          400
        );
      }

      // 2. One-step backend validation of student count against the purchased package limit
      // Happens before processing or inserting any student record
      const limitCheck = await StudentCsvModel.validatePackageStudentLimit(schoolId, uploadedCount);
      if (!limitCheck.allowed) {
        return ApiResponse.error(
          res,
          limitCheck.message,
          {
            code: limitCheck.code,
            plan_name: limitCheck.planName,
            max_limit: limitCheck.maxLimit,
            current_students: limitCheck.currentCount,
            attempted_upload: limitCheck.uploadedCount,
            remaining_limit: limitCheck.remainingLimit,
          },
          limitCheck.statusCode
        );
      }

      // 3. Process and insert valid records, while collecting failed records and their failure reasons
      const result = await StudentCsvModel.processAndInsertStudents(schoolId, branchId, rows);

      const summary = {
        total_students: result.totalStudents,
        successfully_uploaded: result.successfullyUploaded,
        remaining_failed: result.remainingFailed,
      };

      const failedDownloadUrl = result.failedBatchId
        ? `/api/v1/admin/students/csv/failed-download/${result.failedBatchId}.csv`
        : null;

      const summaryMessage =
        `Total Students: ${result.totalStudents} | ` +
        `Successfully Uploaded: ${result.successfullyUploaded} | ` +
        `Remaining / Failed: ${result.remainingFailed}`;

      return ApiResponse.success(
        res,
        summaryMessage,
        {
          summary,
          total_students: result.totalStudents,
          successfully_uploaded: result.successfullyUploaded,
          remaining_failed: result.remainingFailed,
          failed_batch_id: result.failedBatchId,
          failed_csv_download_url: failedDownloadUrl,
          failed_records: result.failedRecords.map((item) => ({
            row_number: item.row_number,
            admission_number: item.admission_number,
            first_name: item.first_name,
            last_name: item.last_name,
            email_address: item.email_address,
            failure_reason: item.failure_reason,
          })),
        },
        result.successfullyUploaded > 0 ? 201 : 200
      );
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/admin/students/csv/failed-download/:batchId
   * Downloads a separate CSV file containing only the student records that failed to upload,
   * including the `failure_reason` column so the user can fix the errors and upload again.
   */
  static async downloadFailedStudentsCsv(req, res, next) {
    try {
      const rawBatchId = req.params.batchId || req.query.batchId || null;
      const cleanBatchId = rawBatchId ? String(rawBatchId).replace(/\.csv$/i, '').trim() : null;
      const schoolId = extractSchoolIdFromRequest(req);

      const batch = StudentCsvModel.getFailedBatch(cleanBatchId, schoolId);
      if (!batch || !Array.isArray(batch.failedRecords) || batch.failedRecords.length === 0) {
        return ApiResponse.notFound(res, 'No failed student records found to download.');
      }

      const dynamicHeaders = await StudentCsvModel.getDynamicTemplateHeaders(batch.schoolId || req);
      const csvBuffer = generateFailedRecordsCsvBuffer(batch.failedRecords, dynamicHeaders);
      const fileName = 'failed_students_records.csv';

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=${fileName}; filename*=UTF-8''${fileName}`
      );
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Content-Length', String(csvBuffer.length));
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

      return res.status(200).end(csvBuffer);
    } catch (error) {
      next(error);
    }
  }
}

StudentCsvController.uploadStudentsCsv = StudentCsvController.uploadStudentsExcel;

module.exports = StudentCsvController;
