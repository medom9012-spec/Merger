// عمليات المهام: إنشاء/قراءة/تحديث/حذف + التنظيف المنتهي الصلاحية
'use strict';

const crypto = require('crypto');
const { getClient, ensureSchema, nowSql, sqlTimeToIso } = require('./db');
const { config } = require('./env');

// حذف كل المهمة (الصفوف الأربعة) في دفعة واحدة
async function deleteJobBatch(jobId) {
  return getClient().batch([
    { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [jobId] },
    { sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [jobId] },
    { sql: 'DELETE FROM sources WHERE job_id = ?', args: [jobId] },
    { sql: 'DELETE FROM jobs WHERE id = ?', args: [jobId] },
  ], 'write');
}

// حذف المهام المنتهية الصلاحية بالكامل من الجداول الأربعة — يعيد عدد المهام المحذوفة
async function deleteExpired() {
  await ensureSchema();
  const cond = `WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`;
  const results = await getClient().batch([
    { sql: `DELETE FROM source_chunks WHERE job_id IN (SELECT id FROM jobs ${cond})`, args: [] },
    { sql: `DELETE FROM output_chunks WHERE job_id IN (SELECT id FROM jobs ${cond})`, args: [] },
    { sql: `DELETE FROM sources WHERE job_id IN (SELECT id FROM jobs ${cond})`, args: [] },
    { sql: `DELETE FROM jobs ${cond}`, args: [] },
  ], 'write');
  return (results[3] && results[3].rowsAffected) || 0;
}

async function createJob(sources) {
  await ensureSchema();
  const c = getClient();
  const id = crypto.randomBytes(12).toString('hex');
  const hasFiles = sources.some((s) => s.kind === 'file');
  const status = hasFiles ? 'uploading' : 'queued';
  const expiresAt = nowSql(config.retentionHours);
  await c.batch([
    {
      sql: 'INSERT INTO jobs (id, status, progress, expires_at) VALUES (?, ?, 0, ?)',
      args: [id, status, expiresAt],
    },
    ...sources.map((s, i) => ({
      sql: 'INSERT INTO sources (job_id, seq, kind, url, name, mime, size, duration, width, height, has_audio) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1)',
      args: [id, i, s.kind, s.url || null, s.name || null, s.mime || null, Number.isFinite(s.size) ? s.size : null],
    })),
  ], 'write');
  return { id, status, expiresAt };
}

async function getJobRow(id) {
  const rs = await getClient().execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
  return rs.rows[0] || null;
}

async function getSources(jobId) {
  const rs = await getClient().execute({
    sql: 'SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC',
    args: [jobId],
  });
  return rs.rows;
}

async function listJobs(limit = 50) {
  await ensureSchema();
  const rs = await getClient().execute({
    sql: 'SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?',
    args: [limit],
  });
  return rs.rows;
}

async function updateJob(id, fields) {
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    args.push(v);
  }
  sets.push(`updated_at = datetime('now')`);
  args.push(id);
  await getClient().execute({ sql: `UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, args });
}

// وضع الحالة processing فقط إذا كانت المهمة قابلة للبدء (منع التنفيذ المتوازي)
async function setStatusExclusive(id) {
  const rs = await getClient().execute({
    sql: `UPDATE jobs SET status='processing', progress=0, error=NULL, updated_at=datetime('now') WHERE id = ? AND status IN ('queued','uploading','failed')`,
    args: [id],
  });
  return (rs.rowsAffected || 0) > 0;
}

async function markFailed(id, error) {
  await updateJob(id, { status: 'failed', error });
}

async function setProgress(id, progress) {
  await updateJob(id, { progress: Math.max(0, Math.min(100, Math.round(progress))) });
}

// حذف كامل لمهمة واحدة من الجداول الأربعة
async function deleteJobFully(id) {
  await ensureSchema();
  await deleteJobBatch(id);
}

module.exports = {
  deleteExpired,
  createJob,
  getJobRow,
  getSources,
  listJobs,
  updateJob,
  setStatusExclusive,
  markFailed,
  setProgress,
  deleteJobFully,
  sqlTimeToIso,
};
