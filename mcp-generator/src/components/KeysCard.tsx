"use client";

// ============================================================
// البطاقة أ) مدير المفاتيح
// إضافة/تعطيل/تنشيط/حذف + عدّادات الاستخدام — المفاتيح مُقنَّعة دائمًا.
// ============================================================
import { useCallback, useEffect, useState } from "react";

interface KeyItem {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: string;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastError: string | null;
  createdAtLabel: string;
}

const PROVIDER_LABEL: Record<string, string> = { kie: "kie.ai", cometapi: "CometAPI" };

export default function KeysCard() {
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      const data = await res.json();
      setKeys(data.keys ?? []);
    } catch {
      /* نعرض الحالة الحالية فقط */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function addKey() {
    if (!apiKey.trim()) {
      setMsg({ text: "أدخل قيمة المفتاح أولًا", ok: false });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ text: data.error ?? "فشل الإضافة", ok: false });
      } else {
        setMsg({ text: "تمت إضافة المفتاح بنجاح", ok: true });
        setApiKey("");
        setLabel("");
        await refresh();
      }
    } catch {
      setMsg({ text: "تعذر الاتصال بالخادم", ok: false });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(k: KeyItem) {
    const next = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    await refresh();
  }

  async function remove(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <section className="rounded-2xl border border-card-border bg-card p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-extrabold sm:text-lg">
          <span className="me-2 text-accent">أ)</span> مدير المفاتيح
        </h2>
        <span className="text-xs text-muted">{keys.length} مفتاح</span>
      </div>

      {/* نص توضيحي ثابت أعلى القائمة — حرفيًا كما في المواصفة */}
      <p className="mb-4 rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-3 text-xs leading-6 text-cyan-200 sm:text-sm">
        أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
      </p>

      {/* نموذج الإضافة */}
      <div className="mb-5 grid gap-2 sm:grid-cols-[130px_1fr_1fr_auto]">
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="rounded-xl border border-card-border bg-[#0d1428] px-3 py-2.5 text-sm outline-none focus:border-accent"
          aria-label="المزود"
        >
          <option value="kie">kie.ai</option>
          <option value="cometapi">CometAPI</option>
        </select>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="تسمية اختيارية (مثل: الحساب الأول)"
          className="rounded-xl border border-card-border bg-[#0d1428] px-3 py-2.5 text-sm outline-none placeholder:text-muted focus:border-accent"
        />
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="قيمة المفتاح API Key"
          dir="ltr"
          className="rounded-xl border border-card-border bg-[#0d1428] px-3 py-2.5 text-left font-mono text-sm outline-none placeholder:text-muted focus:border-accent"
          type="password"
          autoComplete="off"
        />
        <button
          onClick={() => void addKey()}
          disabled={busy}
          className="rounded-xl bg-gradient-to-l from-cyan-400 to-violet-500 px-5 py-2.5 text-sm font-extrabold text-[#0b1020] transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "جارٍ الإضافة…" : "إضافة"}
        </button>
      </div>

      {msg && (
        <p className={`mb-4 rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-emerald-400/10 text-emerald-300" : "bg-red-400/10 text-red-300"}`}>
          {msg.text}
        </p>
      )}

      {/* قائمة المفاتيح */}
      <div className="scroll-slim max-h-96 space-y-2 overflow-y-auto pe-1">
        {keys.length === 0 && (
          <p className="rounded-xl border border-dashed border-card-border p-6 text-center text-sm text-muted">
            لا توجد مفاتيح بعد — أضف أول مفتاح ليبدأ التوليد فورًا
          </p>
        )}
        {keys.map((k) => (
          <div key={k.id} className="rounded-xl border border-card-border bg-[#0d1428] p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <code dir="ltr" className="rounded-lg bg-black/30 px-2 py-1 font-mono text-xs text-cyan-300">
                {k.masked}
              </code>
              <span className="rounded-full bg-violet-400/10 px-2 py-0.5 text-[11px] font-bold text-violet-300">
                {PROVIDER_LABEL[k.provider] ?? k.provider}
              </span>
              {/* شارة الحالة: active أخضر / exhausted كهرماني / disabled رمادي */}
              <StatusBadge status={k.status} />
              {k.label && <span className="text-xs text-muted">({k.label})</span>}
              <span className="ms-auto text-[11px] text-muted">{k.createdAtLabel}</span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
              <span>استخدام: <b className="text-foreground">{k.usageCount}</b></span>
              <span>نجاح: <b className="text-emerald-300">{k.successCount}</b></span>
              <span>فشل: <b className="text-red-300">{k.failCount}</b></span>
              {k.lastError && (
                <span className="max-w-full truncate" title={k.lastError}>آخر خطأ: {k.lastError}</span>
              )}
            </div>

            <div className="mt-3 flex gap-2">
              <button
                onClick={() => void toggle(k)}
                className="rounded-lg border border-card-border px-3 py-1.5 text-xs font-bold text-foreground transition hover:border-accent hover:text-accent"
              >
                {k.status === "disabled" ? "تنشيط" : "تعطيل"}
              </button>
              <button
                onClick={() => void remove(k)}
                className="rounded-lg border border-red-400/20 px-3 py-1.5 text-xs font-bold text-red-300 transition hover:bg-red-400/10"
              >
                حذف
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "active") {
    return (
      <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-bold text-emerald-300">
        نشط
      </span>
    );
  }
  if (status === "exhausted") {
    return (
      <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] font-bold text-amber-300">
        مستنزف
      </span>
    );
  }
  return (
    <span className="rounded-full border border-slate-400/20 bg-slate-400/10 px-2 py-0.5 text-[11px] font-bold text-slate-300">
      معطّل
    </span>
  );
}
