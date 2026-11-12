// نقطة /api/config: حدود وإعدادات الخدمة العامة
'use strict';

const { handleOptions, sendJson, sendError } = require('../lib/http');
const { config } = require('../lib/env');

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return handleOptions(res);
    if (req.method !== 'GET') return sendError(res, 405, 'الطريقة غير مسموحة');
    return sendJson(res, 200, {
      version: '2.0',
      maxSources: config.maxSources,
      sourceMaxMB: config.sourceMaxMB,
      outputMaxMB: config.outputMaxMB,
      maxTotalDurationSec: config.maxTotalDurationSec,
      uploadChunkBytes: config.uploadChunkBytes,
      retentionHours: config.retentionHours,
    });
  } catch (e) {
    console.error('[api/config]', e);
    return sendError(res, 500, 'خطأ داخلي');
  }
};
