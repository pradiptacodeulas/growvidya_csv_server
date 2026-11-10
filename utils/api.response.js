class ApiResponse {
  static success(res, message = 'Success', data = null, statusCode = 200) {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
    });
  }

  static created(res, message = 'Created', data = null) {
    return this.success(res, message, data, 201);
  }

  static error(res, message = 'An error occurred', errors = null, statusCode = 400) {
    if (typeof errors === 'number') {
      statusCode = errors;
      errors = null;
    }
    return res.status(statusCode).json({
      success: false,
      message,
      errors,
    });
  }

  static badRequest(res, message = 'Bad request', errors = null) {
    return this.error(res, message, errors, 400);
  }

  static notFound(res, message = 'Not found') {
    return this.error(res, message, null, 404);
  }

  static forbidden(res, message = 'Forbidden') {
    return this.error(res, message, null, 403);
  }
}

module.exports = ApiResponse;
