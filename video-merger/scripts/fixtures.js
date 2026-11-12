// توليد مقاطع فيديو اختبارية صغيرة باستخدام ffmpeg-static (تُستخدم في الاختبارات ومسار /fixtures)
'use strict';

const fs = require('fs');
const path = require('path');
const { ffmpegPath, run } = require('../lib/ffmpeg');

// مقطعان: 320x240 بمدة 3 ثوان مع نغمة صوت، و640x360 بمدة ثانيتين صامت
async function makeTestVideos(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, 'test-a-320x240-3s.mp4');
  const b = path.join(dir, 'test-b-640x360-2s.mp4');
  const r1 = await run(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    a,
  ]);
  if (r1.code !== 0) throw new Error('فشل توليد المقطع الأول: ' + r1.stderr.slice(-400));
  const r2 = await run(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    b,
  ]);
  if (r2.code !== 0) throw new Error('فشل توليد المقطع الثاني: ' + r2.stderr.slice(-400));
  return [a, b];
}

module.exports = { makeTestVideos };
