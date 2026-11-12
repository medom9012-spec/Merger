// أدوات ffmpeg/ffprobe: ضمان صلاحية التنفيذ، فحص المقاطع، بناء الفلتر، الترميز مع قراءة التقدم
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const { httpError } = require('./http');

const ensured = new Map();

// ضمان قابلية التنفيذ: عند الفشل يُنسخ الملف إلى /tmp ويمنح صلاحية 755 (مطلوب على بعض الأنظمة الاستضافية)
function ensureExecutable(binPath) {
  if (!binPath) throw httpError(500, 'تعذر العثور على ملف ffmpeg التنفيذي');
  if (ensured.has(binPath)) return ensured.get(binPath);
  let out = binPath;
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
  } catch (_) {
    const tmp = path.join(os.tmpdir(), path.basename(binPath));
    fs.copyFileSync(binPath, tmp);
    fs.chmodSync(tmp, 0o755);
    out = tmp;
  }
  ensured.set(binPath, out);
  return out;
}

function ffmpegPath() {
  return ensureExecutable(ffmpegStatic);
}

function ffprobePath() {
  return ensureExecutable(ffprobeStatic.path || ffprobeStatic);
}

// تشغيل أمر خارجي وجمع المخرجات
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      if (opts.onStdout) opts.onStdout(d);
      if (!opts.keepStdout) return;
      stdout += d.toString();
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-512 * 1024);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-512 * 1024);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// فحص مقطع: الأبعاد، معدل الإطارات، المدة، وجود صوت
async function probeVideo(filePath) {
  const { code, stdout, stderr } = await run(ffprobePath(), [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath,
  ], { keepStdout: true });
  if (code !== 0) {
    throw httpError(400, 'تعذر تحليل أحد المقاطع، قد يكون الملف تالفاً أو ليس فيديو صالحاً');
  }
  let info;
  try {
    info = JSON.parse(stdout);
  } catch (_) {
    throw httpError(400, 'تعذر تحليل أحد المقاطع');
  }
  const streams = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic === 1));
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw httpError(400, 'أحد الملفات لا يحتوي على مسار فيديو صالح');
  let fps = 30;
  if (video.r_frame_rate && video.r_frame_rate.includes('/')) {
    const [n, d] = video.r_frame_rate.split('/').map(Number);
    if (d > 0 && n > 0) fps = n / d;
  }
  let duration = parseFloat(video.duration);
  if (!Number.isFinite(duration) && info.format && info.format.duration) {
    duration = parseFloat(info.format.duration);
  }
  return {
    width: video.width || 0,
    height: video.height || 0,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    hasAudio: Boolean(audio),
  };
}

// حساب الأبعاد الهدف: أكبر أبعاد بين المدخلات مع سقف 1920x1080 وأبعاد زوجية
function computeTarget(metas) {
  let w = 0;
  let h = 0;
  for (const m of metas) {
    w = Math.max(w, m.width || 0);
    h = Math.max(h, m.height || 0);
  }
  w = Math.min(w || 1280, 1920);
  h = Math.min(h || 720, 1080);
  if (w % 2 !== 0) w -= 1;
  if (h % 2 !== 0) h -= 1;
  return { w: Math.max(w, 2), h: Math.max(h, 2) };
}

// بناء فلتر التوحيد: تكبير/حشو ل largest دقة، fps=30، setsar، yuv420p، ومسار صوتي لكل مقطع ثم concat
function buildFilter(metas, target) {
  const parts = [];
  metas.forEach((m, i) => {
    parts.push(
      `[${i}:v]scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease,` +
      `pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`
    );
    const dur = Number(m.duration) > 0 ? m.duration.toFixed(3) : null;
    if (m.hasAudio) {
      // توحيد الصوت وتقصيره لمدة المقطع
      const chain = ['aresample=44100', 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
      if (dur) chain.push(`atrim=0:${dur}`, 'asetpts=PTS-STARTPTS');
      parts.push(`[${i}:a]${chain.join(',')}[a${i}]`);
    } else {
      // مقطع بلا صوت: توليد مسار صامت بنفس المدة
      if (!dur) throw httpError(400, 'تعذر تحديد مدة أحد المقاطع الصامتة، الملف غير مدعوم');
      parts.push(`anullsrc=r=44100:cl=stereo,atrim=0:${dur},asetpts=PTS-STARTPTS[a${i}]`);
    }
  });
  const maps = metas.map((_, i) => `[v${i}][a${i}]`).join('');
  parts.push(`${maps}concat=n=${metas.length}:v=1:a=1[vout][aout]`);
  return parts.join(';');
}

// تشغيل الدمج والترميز النهائي بجودة عالية مع قراءة التقدم من -progress pipe:1
async function encodeMerge({ inputs, metas, preset, outputPath, totalDuration, onRatio }) {
  const target = computeTarget(metas);
  const filter = buildFilter(metas, target);
  const args = ['-hide_banner', '-y'];
  for (const f of inputs) args.push('-i', f);
  args.push(
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-crf', '18', '-preset', preset || 'medium',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outputPath
  );
  let lineBuf = '';
  const { code, stderr } = await run(ffmpegPath(), args, {
    keepStdout: false,
    onStdout: (d) => {
      if (!onRatio) return;
      lineBuf += d.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) {
        // ملاحظة: out_time_ms في ffmpeg بالميكروثانية تاريخياً — يعامل كـ out_time_us
        const m = /^out_time_us=(\d+)/.exec(line) || /^out_time_ms=(\d+)/.exec(line);
        if (m && totalDuration > 0) {
          const ratio = Number(m[1]) / (totalDuration * 1e6);
          try {
            onRatio(Math.max(0, Math.min(1, ratio)));
          } catch (_) { /* تجاهل أخطاء رد التقدم */ }
        }
      }
    },
  });
  if (code !== 0) {
    const tail = (stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300);
    throw httpError(500, `فشل ترميز الفيديو أثناء الدمج${tail ? ` (${tail})` : ''}`);
  }
  return target;
}

module.exports = {
  ensureExecutable,
  ffmpegPath,
  ffprobePath,
  probeVideo,
  computeTarget,
  buildFilter,
  encodeMerge,
  run,
};
