// ============================================================
// عميل خدمة دمج الفيديو — Video Merger API v2 (قسم 7)
// • بلا مفاتيح أو توثيق — العنوان من MERGER_API_BASE.
// • روابط فقط: لا تُنزَّل أي وسائط إلى سيرفرنا إطلاقًا.
// • القاعدة الحتمية: أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) =
//   فشل نهائي فوري لا إعادة محاولة. أخطاء شبكتنا نحن (timeout/fetch) مؤقتة.
// • POST .../process يُطلق خلفيًا وبمرة واحدة فقط بقفل في الذاكرة.
// • ملفات الدمج تُحذف من الخدمة بعد ~24 ساعة (expiresAt).
// ============================================================
import { ensureSchema, getTask, insertTask, updateTask, type TaskRow } from "./turso";
import {
  ToolInputError, ProgressCb, POLL_MS, sanitizeForClient, sleep, waitBudget,
} from "./core";

const BASE = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");

/** هل خدمة الدمج مهيأة فعليًا؟ (نرفض العناوين الافتراضية النائبة xxxx) */
export function mergerConfigured(): boolean {
  return BASE.length > 0 && !/x{4,}/i.test(BASE) && /^https?:\/\//.test(BASE);
}

export function mergerBase(): string {
  return BASE || "";
}

export const MERGER_LIMITS = {
  maxSources: 10,
  sourceMaxMb: 200,
  outputMaxMb: 150,
  maxTotalDurationSec: 600,
  retentionHours: 24,
};

/** أخطاء الخدمة المعلنة → فشل حتمي فوري */
export class MergerFinalError extends Error {}
/** أخطاء شبكتنا نحن → مؤقتة وتستمر بالاستعلام */
export class MergerTempError extends Error {}

/** قفل يمنع تنفيذ process المتزامن مع get_task لنفس المهمة */
const processInFlight = new Set<string>();

async function mFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 30_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new MergerTempError(`network: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}

// ------------------------------------------------------------
// تحليل دفاعي للحالة (7.2)
// ------------------------------------------------------------
export function normalizeMergerStatus(body: Record<string, unknown>): "done" | "failed" | "processing" {
  // الجسم قد يرد فيه error بدون حقل status → نعاملها failed فورًا
  if (body.error && !body.status && !body.state) return "failed";
  const s = String(body.status ?? body.state ?? "").toLowerCase();
  if (/^(done|completed|complete|success|succeeded|finished)$/.test(s)) return "done";
  if (/^(error|failed|failure|cancelled|canceled)$/.test(s)) return "failed";
  return "processing";
}

/** progress يأتي أحيانًا كسرًا 0..1 → نضربه في 100 */
export function normalizeProgress(p: unknown): number {
  const n = typeof p === "number" ? p : Number(p);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n <= 1) return Math.round(n * 100);
  return Math.min(100, Math.round(n));
}

/** فضّل videoUrl ثم downloadUrl — وإن غابا وبقي jobId فاضبط رابط الفيديو */
export function resolveVideoUrl(jobId: string, body: Record<string, unknown>): string {
  const candidates = [
    body.videoUrl, body.video_url, body.downloadUrl, body.download_url,
    (body.data as Record<string, unknown> | undefined)?.videoUrl,
    (body.data as Record<string, unknown> | undefined)?.downloadUrl,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return c;
  }
  return `${BASE}/api/jobs/${jobId}/video`;
}

// ------------------------------------------------------------
// نداءات الخدمة
// ------------------------------------------------------------
async function createMergeJob(urls: string[]): Promise<string> {
  const { status, body } = await mFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: urls }),
  });
  if (status < 200 || status >= 300) {
    throw new MergerFinalError(String(body.error ?? `HTTP ${status}`));
  }
  const jobId = body.jobId ?? body.job_id ?? body.id;
  if (!jobId) throw new MergerFinalError("استجابة إنشاء مهمة الدمج بلا jobId");
  return String(jobId);
}

/**
 * تنفيذ الدمج الفعلي (يستغرق ~10–15 ثانية، blocking) — يُنفَّذ مرة واحدة فقط
 * لكل مهمة بفضل القفل + علم processStarted في params_json.
 */
async function runProcessOnce(jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  try {
    const { status, body } = await mFetch(`/api/jobs/${jobId}/process`, { method: "POST" }, 180_000);
    if (status >= 400) throw new MergerFinalError(String(body.error ?? `HTTP ${status}`));
  } finally {
    processInFlight.delete(jobId);
  }
}

async function getJobStatus(jobId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return mFetch(`/api/jobs/${jobId}`, { method: "GET" });
}

// ------------------------------------------------------------
// runMerge — تدفق أداة merge_videos (7.3)
// ------------------------------------------------------------
export async function runMerge(
  args: { urls?: string[]; task_ids?: string[]; wait_seconds?: number },
  onProgress?: ProgressCb,
): Promise<TaskRow> {
  await ensureSchema();

  // خدمة الدمج غير مهيأة → رسالة عربية واضحة فورًا (بدون إنشاء مهمة)
  if (!mergerConfigured()) {
    throw new ToolInputError(
      "❌ خدمة الدمج غير مُهيأة بعد. اضبط متغير البيئة MERGER_API_BASE على عنوان خدمة Video Merger v2 ثم أعد المحاولة. (توليد الصور والفيديو يعمل بشكل كامل)",
    );
  }

  // 1) حلّ task_ids بالترتيب أولًا ثم روابط urls المباشرة بنفس ترتيبها
  const collected: string[] = [];
  const failedIds: string[] = [];
  for (const tid of args.task_ids ?? []) {
    const t = await getTask(String(tid).trim());
    if (t && t.status === "completed" && t.result_urls_json) {
      try {
        const urls = JSON.parse(t.result_urls_json) as string[];
        if (Array.isArray(urls) && urls.length && /^https?:\/\//.test(urls[0])) {
          collected.push(urls[0]);
          continue;
        }
      } catch { /* يُعامَل كمعرّف فاشل */ }
    }
    failedIds.push(String(tid));
  }
  for (const u of args.urls ?? []) collected.push(String(u).trim());

  // 2) تحقق صارم: ≥2 وكلها http/https مباشرة وعامة و≤10
  if (collected.length > MERGER_LIMITS.maxSources) {
    throw new ToolInputError(
      `❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).`,
    );
  }
  if (collected.length < 2) {
    let m = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (failedIds.length) m += `\nتفاصيل المعرّفات غير الصالحة: ${failedIds.join(" ، ")}`;
    throw new ToolInputError(m);
  }
  if (failedIds.length) {
    throw new ToolInputError(
      `❌ تعذر حل بعض المعرّفات (تكون مهمة غير مكتملة أو غير موجودة): ${failedIds.join(" ، ")}`,
    );
  }
  const bad = collected.filter((u) => !/^https?:\/\//i.test(u));
  if (bad.length) {
    throw new ToolInputError(`❌ كل الروابط يجب أن تكون روابط فيديو مباشرة عامة (http/https). روابط غير صالحة: ${bad.join(" ، ")}`);
  }

  // 3) سجّل مهمة type=merge في Turso أولًا
  let task = await insertTask({
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${collected.length} مقاطع`,
    params: { urls: collected },
  });

  // 4) أنشئ المهمة لدى الخدمة ثم أطلق process خلفيًا بمرة واحدة فقط
  try {
    const jobId = await createMergeJob(collected);
    task = (await updateTask(task.id, {
      provider: "merger",
      provider_task_id: jobId,
      progress: 5,
      params_merge: { processStarted: true },
    }))!;
    await runProcessOnce(jobId);
  } catch (e) {
    if (e instanceof MergerFinalError) {
      // خطأ معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
      return (await updateTask(task.id, {
        status: "failed", error_message: sanitizeForClient(e.message),
      }))!;
    }
    // مؤقت → تبقى processing وستستأنف تلقائيًا مع get_task
    return (await updateTask(task.id, {
      error_message: "تعذر الوصول لخدمة الدمج مؤقتًا — ستُستأنف تلقائيًا",
    }))!;
  }

  // 5) نافذة الانتظار (افتراضي 60 ثانية): استعلام كل 3 ثوانٍ مع بث تقدم
  const waitS = waitBudget(args.wait_seconds ?? 60);
  const deadline = Date.now() + waitS * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    task = await refreshMergeTask((await getTask(task.id))!);
    await onProgress?.(task.progress, `جارٍ الدمج… ${task.progress}%`);
    if (task.status !== "processing") return task;
  }
  return task;
}

// ------------------------------------------------------------
// refreshMergeTask — يستدعيه get_task لمهام الدمج (7.3.6)
// ------------------------------------------------------------
export async function refreshMergeTask(task: TaskRow, depth = 0): Promise<TaskRow> {
  if (!mergerConfigured()) {
    return (await updateTask(task.id, {
      status: "failed",
      error_message: "خدمة الدمج غير مُهيأة (MERGER_API_BASE غير مضبوط)",
    }))!;
  }

  const params = safeParse(task.params_json);
  const jobId = task.provider_task_id;

  // لم تُنشأ المهمة لدى الخدمة بعد (تعذر الوصول مؤقتًا عند الإنشاء) → أنشئها الآن
  if (!jobId) {
    try {
      const urls = (params.urls ?? []) as string[];
      const newJobId = await createMergeJob(urls);
      await updateTask(task.id, {
        provider: "merger",
        provider_task_id: newJobId,
        params_merge: { processStarted: true },
      });
      await runProcessOnce(newJobId);
      const fresh = (await getTask(task.id))!;
      return depth < 1 ? refreshMergeTask(fresh, depth + 1) : fresh;
    } catch (e) {
      if (e instanceof MergerFinalError) {
        return (await updateTask(task.id, {
          status: "failed", error_message: sanitizeForClient(e.message),
        }))!;
      }
      return (await getTask(task.id))!; // مؤقت → تابع
    }
  }

  const { status, body } = await getJobStatus(jobId);

  // 404 → فشل نهائي: المهمة حُذفت أو انتهت صلاحيتها بعد 24 ساعة
  if (status === 404) {
    return (await updateTask(task.id, {
      status: "failed",
      error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
    }))!;
  }
  if (status >= 400) {
    return (await updateTask(task.id, {
      status: "failed", error_message: sanitizeForClient(String(body.error ?? `HTTP ${status}`)),
    }))!;
  }

  const st = normalizeMergerStatus(body);
  if (st === "done") {
    return (await updateTask(task.id, {
      status: "completed",
      result_urls: [resolveVideoUrl(jobId, body)],
      progress: 100,
      error_message: null,
    }))!;
  }
  if (st === "failed") {
    return (await updateTask(task.id, {
      status: "failed",
      error_message: sanitizeForClient(String(body.error ?? "فشل الدمج لدى الخدمة")),
    }))!;
  }

  // جارية: إن كانت في الطابور ولم يُنفَّذ process بعد فنفّذه الآن (بالقفل)
  const jobState = String(body.status ?? body.state ?? "").toLowerCase();
  if (jobState === "queued" && !params.processStarted && depth < 1) {
    await updateTask(task.id, { params_merge: { processStarted: true } });
    try {
      await runProcessOnce(jobId);
    } catch (e) {
      if (e instanceof MergerFinalError) {
        return (await updateTask(task.id, {
          status: "failed", error_message: sanitizeForClient(e.message),
        }))!;
      }
      // مؤقت → استمر بالاستعلام في الطلبات التالية
    }
    const fresh = (await getTask(task.id))!;
    return refreshMergeTask(fresh, depth + 1);
  }

  const next = Math.max(task.progress, Math.min(90, normalizeProgress(body.progress)));
  if (next > task.progress) return (await updateTask(task.id, { progress: next }))!;
  return task;
}

function safeParse(json: string): Record<string, unknown> {
  try { return JSON.parse(json || "{}"); } catch { return {}; }
}
