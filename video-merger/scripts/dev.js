// خادم تطوير محلي على المنفذ 3200: يقدم الواجهة الثابتة ومسار /fixtures ويوجه /api إلى نفس معالجات Vercel
'use strict';

require('../lib/env'); // تحميل .env يدوياً

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 3200); // المنفذ المطلوب: 3200
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const FIXTURES_DIR = path.join(os.tmpdir(), 'video-merger-fixtures');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.3gp': 'video/3gpp',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.m4v': 'video/x-m4v',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(body);
}

// تقديم ملف ثابت مع منع اجتياز المسارات
function serveFile(baseDir, relPath, res) {
  const safe = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(baseDir, safe);
  if (!full.startsWith(baseDir)) return sendJson(res, 404, { error: 'المسار غير موجود' });
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'المسار غير موجود' });
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Content-Length', st.size);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const stream = fs.createReadStream(full);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

// نفس وحدات Vercel تُستخدم هنا حرفياً
const handlers = {
  jobs: require('../api/jobs'),
  job: require('../api/jobs/[id]'),
  process: require('../api/jobs/[id]/process'),
  video: require('../api/jobs/[id]/video'),
  upload: require('../api/upload'),
  config: require('../api/config'),
  cron: require('../api/cron'),
};

async function routeApi(req, res, pathname) {
  if (pathname === '/api/jobs') return handlers.jobs(req, res);
  if (pathname === '/api/upload') return handlers.upload(req, res);
  if (pathname === '/api/config') return handlers.config(req, res);
  if (pathname === '/api/cron') return handlers.cron(req, res);
  let m = /^\/api\/jobs\/([^/]+)\/process$/.exec(pathname);
  if (m) {
    req.query.id = decodeURIComponent(m[1]); // مثل Vercel: معلمات المسار تصل عبر req.query
    return handlers.process(req, res);
  }
  m = /^\/api\/jobs\/([^/]+)\/video$/.exec(pathname);
  if (m) {
    req.query.id = decodeURIComponent(m[1]);
    return handlers.video(req, res);
  }
  m = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
  if (m) {
    req.query.id = decodeURIComponent(m[1]);
    return handlers.job(req, res);
  }
  return sendJson(res, 404, { error: 'المسار غير موجود' });
}

const server = http.createServer((req, res) => {
  // منع انهيار العملية عند انقطاع العميل أو أخطاء الشبكة العابرة
  res.on('error', () => { /* تجاهل أخطاء الكتابة على مقابس مغلقة */ });
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch (_) {
    return sendJson(res, 400, { error: 'طلب غير صالح' });
  }
  // نسخ معلمات الاستعلام إلى req.query كما يفعل Vercel
  req.query = req.query || {};
  for (const [k, v] of u.searchParams) req.query[k] = v;

  Promise.resolve()
    .then(async () => {
      const p = u.pathname;
      if (p === '/api' || p.startsWith('/api/')) return routeApi(req, res, p);
      if (p.startsWith('/fixtures/')) {
        return serveFile(FIXTURES_DIR, decodeURIComponent(p.slice('/fixtures/'.length)), res);
      }
      return serveFile(PUBLIC_DIR, p === '/' ? 'index.html' : decodeURIComponent(p), res);
    })
    .catch((e) => {
      console.error('[dev]', e);
      if (!res.headersSent) sendJson(res, 500, { error: 'خطأ داخلي' });
      else res.destroy();
    });
});

// الطلبات المشوهة على مستوى المقابس لا تُسقط الخادم
server.on('clientError', (err, socket) => {
  try {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  } catch (_) { /* تجاهل */ }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[dev] خادم التطوير يعمل على http://127.0.0.1:${PORT}`);
  console.log('VIDEO_MERGER_DEV_READY');
});
