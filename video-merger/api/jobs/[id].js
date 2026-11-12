// نقطة /api/jobs/{id}: حالة المهمة مع ملخص المصادر (GET) وحذفها بالكامل (DELETE)
'use strict';

const { handleOptions, sendJson, sendError, baseUrl } = require('../../lib/http');
const { ensureSchema, sqlTimeToIso } = require('../../lib/db');
const jobs = require('../../lib/jobs');

function jobPayload(row, sources, base) {
  // إذا كان هناك خطأ بدون حالة تُعامل المهمة كفاشلة
  const status = row.status || (row.error ? 'failed' : 'queued');
  const done = status === 'done';
  return {
    jobId: row.id,
    status,
    progress: Number(row.progress) || 0,
    videoUrl: done ? `${base}/api/jobs/${row.id}/video` : null,
    downloadUrl: done ? `${base}/api/jobs/${row.id}/video?download=1` : null,
    error: row.error || null,
    expiresAt: sqlTimeToIso(row.expires_at),
    size: done ? row.result_size : null,
    duration: done ? row.result_duration : null,
    resolution: done ? row.result_resolution : null,
    sources: sources.map((s) => ({
      seq: s.seq,
      kind: s.kind,
      name: s.name || null,
      url: s.url || null,
      mime: s.mime || null,
      size: s.size == null ? null : s.size,
      duration: s.duration == null ? null : s.duration,
      width: s.width == null ? null : s.width,
      height: s.height == null ? null : s.height,
      hasAudio: Boolean(s.has_audio),
    })),
  };
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return handleOptions(res);
    const id = String((req.query || {}).id || '');
    if (!id) return sendError(res, 400, 'معرف المهمة مفقود');
    await ensureSchema();

    if (req.method === 'GET') {
      const row = await jobs.getJobRow(id);
      if (!row) return sendError(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');
      const sources = await jobs.getSources(id);
      return sendJson(res, 200, jobPayload(row, sources, baseUrl(req)));
    }

    if (req.method === 'DELETE') {
      const row = await jobs.getJobRow(id);
      if (!row) return sendError(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');
      await jobs.deleteJobFully(id);
      return sendJson(res, 200, { deleted: true });
    }

    return sendError(res, 405, 'الطريقة غير مسموحة');
  } catch (e) {
    if (e && e.userMessage) return sendError(res, e.statusCode || 500, e.userMessage);
    console.error('[api/jobs/:id]', e);
    return sendError(res, 500, 'خطأ داخلي');
  }
};
