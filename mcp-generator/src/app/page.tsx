"use client";

// ============================================================
// لوحة الإدارة العربية (RTL) — صفحة واحدة بثلاث بطاقات:
// أ) مدير المفاتيح  ب) لوحة المهام  ج) ربط السيرفر
// الهيدر يعرض حالة /api/health مباشرة.
// ============================================================
import { useCallback, useEffect, useState } from "react";
import KeysCard from "@/components/KeysCard";
import TasksCard from "@/components/TasksCard";
import ConnectCard from "@/components/ConnectCard";

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  merger: { base: string | null; configured: boolean; healthy: boolean };
  authRequired: boolean;
}

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);

  const refreshHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      setHealth(await res.json());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    const t = setInterval(() => void refreshHealth(), 15_000);
    return () => clearInterval(t);
  }, [refreshHealth]);

  const dbOk = health?.ok === true;

  return (
    <div className="min-h-screen flex flex-col">
      {/* ---------------- الهيدر ---------------- */}
      <header className="sticky top-0 z-20 border-b border-white/5 bg-[#0b1020]/85 backdrop-blur">
        <div className="mx-auto w-full max-w-6xl px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 me-auto">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500 text-[#0b1020] font-extrabold text-lg">
              M
            </div>
            <div>
              <h1 className="text-lg font-extrabold leading-tight">مولد الوسائط — MCP</h1>
              <p className="text-xs text-muted">توليد الصور والفيديو ودمج المقاطع مع تبديل تلقائي للمفاتيح</p>
            </div>
          </div>

          {/* شارة حالة قاعدة البيانات */}
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${
              dbOk
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
                : "border-red-400/30 bg-red-400/10 text-red-300"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${dbOk ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
            {dbOk ? "Turso متصل" : "Turso غير متصل"}
          </span>

          {/* شارة خدمة الدمج */}
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${
              health?.merger?.configured
                ? health.merger.healthy
                  ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-300"
                  : "border-amber-400/30 bg-amber-400/10 text-amber-300"
                : "border-slate-400/20 bg-slate-400/10 text-slate-300"
            }`}
          >
            خدمة الدمج:{" "}
            {health?.merger?.configured ? (health.merger.healthy ? "جاهزة" : "لا تستجيب") : "غير مهيأة"}
          </span>

          {health?.authRequired && (
            <span className="inline-flex items-center gap-2 rounded-full border border-violet-400/30 bg-violet-400/10 px-3 py-1.5 text-xs font-bold text-violet-300">
              /mcp محمي بـ Bearer
            </span>
          )}
        </div>
      </header>

      {/* ---------------- البطاقات الثلاث ---------------- */}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 space-y-6">
        <KeysCard />

        <TasksCard />

        <ConnectCard mcpPath={health?.mcpEndpoint ?? "/mcp"} />
      </main>

      <footer className="border-t border-white/5 py-4 text-center text-xs text-muted">
        MCP Media Generator v1.2.0 — يعمل عبر kie.ai وCometAPI مع تبديل تسلسلي صارم للمفاتيح
      </footer>
    </div>
  );
}
