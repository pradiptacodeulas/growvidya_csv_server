const UserCsvModel = require('../models/userCsv.model');
const ApiResponse = require('../utils/api.response');
const { extractSchoolIdFromRequest } = require('../utils/branchScope.util');
const {
  parseUserCsvBuffer,
  generateUserExcelTemplateBuffer,
  generateUserCsvTemplateBuffer,
  generateFailedUsersCsvBuffer,
} = require('../utils/userCsvParser.util');

class UserCsvController {
  /**
   * GET /api/v1/admin/users/csv/template
   * GET /api/v1/admin/users/csv/template.xlsx
   * GET /api/v1/admin/users/csv/template.csv
   * Dynamically fetches User Model column headers from the database schema
   * and downloads a valid Excel (.xlsx) or CSV (.csv) template.
   */
  static async downloadUserTemplate(req, res, next) {
    try {
      const dynamicHeaders = await UserCsvModel.getDynamicHeaders(req);
      const isCsv =
        req.path.toLowerCase().endsWith('.csv') ||
        String(req.query.format || '').toLowerCase() === 'csv';

      if (isCsv) {
        const csvBuffer = generateUserCsvTemplateBuffer(dynamicHeaders);
        const fileName = 'user_bulk_upload_template.csv';

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

      const buffer = Buffer.from(generateUserExcelTemplateBuffer(dynamicHeaders));
      const fileName = 'user_bulk_upload_template.xlsx';

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
   * POST /api/v1/admin/users/csv/upload
   * Separate API for step-by-step batch CSV/Excel user uploads.
   * 1. Validates package limit before processing.
   * 2. Processes and stores user records in small sequential batches.
   * 3. Immediately returns upload summary (Total Users, Successfully Uploaded, Remaining / Failed)
   *    and a download URL for failed records CSV.
   */
  static async uploadUsersCsv(req, res, next) {
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
        return ApiResponse.error(res, 'Please upload a valid CSV or Excel (.xlsx, .xls) file.', null, 400);
      }

      // 1. Parse uploaded CSV/Excel file using User Model field mappings
      const rows = parseUserCsvBuffer(req.file.buffer);
      const totalUsers = rows.length;

      if (totalUsers === 0) {
        return ApiResponse.error(
          res,
          'The uploaded CSV/Excel file is empty or contains no user records.',
          null,
          400
        );
      }

      // 2. Validate package limit before inserting any records
      const limitCheck = await UserCsvModel.validatePackageLimit(schoolId, totalUsers);
      if (!limitCheck.allowed) {
        return ApiResponse.error(
          res,
          limitCheck.message,
          {
            code: limitCheck.code,
            plan_name: limitCheck.planName,
            max_limit: limitCheck.maxLimit,
            current_users: limitCheck.currentCount,
            attempted_upload: limitCheck.uploadedCount,
            remaining_limit: limitCheck.remainingLimit,
          },
          limitCheck.statusCode
        );
      }

      // 3. Process and store user records step by step in batches
      const result = await UserCsvModel.processUsersInBatches(
        schoolId,
        branchId,
        rows,
        batchSize
      );

      const failedRecords = result.failedRecords.map((item) => ({
        row_number: item.row_number,
        first_name: item.first_name,
        last_name: item.last_name,
        email: item.email,
        phone: item.phone,
        failure_reason: item.failure_reason,
      }));

      const summary = {
        total_users: result.totalUsers,
        successfully_uploaded: result.successfullyUploaded,
        remaining_failed: result.remainingFailed,
        batches_processed: result.batchesProcessed,
      };

      const failedDownloadUrl = result.failedBatchId
        ? `/api/v1/admin/users/csv/failed-download/${result.failedBatchId}.csv`
        : null;

      const summaryMessage =
        `Total Users: ${result.totalUsers} | ` +
        `Successfully Uploaded: ${result.successfullyUploaded} | ` +
        `Remaining / Failed: ${result.remainingFailed}`;

      const responseData = {
        summary,
        total_users: result.totalUsers,
        successfully_uploaded: result.successfullyUploaded,
        remaining_failed: result.remainingFailed,
        batches_processed: result.batchesProcessed,
        failed_batch_id: result.failedBatchId,
        failed_csv_download_url: failedDownloadUrl,
        failed_records: failedRecords,
      };

      if (result.successfullyUploaded === 0) {
        return res.status(400).json({
          success: false,
          message: summaryMessage,
          data: responseData,
          errors: failedRecords,
        });
      }

      return ApiResponse.success(res, summaryMessage, responseData, 201);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/admin/users/csv/failed-download/:batchId
   * Downloads a separate CSV file containing only the user records that failed to upload,
   * including the `failure_reason` column so the user can correct and re-upload them.
   */
  static async downloadFailedUsersCsv(req, res, next) {
    try {
      const rawBatchId = req.params.batchId || req.query.batchId || null;
      const cleanBatchId = rawBatchId ? String(rawBatchId).replace(/\.csv$/i, '').trim() : null;
      const schoolId = extractSchoolIdFromRequest(req);

      const batch = UserCsvModel.getFailedBatch(cleanBatchId, schoolId);
      if (!batch || !Array.isArray(batch.failedRecords) || batch.failedRecords.length === 0) {
        return ApiResponse.notFound(res, 'No failed user records found to download.');
      }

      const dynamicHeaders = await UserCsvModel.getDynamicHeaders(batch.schoolId || req);
      const csvBuffer = generateFailedUsersCsvBuffer(batch.failedRecords, dynamicHeaders);
      const fileName = 'failed_users_records.csv';

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

module.exports = UserCsvController;
