# MCP Media Generator — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم **MCP** (Model Context Protocol — نقل Streamable HTTP) يعرض **5 أدوات** لأي عميل (ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK)، مع **لوحة إدارة عربية RTL** لإدارة المفاتيح ومتابعة المهام حية.

**القدرات الثلاث:**
1. **توليد صور** — الموديل `gpt-image-2-6/flare-text-to-image`.
2. **توليد فيديو بصوت متزامن** — الموديل `grok-imagine-video-1-5-preview`.
3. **دمج مقاطع فيديو** في ملف واحد بالترتيب المطلوب (عبر خدمة Video Merger API v2).

## القواعد الجوهرية

- **روابط فقط**: لا يُنزَّل أي ملف وسائط إلى السيرفر — تُخزن روابط النتائج في Turso فقط.
- **تبديل تسلسلي صارم للمفاتيح**: أول مفتاح أُضيف يُجرَّب أولًا (`created_at ASC, id ASC`) — عند أي خطأ (نفاد رصيد، مفتاح فاشل، 429/5xx) يُنتقل **فورًا وصامتةً** للمفتاح التالي مع استئناف **نفس المهمة بنفس `task_id`**. عميل الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا.
- **بلا توقف**: مهمة فشل إنشاؤها على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة 45 ثانية) — لو شُحن رصيد أي مفتاح تكتمل من تلقاء نفسها.
- المهمة غير متزامنة: الأداة تعيد النتيجة فورًا إن اكتملت خلال نافذة الانتظار، وإلا تعيد `task_id` ويُتابع بـ `get_task` كل ~10 ثوانٍ.
- إخفاء المفاتيح إلزامي في كل الاستجابات (`maskKey`).
- ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة (تُذكَّر في ردود الأدوات).

## الأدوات الخمس

| الأداة | الوصف |
|---|---|
| `generate_image` | توليد صورة (`prompt` إلزامي + aspect_ratio/resolution/background/output_format/wait_seconds) — تعيد الرابط جاهزًا أو `task_id`. |
| `generate_video` | توليد فيديو بصوت متزامن (prompt/image_url اختياري لـ image-to-video/resolution 480p–1080p/duration 1–15 ثانية) — يحتاج دقائق. |
| `merge_videos` | دمج مقاطع بالترتيب: `urls` روابط مباشرة أو `task_ids` لمهام فيديو مكتملة (تُحل روابطها من القاعدة بالترتيب). من 2 إلى 10 مقاطع. |
| `get_task` | تتبع أي مهمة (توليد أو دمج) — يحدّث من المزود/خدمة الدمج حيًّا ويعيد صياغة عربية جاهزة للعرض. |
| `list_media` | أحدث الوسائط المخزنة بروابطها (مع فلترة type/status وlimit حتى 50). |

جميع نتائج الأدوات **بالعربية**: مكتملة → `✅ تم توليد ...` + الروابط، جارية → `⏳ المهمة قيد المعالجة — task_id: ...`، فاشلة → `❌ فشلت المهمة: <السبب>`.

## ربط أي عميل MCP

الرابط: `<origin>/mcp` (POST لرسائل JSON-RPC، وضع عديم الحالة — لا حاجة لإدارة جلسات).

**ChatGPT (Connectors):** Settings → Connectors → Create → Custom MCP server → ضع الرابط في «Server URL».
```json
{"mcpServers":{"media-generator":{"url":"https://<your-app>.vercel.app/mcp"}}}
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{"mcpServers":{"media-generator":{"type":"http","url":"https://<your-app>.vercel.app/mcp"}}}
```

**Cursor / Windsurf / Cline** (`mcp.json`): نفس صيغة ChatGPT أعلاه.

> إن ضُبط `MCP_ACCESS_TOKEN` يُطلب الترويسة `Authorization: Bearer <token>` وتُضاف حقل `headers` في كل الصيغ أعلاه.

### اختبار سريع بـ curl
```bash
# التهيئة
curl -s -X POST https://<domain>/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# قائمة الأدوات
curl -s -X POST https://<domain>/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# استدعاء أداة
curl -s -X POST https://<domain>/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"a cute robot","wait_seconds":90}}}'
```

## لوحة الإدارة (الصفحة الرئيسية)

- **مدير المفاتيح**: إضافة مفاتيح لكل مزود (kie.ai / CometAPI) مع تسمية، إخفاء دائم للمفاتيح (`ABCD123••••••••WXYZ`)، شارات حالة (active أخضر / exhausted كهرماني / disabled رمادي)، عدّادات استخدام/نجاح/فشل، تعطيل–تنشيط–حذف. المستنزف يبقى في القاعدة ولا يعيق المفاتيح التالية.
- **لوحة المهام**: شرائح إحصائيات (إجمالي/مكتملة/فاشلة/جارية) + أحدث المهام تتحدث تلقائيًا كل 5 ثوانٍ مع شريط التقدم وعدد المحاولات وأزرار فتح الروابط.
- **بطاقة الربط**: رابط `/mcp` بزر نسخ + ثلاث تبويبات JSON جاهزة (ChatGPT / Claude Desktop / Cursor) + رقائق الأدوات الخمس + ملاحظة الانتظار والبث.

## المزودون

- **kie.ai** (أساسي): Jobs API موحّد — `POST /api/v1/jobs/createTask` ثم `GET /api/v1/jobs/recordInfo` (لاحظ أن `resultJson` نص يحتاج `JSON.parse` ثانيًا). مفتاح واحد يكفي للبداية.
- **CometAPI** (ثانوي): صور متزامنة عبر نقطة متوافقة مع OpenAI + مهام فيديو غير متزامنة بنفس النمط.
- أسماء الموديلات قابلة للتجاوز بمتغيرات البيئة (`KIE_IMAGE_MODEL`, `KIE_VIDEO_MODEL`, `COMETAPI_IMAGE_MODEL`, `COMETAPI_VIDEO_MODEL`).

**تصنيف الأخطاء التلقائي** (`classifyProviderError`): `disabled` (401/403) → تعطيل المفتاح والانتقال للتالي؛ `exhausted` (402 أو رسائل نفاد الرصيد — تُفحص قبل 400) → تعليم exhausted والانتقال؛ `provider` (موديل غير مدعوم) → الانتقال؛ `params` (400/422) → توقف فوري (تبديل المفاتيح لا يصلح معطيات)؛ `temporary` (429/5xx/شبكة) → الانتقال.

## النشر على Vercel

1. في Vercel: **Add New → Project** → اختر المستودع واجعل **Root Directory = `mcp-generator`** (يُكتشف Next.js تلقائيًا).
2. أضف متغيرات البيئة في **Settings → Environment Variables**:
   | المتغير | إلزامي | الوصف |
   |---|---|---|
   | `TURSO_DATABASE_URL` | ✅ | رابط قاعدة Turso |
   | `TURSO_AUTH_TOKEN` | ✅ | رمز قاعدة Turso |
   | `MERGER_API_BASE` | للدمج فقط | رابط خدمة الدمج المنشورة (Video Merger API v2) |
   | `MCP_ACCESS_TOKEN` | اختياري | يطلب Bearer token على `/mcp` |
   | `KIE_IMAGE_MODEL` … | اختياري | تجاوز أسماء الموديلات |
3. Deploy. الجداول تُنشأ تلقائيًا، ومسار `/mcp` يدعم البث (maxDuration 300 ثانية).

### التشغيل المحلي
```bash
npm install
cp .env.example .env.local   # ضع القيم الحقيقية
npm run dev                  # http://127.0.0.1:3100
npm run build && npm start   # وضع الإنتاج محليًا
npx tsc --noEmit             # فحص الأنواع
```

## البنية

```
src/
├── app/
│   ├── mcp/route.ts            # نقطة MCP (stateless Streamable HTTP)
│   ├── api/health/route.ts     # فحص الحالة (DB + الموديلات + خدمة الدمج)
│   ├── api/keys/…              # CRUD للمفاتيح (إخفاء دائم)
│   ├── api/tasks/route.ts      # تغذية لوحة المهام
│   ├── layout.tsx              # RTL + خط عربي
│   └── page.tsx                # لوحة الإدارة الثلاثية
└── lib/
    ├── turso.ts                # العميل + المخطط + عمليات المهام والمفاتيح
    ├── models.ts               # سجل الموديلات والأسماء البديلة
    ├── errors.ts               # تصنيف أخطاء المزودين
    ├── providers/              # kie + cometapi (واجهة موحدة)
    ├── merger.ts               # عميل Video Merger API v2
    ├── coordinator.ts          # runGeneration / refreshTask / runMerge (التبديل التسلسلي)
    └── mcp/server.ts           # McpServer + الأدوات الخمس
```

**ملاحظة تقنية:** الوضع عديم الحالة (`sessionIdGenerator: undefined` + `enableJsonResponse: true`) مقصود — إلزامي للعمل الموثوق على دوال Vercel Serverless ومع ChatGPT Connectors، والتقدم يُضمَّن في ردود `get_task` بدل بث SSE.
