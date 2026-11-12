// مزود kie.ai — Jobs API الموحد (أشكال حقيقية مقاسة):
// POST /api/v1/jobs/createTask  → {"code":200,"data":{"taskId":"..."}}
// GET  /api/v1/jobs/recordInfo?taskId=<id> → {"code":200,"data":{"state":"...","resultJson":"...","failMsg":...}}
import { ProviderError } from "../errors";
import type { CheckResult, ProviderAdapter } from "./types";

const KIE_BASE = "https://api.kie.ai";
const TIMEOUT_MS = 30_000;

// نداء موحد مع مهلة (AbortController) — انتهاء المهلة/الشبكة = مؤقت
async function kieFetch(path: string, key: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(KIE_BASE + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: ctrl.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* جسم غير JSON */ }

    if (!res.ok) {
      const b = (body ?? {}) as Record<string, unknown>;
      const msg = (typeof b.msg === "string" && b.msg) || (typeof b.message === "string" && b.message) || `kie.ai HTTP ${res.status}`;
      throw new ProviderError(String(msg), res.status);
    }
    // kie يعيد {"code":200,...} — أي كود آخر يُعامل كخطأ بنفس الكود ليُصنَّف
    const code = body && typeof body.code === "number" ? body.code : 200;
    if (code !== 200) {
      const b = (body ?? {}) as Record<string, unknown>;
      const msg = (typeof b.msg === "string" && b.msg) || `kie.ai code ${code}`;
      throw new ProviderError(String(msg), code >= 400 && code < 600 ? code : res.status);
    }
    return body ?? {};
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const msg = err instanceof Error ? (err.name === "AbortError" ? "انتهت مهلة الاتصال بـ kie.ai" : err.message) : String(err);
    throw new ProviderError(msg); // بلا حالة HTTP → مؤقت
  } finally {
    clearTimeout(timer);
  }
}

export const kieAdapter: ProviderAdapter = {
  id: "kie",

  async createTask(key, model, input) {
    const body = await kieFetch("/api/v1/jobs/createTask", key, {
      method: "POST",
      body: JSON.stringify({ model, input }),
    });
    const data = body.data as Record<string, unknown> | undefined;
    const taskId = data?.taskId;
    if (typeof taskId !== "string" || !taskId) {
      throw new ProviderError("kie.ai: استجابة createTask بلا taskId"); // مؤقت — شكل غير متوقع
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    const body = await kieFetch(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, key);
    const data = body.data as Record<string, unknown> | undefined;
    if (!data) throw new ProviderError("kie.ai: استجابة recordInfo بلا data");

    const state = String(data.state ?? "").toLowerCase();
    if (state === "success") {
      // resultJson نص JSON داخل نص — يحتاج JSON.parse ثانيًا
      let urls: string[] = [];
      try {
        const parsed = typeof data.resultJson === "string" ? JSON.parse(data.resultJson) : data.resultJson;
        const ru = (parsed as Record<string, unknown>)?.resultUrls;
        if (Array.isArray(ru)) {
          urls = ru.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
        }
      } catch { /* تُعالج كقائمة فارغة أدناه */ }
      return { status: "completed", urls };
    }
    if (state === "fail") {
      return { status: "failed", error: (typeof data.failMsg === "string" && data.failMsg) || "أعلن المزود فشل المهمة" };
    }
    // waiting → 5 ، queuing → 15 ، generating → 55
    const progress = state === "generating" ? 55 : state === "queuing" ? 15 : 5;
    return { status: "processing", progress };
  },
};
