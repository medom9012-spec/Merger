// ============================================================
// مزود kie.ai — Jobs API الموحد (التوثيق الرسمي: docs.kie.ai)
// POST /api/v1/jobs/createTask  → {"code":200,"data":{"taskId":"..."}}
// GET  /api/v1/jobs/recordInfo?taskId=… → {"code":200,"data":{
//         "state":"waiting|queuing|generating|success|fail",
//         "resultJson":"{\"resultUrls\":[\"…\"]}",   // نص JSON داخل JSON
//         "failMsg":"..."}}
// الأشكال أعلاه مقاسة بنداءات حقيقية — إن تغيّر الشكل لاحقًا نتبع التوثيق
// الرسمي ولا نخترع حقولًا.
// ============================================================
import { ProviderError, type ProviderAdapter, type ProviderKey } from "./types";

const BASE = "https://api.kie.ai/api/v1/jobs";

async function kieFetch(
  key: ProviderKey,
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.api_key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // انقطاع شبكة/timeout → بلا status → يُصنَّف temporary
    throw new ProviderError(`kie.ai network error: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text); } catch { body = null; }

  if (!res.ok) {
    const msg = (body?.msg ?? body?.message ?? `HTTP ${res.status}`) as string;
    throw new ProviderError(String(msg), res.status);
  }
  // بعض استجابات kie.ai تحمل code داخل الجسم مع HTTP 200
  const code = typeof body?.code === "number" ? body.code : 200;
  if (code !== 200) {
    const msg = (body?.msg ?? body?.message ?? `kie.ai code ${code}`) as string;
    throw new ProviderError(String(msg), code >= 400 && code < 600 ? code : undefined);
  }
  return body ?? {};
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: ProviderKey, model: string, input: Record<string, unknown>) {
    const body = await kieFetch(key, "/createTask", {
      method: "POST",
      body: JSON.stringify({ model, input }),
    });
    const data = body.data as { taskId?: string } | undefined;
    const taskId = data?.taskId;
    if (!taskId) throw new ProviderError("kie.ai createTask: استجابة بلا taskId", 502);
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string) {
    const body = await kieFetch(
      key,
      `/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      { method: "GET" },
    );
    const data = (body.data ?? {}) as {
      state?: string;
      resultJson?: string;
      failMsg?: string;
    };
    const state = String(data.state ?? "waiting").toLowerCase();

    if (state === "success") {
      // resultJson نص يحتاج JSON.parse ثانيًا (انتبه: قد يتغير الشكل — نتبع التوثيق)
      let urls: string[] = [];
      if (data.resultJson) {
        try {
          const parsed = JSON.parse(data.resultJson) as Record<string, unknown>;
          const raw = (parsed.resultUrls ?? parsed.resultUrl ?? parsed.urls) as unknown;
          if (Array.isArray(raw)) {
            urls = raw.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
          } else if (typeof raw === "string" && /^https?:\/\//.test(raw)) {
            urls = [raw];
          }
        } catch { /* نعاملها كلا روابط */ }
      }
      if (!urls.length) return { status: "failed" as const, error: "اكتمل التوليد دون روابط نتيجة صالحة" };
      return { status: "completed" as const, urls, progress: 100 };
    }

    if (state === "fail" || state === "failed" || state === "error") {
      return { status: "failed" as const, error: data.failMsg || "فشل التوليد لدى المزود" };
    }

    const progress = state === "generating" ? 45 : state === "queuing" ? 15 : 5;
    return { status: "processing" as const, progress };
  },
};
