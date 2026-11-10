const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { testConnection } = require('./config/db.config');
const studentCsvRoutes = require('./routes/studentCsv.routes');
const userCsvRoutes = require('./routes/userCsv.routes');
const teacherCsvRoutes = require('./routes/teacherCsv.routes');
const ApiResponse = require('./utils/api.response');

const app = express();

// 1. CORS & Cookie/Body Parsing Middlewares
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.COOKIE_SECRET));

// 2. Health Check
app.get('/api/health', async (req, res) => {
  const dbStatus = await testConnection();
  return ApiResponse.success(res, 'GrowVidya Student Upload Server is running.', {
    database: dbStatus.ok ? 'connected' : 'disconnected',
  });
});

// 3. Student, User & Teacher CSV/Excel Bulk Upload Routes
app.use('/api/v1/admin/students/excel', studentCsvRoutes);
app.use('/api/v1/admin/students/csv', studentCsvRoutes);
app.use('/api/v1/admin/users/csv', userCsvRoutes);
app.use('/api/v1/admin/teachers/csv', teacherCsvRoutes);

// 4. 404 & Global Error Handling
app.use((req, res) => {
  return ApiResponse.notFound(res, `Route ${req.originalUrl} not found.`);
});

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  return ApiResponse.error(res, err.message, null, statusCode);
});

// 5. Start Server
async function startServer() {
  const dbCheck = await testConnection();
  if (!dbCheck.ok) {
    console.error('[DB Connection Error]:', dbCheck.error);
  }

  const port = Number(process.env.PORT);
  app.listen(port, () => {
    console.log(`GrowVidya Student Upload Server running on http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = app;
