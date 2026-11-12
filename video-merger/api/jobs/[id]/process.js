// نقطة /api/jobs/{id}/process: تنفيذ الدمج الكامل بشكل متزامن مع حفظ التقدم
'use strict';

const { handleOptions, sendJson, sendError, baseUrl } = require('../../../lib/http');
const { ensureSchema, sqlTimeToIso } = require('../../../lib/db');
const jobs = require('../../../lib/jobs');
const merge = require('../../../lib/merge');

function donePayload(row, base) {
  return {
    jobId: row.id,
    status: 'done',
    progress: 100,
    videoUrl: `${base}/api/jobs/${row.id}/video`,
    downloadUrl: `${base}/api/jobs/${row.id}/video?download=1`,
    size: row.result_size,
    duration: row.result_duration,
    resolution: row.result_resolution,
    expiresAt: sqlTimeToIso(row.expires_at),
  };
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return handleOptions(res);
    if (req.method !== 'POST') return sendError(res, 405, 'الطريقة غير مسموحة');
    const id = String((req.query || {}).id || '');
    if (!id) return sendError(res, 400, 'معرف المهمة مفقود');
    await ensureSchema();

    // تنظيف كسول للمهام المنتهية الصلاحية
    try { await jobs.deleteExpired(); } catch (_) { /* التنظيف لا يعطّل الخدمة */ }

    const row = await jobs.getJobRow(id);
    if (!row) return sendError(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');
    const base = baseUrl(req);

    // مكتملة سابقاً: يعاد نفس الرد النهائي
    if (row.status === 'done') return sendJson(res, 200, donePayload(row, base));
    // قيد التنفيذ حالياً: 202 مع التقدم
    if (row.status === 'processing') {
      return sendJson(res, 202, { status: 'processing', progress: Number(row.progress) || 0 });
    }

    // بدء حصري يمنع تنفيذين متوازيين لنفس المهمة
    const started = await jobs.setStatusExclusive(id);
    if (!started) {
      const again = await jobs.getJobRow(id);
      if (again && again.status === 'processing') {
        return sendJson(res, 202, { status: 'processing', progress: Number(again.progress) || 0 });
      }
      if (again && again.status === 'done') return sendJson(res, 200, donePayload(again, base));
      return sendError(res, 409, 'لا يمكن بدء الدمج في الحالة الحالية');
    }

    // حفظ التقدم في قاعدة البيانات مع تخفيف وتيرة التحديثات
    let lastMs = 0;
    let lastVal = -5;
    const onProgress = (p) => {
      const now = Date.now();
      if (p >= 100 || now - lastMs > 1500 || p - lastVal >= 3) {
        lastMs = now;
        lastVal = p;
        jobs.setProgress(id, p).catch(() => { /* تجاهل أخطاء حفظ التقدم */ });
      }
    };

    try {
      const result = await merge.mergeJob(id, onProgress);
      await jobs.updateJob(id, {
        status: 'done',
        progress: 100,
        error: null,
        result_size: result.size,
        result_duration: result.duration,
        result_resolution: `${result.width}x${result.height}`,
      });
      const fresh = await jobs.getJobRow(id);
      return sendJson(res, 200, donePayload(fresh || { id, ...row, result_size: result.size, result_duration: result.duration, result_resolution: `${result.width}x${result.height}` }, base));
    } catch (e) {
      const msg = (e && e.userMessage) || 'فشل الدمج لسبب غير متوقع';
      await jobs.markFailed(id, msg).catch(() => { /* تجاهل */ });
      throw e;
    }
  } catch (e) {
    if (e && e.userMessage) return sendError(res, e.statusCode || 500, e.userMessage);
    console.error('[api/process]', e);
    return sendError(res, 500, 'خطأ داخلي');
  }
};
