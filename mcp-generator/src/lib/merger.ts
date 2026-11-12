// عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح/توثيق)
// القاعدة الذهبية: أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري؛
// أخطاء شبكتنا نحن (timeout/abort/fetch) = مؤقتة وتستمر بالاستعلام حتى انتهاء النافذة.

import { ProviderError, errMessage } from "./errors";

// فشل نهائي معلن من خدمة الدمج — لا إعادة محاولة
export class MergeFinalError extends ProviderError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "MergeFinalError";
  }
}

// المهمة غير موجودة (HTTP 404) — حُذفت أو انتهت صلاحيتها بعد 24 ساعة
export class MergeGoneError extends Error {
  constructor() {
    super("مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    this.name = "MergeGoneError";
  }
}

export const MERGER_NOT_CONFIGURED =
  "خدمة الدمج غير مهيأة بعد — عيّن MERGER_API_BASE في متغيرات البيئة";

export function mergerBase(): string | null {
  const b = (process.env.MERGER_API_BASE || "").trim().replace(/\/+$/, "");
  return b || null;
}

export function mergerConfigured(): boolean {
  return mergerBase() !== null;
}

async function mergerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 30_000
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = mergerBase();
  if (!base) throw new MergeFinalError(MERGER_NOT_CONFIGURED);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, { ...init, signal: ctrl.signal, cache: "no-store" });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
    return { status: res.status, body };
  } catch (err) {
    // شبكتنا/مهلة → مؤقت (بلا حالة HTTP)
    const msg = err instanceof Error ? (err.name === "AbortError" ? `انتهت مهلة الاتصال بخدمة الدمج (${path})` : err.message) : String(err);
    throw new ProviderError(msg);
  } finally {
    clearTimeout(timer);
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

// ================== إنشاء مهمة دمج ==================
export interface CreatedJob {
  jobId: string;
  status: string;
  expiresAt?: string;
}

// POST /api/jobs {"videos":[...]} → {jobId, status, statusUrl, processUrl, expiresAt}
export async function createJob(urls: string[]): Promise<CreatedJob> {
  const { status, body } = await mergerFetch(
    "/api/jobs",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: urls }) },
    30_000
  );
  if (status < 200 || status >= 300) {
    throw new MergeFinalError(str(body.error) ?? `خدمة الدمج رفضت إنشاء المهمة (HTTP ${status})`, status);
  }
  const jobId = str(body.jobId) ?? str(body.job_id) ?? str(body.id);
  if (!jobId) {
    // شكل غير متوقع — نعامله كمؤقت لتُعاد المحاولة مع get_task
    throw new ProviderError(`خدمة الدمج: شكل استجابة غير متوقع عند إنشاء المهمة: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return { jobId, status: str(body.status) ?? "queued", expiresAt: str(body.expiresAt) ?? undefined };
}

// ================== تنفيذ الدمج (حاجب ~10-60 ثانية) ==================
export type ProcessOutcome =
  | { kind: "done"; videoUrl: string; downloadUrl?: string; size?: number; duration?: number; resolution?: string; expiresAt?: string }
  | { kind: "processing" };

export async function processJob(jobId: string): Promise<ProcessOutcome> {
  // النداء حاجب ~10-60 ثانية → مهلة سخية (120 ثانية)
  const { status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 120_000);
  if (status === 200) {
    const base = mergerBase() ?? "";
    const videoUrl = str(body.videoUrl) ?? str(body.downloadUrl) ?? `${base}/api/jobs/${jobId}/video`;
    return {
      kind: "done",
      videoUrl,
      downloadUrl: str(body.downloadUrl) ?? undefined,
      size: Number(body.size) || undefined,
      duration: Number(body.duration) || undefined,
      resolution: str(body.resolution) ?? undefined,
      expiresAt: str(body.expiresAt) ?? undefined,
    };
  }
  if (status === 202) return { kind: "processing" };
  // 4xx/5xx مع {"error"} = فشل نهائي (حتمي) — لا إعادة محاولة
  throw new MergeFinalError(str(body.error) ?? `خدمة الدمج رفضت التنفيذ (HTTP ${status})`, status);
}

// ================== استعلام حالة المهمة ==================
export type JobStatusResult =
  | { status: "processing"; progress?: number; queued?: boolean }
  | { status: "completed"; url: string; expiresAt?: string }
  | { status: "failed"; error: string };

const DONE_RE = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAILED_RE = /^(error|failed|failure|cancelled|canceled)$/i;

// GET /api/jobs/{id} — تحليل دفاعي
export async function getJob(jobId: string): Promise<JobStatusResult> {
  const { status, body } = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, 30_000);
  if (status === 404) throw new MergeGoneError();
  if (status >= 400) throw new MergeFinalError(str(body.error) ?? `خدمة الدمج أعلنت خطأ (HTTP ${status})`, status);

  const st = str(body.status)?.trim() ?? "";
  const err = str(body.error);

  // جسم فيه error بدون status → فشل فورًا
  if (!st && err) return { status: "failed", error: err };
  if (FAILED_RE.test(st)) return { status: "failed", error: err ?? "فشل الدمج لدى الخدمة" };
  if (DONE_RE.test(st)) {
    const base = mergerBase() ?? "";
    // رابط النتيجة: فضّل videoUrl ثم downloadUrl ثم رابط البث الافتراضي
    const url = str(body.videoUrl) ?? str(body.downloadUrl) ?? `${base}/api/jobs/${jobId}/video`;
    return { status: "completed", url, expiresAt: str(body.expiresAt) ?? undefined };
  }
  // progress قد يأتي كسرًا 0..1 → اضربه في 100
  let progress: number | undefined;
  const p = Number(body.progress);
  if (Number.isFinite(p)) progress = p > 0 && p <= 1 ? Math.round(p * 100) : Math.round(p);
  return { status: "processing", progress, queued: st === "queued" || st === "" };
}

// ================== فحص الجهوزية (4 ثوانٍ) ==================
export async function mergerHealthy(): Promise<boolean> {
  const base = mergerBase();
  if (!base) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${base}/api/config`, { signal: ctrl.signal, cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export { errMessage };
