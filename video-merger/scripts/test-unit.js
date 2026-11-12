// اختبارات الوحدة: محرك الدمج مباشرة بدون HTTP + دورة تقسيم/تجميع الأجزاء
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { hasTurso } = require('../lib/env');
const { probeVideo } = require('../lib/ffmpeg');
const merge = require('../lib/merge');
const { getClient, ensureSchema } = require('../lib/db');
const { makeTestVideos } = require('./fixtures');

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? ' — ' + extra : ''}`);
}
function skip(name, reason) {
  results.push({ name, ok: null });
  console.log(`SKIP: ${name}${reason ? ' — ' + reason : ''}`);
}

async function main() {
  console.log('== اختبارات الوحدة: Video Merger API v2 ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmerge-test-'));
  try {
    // 1) توليد مقطعين اختباريين بأبعاد مختلفة
    const [a, b] = await makeTestVideos(tmp);
    check('توليد مقطعين اختباريين بـ ffmpeg', fs.existsSync(a) && fs.existsSync(b),
      `a=${(fs.statSync(a).size / 1024).toFixed(0)}KB b=${(fs.statSync(b).size / 1024).toFixed(0)}KB`);

    // 2) تشغيل محرك الدمج مباشرة (بدون HTTP)
    const outPath = path.join(tmp, 'merged.mp4');
    const t0 = Date.now();
    const result = await merge.mergeFilesToTmp([a, b], { outputPath: outPath, onRatio: () => {} });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    check('الناتج موجود وغير فارغ', fs.existsSync(outPath) && result.size > 0,
      `${(result.size / 1024).toFixed(0)}KB خلال ${secs} ثانية`);
    check('دقة الناتج تساوي أكبر دقة مدخلات (640x360)', result.width === 640 && result.height === 360,
      `${result.width}x${result.height}`);
    check('مدة الناتج تساوي مجموع المدخلات تقريباً (5 ثوان)', Math.abs(result.duration - 5) <= 0.8,
      `${result.duration.toFixed(2)} ثانية`);
    check('الناتج يحتوي على مسار صوت', result.hasAudio === true);

    // 3) دورة تقسيم/تجميع الأجزاء مع sha256 (مخزن عشوائي 5 ميجابايت)
    const big = crypto.randomBytes(5 * 1024 * 1024);
    const parts = merge.splitBuffer(big, 2 * 1024 * 1024);
    const joined = Buffer.concat(parts.map((p) => Buffer.from(p)));
    const h1 = crypto.createHash('sha256').update(big).digest('hex');
    const h2 = crypto.createHash('sha256').update(joined).digest('hex');
    check('دورة تقسيم/تجميع الأجزاء (5MB إلى أجزاء 2MB ثم sha256)', parts.length === 3 && h1 === h2,
      `عدد الأجزاء=${parts.length} sha256=${h2.slice(0, 12)}...`);

    // 4) جزء يعتمد على قاعدة البيانات: تخزين الناتج وقراءته صفحة صفحة
    if (!hasTurso()) {
      skip('تخزين الأجزاء وقراءتها من قاعدة البيانات', 'SKIP: no TURSO env');
    } else {
      await ensureSchema();
      const jobId = 'unittest-' + crypto.randomBytes(6).toString('hex');
      const { size } = await merge.storeOutputChunks(jobId, outPath);
      const pieces = [];
      await merge.streamOutput(jobId, 0, size, async (piece) => { pieces.push(Buffer.from(piece)); }, () => false);
      const h3 = crypto.createHash('sha256').update(Buffer.concat(pieces)).digest('hex');
      const h4 = crypto.createHash('sha256').update(fs.readFileSync(outPath)).digest('hex');
      check('تخزين الناتج في قاعدة البيانات وقراءته صفحة صفحة (8 صفوف)', h3 === h4 && size === result.size,
        `sha256=${h3.slice(0, 12)}...`);
      await getClient().execute({ sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [jobId] });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((r) => r.ok === false).length;
  const passed = results.filter((r) => r.ok === true).length;
  const skipped = results.filter((r) => r.ok === null).length;
  console.log(`\nالملخص: ${passed} ناجح، ${failed} فاشل، ${skipped} متخطى`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL: خطأ غير متوقع —', e && (e.stack || e.message));
  process.exit(1);
});
