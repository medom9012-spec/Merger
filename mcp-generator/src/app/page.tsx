"use client";

// لوحة الإدارة العربية (RTL) — ثلاث بطاقات: مدير المفاتيح، لوحة المهام، ربط السيرفر
import { useCallback, useEffect, useState } from "react";

// ================== أنواع البيانات ==================
interface HealthInfo {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}

interface KeyItem {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string | null;
}

interface TaskItem {
  id: string;
  provider: string | null;
  model: string;
  type: string;
  prompt: string;
  status: string;
  progress: number;
  result_urls: string[] | null;
  error_message: string | null;
  attempts: unknown[];
  created_at: string | null;
}

const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_AR: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "جارية",
  pending: "قيد الانتظار",
};
const KEY_STATUS_AR: Record<string, string> = {
  active: "نشط",
  exhausted: "مستنزف",
  disabled: "معطّل",
};

function relativeTime(ts: string | null): string {
  if (!ts) return "";
  const t = Date.parse(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return ts;
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "قبل لحظات";
  if (m < 60) return `قبل ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `قبل ${h} ساعة`;
  return `قبل ${Math.floor(h / 24)} يوم`;
}

// ================== عناصر واجهة صغيرة ==================
function Badge({ color, children }: { color: "green" | "amber" | "red" | "zinc" | "pink" | "teal" | "orange"; children: React.ReactNode }) {
  const map: Record<string, string> = {
    green: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    amber: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    red: "bg-red-500/15 text-red-400 border-red-500/30",
    zinc: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    pink: "bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/30",
    teal: "bg-teal-500/15 text-teal-400 border-teal-500/30",
    orange: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${map[color]}`}>
      {children}
    </span>
  );
}

function CopyButton({ text, small }: { text: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // بديل للمتصفحات القديمة
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }
  return (
    <button
      type="button"
      onClick={copy}
      className={`shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 font-medium text-zinc-200 transition hover:bg-zinc-700 active:scale-95 ${small ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs"}`}
    >
      {copied ? "تم النسخ!" : "نسخ"}
    </button>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
      <div
        className="h-full rounded-full bg-emerald-500 transition-all duration-500"
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function TaskTypeBadge({ type }: { type: string }) {
  const color = type === "image" ? "pink" : type === "video" ? "teal" : "orange";
  return <Badge color={color}>{TYPE_AR[type] ?? type}</Badge>;
}

function TaskStatusBadge({ status }: { status: string }) {
  const color = status === "completed" ? "green" : status === "failed" ? "red" : "amber";
  return <Badge color={color}>{STATUS_AR[status] ?? status}</Badge>;
}

function KeyStatusBadge({ status }: { status: string }) {
  const color = status === "active" ? "green" : status === "exhausted" ? "amber" : "zinc";
  return <Badge color={color}>{KEY_STATUS_AR[status] ?? status}</Badge>;
}

// ================== الصفحة الرئيسية ==================
export default function Home() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [formMsg, setFormMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // بطاقة الربط
  const [mcpUrl, setMcpUrl] = useState("");
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");

  // الرابط المطلق <origin>/mcp
  useEffect(() => {
    setMcpUrl(`${window.location.origin}/mcp`);
  }, []);

  // تحميل الحالة — فحص الصحة كل 15 ثانية
  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health");
      setHealth(await r.json());
    } catch { /* تجاهل — المحاولة القادمة */ }
  }, []);

  // المفاتيح والمهام — تحديث تلقائي كل 5 ثوانٍ
  const loadKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      const j = await r.json();
      setKeys(j.keys ?? []);
    } catch { /* تجاهل */ }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20");
      const j = await r.json();
      setTasks(j.tasks ?? []);
      if (j.stats) setStats(j.stats);
    } catch { /* تجاهل */ }
  }, []);

  useEffect(() => {
    loadHealth();
    const t = setInterval(loadHealth, 15000);
    return () => clearInterval(t);
  }, [loadHealth]);

  useEffect(() => {
    loadKeys();
    loadTasks();
    const t = setInterval(() => {
      loadKeys();
      loadTasks();
    }, 5000);
    return () => clearInterval(t);
  }, [loadKeys, loadTasks]);

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormMsg(null);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, label, api_key: apiKeyInput.trim() }),
      });
      const j = await r.json();
      if (r.ok) {
        setFormMsg({ kind: "ok", text: "تمت إضافة المفتاح بنجاح." });
        setApiKeyInput("");
        setLabel("");
        loadKeys();
      } else {
        setFormMsg({ kind: "err", text: j?.error ?? "تعذّرت إضافة المفتاح." });
      }
    } catch {
      setFormMsg({ kind: "err", text: "تعذّر الاتصال بالخادم." });
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleKey(k: KeyItem) {
    try {
      const r = await fetch(`/api/keys/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: k.status === "disabled" ? "active" : "disabled" }),
      });
      if (r.ok) loadKeys();
    } catch { /* تجاهل */ }
  }

  async function removeKey(k: KeyItem) {
    if (!window.confirm("حذف هذا المفتاح نهائيًا؟")) return;
    try {
      const r = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
      if (r.ok) loadKeys();
    } catch { /* تجاهل */ }
  }

  // JSON جاهز للنسخ لكل تبويب
  const authHeaders = health?.authRequired ? { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } : undefined;
  const serverEntry: Record<string, unknown> = { url: mcpUrl || "<MCP_URL>" };
  if (authHeaders) serverEntry.headers = authHeaders;

  const chatgptJson = JSON.stringify({ mcpServers: { "media-generator": serverEntry } }, null, 2);
  const claudeJson = JSON.stringify(
    { mcpServers: { "media-generator": { ...serverEntry, type: "http" } } },
    null,
    2
  );
  const cursorJson = JSON.stringify({ mcpServers: { "media-generator": serverEntry } }, null, 2);

  const tabData: Record<typeof tab, { json: string; file?: string; hint?: string }> = {
    chatgpt: {
      json: chatgptJson,
      hint: "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».",
    },
    claude: { json: claudeJson, file: "claude_desktop_config.json" },
    cursor: { json: cursorJson, file: "mcp.json" },
  };

  const tools = [
    { name: "generate_image", desc: "توليد صورة من وصف نصي" },
    { name: "generate_video", desc: "توليد فيديو مع صوت متزامن أصلي" },
    { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب" },
    { name: "get_task", desc: "تتبع حالة أي مهمة بمعرّفها حتى تكتمل" },
    { name: "list_media", desc: "استرجاع الوسائط المخزنة سابقًا بروابطها" },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* الترويسة + شارة الصحة */}
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/70 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <h1 className="text-lg font-bold sm:text-xl">مولّد الوسائط — MCP</h1>
          <div className="flex items-center gap-2">
            {!health ? (
              <Badge color="zinc">جارٍ فحص الحالة…</Badge>
            ) : health.database === "turso-connected" ? (
              <Badge color="green">Turso متصل</Badge>
            ) : health.database === "not-configured" ? (
              <Badge color="amber">غير مهيأة</Badge>
            ) : (
              <Badge color="red">غير متصل</Badge>
            )}
            {health?.merger?.base ? (
              health.merger.healthy ? (
                <Badge color="green">الدمج جاهز</Badge>
              ) : (
                <Badge color="red">الدمج لا يستجيب</Badge>
              )
            ) : (
              <Badge color="zinc">الدمج غير مهيأ</Badge>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
        <div className="grid gap-6 xl:grid-cols-3">
          {/* ====== أ) مدير المفاتيح ====== */}
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6" aria-labelledby="keys-title">
            <h2 id="keys-title" className="mb-3 text-base font-bold">مدير المفاتيح</h2>
            <p className="mb-4 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-xs leading-5 text-zinc-400">
              أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند
              أي خطأ أو نفاد رصيد دون توقف.
            </p>

            <form onSubmit={addKey} className="mb-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="key-provider" className="mb-1 block text-xs text-zinc-400">المزود</label>
                  <select
                    id="key-provider"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    className="h-10 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-emerald-500"
                  >
                    <option value="kie">kie.ai</option>
                    <option value="cometapi">CometAPI</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="key-label" className="mb-1 block text-xs text-zinc-400">تسمية (اختياري)</label>
                  <input
                    id="key-label"
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="مثال: حساب رئيسي"
                    className="h-10 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="key-value" className="mb-1 block text-xs text-zinc-400">المفتاح</label>
                <input
                  id="key-value"
                  type="text"
                  dir="ltr"
                  required
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="sk-..."
                  className="h-10 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-500"
                />
              </div>
              <button
                type="submit"
                disabled={submitting || !apiKeyInput.trim()}
                className="h-10 w-full rounded-lg bg-emerald-600 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? "جارٍ الإضافة…" : "إضافة المفتاح"}
              </button>
              {formMsg && (
                <p className={`text-xs ${formMsg.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>{formMsg.text}</p>
              )}
            </form>

            <ul className="scroll-thin max-h-96 space-y-3 overflow-y-auto pl-1">
              {keys.length === 0 && (
                <li className="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-500">
                  لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل.
                </li>
              )}
              {keys.map((k) => (
                <li key={k.id} className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <code dir="ltr" className="break-all font-mono text-xs text-zinc-300">{k.masked}</code>
                    <KeyStatusBadge status={k.status} />
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                    <span>{k.provider === "kie" ? "kie.ai" : "CometAPI"}</span>
                    {k.label && <span className="text-zinc-400">{k.label}</span>}
                    <span>الاستخدام: {k.usage_count}</span>
                    <span className="text-emerald-500">نجاح: {k.success_count}</span>
                    <span className="text-red-400">فشل: {k.fail_count}</span>
                    {k.last_used_at && <span>آخر استخدام: {relativeTime(k.last_used_at)}</span>}
                  </div>
                  {k.last_error && (
                    <p className="truncate text-[11px] text-amber-400/90" title={k.last_error}>
                      آخر خطأ: {k.last_error}
                    </p>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => toggleKey(k)}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[11px] text-zinc-300 transition hover:bg-zinc-800"
                    >
                      {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeKey(k)}
                      className="rounded-lg border border-red-900/60 px-3 py-1.5 text-[11px] text-red-400 transition hover:bg-red-950/40"
                    >
                      حذف
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {/* ====== ب) لوحة المهام ====== */}
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6" aria-labelledby="tasks-title">
            <h2 id="tasks-title" className="mb-3 text-base font-bold">لوحة المهام</h2>

            <div className="mb-4 grid grid-cols-4 gap-2">
              <StatChip label="إجمالي" value={stats.total} color="text-zinc-100" />
              <StatChip label="مكتملة" value={stats.completed} color="text-emerald-400" />
              <StatChip label="فاشلة" value={stats.failed} color="text-red-400" />
              <StatChip label="جارية" value={stats.processing} color="text-amber-400" />
            </div>

            <ul className="scroll-thin max-h-96 space-y-3 overflow-y-auto pl-1">
              {tasks.length === 0 && (
                <li className="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-500">
                  لا توجد مهام بعد — ابدأ من عميل MCP (ChatGPT / Claude / Cursor).
                </li>
              )}
              {tasks.map((t) => (
                <li key={t.id} className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <TaskTypeBadge type={t.type} />
                      <TaskStatusBadge status={t.status} />
                      {t.attempts.length > 0 && <Badge color="zinc">محاولات: {t.attempts.length}</Badge>}
                    </div>
                    <span className="text-[11px] text-zinc-500">{relativeTime(t.created_at)}</span>
                  </div>

                  {(t.status === "processing" || t.status === "pending") && (
                    <ProgressBar value={t.progress} />
                  )}

                  <p className="font-mono text-[11px] text-zinc-400" dir="ltr">{t.model}</p>
                  {t.prompt && (
                    <p className="line-clamp-2 text-xs text-zinc-300" title={t.prompt}>{t.prompt}</p>
                  )}
                  {t.status === "failed" && t.error_message && (
                    <p className="truncate text-[11px] text-red-400" title={t.error_message}>
                      {t.error_message}
                    </p>
                  )}
                  {t.status === "completed" && (t.result_urls?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {t.result_urls!.map((u, i) => (
                        <a
                          key={i}
                          href={u}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="rounded-lg border border-emerald-800/60 bg-emerald-950/30 px-3 py-1.5 text-[11px] text-emerald-400 transition hover:bg-emerald-900/40"
                        >
                          فتح الرابط {t.result_urls!.length > 1 ? `#${i + 1}` : ""}
                        </a>
                      ))}
                    </div>
                  )}
                  <p className="truncate text-[10px] text-zinc-600" dir="ltr" title={t.id}>task_id: {t.id}</p>
                </li>
              ))}
            </ul>
          </section>

          {/* ====== ج) ربط السيرفر ====== */}
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6" aria-labelledby="connect-title">
            <h2 id="connect-title" className="mb-3 text-base font-bold">ربط السيرفر</h2>

            <div className="mb-4">
              <label htmlFor="mcp-url" className="mb-1 block text-xs text-zinc-400">رابط خادم MCP</label>
              <div className="flex gap-2">
                <input
                  id="mcp-url"
                  type="text"
                  dir="ltr"
                  readOnly
                  value={mcpUrl}
                  className="h-10 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 font-mono text-xs text-zinc-300 outline-none"
                />
                <CopyButton text={mcpUrl} />
              </div>
            </div>

            <div className="mb-2 flex gap-1 rounded-xl border border-zinc-800 bg-zinc-950/60 p-1">
              {(
                [
                  ["chatgpt", "ChatGPT / GPT Agents"],
                  ["claude", "Claude Desktop"],
                  ["cursor", "Cursor / Windsurf / Cline"],
                ] as const
              ).map(([id, title]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`flex-1 rounded-lg px-2 py-2 text-[11px] font-medium transition ${
                    tab === id ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {title}
                </button>
              ))}
            </div>

            {tabData[tab].hint && (
              <p className="mb-2 text-[11px] leading-5 text-zinc-400">{tabData[tab].hint}</p>
            )}
            {tabData[tab].file && (
              <p className="mb-2 text-[11px] text-zinc-500" dir="ltr">
                {tabData[tab].file}
              </p>
            )}
            {health?.authRequired && (
              <p className="mb-2 text-[11px] text-amber-400">
                الحماية مفعّلة (MCP_ACCESS_TOKEN) — استبدل &lt;MCP_ACCESS_TOKEN&gt; بالتوكن الحقيقي في الترويسة.
              </p>
            )}

            <div className="relative">
              <pre
                dir="ltr"
                className="scroll-thin max-h-64 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-left font-mono text-[11px] leading-5 text-zinc-300"
              >
                {tabData[tab].json}
              </pre>
              <div className="mt-2">
                <CopyButton text={tabData[tab].json} />
              </div>
            </div>

            <h3 className="mb-2 mt-5 text-xs font-semibold text-zinc-400">الأدوات المتاحة</h3>
            <ul className="space-y-2">
              {tools.map((tool) => (
                <li
                  key={tool.name}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2"
                >
                  <code dir="ltr" className="rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-emerald-400">
                    {tool.name}
                  </code>
                  <span className="text-[11px] text-zinc-300">{tool.desc}</span>
                </li>
              ))}
            </ul>

            <p className="mt-4 rounded-xl border border-amber-700/40 bg-amber-950/20 p-3 text-[11px] leading-5 text-amber-300">
              الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
              المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا
              تنقطع العملية.
            </p>
          </section>
        </div>
      </main>

      {/* تذييل ثابت أسفل الشاشة عند المحتوى القصير */}
      <footer className="mt-auto border-t border-zinc-800 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-[11px] text-zinc-600">
        MCP Media Generator — Next.js 15 + Turso + بروتوكول MCP (Stateless Streamable HTTP)
      </footer>
    </div>
  );
}

function StatChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-2 py-3 text-center">
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      <p className="text-[11px] text-zinc-500">{label}</p>
    </div>
  );
}
