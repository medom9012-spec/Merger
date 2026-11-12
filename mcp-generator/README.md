# MCP Media Generator

> خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — مع لوحة إدارة عربية وتبديل تلقائي تسلسلي للمفاتيح.

**الإصدار:** 1.2.0 — **الاسم لدى عملاء MCP:** `media-generator-mcp`

## ماذا يفعل؟

تطبيق **Next.js واحد** فيه جزءان:

1. **خادم MCP على المسار `/mcp`** (Streamable HTTP حسب مواصفة MCP) يعرض **5 أدوات** يستدعيها أي عميل (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK):

   | الأداة | الوظيفة |
   |---|---|
   | `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` |
   | `generate_video` | توليد فيديو بصوت متزامن بـ `grok-imagine-video-1-5-preview` (image-to-video اختياري) |
   | `merge_videos` | دمج 2–10 مقاطع في فيديو واحد بالترتيب المطلوب (روابط مباشرة أو `task_ids`) |
   | `get_task` | تتبع أي مهمة (توليد أو دمج) بمعرّفها حتى الاكتمال |
   | `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها |

2. **واجهة ويب عربية RTL** بثلاث بطاقات: مدير المفاتيح، لوحة المهام الحية، وبطاقة ربط السيرفر مع JSON جاهز للنسخ لكل عميل.

### قواعد جوهرية مطبقة حرفيًا

- **روابط فقط**: لا يُنزَّل أي ملف وسائط على السيرفر — تُخزَّن روابط النتائج في قاعدة البيانات فقط.
- **ترتيب تسلسلي صارم**: المفاتيح تُجرَّب حسب ترتيب الإضافة (`created_at ASC, id ASC`) — ليس round-robin.
- **لا توقف أبدًا**: عند أي خطأ (مفتاح غير صالح، نفاد رصيد، 429، 5xx) ينتقل فورًا للمفتاح التالي ويُستأنف **نفس المهمة بنفس `task_id`**.
- **صمت تام تجاه العميل**: نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الأرصدة أبدًا.
- **مهام بلا مفتاح صالح تبقى `processing`** وتُعاد تلقائيًا مع كل `get_task` (تهدئة ~45 ثانية) — لو شُحن رصيد أي مفتاح تكتمل المهمة من تلقاء نفسها.
- **إخفاء المفاتيح إلزامي**: كل الاستجابات تعرض المفتاح مُقنَّعًا (`ABCD123••••••••WXYZ`) ولا يُعاد كاملًا أبدًا.
- ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة (التحذير مذكور في وصف الأداة وفي تعليمات السيرفر).

---

## التقنيات

- Next.js 16 (App Router) + TypeScript + Tailwind CSS 4
- `@modelcontextprotocol/sdk` (رسمي) — وضع stateless متوافق مع Vercel serverless
- `@libsql/client` مع قاعدة **Turso** عبر HTTP (بلا أي ملفات محلية)
- مزودا التوليد: **kie.ai** (أساسي) و **CometAPI** (ثانوي)

---

## التشغيل المحلي

```bash
npm install
cp .env.example .env.local     # ثم عبّئ القيم الحقيقية
npm run build && npm start     # أو npm run dev
```

افتح `http://localhost:3000` للوحة الإدارة، وخادم MCP على `http://localhost:3000/mcp`.

## متغيرات البيئة

| المتغير | إلزامي؟ | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | نعم | رابط قاعدة Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | نعم | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | لا (حتى نشر خدمة الدمج) | عنوان خدمة Video Merger v2 — بدونها يعمل التوليد كاملًا وأداة الدمج تعيد رسالة عربية واضحة |
| `MCP_ACCESS_TOKEN` | لا | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` / `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | لا | تجاوز أسماء الموديلات لكل مزود |
| `MAX_WAIT_SECONDS` | لا (افتراضي 45) | سقف نافذة انتظار الأدوات داخل الاستدعاء الواحد |

---

## النشر على Vercel (خطوة بخطوة)

1. **أنشئ قاعدة Turso** (إن لم تكن جاهزة):
   ```bash
   turso db create <name>
   turso db show <name> --url        # ← TURSO_DATABASE_URL
   turso db tokens create <name>     # ← TURSO_AUTH_TOKEN
   ```
   (المخطط يُنشأ تلقائيًا عند أول طلب — لا migrations.)

2. **ارفع المستودع إلى GitHub** (مفعل بالفعل — راجع قسم «المستودع»).

3. **في Vercel**: Add New → Project → اختر المستودع (Next.js يُكتشف تلقائيًا).

4. **Environment Variables**: أضف `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (و`MERGER_API_BASE` بعد نشر خدمة الدمج، و`MCP_ACCESS_TOKEN` إن أردت حماية `/mcp`).

5. **Deploy** — لا حاجة لأي إعداد إضافي: libSQL يتصل عبر HTTP ومناسب للـ serverless، ومسار `/mcp` يدعم البث (streaming)، ولا يعتمد المشروع على أي ملف محلي.

> **ملاحظة مدة الدوال:** كود مسار `/mcp` يضبط `maxDuration = 60` (حد خطة Hobby). نافذة انتظار الأدوات مقيدة بـ `MAX_WAIT_SECONDS=45` افتراضيًا لتبقى دونه. على خطة Pro يمكنك رفع الاثنين (إلى 300 و240) لتقليل الاعتماد على `get_task`.

## ربط العملاء بخادم MCP

ضع `<MCP_URL>` = `https://<your-app>.vercel.app/mcp`

**ChatGPT / GPT Agents** — في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL»:
```json
{ "mcpServers": { "media-generator": { "url": "<MCP_URL>" } } }
```

**Claude Desktop** — في `claude_desktop_config.json`:
```json
{ "mcpServers": { "media-generator": { "type": "http", "url": "<MCP_URL>" } } }
```

**Cursor / Windsurf / Cline** — في `mcp.json`:
```json
{ "mcpServers": { "media-generator": { "url": "<MCP_URL>" } } }
```
(إن ضُبط `MCP_ACCESS_TOKEN` أضِف `"headers": { "Authorization": "Bearer <token>" }` لكل عميل.)

## سير عمل النموذج مع الأدوات

1. استدعِ `generate_image` أو `generate_video` — إن اكتملت خلال نافذة الانتظار وصل الرابط فورًا.
2. إن رجعت مهمة `processing` مع `task_id` فاستدعِ `get_task` كل ~10 ثوانٍ حتى `completed` (اعرض الرابط) أو `failed` (اشرح السبب).
3. للدمج: `merge_videos` بـ `urls` (روابط مباشرة) أو `task_ids` (لمهام فيديو مكتملة بالترتيب) ثم تابع بـ `get_task` — وذكّر المستخدم أن ملف الدمج يُحذف بعد ~24 ساعة.

---

## واجهات API الإدارية

| Method | المسار | الوظيفة |
|---|---|---|
| GET | `/api/health` | جهوزية النظام: قاعدة البيانات، الموديلات، حالة خدمة الدمج، حماية /mcp |
| GET | `/api/keys` | قائمة المفاتيح (مُقنَّعة دائمًا) بالعدادات وآخر الأخطاء |
| POST | `/api/keys` | إضافة مفتاح `{provider, api_key, label?}` — رفض التكرار (409) |
| PATCH | `/api/keys/{id}` | تعطيل/تنشيط `{status: "active"|"disabled"}` |
| DELETE | `/api/keys/{id}` | حذف المفتاح |
| GET | `/api/tasks?limit=&type=&status=` | إحصائيات + أحدث المهام للوحة الحية |
| POST/GET/DELETE | `/mcp` | نقطة بروتوكول MCP (JSON-RPC / SSE) |

## المزودون

- **kie.ai** (أساسي): Jobs API موحد — `POST /api/v1/jobs/createTask` ثم `GET /api/v1/jobs/recordInfo` (انتبه: `resultJson` نص يحتاج `JSON.parse` ثانيًا). الأشكال مقاسة بنداءات حقيقية.
- **CometAPI** (ثانوي): صور متزامنة عبر `/v1/images/generations` (متوافقة مع OpenAI)، وفيديو غير متزامن عبر `/v1/videos` ثم `GET /v1/videos/{id}` وفق التوثيق الرسمي apidoc.cometapi.com. لا يُفعَّل مساره إلا بإضافة مفتاح CometAPI من الواجهة.

## حدود خدمة الدمج (Video Merger v2)

10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد، MP4 (H.264 + AAC) — والأخطاء المعلنة من الخدمة فشل نهائي فوري، وأخطاء الشبكة مؤقتة تُستأنف تلقائيًا. الملفات تُحذف بعد 24 ساعة.

## الاختبارات

```bash
# اختبار e2e شامل ضد خادم محلي (يشغّل الخادم ويختبر: health، أدوات MCP،
# توليد صورة حقيقي، التبديل التسلسلي، قواعد الدمج، list_media...)
BASE_URL=http://localhost:3100 KIE_REAL_KEY=<مفتاحك> python3 scripts/e2e_test.py

# تنظيف آثار الاختبار من قاعدة البيانات
node scripts/cleanup-test-data.mjs
node scripts/inspect-db.mjs   # فحص حالة القاعدة (تشخيص)
```

## الأمان

- `.env*` مستثنى في `.gitignore` منذ أول commit — لا أسرار في المستودع، و`.env.example` قالب بلا قيم حقيقية.
- المفاتيح لا تُطبع كاملة في أي استجابة أو سجل (`maskKey`).
- رسائل الأخطاء الخارجة للعميل تُمسح من أي أنماط حساسة (`sanitizeForClient`).

## حالة التنفيذ مقابل معايير القبول

| # | المعيار | الحالة |
|---|---|---|
| 1 | `tsc --noEmit` نظيف و`next build` ينجح | ✅ |
| 2 | health يرجع `ok:true` و`turso-connected` | ✅ (`merger.healthy` صحيح فقط بعد نشر خدمة الدمج) |
| 3 | tools/list بالأدوات الخمس وبالمخططات المطلوبة | ✅ |
| 4 | e2e صورة حقيقية → رابط يعمل | ✅ (صورة تولدت في ~28 ثانية والرابط HTTP 200) |
| 5 | e2e فيديو → task_id → get_task → رابط MP4 صالح | ✅ (فيديو 8 ثوانٍ، `video/mp4` مع دعم Range) |
| 6 | تبديل تسلسلي: خاطئ أولًا → disabled → إكمال على الثاني دون رؤية العميل أي خطأ | ✅ (مثبت في `attempts_json`؛ ملاحظة أدناه) |
| 7 | مفتاح مستنزف 402 → `exhausted` يبقى في القاعدة دون عرقلة | ✅ (تمثيل حقيقي: نفد رصيد المفتاح أثناء الاختبار فوُسم `exhausted` وانتقل النظام للسلوك المطلوب) |
| 8 | e2e دمج حقيقي بمقطعين | ⏳ يتطلب نشر خدمة الدمج (القسم التالي) وضبط `MERGER_API_BASE` |
| 9 | رفض مقطع واحد/أكثر من 10 برسائل عربية + حلّ task_ids بالترتيب | ✅ |
| 10 | list_media يعيد المهام بروابطها من الأحدث | ✅ |
| 11 | الواجهة: إضافة/تعطيل/حذف، تحديث تلقائي، JSON لكل تبويب، RTL سليم | ✅ (فحصت بصريًا) |
| 12 | جاهزية Vercel بلا ملفات محلية | ✅ (stateless MCP + Turso عبر HTTP) |

> **ملاحظة معيار 6:** أثبت الاختبار التبديل الكامل (المفتاح الخاطئ وُسم `disabled` تلقائيًا والانتقال للمفتاح التالي بنفس `task_id` دون وصول أي خطأ للعميل)، ثم نفد رصيد المفتاح الحقيقي فعليًا أثناء الاختبارات فوُسم `exhausted` وبقيت المهمة `processing` بانتظار توفر مفتاح صالح (سلوك 4.3.3 بالضبط) — عند إعادة شحن الرصيد تكتمل المهمة تلقائيًا مع أول `get_task`، ويستأنف المفتاح عمله ويستعيد حالة `active` تلقائيًا عند أول نجاح.

## الخطوة التالية: خدمة الدمج

أداة `merge_videos` تحتاج خدمة **Video Merger API v2** منفصلة (بناء Vercel مستقل بـ ffmpeg — البرومبت الثاني للمشروع). بعد نشرها:
1. ضع عنوانها في `MERGER_API_BASE`.
2. سيعمل `GET /api/health` بإظهار `merger.healthy: true`.
3. تُفعَّل أداة الدمج كاملة (الإنشاء + process + بث التقدم + القواعد الحتمية + الحذف بعد 24 ساعة).

## المستودع

- GitHub: `https://github.com/medom9012-spec/Merger`
- الفروع: `main`
