// نقطة /api/jobs: إنشاء مهمة دمج جديدة (POST) وقائمة المهام الحديثة (GET)
'use strict';

const { handleOptions, sendJson, sendError, readJsonBody, baseUrl, httpError } = require('../lib/http');
const { config } = require('../lib/env');
const jobs = require('../lib/jobs');

// التحقق من أن الرابط رابط مباشر http/https دون بيانات دخول
function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u.href;
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return handleOptions(res);

    // قائمة المهام الحديثة
    if (req.method === 'GET') {
      const rows = await jobs.listJobs(50);
      return sendJson(res, 200, {
        jobs: rows.map((r) => ({
          jobId: r.id,
          status: r.status || (r.error ? 'failed' : 'queued'),
          progress: Number(r.progress) || 0,
          size: r.result_size == null ? null : r.result_size,
          duration: r.result_duration == null ? null : r.result_duration,
          resolution: r.result_resolution || null,
          createdAt: jobs.sqlTimeToIso(r.created_at),
          expiresAt: jobs.sqlTimeToIso(r.expires_at),
        })),
      });
    }

    if (req.method !== 'POST') return sendError(res, 405, 'الطريقة غير مسموحة');

    // قراءة جسم الطلب والتحقق منه أولاً (قبل أي لمس لقاعدة البيانات)
    const body = await readJsonBody(req);
    if (!Array.isArray(body.videos) && !Array.isArray(body.sources)) {
      throw httpError(400, 'البيانات المرسلة غير صالحة، المطلوب حقل videos أو sources');
    }
    const list = [];
    if (Array.isArray(body.videos)) {
      for (const v of body.videos) list.push({ kind: 'url', url: v });
    }
    if (Array.isArray(body.sources)) {
      for (const s of body.sources) list.push(s);
    }

    const sources = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') throw httpError(400, 'مصدر غير صالح في القائمة');
      const kind = item.kind || (item.url ? 'url' : 'file');
      if (kind === 'url') {
        const href = normalizeUrl(item.url);
        if (!href) throw httpError(400, 'رابط غير صالح، يجب أن يكون رابطاً مباشراً يبدأ بـ http أو https');
        sources.push({ kind: 'url', url: href });
      } else if (kind === 'file') {
        const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'file';
        const size = Number(item.size);
        if (!Number.isFinite(size) || size <= 0) {
          throw httpError(400, `حجم الملف "${name}" غير صالح`);
        }
        if (size > config.sourceMaxMB * 1024 * 1024) {
          throw httpError(413, `حجم الملف "${name}" يتجاوز الحد المسموح (${config.sourceMaxMB} ميجابايت)`);
        }
        sources.push({ kind: 'file', name, size, mime: typeof item.mime === 'string' ? item.mime : 'video/mp4' });
      } else {
        throw httpError(400, 'نوع مصدر غير مدعوم، الأنواع المدعومة هي url و file');
      }
    }
    if (sources.length < 2) throw httpError(400, 'مطلوب مقطعان على الأقل لإنشاء مهمة دمج');
    if (sources.length > config.maxSources) {
      throw httpError(400, `الحد الأقصى لعدد المقاطع هو ${config.maxSources}`);
    }

    // تنظيف المهام المنتهية الصلاحية قبل الإنشاء (تنظيف كسول)
    try { await jobs.deleteExpired(); } catch (_) { /* التنظيف لا يعطّل الخدمة */ }

    const job = await jobs.createJob(sources);
    const base = baseUrl(req);
    const payload = {
      jobId: job.id,
      status: job.status,
      statusUrl: `${base}/api/jobs/${job.id}`,
      processUrl: `${base}/api/jobs/${job.id}/process`,
      expiresAt: jobs.sqlTimeToIso(job.expiresAt),
    };
    const uploads = [];
    sources.forEach((s, seq) => {
      if (s.kind === 'file') {
        uploads.push({
          seq,
          uploadUrl: `${base}/api/upload?job=${job.id}&seq=${seq}&chunk=0`,
          uploadChunkBytes: config.uploadChunkBytes,
        });
      }
    });
    if (uploads.length) payload.uploads = uploads;
    return sendJson(res, 201, payload);
  } catch (e) {
    if (e && e.userMessage) return sendError(res, e.statusCode || 500, e.userMessage);
    console.error('[api/jobs]', e);
    return sendError(res, 500, 'خطأ داخلي');
  }
};
