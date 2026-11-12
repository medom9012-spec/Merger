// محرك الدمج: تنزيل المصادر، تجميع الأجزاء المرفوعة، الدمج، تخزين الناتج كأجزاء BLOB
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { getClient, ensureSchema } = require('./db');
const { config } = require('./env');
const { httpError } = require('./http');
const jobs = require('./jobs');
const { probeVideo, encodeMerge } = require('./ffmpeg');

const OUTPUT_CHUNK_BYTES = 2 * 1024 * 1024; // تقسيم الناتج إلى أجزاء 2 ميجابايت
const PAGE_ROWS = 8; // عدد الصفوف في كل صفحة قراءة من قاعدة البيانات

// تنزيل مصدر رابط إلى ملف مع فرض سقف الحجم أثناء التنزيل
async function downloadToFile(url, dest, capBytes) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (_) {
    throw httpError(400, 'تعذر تنزيل أحد الروابط، تأكد من أنه رابط مباشر صالح');
  }
  if (!res.ok) throw httpError(400, `فشل تنزيل أحد الروابط (رمز الحالة ${res.status})`);
  const cl = Number(res.headers.get('content-length') || 0);
  if (cl > capBytes) throw httpError(413, 'حجم أحد المقاطع يتجاوز الحد المسموح');
  const out = fs.createWriteStream(dest);
  let count = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      count += buf.length;
      if (count > capBytes) {
        try { await reader.cancel(); } catch (_) { /* تجاهل */ }
        throw httpError(413, 'حجم أحد المقاطع يتجاوز الحد المسموح');
      }
      if (!out.write(buf)) await once(out, 'drain');
    }
    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.end(resolve);
    });
  } finally {
    out.destroy();
  }
  if (count === 0) throw httpError(400, 'الرابط لا يحتوي على بيانات');
  return count;
}

// تجميع أجزاء مصدر مرفوع من source_chunks إلى ملف مؤقت
async function chunksToFile(jobId, seq, dest, capBytes) {
  await ensureSchema();
  const out = fs.createWriteStream(dest);
  let count = 0;
  let offset = 0;
  try {
    for (;;) {
      const rs = await getClient().execute({
        sql: 'SELECT data FROM source_chunks WHERE job_id = ? AND seq = ? ORDER BY chunk_index ASC LIMIT ? OFFSET ?',
        args: [jobId, seq, PAGE_ROWS, offset],
      });
      if (!rs.rows.length) break;
      for (const row of rs.rows) {
        const buf = Buffer.from(row.data);
        count += buf.length;
        if (count > capBytes) throw httpError(413, 'حجم الملف المرفوع يتجاوز الحد المسموح');
        if (!out.write(buf)) await once(out, 'drain');
      }
      offset += rs.rows.length;
    }
    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.end(resolve);
    });
  } finally {
    out.destroy();
  }
  if (count === 0) throw httpError(400, 'لم يتم رفع بيانات أحد المقاطع');
  return count;
}

// تقسيم مخزن مؤقت إلى أجزاء بحجم محدد (دالة نقية تستخدمها الاختبارات أيضاً)
function splitBuffer(buf, chunkSize = OUTPUT_CHUNK_BYTES) {
  const parts = [];
  for (let off = 0; off < buf.length; off += chunkSize) {
    parts.push(buf.subarray(off, Math.min(off + chunkSize, buf.length)));
  }
  return parts;
}

// تخزين ملف الناتج في output_chunks على شكل أجزاء 2MB ضمن دفعات صغيرة
async function storeOutputChunks(jobId, filePath) {
  await ensureSchema();
  const stat = await fsp.stat(filePath);
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(OUTPUT_CHUNK_BYTES);
    let index = 0;
    let batch = [];
    let batchBytes = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, OUTPUT_CHUNK_BYTES, index * OUTPUT_CHUNK_BYTES);
      if (bytesRead === 0) break;
      const data = buf.subarray(0, bytesRead);
      batch.push({
        sql: 'INSERT OR REPLACE INTO output_chunks (job_id, chunk_index, data) VALUES (?, ?, ?)',
        args: [jobId, index, data],
      });
      batchBytes += bytesRead;
      index += 1;
      // دفعات صغيرة لتجنب تجاوز الحد الأقصى لحجم طلب HTTP لقاعدة البيانات
      if (batchBytes >= OUTPUT_CHUNK_BYTES * 2) {
        await getClient().batch(batch, 'write');
        batch = [];
        batchBytes = 0;
      }
    }
    if (batch.length) await getClient().batch(batch, 'write');
    return { size: stat.size, chunks: index };
  } finally {
    await fh.close();
  }
}

// الحجم الكلي لمقاطع الناتج المخزنة لمهمة معينة
async function outputTotalBytes(jobId) {
  await ensureSchema();
  const rs = await getClient().execute({
    sql: 'SELECT COALESCE(SUM(LENGTH(data)), 0) AS total FROM output_chunks WHERE job_id = ?',
    args: [jobId],
  });
  return Number(rs.rows[0] ? rs.rows[0].total : 0) || 0;
}

// بث الناتج بالقراءة صفحة صفحة (8 صفوف) مع دعم قص البداية والنهاية لنطاقات Range
async function streamOutput(jobId, start, length, writeFn, isAborted) {
  await ensureSchema();
  const pageSize = PAGE_ROWS * OUTPUT_CHUNK_BYTES;
  let page = Math.floor(start / pageSize);
  let skip = start - page * pageSize;
  let remaining = length;
  while (remaining > 0) {
    if (isAborted && isAborted()) return;
    const rs = await getClient().execute({
      sql: 'SELECT data FROM output_chunks WHERE job_id = ? ORDER BY chunk_index ASC LIMIT ? OFFSET ?',
      args: [jobId, PAGE_ROWS, page * PAGE_ROWS],
    });
    if (!rs.rows.length) break;
    const joined = Buffer.concat(rs.rows.map((r) => Buffer.from(r.data)));
    let piece = joined;
    if (skip > 0) {
      piece = piece.subarray(Math.min(skip, piece.length));
      skip = 0;
    }
    if (piece.length > remaining) piece = piece.subarray(0, remaining);
    if (piece.length) {
      await writeFn(piece);
      remaining -= piece.length;
    }
    page += 1;
  }
  if (remaining > 0) throw httpError(500, 'بيانات الفيديو غير مكتملة');
}

// دمج ملفات محلية جاهزة إلى ملف ناتج (تستخدمه الاختبارات مباشرة)
async function mergeFilesToTmp(inputs, { outputPath, onRatio }) {
  const metas = [];
  for (const f of inputs) metas.push(await probeVideo(f));
  const totalDuration = metas.reduce((a, m) => a + (m.duration || 0), 0);
  await encodeMerge({ inputs, metas, preset: config.ffmpegPreset, outputPath, totalDuration, onRatio });
  let outMeta;
  try {
    outMeta = await probeVideo(outputPath);
  } catch (e) {
    throw httpError(500, 'فشل التحقق من الملف الناتج');
  }
  return {
    path: outputPath,
    size: fs.statSync(outputPath).size,
    width: outMeta.width,
    height: outMeta.height,
    duration: outMeta.duration,
    hasAudio: outMeta.hasAudio,
  };
}

// تنفيذ مهمة كاملة: تحضير المصادر ثم الدمج ثم تخزين الناتج وحذف أجزاء المصادر
async function mergeJob(jobId, onProgress) {
  const sources = await jobs.getSources(jobId);
  if (sources.length < 2) throw httpError(400, 'مطلوب مقطعان على الأقل للدمج');
  const capBytes = config.sourceMaxMB * 1024 * 1024;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vmerge-'));
  const files = [];
  const counts = [];
  try {
    // 1) تحضير المصادر (التقدم 0 إلى 40 بالمئة)
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dest = path.join(tmpDir, `src-${i}.bin`);
      if (s.kind === 'url') counts[i] = await downloadToFile(s.url, dest, capBytes);
      else counts[i] = await chunksToFile(jobId, s.seq, dest, capBytes);
      files.push(dest);
      if (onProgress) onProgress(Math.round(((i + 1) / sources.length) * 40));
    }
    // 2) فحص المقاطع وتحديث بيانات المصادر
    const metas = [];
    for (const f of files) metas.push(await probeVideo(f));
    const srcUpdates = sources.map((s, i) => ({
      sql: 'UPDATE sources SET duration = ?, width = ?, height = ?, has_audio = ?, size = ? WHERE job_id = ? AND seq = ?',
      args: [metas[i].duration, metas[i].width, metas[i].height, metas[i].hasAudio ? 1 : 0, counts[i] || null, jobId, s.seq],
    }));
    await getClient().batch(srcUpdates, 'write');
    // 3) فرض حد المدة الإجمالية
    const totalDuration = metas.reduce((a, m) => a + (m.duration || 0), 0);
    if (totalDuration > config.maxTotalDurationSec) {
      throw httpError(413, `المدة الإجمالية للمقاطع (${Math.round(totalDuration)} ثانية) تتجاوز الحد المسموح (${config.maxTotalDurationSec} ثانية)`);
    }
    // 4) الدمج والترميز (التقدم 40 إلى 90 بالمئة)
    const outputPath = path.join(tmpDir, 'output.mp4');
    const result = await mergeFilesToTmp(files, {
      outputPath,
      onRatio: (ratio) => {
        if (onProgress) onProgress(40 + Math.round(ratio * 50));
      },
    });
    // 5) تخزين الناتج ثم فرض حد حجم الناتج
    const { size } = await storeOutputChunks(jobId, outputPath);
    if (size > config.outputMaxMB * 1024 * 1024) {
      await getClient().execute({ sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [jobId] });
      throw httpError(413, `حجم الفيديو الناتج (${(size / 1048576).toFixed(1)} ميجابايت) يتجاوز الحد المسموح (${config.outputMaxMB} ميجابايت)`);
    }
    // 6) حذف أجزاء المصادر بعد نجاح الدمج (إبقاء بيانات المصادر والناتج)
    await getClient().execute({ sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [jobId] });
    return { size, duration: result.duration, width: result.width, height: result.height };
  } finally {
    // تنظيف كل الملفات المؤقتة مهما كانت النتيجة
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = {
  downloadToFile,
  chunksToFile,
  splitBuffer,
  storeOutputChunks,
  streamOutput,
  outputTotalBytes,
  mergeFilesToTmp,
  mergeJob,
  OUTPUT_CHUNK_BYTES,
  PAGE_ROWS,
};
