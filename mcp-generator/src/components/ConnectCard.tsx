"use client";

// ============================================================
// البطاقة ج) ربط السيرفر — رابط /mcp + JSON جاهز للنسخ لكل عميل
// + رقائق الأدوات الخمس + ملاحظة الفيديو الكهرمانية
// ============================================================
import { useEffect, useMemo, useState } from "react";

const TOOLS: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي مع تبديل تلقائي عبر كل المفاتيح النشطة" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن من وصف، مع صورة بداية اختيارية" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد نهائي بالترتيب المعطى" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها — توليد أو دمج — حتى اكتمالها" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها من قاعدة البيانات" },
];

export default function ConnectCard({ mcpPath }: { mcpPath: string }) {
  const [origin, setOrigin] = useState("");
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [copied, setCopied] = useState<string>("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const mcpUrl = `${origin}${mcpPath}`;

  const jsons = useMemo(() => {
    return {
      chatgpt: {
        label: "ChatGPT / GPT Agents",
        json: JSON.stringify({ mcpServers: { "media-generator": { url: "__MCP_URL__" } } }, null, 2),
        hint: "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».",
      },
      claude: {
        label: "Claude Desktop",
        json: JSON.stringify(
          { mcpServers: { "media-generator": { type: "http", url: "__MCP_URL__" } } },
          null,
          2,
        ),
        hint: "الصق الإعداد في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.",
      },
      cursor: {
        label: "Cursor / Windsurf / Cline",
        json: JSON.stringify({ mcpServers: { "media-generator": { url: "__MCP_URL__" } } }, null, 2),
        hint: "الصق الإعداد في ملف mcp.json داخل إعدادات المحرر.",
      },
    };
  }, []);

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text.replaceAll("__MCP_URL__", mcpUrl));
      setCopied(tag);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      /* المتصفح منع النسخ */
    }
  }

  const current = jsons[tab];

  return (
    <section className="rounded-2xl border border-card-border bg-card p-4 sm:p-6">
      <h2 className="mb-4 text-base font-extrabold sm:text-lg">
        <span className="me-2 text-accent">ج)</span> ربط السيرفر
      </h2>

      {/* حقل الرابط المطلق + نسخ */}
      <div className="mb-5 flex flex-col gap-2 sm:flex-row">
        <input
          readOnly
          dir="ltr"
          value={mcpUrl}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full rounded-xl border border-card-border bg-[#0d1428] px-3 py-2.5 text-left font-mono text-sm text-cyan-300 outline-none"
          aria-label="رابط خادم MCP"
        />
        <button
          onClick={() => void copy(mcpUrl, "url")}
          className="shrink-0 rounded-xl border border-card-border px-4 py-2.5 text-sm font-bold transition hover:border-accent hover:text-accent"
        >
          {copied === "url" ? "تم النسخ ✓" : "نسخ الرابط"}
        </button>
      </div>

      {/* تبويبات JSON */}
      <div className="mb-2 flex flex-wrap gap-2">
        {(Object.keys(jsons) as (keyof typeof jsons)[]).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              tab === k
                ? "bg-gradient-to-l from-cyan-400 to-violet-500 text-[#0b1020]"
                : "border border-card-border text-muted hover:text-foreground"
            }`}
          >
            {jsons[k].label}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-card-border bg-[#0d1428] p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted">{current.hint}</p>
          <button
            onClick={() => void copy(current.json, tab)}
            className="shrink-0 rounded-lg border border-card-border px-3 py-1 text-xs font-bold transition hover:border-accent hover:text-accent"
          >
            {copied === tab ? "تم النسخ ✓" : "نسخ"}
          </button>
        </div>
        <pre
          dir="ltr"
          className="scroll-slim max-h-56 overflow-auto rounded-lg bg-black/40 p-3 text-left font-mono text-xs leading-5 text-cyan-200"
        >
          {current.json.replaceAll("__MCP_URL__", mcpUrl)}
        </pre>
      </div>

      {/* رقائق الأدوات الخمس */}
      <div className="mt-5">
        <h3 className="mb-2 text-sm font-extrabold text-muted">الأدوات الخمس المتاحة عبر MCP</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TOOLS.map((t) => (
            <div key={t.name} className="rounded-xl border border-card-border bg-[#0d1428] p-3">
              <code dir="ltr" className="block text-left font-mono text-xs font-bold text-violet-300">
                {t.name}
              </code>
              <p className="mt-1 text-[11px] leading-5 text-muted">{t.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ملاحظة كهرمانية — حرفيًا كما في المواصفة */}
      <p className="mt-5 rounded-xl border border-amber-400/25 bg-amber-400/5 p-3 text-xs leading-6 text-amber-200 sm:text-sm">
        الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
      </p>
    </section>
  );
}
