// نقطة /api/jobs/{id}/video: بث الفيديو الناتج مع دعم كامل لنطاقات Range
'use strict';

const { handleOptions, sendError, setCors } = require('../../../lib/http');
const { ensureSchema } = require('../../../lib/db');
const jobs = require('../../../lib/jobs');
const merge = require('../../../lib/merge');

// تحليل ترويسة Range: bytes=a-b أو bytes=a- أو bytes=-n — يعيد null للبث الكامل
function parseRange(header, total) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return { invalid: true };
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = parseInt(b, 10);
    if (!Number.isFinite(n) || n <= 0) return { invalid: true };
    return { start: Math.max(0, total - n), end: total - 1 };
  }
  const start = parseInt(a, 10);
  if (!Number.isFinite(start) || start >= total) return { invalid: true };
  const end = b === '' ? total - 1 : Math.min(parseInt(b, 10), total - 1);
  if (!Number.isFinite(end) || end < start) return { invalid: true };
  return { start, end };
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return handleOptions(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'الطريقة غير مسموحة');
    const id = String((req.query || {}).id || '');
    if (!id) return sendError(res, 400, 'معرف المهمة مفقود');
    await ensureSchema();

    const row = await jobs.getJobRow(id);
    if (!row || row.status !== 'done') {
      return sendError(res, 404, 'الفيديو غير موجود أو لم يكتمل الدمج بعد');
    }
    const total = await merge.outputTotalBytes(id);
    if (!total) return sendError(res, 404, 'ملف الفيديو غير متوفر');

    const range = parseRange(req.headers.range, total);
    if (range && range.invalid) {
      setCors(res);
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.end();
    }
    let status = 200;
    let start = 0;
    let end = total - 1;
    if (range) {
      status = 206;
      start = range.start;
      end = range.end;
    }
    const length = end - start + 1;

    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(length),
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
    };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    if (String((req.query || {}).download || '') === '1') {
      headers['Content-Disposition'] = `attachment; filename="merged-${id}.mp4"`;
    }
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();

    let aborted = false;
    // قطع العميل للاتصال أثناء البث يجب ألا يسبب أي انهيار
    res.on('error', () => {
      aborted = true;
    });
    res.on('close', () => {
      aborted = true;
    });
    await merge.streamOutput(
      id,
      start,
      length,
      (piece) => new Promise((resolve, reject) => {
        if (aborted || res.writableEnded || res.destroyed) {
          resolve();
          return;
        }
        res.write(piece, (err) => (err ? reject(err) : resolve()));
      }),
      () => aborted || res.destroyed
    );
    // إنهاء الاستجابة صراحةً بعد اكتمال البث (بدون هذا يبقى الاتصال مفتوحًا ويتعلق العميل)
    if (!aborted && !res.writableEnded && !res.destroyed) res.end();
  } catch (e) {
    if (res.headersSent) {
      try { res.destroy(); } catch (_) { /* تجاهل */ }
      return;
    }
    if (e && e.userMessage) return sendError(res, e.statusCode || 500, e.userMessage);
    console.error('[api/video]', e);
    return sendError(res, 500, 'خطأ داخلي');
  }
};
