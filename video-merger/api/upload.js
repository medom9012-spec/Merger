// نقطة /api/upload: رفع ملف مصدر على شكل أجزاء ثنائية بحجم 4 ميجابايت كحد أقصى
'use strict';

const { handleOptions, sendError, sendNoContent, httpError, readBody } = require('../lib/http');
const { config } = require('../lib/env');
const { getClient, ensureSchema } = require('../lib/db');
const jobs = require('../lib/jobs');

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return handleOptions(res);
    if (req.method !== 'POST') return sendError(res, 405, 'الطريقة غير مسموحة');

    const q = req.query || {};
    const jobId = String(q.job || '');
    const seq = Number(q.seq);
    const chunkIndex = Number(q.chunk);
    if (!jobId || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw httpError(400, 'معلمات الرفع غير صالحة، المطلوب job و seq و chunk');
    }

    await ensureSchema();
    const job = await jobs.getJobRow(jobId);
    if (!job) throw httpError(404, 'المهمة غير موجودة أو انتهت صلاحيتها');
    if (job.status !== 'uploading') {
      throw httpError(409, 'لا يمكن رفع الملفات في هذه المرحلة، حالة المهمة الحالية: ' + job.status);
    }

    const srcRs = await getClient().execute({
      sql: 'SELECT kind FROM sources WHERE job_id = ? AND seq = ?',
      args: [jobId, seq],
    });
    const src = srcRs.rows[0];
    if (!src || src.kind !== 'file') {
      throw httpError(400, 'لا يوجد ملف مرفوع مرتبط بهذا الرقم في المهمة');
    }

    // قراءة الجزء مع فرض سقف 4 ميجابايت، وعند التجاوز تفشل المهمة
    let body;
    try {
      body = await readBody(req, config.uploadChunkBytes);
    } catch (e) {
      if (e && e.statusCode === 413) {
        await jobs.markFailed(jobId, 'حجم أحد أجزاء الرفع يتجاوز الحد المسموح (4 ميجابايت)').catch(() => {});
        throw httpError(413, 'حجم الجزء يتجاوز الحد المسموح (4 ميجابايت)');
      }
      throw e;
    }
    if (!body.length) throw httpError(400, 'الجزء المرسل فارغ');

    // فرض الحد الأقصى للحجم المتراكم للملف الواحد
    const capBytes = config.sourceMaxMB * 1024 * 1024;
    const acc = await getClient().execute({
      sql: 'SELECT COALESCE(SUM(LENGTH(data)), 0) AS total FROM source_chunks WHERE job_id = ? AND seq = ?',
      args: [jobId, seq],
    });
    const existing = Number(acc.rows[0].total) || 0;
    // عند إعادة إرسال نفس الجزء لا يُحسب مرتين (الرفع آمن لإعادة المحاولة)
    const sameChunk = await getClient().execute({
      sql: 'SELECT LENGTH(data) AS len FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk_index = ?',
      args: [jobId, seq, chunkIndex],
    });
    const replacing = sameChunk.rows.length ? Number(sameChunk.rows[0].len) : 0;
    if (existing - replacing + body.length > capBytes) {
      await jobs.markFailed(jobId, `الحجم الإجمالي للملف المرفوع يتجاوز الحد المسموح (${config.sourceMaxMB} ميجابايت)`).catch(() => {});
      throw httpError(413, `الحجم الإجمالي للملف يتجاوز الحد المسموح (${config.sourceMaxMB} ميجابايت)`);
    }

    // الحفظ: فهرسة صريحة تجعل إعادة الإرسال آمنة
    await getClient().execute({
      sql: 'INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk_index, data) VALUES (?, ?, ?, ?)',
      args: [jobId, seq, chunkIndex, body],
    });
    // تحديث حجم المصدر المرفوع فعلياً
    await getClient().execute({
      sql: 'UPDATE sources SET size = (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM source_chunks WHERE job_id = ? AND seq = ?) WHERE job_id = ? AND seq = ?',
      args: [jobId, seq, jobId, seq],
    });
    await jobs.updateJob(jobId, {}).catch(() => { /* تحديث وقت التعديل فقط */ });
    return sendNoContent(res);
  } catch (e) {
    if (e && e.userMessage) return sendError(res, e.statusCode || 500, e.userMessage);
    console.error('[api/upload]', e);
    return sendError(res, 500, 'خطأ داخلي');
  }
};
