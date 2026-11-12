# Video Merger API v2 — خدمة دمج مقاطع الفيديو

واجهة برمجية عامة + موقع عربي لدمج حتى **10 مقاطع فيديو** في ملف MP4 واحد عالي الجودة (H.264 + AAC، حتى 1080p، CRF 18)، جاهزة للنشر على Vercel بدون أي خدمة خارجية: المعالجة داخل الدالة بـ ffmpeg والتخزين كاملًا في قاعدة **Turso** (libSQL).

- **بلا تسجيل دخول** و**CORS مفتوح** — صالحة للاستخدام من أي عميل أو متصفح.
- **بلا مفاتيح** — الحماية بالحدود الزمنية والحجمية فقط.
- كل الملفات تُحذف تلقائيًا بعد **24 ساعة**.

## النشر على Vercel خطوة بخطوة

1. أنشئ قاعدة Turso مجانية من [turso.tech](https://turso.tech) (أو عبر CLI):
   ```bash
   turso db create merger-db
   turso db show merger-db --url        # ← TURSO_DATABASE_URL
   turso db tokens create merger-db     # ← TURSO_AUTH_TOKEN
   ```
2. في Vercel: **Add New → Project** → اختر هذا المستودع.
3. في إعدادات الاستيراد اجعل **Root Directory = `video-merger`** (Framework Preset: Other).
4. أضف متغيرَي البيئة في **Settings → Environment Variables**:
   | المتغير | القيمة |
   |---|---|
   | `TURSO_DATABASE_URL` | `libsql://<db>-<org>.turso.io` |
   | `TURSO_AUTH_TOKEN` | الرمز من الخطوة 1 |
5. اضغط **Deploy**. الجداول تُنشأ تلقائيًا عند أول طلب (`CREATE TABLE IF NOT EXISTS`).

### التشغيل المحلي
```bash
npm install
cp .env.example .env   # ثم ضع قيم Turso الحقيقية
npm run dev            # http://127.0.0.1:3200
npm run test:unit      # اختبارات وحدة (ffmpeg + الأجزاء)
npm run test:http      # اختبار HTTP شامل ضد خادم التطوير
```

## واجهة الموقع

الصفحة الرئيسية (`/`) عربية RTL بثيم داكن، وتتيح:
- إضافة روابط فيديو مباشرة، أو سحب وإفلات ملفات من الجهاز (mp4/mov/webm/mkv/avi/m4v/mpg/3gp).
- إعادة ترتيب المصادر بالسحب أو أزرار ↑↓ — **ترتيب القائمة = ترتيب الدمج**.
- زر «دمج الفيديوهات» ينفذ التدفق كاملًا مع شريط تقدم حقيقي وإعادة محاولة تلقائية لأي جزء رفع يفشل.
- صفحة نتيجة: مشغل فيديو، الحجم/المدة/الدقة، تحميل، نسخ الرابط، وعدّاد تنازلي حتى انتهاء الصلاحية (24 ساعة).
- قسم «توثيق API» قابل للطي بأمثلة curl جاهزة على دومينك الحقيقي.
- استئناف العرض بعد تحديث الصفحة عبر `#job=<id>`.

## توثيق API

كل الردود بتررويسات CORS مفتوحة، والأخطاء بصيغة `{"error":"رسالة عربية"}` مع الكود المناسب (400/404/405/409/413/500).

### `POST /api/jobs` — إنشاء مهمة دمج
```bash
curl -X POST https://<domain>/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/a.mp4","https://example.com/b.mp4"]}'
```
```json
{
  "jobId": "wkucdefoxwvd",
  "status": "queued",
  "statusUrl": "https://<domain>/api/jobs/wkucdefoxwvd",
  "processUrl": "https://<domain>/api/jobs/wkucdefoxwvd/process",
  "expiresAt": "2026-11-13T20:00:00.000Z"
}
```
- يقبل بدلًا من `videos` حقل `sources`: `[{"kind":"url","url":"..."},{"kind":"file","name":"clip.mp4","size":123,"mime":"video/mp4"}]` — ومع وجود ملفات تُعاد قائمة `uploads[]` تحوي رابط رفع لكل مصدر و`uploadChunkBytes` (4MB) والحالة `uploading`.

### `POST /api/upload?job=<id>&seq=<n>&chunk=<k>` — رفع أجزاء الملفات
جسم ثنائي خام (`application/octet-stream`) بحد **4MB** للجزء، أجزاء متتالية تبدأ من `chunk=0`، والرد `204`. حد الطلب في Vercel ≈ 4.5MB لذلك الرفع أجزاء إلزامًا.

### `POST /api/jobs/<id>/process` — تنفيذ الدمج (متزامن)
```bash
curl -X POST https://<domain>/api/jobs/<id>/process
```
نجاح:
```json
{"status":"done","videoUrl":"https://<domain>/api/jobs/<id>/video",
 "downloadUrl":"https://<domain>/api/jobs/<id>/video?download=1",
 "size":3408374,"duration":20,"resolution":"640x360","expiresAt":"..."}
```
- المهمة قيد المعالجة بالفعل → `202`. فشل → `500` مع `{"error":"..."}` (مثل مصدر يرفض التحميل — فشل حتمي).
- التقدم داخل المهمة: 0–40 جلب المصادر، 40–90 ترميز، 100 اكتمال.

### `GET /api/jobs/<id>` — حالة المهمة
```json
{"jobId":"...","status":"done","progress":100,"videoUrl":"...","downloadUrl":"...",
 "error":null,"expiresAt":"...","size":...,"duration":...,"resolution":"...","sources":[...]}
```
الحالات: `queued` → (`uploading`) → `processing` → `done` | `failed`.

### `GET /api/jobs/<id>/video` — بث الناتج
- يدعم **Range** كاملًا (`206` + `Content-Range`) للتقديم/الترجيع في المشغل.
- `?download=1` للتحميل المباشر (`Content-Disposition: attachment`).

### `DELETE /api/jobs/<id>` — حذف فوري شامل
```bash
curl -X DELETE https://<domain>/api/jobs/<id>   # → {"deleted":true}
```

### `GET /api/config` — الحدود العامة
```json
{"version":"2.0","maxSources":10,"sourceMaxMB":200,"outputMaxMB":150,
 "maxTotalDurationSec":600,"uploadChunkBytes":4194304,"retentionHours":24}
```

### `GET /api/cron` — تنظيف المهام المنتهية
مجدول يوميًا في `vercel.json` (3 صباحًا UTC)، ويعمل أيضًا كسولًا عند كل إنشاء/دمج.

## محرك الدمج (الجودة)

- ffprobe لكل مصدر، ثم توحيد الجميع: `scale+pad` لأكبر دقة بين المدخلات (حد أقصى 1920×1080 بأبعاد زوجية)، `fps=30`، `setsar=1`، `yuv420p`، ثم `concat=n=:v=1:a=1`.
- مصدر بلا صوت → مسار صامت `anullsrc` بنفس مدته بدل فشل الدمج.
- الترميز: `libx264 CRF 18` + `AAC 192k/44100Hz` + `+faststart` → MP4 يعمل فورًا على الويب.
- تقدم الترميز يُقرأ من `-progress pipe:1` ويُخزن في القاعدة.
- التخزين: الناتج يُقسم أجزاء 2MB في `output_chunks` ويُبث صفحات من 8 صفوف؛ وأجزاء المصادر تُحذف بعد نجاح الدمج.

## الحدود ومتغيرات البيئة

| المتغير | الافتراضي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | — | إلزامي |
| `TURSO_AUTH_TOKEN` | — | إلزامي |
| `MAX_SOURCES` | 10 | أقصى عدد مقاطع |
| `SOURCE_MAX_MB` | 200 | حد كل مصدر |
| `OUTPUT_MAX_MB` | 150 | حد حجم الناتج |
| `MAX_TOTAL_DURATION_SEC` | 600 | مجموع مدد المقاطع |
| `FFMPEG_PRESET` | medium | سرعة/جودة الترميز |

**ملاحظات الخطة المجانية:** مدة الدالة مضبوطة 300 ثانية (`maxDuration`)، حد الطلب 4.5MB (لذا الرفع أجزاء)، `/tmp` مؤقت ويُنظف في `finally`، وتخزين Turso المجاني ~5GB — الحذف التلقائي بعد 24 ساعة يحافظ عليه.
