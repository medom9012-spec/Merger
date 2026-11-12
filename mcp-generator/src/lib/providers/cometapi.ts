// مزود CometAPI (ثانوي — أفضل جهد، لا مفتاح متاح للاختبار الفعلي):
// - الصور: نقطة متوافقة مع OpenAI (POST /v1/images/generations) تُعيد النتيجة فورًا (createImageSync).
// - الفيديو: مهام غير متزامنة بنمط create/check على /v1/tasks (دفاعي كليًا: أي شكل غير متوقع → مؤقت).
import { ProviderError } from "../errors";
import type { CheckResult, ProviderAdapter } from "./types";

const COMET_BASE = "https://api.cometapi.com";
const TIMEOUT_MS = 30_000;

// نداء موحد — يرمي ProviderError عند !ok، ويعيد الحالة والجسم عند النجاح
async function cometFetch(
  path: string,
  key: string,
  init?: RequestInit,
  timeoutMs = TIMEOUT_MS
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(COMET_BASE + path, {
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
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
    if (!res.ok) {
      const msg = (typeof body.error === "string" && body.error) ||
        (typeof body.message === "string" && body.message) ||
        (typeof body.msg === "string" && body.msg) ||
        `CometAPI HTTP ${res.status}`;
      throw new ProviderError(String(msg), res.status);
    }
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const msg = err instanceof Error ? (err.name === "AbortError" ? "انتهت مهلة الاتصال بـ CometAPI" : err.message) : String(err);
    throw new ProviderError(msg); // مؤقت
  } finally {
    clearTimeout(timer);
  }
}

// استخراج دفاعي لأول معرّف مهمة من أشكال استجابة مختلفة محتملة
function pickTaskId(body: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const data = b.data as Record<string, unknown> | undefined;
  for (const v of [data?.id, data?.taskId, data?.task_id, b.id, b.taskId, b.task_id]) {
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

// استخراج دفاعي للروابط: نجمع كل الروابط ونفضّل ما ينتهي بامتداد وسائط
function extractUrls(value: unknown, depth = 0): string[] {
  const all: string[] = [];
  const visit = (v: unknown, d: number) => {
    if (d > 6 || v == null) return;
    if (typeof v === "string") {
      if (/^https?:\/\/\S+$/i.test(v)) all.push(v);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => visit(x, d + 1)); return; }
    if (typeof v === "object") { Object.values(v as Record<string, unknown>).forEach((x) => visit(x, d + 1)); }
  };
  visit(value, depth);
  const media = all.filter((u) => /\.(mp4|webm|mov|m4v|png|jpe?g|webp|gif)(\?|#|$)/i.test(u));
  return media.length ? [...new Set(media)] : [...new Set(all)];
}

function mapStatus(raw: unknown): "processing" | "completed" | "failed" {
  const st = String(raw ?? "").toLowerCase();
  if (["completed", "success", "succeeded", "done", "finished"].includes(st)) return "completed";
  if (["failed", "error", "failure", "cancelled", "canceled"].includes(st)) return "failed";
  return "processing";
}

export const cometapiAdapter: ProviderAdapter = {
  id: "cometapi",

  // صور متزامنة — نمط OpenAI: {model, prompt, size?...} → data[0].url أو b64_json
  async createImageSync(key, input) {
    const payload: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      n: 1,
    };
    // تحويل تقريبي لنسبة الأبعاد إلى حجم (أفضل جهد)
    const sizeMap: Record<string, string> = {
      "1:1": "1024x1024",
      "16:9": "1792x1024",
      "9:16": "1024x1792",
      "3:2": "1536x1024",
      "2:3": "1024x1536",
    };
    const size = sizeMap[String(input.aspect_ratio ?? "")];
    if (size) payload.size = size;

    const { body } = await cometFetch("/v1/images/generations", key, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = body.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new ProviderError(`CometAPI: شكل استجابة غير متوقع لتوليد الصور: ${JSON.stringify(body).slice(0, 200)}`);
    }
    const urls: string[] = [];
    for (const item of data as Record<string, unknown>[]) {
      if (typeof item?.url === "string" && item.url) urls.push(item.url);
      else if (typeof item?.b64_json === "string" && item.b64_json) {
        urls.push(`data:image/png;base64,${item.b64_json}`);
      }
    }
    if (urls.length === 0) throw new ProviderError("CometAPI: لم يُعثر على رابط صورة في الاستجابة");
    return { urls };
  },

  // فيديو — مهام غير متزامنة (نمط create/check دفاعي)
  async createTask(key, model, input) {
    const { status, body } = await cometFetch("/v1/tasks", key, {
      method: "POST",
      body: JSON.stringify({ model, ...input }),
    });
    const id = pickTaskId(body);
    if (!id) {
      throw new ProviderError(`CometAPI: شكل استجابة غير متوقع لإنشاء المهمة (HTTP ${status}): ${JSON.stringify(body).slice(0, 200)}`);
    }
    return { providerTaskId: id };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    let status = 200;
    let body: Record<string, unknown> = {};
    try {
      const r = await cometFetch(`/v1/tasks/${encodeURIComponent(providerTaskId)}`, key);
      status = r.status;
      body = r.body;
    } catch (err) {
      // 404 → المهمة غير موجودة لدى المزود (فشل حقيقي وليس مؤقتًا)
      if (err instanceof ProviderError && err.status === 404) {
        return { status: "failed", error: "المهمة غير موجودة لدى المزود" };
      }
      throw err;
    }

    const raw = ((body.data as Record<string, unknown> | undefined) ?? body) as Record<string, unknown>;
    const st = mapStatus(raw.status ?? raw.state);

    if (st === "completed") {
      const urls = extractUrls(raw);
      if (urls.length === 0) return { status: "failed", error: "اكتملت المهمة لكن لم يُعثر على رابط ناتج" };
      return { status: "completed", urls };
    }
    if (st === "failed") {
      const errMsg = typeof raw.error === "string" && raw.error
        ? raw.error
        : typeof raw.message === "string" && raw.message
          ? raw.message
          : "أعلن المزود فشل المهمة";
      return { status: "failed", error: errMsg };
    }

    // progress قد يأتي كسرًا 0..1 أو نسبة 0..100
    const p = Number(raw.progress);
    const progress = Number.isFinite(p) ? (p > 0 && p <= 1 ? Math.round(p * 100) : Math.round(p)) : undefined;
    void status;
    return { status: "processing", progress };
  },
};
