// اختبار HTTP شامل ضد خادم التطوير المحلي على المنفذ 3200
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3200;
const BASE = `http://127.0.0.1:${PORT}`;
const URL_A = 'https://www.w3schools.com/html/mov_bbb.mp4';
const URL_B = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';

const results = [];
let serverOut = '';
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? ' — ' + extra : ''}`);
}
function skip(name, reason) {
  results.push({ name, ok: null });
  console.log(`SKIP: ${name}${reason ? ' — ' + reason : ''}`);
}

// fetch مع إعادة محاولة قصيرة للأخطاء العابرة على مستوى الشبكة
async function fetchRetry(url, opts = {}, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      lastErr = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 600 * i));
    }
  }
  throw lastErr;
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch (_) { /* إعادة المحاولة */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// فحص وصول الرابط العام: نقرأ الترويسات فقط ثم نلغي التنزيل
async function urlReachable(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    try { await r.body.cancel(); } catch (_) { /* تجاهل */ }
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function main() {
  console.log('== اختبار HTTP: Video Merger API v2 ==');
  const hasDb = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
  if (!hasDb) console.log('SKIP: no TURSO env — سيتم التحقق من المسارات غير المعتمدة على قاعدة البيانات فقط');

  const child = spawn(process.execPath, [path.join(__dirname, 'dev.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.on('data', (d) => { serverOut += d.toString(); });
  child.stderr.on('data', (d) => { serverOut += d.toString(); });

  try {
    const ready = await waitReady();
    check('تشغيل خادم التطوير على المنفذ 3200', ready);
    if (!ready) {
      console.error(serverOut.slice(-800));
      throw new Error('الخادم لم يبدأ');
    }

    // 1) إعدادات الخدمة + CORS
    {
      const r = await fetch(`${BASE}/api/config`);
      const j = await r.json().catch(() => ({}));
      const cors = r.headers.get('access-control-allow-origin');
      check('GET /api/config → 200 مع version 2.0', r.status === 200 && j.version === '2.0' && Number(j.uploadChunkBytes) === 4194304, JSON.stringify(j));
      check('ترويسة CORS مفتوحة على كل الردود', cors === '*', `access-control-allow-origin=${cors}`);
    }

    // 2) Preflight
    {
      const r = await fetch(`${BASE}/api/jobs`, { method: 'OPTIONS' });
      const cors = r.headers.get('access-control-allow-origin');
      check('OPTIONS preflight → 204 مع CORS', r.status === 204 && cors === '*', `status=${r.status} cors=${cors}`);
    }

    // 3) JSON غير صالح → 400 برسالة عربية (لا يحتاج قاعدة بيانات)
    {
      const r = await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      });
      const j = await r.json().catch(() => ({}));
      check('POST /api/jobs بجسم غير صالح → 400 برسالة عربية', r.status === 400 && /[\u0600-\u06FF]/.test(j.error || ''), JSON.stringify(j));
    }

    // 4) مقطع واحد فقط → 400 برسالة عربية (لا يحتاج قاعدة بيانات)
    {
      const r = await fetch(`${BASE}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos: ['https://example.com/a.mp4'] }),
      });
      const j = await r.json().catch(() => ({}));
      check('POST /api/jobs بمقطع واحد → 400', r.status === 400 && /[\u0600-\u06FF]/.test(j.error || ''), JSON.stringify(j));
    }

    // 5) طريقة غير مسموحة → 405
    {
      const r = await fetch(`${BASE}/api/config`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      check('POST /api/config → 405', r.status === 405 && /[\u0600-\u06FF]/.test(j.error || ''), `status=${r.status}`);
    }

    if (!hasDb) {
      // كل ما يلي يحتاج قاعدة البيانات (الإنشاء والقراءة والحذف والدمج)
      skip('POST /api/jobs (رابطان عامان) → 201', 'SKIP: no TURSO env');
      skip('POST process → done مع videoUrl', 'SKIP: no TURSO env');
      skip('GET video مع Range bytes=0-1023 → 206 + Content-Range', 'SKIP: no TURSO env');
      skip('GET job → done', 'SKIP: no TURSO env');
      skip('DELETE job → deleted:true', 'SKIP: no TURSO env');
      skip('GET job بعد الحذف → 404', 'SKIP: no TURSO env');
    } else {
      // اختيار مصادر عامة: روابط حقيقية أو بدائل محلية عبر /fixtures عند تعذر الشبكة
      let urlA = URL_A;
      let urlB = URL_B;
      if (!(await urlReachable(URL_A)) || !(await urlReachable(URL_B))) {
        console.log('الروابط العامة غير متاحة — توليد بدائل محلية عبر /fixtures');
        const { makeTestVideos } = require('./fixtures');
        const dir = path.join(os.tmpdir(), 'video-merger-fixtures');
        const [fa, fb] = await makeTestVideos(dir);
        urlA = `${BASE}/fixtures/${path.basename(fa)}`;
        urlB = `${BASE}/fixtures/${path.basename(fb)}`;
      }

      // 6) إنشاء مهمة
      let jobId = null;
      {
        const r = await fetch(`${BASE}/api/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videos: [urlA, urlB] }),
        });
        const j = await r.json().catch(() => ({}));
        jobId = j.jobId || null;
        check('POST /api/jobs (رابطان) → 201', r.status === 201 && !!jobId && !!j.processUrl && !!j.expiresAt, JSON.stringify(j));
      }

      if (jobId) {
        // 7) تنفيذ الدمج (متزامن وقد يستغرق عشرات الثواني)
        let done = null;
        {
          const r = await fetch(`${BASE}/api/jobs/${jobId}/process`, { method: 'POST', signal: AbortSignal.timeout(280000) });
          const j = await r.json().catch(() => ({}));
          done = r.status === 200 && j.status === 'done' ? j : null;
          check('POST process → done مع videoUrl', !!done && typeof j.videoUrl === 'string',
            done ? `size=${j.size} duration=${j.duration} resolution=${j.resolution}` : JSON.stringify(j));
        }
        // 8) بث الفيديو مع نطاق بايتات
        {
          const r = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: 'bytes=0-1023' } });
          const cr = r.headers.get('content-range') || '';
          const ar = r.headers.get('accept-ranges') || '';
          check('GET video مع Range bytes=0-1023 → 206 + Content-Range', r.status === 206 && cr.startsWith('bytes 0-1023/') && ar === 'bytes',
            `status=${r.status} content-range=${cr}`);
          try { await r.body.cancel(); } catch (_) { /* تجاهل */ }
        }
        // 9) حالة المهمة بعد الدمج
        {
          const r = await fetch(`${BASE}/api/jobs/${jobId}`);
          const j = await r.json().catch(() => ({}));
          check('GET job → done', r.status === 200 && j.status === 'done' && j.progress === 100 && Array.isArray(j.sources),
            `status=${j.status} progress=${j.progress} sources=${(j.sources || []).length}`);
        }
        // 10) الحذف الكامل
        {
          const r = await fetch(`${BASE}/api/jobs/${jobId}`, { method: 'DELETE' });
          const j = await r.json().catch(() => ({}));
          check('DELETE job → deleted:true', r.status === 200 && j.deleted === true, JSON.stringify(j));
        }
        // 11) بعد الحذف
        {
          const r = await fetch(`${BASE}/api/jobs/${jobId}`);
          check('GET job بعد الحذف → 404', r.status === 404, `status=${r.status}`);
        }
      }
    }
  } finally {
    try { child.kill('SIGTERM'); } catch (_) { /* تجاهل */ }
    await new Promise((r) => setTimeout(r, 700));
    try { child.kill('SIGKILL'); } catch (_) { /* تجاهل */ }
  }

  const failed = results.filter((r) => r.ok === false).length;
  const passed = results.filter((r) => r.ok === true).length;
  const skipped = results.filter((r) => r.ok === null).length;
  console.log(`\nالملخص: ${passed} ناجح، ${failed} فاشل، ${skipped} متخطى`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL: خطأ غير متوقع —', e && (e.stack || e.message));
  if (typeof serverOut === 'string' && serverOut) {
    console.error('--- مخرجات الخادم ---');
    console.error(serverOut.slice(-3000));
  }
  process.exit(1);
});
