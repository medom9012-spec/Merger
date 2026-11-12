"use client";

// ============================================================
// البطاقة ب) لوحة المهام — شرائح إحصائيات + قائمة تتحدث تلقائيًا كل ~5 ثوانٍ
// ============================================================
import { useCallback, useEffect, useState } from "react";

interface TaskItem {
  id: string;
  type: string;
  model: string;
  provider: string | null;
  status: string;
  progress: number;
  prompt: string;
  urls: string[];
  error: string | null;
  attemptsCount: number;
  createdAtLabel: string;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

const TYPE_LABEL: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };

export default function TasksCard() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [updatedAt, setUpdatedAt] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const data = await res.json();
      setTasks(data.tasks ?? []);
      if (data.stats) setStats(data.stats);
      setUpdatedAt(new Date().toLocaleTimeString("ar"));
    } catch {
      /* نعرض الحالة الحالية فقط */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <section className="rounded-2xl border border-card-border bg-card p-4 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-extrabold sm:text-lg">
          <span className="me-2 text-accent">ب)</span> لوحة المهام
        </h2>
        {updatedAt && <span className="text-[11px] text-muted">آخر تحديث: {updatedAt} (كل 5 ثوانٍ)</span>}
      </div>

      {/* شرائح الإحصائيات */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatChip label="إجمالي" value={stats.total} cls="text-foreground border-card-border" />
        <StatChip label="مكتملة" value={stats.completed} cls="text-emerald-300 border-emerald-400/25" />
        <StatChip label="فاشلة" value={stats.failed} cls="text-red-300 border-red-400/25" />
        <StatChip label="جارية" value={stats.processing} cls="text-cyan-300 border-cyan-400/25" />
      </div>

      {/* قائمة أحدث المهام */}
      <div className="scroll-slim max-h-[28rem] space-y-2 overflow-y-auto pe-1">
        {tasks.length === 0 && (
          <p className="rounded-xl border border-dashed border-card-border p-6 text-center text-sm text-muted">
            لا توجد مهام بعد — كل توليد أو دمج سيظهر هنا مباشرة
          </p>
        )}
        {tasks.map((t) => (
          <div key={t.id} className="rounded-xl border border-card-border bg-[#0d1428] p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-lg bg-violet-400/10 px-2 py-0.5 text-[11px] font-bold text-violet-300">
                {TYPE_LABEL[t.type] ?? t.type}
              </span>
              <TaskStatusBadge status={t.status} />
              <code dir="ltr" className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[11px] text-muted">
                {t.model}
              </code>
              <span className="ms-auto text-[11px] text-muted">{t.createdAtLabel}</span>
            </div>

            {t.prompt && (
              <p className="mt-2 truncate text-xs text-muted" title={t.prompt}>
                {t.prompt}
              </p>
            )}

            {/* شريط التقدم */}
            {(t.status === "processing" || t.status === "pending") && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full bg-gradient-to-l from-cyan-400 to-violet-500 transition-all duration-500"
                  style={{ width: `${Math.max(4, Math.min(100, t.progress))}%` }}
                />
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
              <span>المحاولات: <b className="text-foreground">{t.attemptsCount}</b></span>
              {t.provider && <span>عبر: {t.provider}</span>}
              <code dir="ltr" className="font-mono">task: {t.id.slice(0, 8)}…</code>
            </div>

            {t.status === "failed" && t.error && (
              <p className="mt-2 rounded-lg bg-red-400/10 px-3 py-2 text-xs text-red-300">{t.error}</p>
            )}

            {t.status === "completed" && t.urls.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {t.urls.map((u, i) => (
                  <a
                    key={i}
                    href={u}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-cyan-400/25 bg-cyan-400/10 px-3 py-1.5 text-xs font-bold text-cyan-300 transition hover:bg-cyan-400/20"
                  >
                    فتح الرابط {t.urls.length > 1 ? `(${i + 1})` : ""}
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function StatChip({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={`rounded-xl border bg-[#0d1428] px-3 py-2.5 text-center ${cls}`}>
      <div className="text-lg font-extrabold leading-none">{value}</div>
      <div className="mt-1 text-[11px] font-bold opacity-80">{label}</div>
    </div>
  );
}

function TaskStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    failed: "border-red-400/30 bg-red-400/10 text-red-300",
    processing: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300",
    pending: "border-slate-400/20 bg-slate-400/10 text-slate-300",
  };
  const label: Record<string, string> = {
    completed: "مكتملة",
    failed: "فاشلة",
    processing: "جارية",
    pending: "بالانتظار",
  };
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${map[status] ?? map.pending}`}>
      {label[status] ?? status}
    </span>
  );
}
