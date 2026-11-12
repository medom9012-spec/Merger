// إعدادات البيئة: تحميل .env يدوياً ثم قراءة المتغيرات مع قيم افتراضية
'use strict';

const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (_) {
    /* تجاهل أي خطأ في قراءة ملف البيئة */
  }
}
loadEnvFile();

function toInt(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const config = {
  maxSources: toInt('MAX_SOURCES', 10),
  sourceMaxMB: toInt('SOURCE_MAX_MB', 200),
  outputMaxMB: toInt('OUTPUT_MAX_MB', 150),
  maxTotalDurationSec: toInt('MAX_TOTAL_DURATION_SEC', 600),
  ffmpegPreset: (process.env.FFMPEG_PRESET || 'medium').trim(),
  uploadChunkBytes: 4 * 1024 * 1024,
  retentionHours: 24,
};

function hasTurso() {
  return Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
}

module.exports = { config, hasTurso };
