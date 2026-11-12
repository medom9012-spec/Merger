// أدوات مشتركة لمعالجة الطلبات: CORS، ردود JSON، قراءة الجسم، إنشاء الروابط المطلقة
'use strict';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Length, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function handleOptions(res) {
  setCors(res);
  res.statusCode = 204;
  res.end();
}

function sendJson(res, code, obj) {
  setCors(res);
  const body = JSON.stringify(obj);
  res.statusCode = code;
  if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function sendError(res, code, message) {
  sendJson(res, code, { error: message || 'خطأ داخلي' });
}

function sendNoContent(res) {
  setCors(res);
  res.statusCode = 204;
  res.end();
}

// خطأ يحمل رمز حالة HTTP ورسالة عربية للمستخدم
function httpError(statusCode, userMessage) {
  const e = new Error(userMessage);
  e.statusCode = statusCode;
  e.userMessage = userMessage;
  return e;
}

// حساب الرابط المطلق للخدمة من ترويسات الطلب (يعمل محلياً وعلى Vercel)
function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http'))
    .split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
    .split(',')[0].trim();
  return `${proto}://${host}`;
}

// قراءة جسم الطلب بالكامل مع سقف للحجم
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        req.resume();
        reject(httpError(413, 'حجم البيانات المرسلة يتجاوز الحد المسموح'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const raw = await readBody(req, maxBytes);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('bad');
    return parsed;
  } catch (_) {
    throw httpError(400, 'صيغة JSON غير صالحة');
  }
}

module.exports = {
  setCors,
  handleOptions,
  sendJson,
  sendError,
  sendNoContent,
  httpError,
  baseUrl,
  readBody,
  readJsonBody,
};
