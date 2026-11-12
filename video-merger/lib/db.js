// طبقة قاعدة البيانات: عميل Turso (libsql عبر HTTP) مع ضمان وجود الجداول بالشكل المطلوب
'use strict';

const { createClient } = require('@libsql/client');
const { hasTurso } = require('./env');

let client = null;
let schemaPromise = null;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER DEFAULT 0,
    error TEXT,
    result_size INTEGER,
    result_duration REAL,
    result_resolution TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    job_id TEXT,
    seq INTEGER,
    kind TEXT,
    url TEXT,
    name TEXT,
    mime TEXT,
    size INTEGER,
    duration REAL,
    width INTEGER,
    height INTEGER,
    has_audio INTEGER DEFAULT 1,
    PRIMARY KEY (job_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS source_chunks (
    job_id TEXT,
    seq INTEGER,
    chunk_index INTEGER,
    data BLOB,
    PRIMARY KEY (job_id, seq, chunk_index)
  )`,
  `CREATE TABLE IF NOT EXISTS output_chunks (
    job_id TEXT,
    chunk_index INTEGER,
    data BLOB,
    PRIMARY KEY (job_id, chunk_index)
  )`,
];

function getClient() {
  if (client) return client;
  if (!hasTurso()) {
    const e = new Error('NO_TURSO');
    e.userMessage = 'خدمة قاعدة البيانات غير مهيأة (متغيرات Turso مفقودة)';
    throw e;
  }
  const url = process.env.TURSO_DATABASE_URL;
  const opts = { url };
  // روابط الملفات المحلية (file:) للاختبار فقط ولا تحتاج رمز مصادقة
  if (!url.startsWith('file:')) opts.authToken = process.env.TURSO_AUTH_TOKEN;
  client = createClient(opts);
  return client;
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = getClient()
      .batch(SCHEMA_SQL.map((sql) => ({ sql, args: [] })), 'write')
      .catch((e) => {
        schemaPromise = null;
        throw e;
      });
  }
  return schemaPromise;
}

// تحويل وقت SQL (YYYY-MM-DD HH:MM:SS) إلى ISO 8601
function sqlTimeToIso(value) {
  if (!value) return null;
  const s = String(value);
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? s : d.toISOString();
}

// الوقت الحالي (+ ساعات اختيارية) بصيغة SQL للتخزين والمقارنة داخل الاستعلامات
function nowSql(offsetHours = 0) {
  const d = new Date(Date.now() + offsetHours * 3600 * 1000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { getClient, ensureSchema, sqlTimeToIso, nowSql };
