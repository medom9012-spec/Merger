# Merger — منصة الوسائط بالذكاء الاصطناعي

مستودع يحوي مشروعين جاهزين للنشر على Vercel:

| المشروع | الوصف | المسار |
|---|---|---|
| **MCP Media Generator** | خادم MCP (Streamable HTTP) لتوليد الصور والفيديو بالذكاء الاصطناعي + دمج المقاطع، مع لوحة إدارة عربية RTL وتبديل تسلسلي تلقائي للمفاتيح | [`mcp-generator/`](./mcp-generator) |
| **Video Merger API v2** | خدمة دمج مقاطع الفيديو (API عامة + واجهة عربية) تعمل بـ ffmpeg داخل دوال Vercel Serverless مع تخزين Turso | [`video-merger/`](./video-merger) |

المشروعان مستقلان، لكن الأفضل ربطهما: انشر **video-merger** أولًا ثم ضع رابطه في متغير `MERGER_API_BASE` لمشروع **mcp-generator** لتعمل أداة `merge_videos`.

## النشر السريع على Vercel

1. في Vercel: **Add New → Project** واختر هذا المستودع.
2. **للمشروع الأول (الدمج):** في إعدادات الاستيراد اجعل **Root Directory = `video-merger`** ثم أضف متغيرَي البيئة:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
3. **للمشروع الثاني (MCP):** أعد الاستيراد مرة ثانية بـ **Root Directory = `mcp-generator`** وأضف:
   - `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (نفس القاعدة أو قاعدة أخرى)
   - `MERGER_API_BASE` = رابط مشروع الدمج بعد نشره (مثل `https://video-merger-xxx.vercel.app`)
4. بعد النشر: افتح لوحة مشروع MCP، أضف مفاتيح مزودي التوليد من واجهة الإدارة، واربط أي عميل MCP على الرابط `<رابط-المشروع>/mcp`.

> لا توجد أي أسرار في هذا المستودع — كل المفاتيح تُدار عبر متغيرات البيئة أو لوحة الإدارة، و`.env*` مستثنى منذ أول commit.

## ما الذي تم اختباره فعليًا (mcp-generator)

- توليد صورة حقيقي عبر kie.ai اكتمل في ~28 ثانية مع بث تقدم حي (7 إشعارات progress) ورابط صورة يعمل (HTTP 200).
- توليد فيديو حقيقي: `generate_video` أعاد `task_id` فورًا واكتمل عبر `get_task` برابط MP4 صالح (`video/mp4` مع دعم Range).
- التبديل التسلسلي للمفاتيح مثبت في `attempts_json`: مفتاح خاطئ أُضيف أولًا ووسم `disabled` تلقائيًا (401)، والانتقال للمفتاح التالي بنفس `task_id` دون وصول أي ذكر للمفاتيح/الأرصدة إلى العميل، والمفتاح المستنزف (رسالة "Credits insufficient") وسم `exhausted` وبقي في القاعدة دون عرقلة.
- قواعد الدمج: رفض مقطع واحد وأكثر من 10 برسائل عربية، وحلّ `task_ids` بالترتيب، والاستئناف التلقائي عند تعذر الوصول للخدمة.
- `tsc --noEmit` نظيف و`next build` ينجح، والواجهة فحصت بصريًا (RTL كامل).

## الروابط

- توثيق MCP الكامل والأدوات الخمس وحالة معايير القبول: [`mcp-generator/README.md`](./mcp-generator/README.md)
- توثيق API الدمج الكامل: [`video-merger/README.md`](./video-merger/README.md)
