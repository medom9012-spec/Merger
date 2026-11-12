// نقطة /api/cron: حذف المهام المنتهية الصلاحية بالكامل من الجداول الأربعة
'use strict';

const { handleOptions, sendJson, sendError } = require('../lib/http');
const jobs = require('../lib/jobs');

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return handleOptions(res);
    if (req.method !== 'GET') return sendError(res, 405, 'الطريقة غير مسموحة');
    const deleted = await jobs.deleteExpired();
    return sendJson(res, 200, { deleted });
  } catch (e) {
    if (e && e.userMessage) return sendError(res, e.statusCode || 500, e.userMessage);
    console.error('[api/cron]', e);
    return sendError(res, 500, 'خطأ داخلي');
  }
};
