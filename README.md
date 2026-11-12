# Merger — منصة الوسائط بالذكاء الاصطناعي

مستودع يحوي مشروعين جاهزين للنشر على Vercel:

| المشروع | الوصف | المسار |
|---|---|---|
| **MCP Media Generator** | خادم MCP (Streamable HTTP) لتوليد الصور والفيديو بالذكاء الاصطناعي + دمج المقاطع، مع لوحة إدارة عربية RTL | [`mcp-generator/`](./mcp-generator) |
| **Video Merger API v2** | خدمة دمج مقاطع الفيديو (API عامة + واجهة عربية) تعمل بـ ffmpeg داخل دوال Vercel Serverless مع تخزين Turso | [`video-merger/`](./video-merger) |

المشروعان مستقلان، لكن الأفضل ربطهما: انشر **video-merger** أولًا ثم ضع رابطه في متغير `MERGER_API_BASE` لمشروع **mcp-generator** لتعمل أداة `merge_videos`.

## النشر السريع على Vercel

1. ارفع هذا المستودع إلى GitHub (مرفوع مسبقًا).
2. في Vercel: **Add New → Project** واختر المستودع.
3. **للمشروع الأول (الدمج):** في إعدادات الاستيراد اجعل **Root Directory = `video-merger`** ثم أضف متغيرَي البيئة:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
4. **للمشروع الثاني (MCP):** أعد الاستيراد مرة ثانية بـ **Root Directory = `mcp-generator`** وأضف:
   - `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (نفس القاعدة)
   - `MERGER_API_BASE` = رابط مشروع الدمج بعد نشره (مثل `https://video-merger-xxx.vercel.app`)
5. بعد النشر: افتح لوحة مشروع MCP، أضف مفاتيح مزودي التوليد من واجهة الإدارة، واربط أي عميل MCP على الرابط `<رابط-المشروع>/mcp`.

> لا توجد أي أسرار في هذا المستودع — كل المفاتيح تُدار عبر متغيرات البيئة أو لوحة الإدارة.

## الروابط

- توثيق MCP الكامل والأدوات الخمس: [`mcp-generator/README.md`](./mcp-generator/README.md)
- توثيق API الدمج الكامل: [`video-merger/README.md`](./video-merger/README.md)
