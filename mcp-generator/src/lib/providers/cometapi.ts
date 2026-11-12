// ============================================================
// مزود CometAPI — api.cometapi.com
// • الصور: نقطة متوافقة مع OpenAI تُعيد النتيجة فورًا (تزامنية):
//     POST /v1/images/generations  {model, prompt, n, size?, background?, output_format?, response_format?}
//     → {"created":…, "data":[{"url" | "b64_json"}]}
// • الفيديو: نقطة مهام غير متزامنة (التوثيق الرسمي apidoc.cometapi.com):
//     POST /v1/videos  (multipart: prompt, model, seconds?, size?, input_reference?)
//     → {"id"/"task_id", "status":"queued", "progress":0}
//     GET  /v1/videos/{id} → status: queued|in_progress|completed|failed|error
// ملاحظة: هذا المزود ثانوي — لا يُفعَّل مساره إلا بإضافة مفتاح CometAPI من الواجهة.
// ============================================================
import { ProviderError, type ProviderAdapter, type ProviderKey } from "./types";

const BASE = "https://api.cometapi.com/v1";

async function cometJson(
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
        ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new ProviderError(`CometAPI network error: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) {
    const msg = ((body as { error?: { message?: string } | string; message?: string })?.error);
    const msgText =
      typeof msg === "string" ? msg : msg?.message ?? (body?.message as string) ?? `HTTP ${res.status}`;
    throw new ProviderError(String(msgText), res.status);
  }
  return body ?? {};
}

/** تحويل aspect_ratio + resolution إلى حجم WxH قريب مدعوم لدى CometAPI */
function sizeForVideo(aspect?: string, resolution?: string): string | undefined {
  const h = resolution === "1080p" ? 1080 : resolution === "720p" ? 720 : 480;
  const w16 = Math.round((h * 16) / 9 / 2) * 2;
  switch (aspect) {
    case "16:9": return `${w16}x${h}`;
    case "9:16": return `${h}x${w16}`;
    case "1:1": return `${h}x${h}`;
    case "3:2": return `${Math.round((h * 3) / 2 / 2) * 2}x${h}`;
    case "2:3": return `${h}x${Math.round((h * 3) / 2 / 2) * 2}`;
    default: return undefined; // auto → نترك الاختيار للمزود
  }
}

/** تحويل aspect_ratio إلى حجم صورة مدعوم (gpt-image: مربع/أفقي/عمودي) */
function sizeForImage(aspect?: string): string | undefined {
  switch (aspect) {
    case "16:9": case "3:2": case "5:4": case "2:1": case "21:9": case "3:1":
      return "1536x1024";
    case "9:16": case "2:3": case "4:5": case "1:2": case "9:21": case "1:3":
      return "1024x1536";
    case "1:1": case "4:3": case "3:4":
      return "1024x1024";
    default:
      return undefined; // auto
  }
}

/** استخراج روابط من استجابة استعلام مهمة فيديو — دفاعي بلا اختراع حقول */
function extractVideoUrls(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const candidates: unknown[] = [
    body, body.data, body.result, body.output,
    (body as { video?: unknown }).video,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    for (const f of ["url", "video_url", "videoUrl", "download_url", "downloadUrl"]) {
      const v = o[f];
      if (typeof v === "string" && /^https?:\/\//.test(v)) out.push(v);
    }
    if (Array.isArray(o.data)) {
      for (const d of o.data as Record<string, unknown>[]) {
        if (d && typeof d.url === "string" && /^https?:\/\//.test(d.url)) out.push(d.url);
      }
    }
  }
  return [...new Set(out)];
}

export const cometApiAdapter: ProviderAdapter = {
  // الصور عبر CometAPI تُعاد فورًا — نستخدم createImageSync
  async createImageSync(key: ProviderKey, model: string, input: Record<string, unknown>) {
    const payload: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      n: 1,
      response_format: "url",
    };
    if (typeof input.aspect_ratio === "string" && input.aspect_ratio !== "auto") {
      payload.size = sizeForImage(input.aspect_ratio);
    }
    if (typeof input.background === "string" && input.background !== "auto") payload.background = input.background;
    if (typeof input.output_format === "string") payload.output_format = input.output_format;

    const body = await cometJson(key, "/images/generations", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const data = (body.data ?? []) as { url?: string; b64_json?: string }[];
    const urls = (data ?? [])
      .map((d) => (d?.url ? d.url : d?.b64_json ? `data:image/png;base64,${d.b64_json}` : ""))
      .filter((u) => u.length > 0);
    if (!urls.length) throw new ProviderError("CometAPI images: استجابة بلا روابط", 502);
    return { urls };
  },

  // الفيديو غير متزامن: إنشاء مهمة ثم استعلام حالتها
  async createTask(key: ProviderKey, model: string, input: Record<string, unknown>) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", String(input.prompt ?? ""));
    const seconds = Number(input.duration);
    if (Number.isFinite(seconds) && seconds > 0) form.append("seconds", String(Math.min(30, Math.round(seconds))));
    const size = sizeForVideo(input.aspect_ratio as string | undefined, input.resolution as string | undefined);
    if (size) form.append("size", size);
    if (typeof input.image_url === "string" && input.image_url) form.append("input_reference", input.image_url);

    const body = await cometJson(key, "/videos", { method: "POST", body: form });
    const taskId = (body.task_id ?? body.id) as string | undefined;
    if (!taskId) throw new ProviderError("CometAPI videos: استجابة بلا task_id", 502);
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKey, providerTaskId: string) {
    const body = await cometJson(key, `/videos/${encodeURIComponent(providerTaskId)}`, { method: "GET" });
    const status = String(body.status ?? "").toLowerCase();
    if (status === "completed" || status === "succeeded" || status === "success") {
      const urls = extractVideoUrls(body);
      if (!urls.length) return { status: "failed" as const, error: "اكتمل التوليد دون روابط نتيجة" };
      return { status: "completed" as const, urls, progress: 100 };
    }
    if (status === "failed" || status === "error" || status === "cancelled") {
      const msg = (body.error as { message?: string } | string | undefined);
      const errText = typeof msg === "string" ? msg : msg?.message ?? "فشل التوليد لدى المزود";
      return { status: "failed" as const, error: String(errText) };
    }
    const progress = typeof body.progress === "number" ? Math.min(90, Math.max(5, body.progress)) : undefined;
    return { status: "processing" as const, progress };
  },
};
