const TeacherCsvModel = require('../models/teacherCsv.model');
const ApiResponse = require('../utils/api.response');
const { extractSchoolIdFromRequest } = require('../utils/branchScope.util');
const {
  parseTeacherCsvBuffer,
  generateTeacherExcelTemplateBuffer,
  generateTeacherCsvTemplateBuffer,
  generateFailedTeachersCsvBuffer,
} = require('../utils/teacherCsvParser.util');

class TeacherCsvController {
  /**
   * GET /api/v1/admin/teachers/csv/template
   * GET /api/v1/admin/teachers/csv/template.xlsx
   * GET /api/v1/admin/teachers/csv/template.csv
   * Dynamically fetches Teacher Model column headers from the database schema
   * and downloads a valid Excel (.xlsx) or CSV (.csv) template.
   */
  static async downloadTeacherTemplate(req, res, next) {
    try {
      const dynamicHeaders = await TeacherCsvModel.getDynamicHeaders(req);
      const isCsv =
        req.path.toLowerCase().endsWith('.csv') ||
        String(req.query.format || '').toLowerCase() === 'csv';

      if (isCsv) {
        const csvBuffer = generateTeacherCsvTemplateBuffer(dynamicHeaders);
        const fileName = 'teacher_bulk_upload_template.csv';

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename=${fileName}; filename*=UTF-8''${fileName}`
        );
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        res.setHeader('Content-Length', String(csvBuffer.length));
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

        return res.status(200).end(csvBuffer);
      }

      const buffer = Buffer.from(generateTeacherExcelTemplateBuffer(dynamicHeaders));
      const fileName = 'teacher_bulk_upload_template.xlsx';

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
   * POST /api/v1/admin/teachers/csv/upload
   * Separate API for step-by-step batch CSV/Excel teacher uploads.
   * 1. Validates package limit before processing.
   * 2. Processes and stores teacher records in small sequential batches.
   * 3. Immediately returns upload summary (Total Teachers, Successfully Uploaded, Remaining / Failed)
   *    and a download URL for failed records CSV.
   */
  static async uploadTeachersCsv(req, res, next) {
    try {
      const schoolId = extractSchoolIdFromRequest(req) || req.user?.schoolId || req.user?.school_id;
      const branchId =
        req.body?.branch_id ||
        req.body?.branchId ||
        req.query?.branch_id ||
        req.user?.branch_id ||
        req.user?.branchId ||
        null;
      const batchSize = req.body?.batch_size || req.query?.batch_size || null;

      if (!req.file || !req.file.buffer) {
        return ApiResponse.error(
          res,
          'Please upload a valid CSV or Excel (.xlsx, .xls) file.',
          null,
          400
        );
      }

      // 1. Parse uploaded CSV/Excel file using Teacher Model field mappings
      const rows = parseTeacherCsvBuffer(req.file.buffer);
      const totalTeachers = rows.length;

      if (totalTeachers === 0) {
        return ApiResponse.error(
          res,
          'The uploaded CSV/Excel file is empty or contains no teacher records.',
          null,
          400
        );
      }

      // 2. Validate package limit before inserting any records
      const limitCheck = await TeacherCsvModel.validatePackageLimit(schoolId, totalTeachers);
      if (!limitCheck.allowed) {
        return ApiResponse.error(
          res,
          limitCheck.message,
          {
            code: limitCheck.code,
            plan_name: limitCheck.planName,
            max_limit: limitCheck.maxLimit,
            current_teachers: limitCheck.currentCount,
            attempted_upload: limitCheck.uploadedCount,
            remaining_limit: limitCheck.remainingLimit,
          },
          limitCheck.statusCode
        );
      }

      // 3. Process and store teacher records step by step in batches
      const result = await TeacherCsvModel.processTeachersInBatches(
        schoolId,
        branchId,
        rows,
        batchSize
      );

      const summary = {
        total_teachers: result.totalTeachers,
        successfully_uploaded: result.successfullyUploaded,
        remaining_failed: result.remainingFailed,
        batches_processed: result.batchesProcessed,
      };

      const failedDownloadUrl = result.failedBatchId
        ? `/api/v1/admin/teachers/csv/failed-download/${result.failedBatchId}.csv`
        : null;

      const summaryMessage =
        `Total Teachers: ${result.totalTeachers} | ` +
        `Successfully Uploaded: ${result.successfullyUploaded} | ` +
        `Remaining / Failed: ${result.remainingFailed}`;

      return ApiResponse.success(
        res,
        summaryMessage,
        {
          summary,
          total_teachers: result.totalTeachers,
          successfully_uploaded: result.successfullyUploaded,
          remaining_failed: result.remainingFailed,
          batches_processed: result.batchesProcessed,
          failed_batch_id: result.failedBatchId,
          failed_csv_download_url: failedDownloadUrl,
          failed_records: result.failedRecords.map((item) => ({
            row_number: item.row_number,
            teacher_id: item.teacher_id,
            first_name: item.first_name,
            last_name: item.last_name,
            email_address: item.email_address,
            primary_contact_number: item.primary_contact_number,
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
   * GET /api/v1/admin/teachers/csv/failed-download/:batchId
   * Downloads a separate CSV file containing only the teacher records that failed to upload,
   * including the `failure_reason` column so the user can correct and re-upload them.
   */
  static async downloadFailedTeachersCsv(req, res, next) {
    try {
      const rawBatchId = req.params.batchId || req.query.batchId || null;
      const cleanBatchId = rawBatchId ? String(rawBatchId).replace(/\.csv$/i, '').trim() : null;
      const schoolId = extractSchoolIdFromRequest(req);

      const batch = TeacherCsvModel.getFailedBatch(cleanBatchId, schoolId);
      if (!batch || !Array.isArray(batch.failedRecords) || batch.failedRecords.length === 0) {
        return ApiResponse.notFound(res, 'No failed teacher records found to download.');
      }

      const dynamicHeaders = await TeacherCsvModel.getDynamicHeaders(batch.schoolId || req);
      const csvBuffer = generateFailedTeachersCsvBuffer(batch.failedRecords, dynamicHeaders);
      const fileName = 'failed_teachers_records.csv';

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

module.exports = TeacherCsvController;
