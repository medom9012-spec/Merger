// منسّق التوليد والدمج — قلب المشروع:
// - تبديل تسلسلي صارم للمفاتيح عند أي فشل (بصمت تام: العميل لا يرى أخطاء مفاتيح/رصيد أبدًا)
// - إعادة إنشاء نفس المهمة بنفس task_id عند فشل مفتاح في منتصف المهمة
// - مهام تظل processing عند نفاد المفاتيح وتُعاد محاولتها مع كل get_task (تهدئة 45 ثانية)

import { randomUUID } from "node:crypto";
import {
  NoDatabaseError,
  insertTask,
  getTask,
  updateTask,
  getKeyPool,
  bumpKeyCounters,
  listRecentTasks,
  parseUrls,
  parseAttempts,
  type ApiKeyRow,
  type Attempt,
  type TaskPatch,
  type TaskRow,
} from "./turso";
import {
  normalizeModel,
  modelByType,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  type MediaType,
  type ModelDef,
} from "./models";
import {
  ProviderErrorClass,
  classifyProviderError,
  classifyKeyFailureMessage,
  KEY_FAIL_RE,
  errMessage,
} from "./errors";
import { getAdapter } from "./providers";
import {
  mergerConfigured,
  createJob,
  processJob,
  getJob,
  MergeFinalError,
  MergeGoneError,
  MERGER_NOT_CONFIGURED,
} from "./merger";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

// معطيات التوليد الأصلية (تُخزن كاملة في params_json لإعادة الإنشاء عند التبديل)
export interface GenerationArgs {
  prompt?: string;
  model?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
  wait_seconds?: number;
}

export interface MergeArgs {
  urls?: string[];
  task_ids?: string[];
  wait_seconds?: number;
}

const POLL_INTERVAL_MS = 3000;      // استطلاع كل 3 ثوانٍ خلال نافذة الانتظار
const RETRY_COOLDOWN_MS = 45_000;   // تهدئة 45 ثانية قبل إعادة الإنشاء مع get_task
const MERGE_DEFAULT_WAIT = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_AR: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "جارية",
  pending: "قيد الانتظار",
};

function newAttempt(a: Omit<Attempt, "at">): Attempt {
  return { ...a, at: new Date().toISOString() };
}

// ================== صياغة الردود العربية (صيغ مطابقة للمواصفة) ==================
export function processingText(taskId: string, progress?: number): string {
  const lines = [`⏳ المهمة قيد المعالجة — task_id: ${taskId}`];
  if (typeof progress === "number" && progress > 0) lines.push(`نسبة التقدم الحالية: ${progress}%`);
  lines.push("تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.");
  return lines.join("\n");
}

function linksBlock(urls: string[]): string {
  return urls.map((u) => `الرابط المباشر: ${u}`).join("\n");
}

export function completedText(type: MediaType, urls: string[]): string {
  if (type === "image") {
    const first = urls[0] ?? "";
    return ["✅ تم توليد الصورة بنجاح", "", `![image](${first})`, "", linksBlock(urls)].join("\n");
  }
  if (type === "video") {
    return ["✅ تم توليد الفيديو بنجاح", linksBlock(urls)].join("\n");
  }
  return [
    "✅ تم دمج المقاطع بنجاح",
    linksBlock(urls),
    "",
    "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.",
  ].join("\n");
}

function failureText(reason: string): ToolResult {
  return { text: `❌ فشلت المهمة: ${reason}`, isError: true };
}

function noKeysText(model: string): ToolResult {
  return {
    text: `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    isError: true,
  };
}

// ================== بناء مدخلات المزودين ==================
function buildImageInput(def: ModelDef, args: GenerationArgs): Record<string, unknown> {
  // المدخل الموثّق لـ kie: {prompt, aspect_ratio, resolution, background, output_format}
  const input: Record<string, unknown> = { prompt: args.prompt ?? "" };
  if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
  if (args.resolution) input.resolution = args.resolution;
  if (args.background && args.background !== "auto") input.background = args.background;
  if (args.output_format) input.output_format = args.output_format;
  return input;
}

function buildVideoInput(def: ModelDef, args: GenerationArgs): Record<string, unknown> {
  // المدخل الموثّق لـ kie: {prompt, image_url?, aspect_ratio, resolution, enable_audio, duration}
  const input: Record<string, unknown> = { prompt: args.prompt ?? "" };
  if (typeof args.image_url === "string" && args.image_url.trim()) input.image_url = args.image_url.trim();
  if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
  if (args.resolution) input.resolution = args.resolution;
  input.enable_audio = args.enable_audio !== false;
  const dur = Math.round(Number(args.duration ?? 8));
  input.duration = clamp(Number.isFinite(dur) && dur > 0 ? dur : 8, 1, 15);
  return input;
}

function parseParams(json: string): GenerationArgs {
  try {
    const v = JSON.parse(json);
    return (v && typeof v === "object" ? v : {}) as GenerationArgs;
  } catch {
    return {};
  }
}

// هل مضى على updated_at ما يكفي لتجاوز التهدئة؟ (datetime('now') بصيغة UTC)
function cooldownOk(updatedAt: string | null): boolean {
  if (!updatedAt) return true;
  const t = Date.parse(updatedAt.includes("T") ? updatedAt : updatedAt.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return true;
  return Date.now() - t >= RETRY_COOLDOWN_MS;
}

// ================== الإنشاء على مفتاح واحد ==================
interface ConnectInfo {
  provider: string;
  providerTaskId: string;
  keyId: string;
  syncUrls?: string[]; // للصور المتزامنة (اكتمال فوري)
}

type CreateOutcome =
  | { kind: "async"; info: ConnectInfo }
  | { kind: "sync"; urls: string[] }
  | { kind: "error"; cls: ProviderErrorClass; msg: string };

// تجربة إنشاء المهمة على مفتاح واحد — تسجّل المحاولة وتحدّث العدّادات دائمًا
async function tryCreateOnKey(
  def: ModelDef,
  type: "image" | "video",
  keyRow: ApiKeyRow,
  taskId: string,
  input: Record<string, unknown>
): Promise<CreateOutcome> {
  try {
    const adapter = getAdapter(keyRow.provider);
    const providerModelName = def.providerModel[keyRow.provider as keyof typeof def.providerModel] ?? def.canonical;

    if (type === "image" && adapter.createImageSync) {
      // مسار متزامن (CometAPI): النتيجة فورًا
      const { urls } = await adapter.createImageSync(keyRow.api_key, { ...input, model: providerModelName });
      await bumpKeyCounters(keyRow.id, { ok: true });
      await updateTask(taskId, {
        provider: keyRow.provider,
        key_id: keyRow.id,
        status: "completed",
        progress: 100,
        result_urls: urls,
        attempt: newAttempt({ provider: keyRow.provider, keyId: keyRow.id, keyLabel: keyRow.label, ok: true }),
      });
      return { kind: "sync", urls };
    }

    const { providerTaskId } = await adapter.createTask(keyRow.api_key, providerModelName, input);
    await bumpKeyCounters(keyRow.id, { ok: true });
    await updateTask(taskId, {
      provider: keyRow.provider,
      provider_task_id: providerTaskId,
      key_id: keyRow.id,
      status: "processing",
      progress: 5,
      attempt: newAttempt({ provider: keyRow.provider, keyId: keyRow.id, keyLabel: keyRow.label, ok: true }),
    });
    return { kind: "async", info: { provider: keyRow.provider, providerTaskId, keyId: keyRow.id } };
  } catch (err) {
    const cls = classifyProviderError(err);
    const msg = errMessage(err);
    // فشل → عدّادات + تعليم الحالة حسب التصنيف + تسجيل المحاولة
    await bumpKeyCounters(keyRow.id, { ok: false, errorClass: cls, error: msg }).catch(() => {});
    await updateTask(taskId, {
      attempt: newAttempt({
        provider: keyRow.provider,
        keyId: keyRow.id,
        keyLabel: keyRow.label,
        ok: false,
        errorClass: cls,
        error: msg,
      }),
    }).catch(() => {});
    return { kind: "error", cls, msg };
  }
}

// ================== فحص حالة مهمة عبر مفاتيح نفس المزود ==================
type CheckOutcome =
  | { kind: "completed"; urls: string[]; keyRow: ApiKeyRow }
  | { kind: "failed"; error: string; keyRow?: ApiKeyRow }
  | { kind: "processing"; progress?: number; keyRow: ApiKeyRow }
  | { kind: "unavailable" };

// يجرّب مفتاح المهمة أولًا ثم بقية مفاتيح نفس المزود بالترتيب
async function checkViaPool(
  provider: string,
  preferredKeyId: string | null,
  providerTaskId: string
): Promise<CheckOutcome> {
  let candidates: ApiKeyRow[] = [];
  try {
    const adapter = getAdapter(provider);
    const pool = await getKeyPool([provider]);
    const preferred = preferredKeyId ? pool.find((k) => k.id === preferredKeyId) : undefined;
    candidates = preferred ? [preferred, ...pool.filter((k) => k.id !== preferredKeyId)] : pool;
    if (candidates.length === 0) return { kind: "unavailable" };

    for (const keyRow of candidates) {
      try {
        const r = await adapter.checkTask(keyRow.api_key, providerTaskId);
        if (r.status === "completed") return { kind: "completed", urls: r.urls ?? [], keyRow };
        if (r.status === "failed") return { kind: "failed", error: r.error ?? "", keyRow };
        return { kind: "processing", progress: r.progress, keyRow };
      } catch (err) {
        // مفتاح مرفوض/مستنزف أثناء الفحص → علّمه وجرّب التالي؛ الشبكة → غير متاح الآن
        const cls = classifyProviderError(err);
        if (cls === "disabled" || cls === "exhausted") {
          await bumpKeyCounters(keyRow.id, { ok: false, errorClass: cls, error: errMessage(err) }).catch(() => {});
          continue;
        }
        return { kind: "unavailable" };
      }
    }
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

// ================== إعادة الإنشاء على المفتاح التالي (نفس task_id) ==================
type ResumeOutcome =
  | { kind: "resumed"; info: ConnectInfo }
  | { kind: "failed"; reason: string }
  | { kind: "exhausted" };

async function recreateOnNextKey(
  taskId: string,
  def: ModelDef,
  type: "image" | "video",
  args: GenerationArgs,
  pool: ApiKeyRow[],
  afterKeyId: string | null
): Promise<ResumeOutcome> {
  const input = type === "image" ? buildImageInput(def, args) : buildVideoInput(def, args);
  // نكمل قائمة المرشحين من حيث توقفنا (بعد المفتاح الذي فشل)
  const startIdx = afterKeyId ? pool.findIndex((k) => k.id === afterKeyId) + 1 : 0;
  for (let i = Math.max(0, startIdx); i < pool.length; i++) {
    const outcome = await tryCreateOnKey(def, type, pool[i], taskId, input);
    if (outcome.kind === "async") return { kind: "resumed", info: outcome.info };
    if (outcome.kind === "sync") {
      return { kind: "resumed", info: { provider: pool[i].provider, providerTaskId: "", keyId: pool[i].id, syncUrls: outcome.urls } };
    }
    if (outcome.kind === "error") {
      // خطأ معطيات أثناء إعادة الإنشاء → توقف فورًا
      if (outcome.cls === "params") return { kind: "failed", reason: `رفض المزود المعطيات — ${outcome.msg}` };
      continue; // disabled/exhausted/provider/temporary → المفتاح التالي بصمت
    }
  }
  return { kind: "exhausted" };
}

// ================== runGeneration (صور / فيديو) ==================
export async function runGeneration(type: "image" | "video", args: GenerationArgs): Promise<ToolResult> {
  // 1) توحيد اسم الموديل — مجهول → خطأ معطيات فوري
  const def = normalizeModel(args.model ?? (type === "image" ? DEFAULT_IMAGE_MODEL : DEFAULT_VIDEO_MODEL));
  if (!def || def.type !== type) {
    const img = modelByType("image")?.canonical ?? "";
    const vid = modelByType("video")?.canonical ?? "";
    const hint = def ? (def.type === "video" ? " خاص بتوليد الفيديو — استخدم أداة generate_video." : " خاص بتوليد الصور — استخدم أداة generate_image.") : " غير معروف.";
    return {
      text: `❌ خطأ في المعطيات: الموديل "${args.model ?? ""}"${hint} الموديلات المتاحة: ${img} (صور)، ${vid} (فيديو).`,
      isError: true,
    };
  }
  if (!args.prompt || !String(args.prompt).trim()) {
    return { text: "❌ خطأ في المعطيات: الوصف (prompt) مطلوب ولا يمكن أن يكون فارغًا.", isError: true };
  }

  // 2) تجيب المفاتيح بالترتيب — فارغة → رد no_keys دون إنشاء مهمة
  const pool = await getKeyPool(def.providers);
  if (pool.length === 0) return noKeysText(def.canonical);

  // 3) تسجيل المهمة قبل أي نداء خارجي (المعطيات الأصلية كاملة للإعادة لاحقًا)
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: def.canonical,
    type,
    prompt: String(args.prompt),
    params_json: JSON.stringify(args),
    status: "pending",
    progress: 0,
  });

  const input = type === "image" ? buildImageInput(def, args) : buildVideoInput(def, args);

  // 4) تجربة المرشحين بالترتيب — أول نجاح يربط المهمة بالمزود والمفتاح
  let connected: ConnectInfo | null = null;
  for (const keyRow of pool) {
    const outcome = await tryCreateOnKey(def, type, keyRow, taskId, input);
    if (outcome.kind === "async") { connected = outcome.info; break; }
    if (outcome.kind === "sync") return { text: completedText("image", outcome.urls) };
    if (outcome.kind === "error") {
      if (outcome.cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
        const reason = `رفض المزود المعطيات — ${outcome.msg}`;
        await updateTask(taskId, { status: "failed", error_message: reason });
        return failureText(reason);
      }
      // disabled/exhausted/provider/temporary → المفتاح التالي بصمت تام
    }
  }

  if (!connected) {
    // فشل الإنشاء على كل المفاتيح: تبقى processing وتُعاد المحاولة مع كل get_task (بتهدئة)
    await updateTask(taskId, { status: "processing", progress: 0, error_message: "بانتظار توفر مفتاح صالح…" });
    return { text: processingText(taskId, 0) };
  }

  // 5) نافذة الانتظار (الافتراضي: 90 للصور و25 للفيديو، بحد 0..240)
  const waitSeconds = clamp(Math.round(Number(args.wait_seconds ?? (type === "image" ? 90 : 25))) || 0, 0, 240);
  return await waitWindow(taskId, type, args, pool, def, connected, waitSeconds);
}

// نافذة استطلاع النتيجة كل 3 ثوانٍ مع تحديث التقدم في القاعدة
async function waitWindow(
  taskId: string,
  type: "image" | "video",
  args: GenerationArgs,
  pool: ApiKeyRow[],
  def: ModelDef,
  start: ConnectInfo,
  waitSeconds: number
): Promise<ToolResult> {
  const deadline = Date.now() + waitSeconds * 1000;
  let current = start;
  let lastProgress = 5;

  if (current.syncUrls) return { text: completedText("image", current.syncUrls) };

  while (Date.now() < deadline) {
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    if (Date.now() >= deadline) break;

    const check = await checkViaPool(current.provider, current.keyId, current.providerTaskId);

    if (check.kind === "completed") {
      if (!check.urls.length) {
        const reason = "اكتملت المهمة لكن لم يُعثر على روابط نتائج";
        await updateTask(taskId, { status: "failed", error_message: reason });
        return failureText(reason);
      }
      await bumpKeyCounters(check.keyRow.id, { ok: true }).catch(() => {});
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        result_urls: check.urls,
        provider: current.provider,
        provider_task_id: current.providerTaskId,
        key_id: check.keyRow.id,
      });
      return { text: completedText(type, check.urls) };
    }

    if (check.kind === "failed") {
      const msg = check.error || "أعلن المزود فشل المهمة";
      if (KEY_FAIL_RE.test(msg)) {
        // فشل مفتاح/رصيد في منتصف المهمة → أعد إنشاء نفس المهمة بنفس task_id على المفتاح التالي
        const mark = classifyKeyFailureMessage(msg);
        if (mark && check.keyRow) {
          await bumpKeyCounters(check.keyRow.id, { ok: false, errorClass: mark, error: msg }).catch(() => {});
        }
        await updateTask(taskId, {
          attempt: newAttempt({
            provider: current.provider,
            keyId: check.keyRow?.id,
            keyLabel: check.keyRow?.label,
            ok: false,
            errorClass: mark ?? "key",
            error: msg,
          }),
        }).catch(() => {});
        const resume = await recreateOnNextKey(taskId, def, type, args, pool, current.keyId);
        if (resume.kind === "resumed") {
          current = resume.info;
          lastProgress = 5;
          if (current.syncUrls) return { text: completedText("image", current.syncUrls) };
          await updateTask(taskId, { progress: 5 }).catch(() => {});
          continue;
        }
        if (resume.kind === "failed") {
          await updateTask(taskId, { status: "failed", error_message: resume.reason });
          return failureText(resume.reason);
        }
        // نفدت قائمة المرشحين → تبقى processing بانتظار مفتاح صالح (يُعاد المحاولة مع get_task)
        await updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
        return { text: processingText(taskId, lastProgress) };
      }
      // فشل حقيقي (سياسة/معطيات/وسائط) → فشل نهائي
      await updateTask(taskId, { status: "failed", error_message: msg });
      return failureText(msg);
    }

    if (check.kind === "processing") {
      if (typeof check.progress === "number") {
        lastProgress = Math.max(lastProgress, Math.round(check.progress));
        await updateTask(taskId, { progress: lastProgress }).catch(() => {});
      }
    }
    // unavailable → استمر بالاستطلاع حتى انتهاء النافذة
  }
  return { text: processingText(taskId, lastProgress) };
}

// ================== refreshTask (تستخدمها get_task) ==================
export async function refreshTask(taskId: string): Promise<ToolResult> {
  const task = await getTask(taskId);
  if (!task) return { text: "لم يتم العثور على المهمة", isError: true };

  if (task.status === "completed") {
    const urls = parseUrls(task.result_urls_json);
    return { text: completedText(task.type as MediaType, urls) };
  }
  if (task.status === "failed") {
    return failureText(task.error_message ?? "سبب غير معروف");
  }

  // pending/processing → تحديث حي
  if (task.type === "merge") return refreshMergeTask(task);

  const def = normalizeModel(task.model);
  if (!def) {
    const reason = task.error_message ?? `موديل غير معروف: ${task.model}`;
    await updateTask(task.id, { status: "failed", error_message: reason });
    return failureText(reason);
  }
  const args = parseParams(task.params_json);

  // بلا provider_task_id → الإنشاء لم ينجح قط: أعد المحاولة على كل المفاتيح بالترتيب (بتهدئة 45 ثانية)
  if (!task.provider_task_id) {
    if (!cooldownOk(task.updated_at)) {
      return { text: processingText(task.id, task.progress) + "\n(تهدئة 45 ثانية قبل إعادة محاولة الإنشاء — أعد الاستعلام بعد قليل)" };
    }
    const pool = await getKeyPool(def.providers);
    if (pool.length === 0) return noKeysText(def.canonical);

    const input = task.type === "image" ? buildImageInput(def, args) : buildVideoInput(def, args);
    for (const keyRow of pool) {
      const outcome = await tryCreateOnKey(def, task.type as "image" | "video", keyRow, task.id, input);
      if (outcome.kind === "async") return { text: processingText(task.id, 5) };
      if (outcome.kind === "sync") return { text: completedText("image", outcome.urls) };
      if (outcome.kind === "error" && outcome.cls === "params") {
        const reason = `رفض المزود المعطيات — ${outcome.msg}`;
        await updateTask(task.id, { status: "failed", error_message: reason });
        return failureText(reason);
      }
    }
    await updateTask(task.id, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
    return { text: processingText(task.id, task.progress) };
  }

  // جارية بمهمة مزود → حدّث من المزود (مفتاح المهمة أولًا ثم بقية مفاتيح نفس المزود)
  const check = await checkViaPool(task.provider ?? "", task.key_id, task.provider_task_id);

  if (check.kind === "completed") {
    if (!check.urls.length) {
      const reason = "اكتملت المهمة لكن لم يُعثر على روابط نتائج";
      await updateTask(task.id, { status: "failed", error_message: reason });
      return failureText(reason);
    }
    await bumpKeyCounters(check.keyRow.id, { ok: true }).catch(() => {});
    await updateTask(task.id, {
      status: "completed",
      progress: 100,
      result_urls: check.urls,
      provider: check.keyRow.provider,
      key_id: check.keyRow.id,
    });
    return { text: completedText(task.type as MediaType, check.urls) };
  }

  if (check.kind === "failed") {
    const msg = check.error || "أعلن المزود فشل المهمة";
    if (KEY_FAIL_RE.test(msg)) {
      const mark = classifyKeyFailureMessage(msg);
      if (mark && check.keyRow) {
        await bumpKeyCounters(check.keyRow.id, { ok: false, errorClass: mark, error: msg }).catch(() => {});
      }
      await updateTask(task.id, {
        attempt: newAttempt({
          provider: task.provider ?? undefined,
          keyId: check.keyRow?.id,
          keyLabel: check.keyRow?.label,
          ok: false,
          errorClass: mark ?? "key",
          error: msg,
        }),
      }).catch(() => {});
      // تهدئة 45 ثانية قبل إعادة الإنشاء حتى لا نضغط المزودين
      if (!cooldownOk(task.updated_at)) {
        return { text: processingText(task.id, task.progress) + "\n(تهدئة 45 ثانية قبل التبديل التلقائي — أعد الاستعلام بعد قليل)" };
      }
      const pool = await getKeyPool(def.providers);
      const resume = await recreateOnNextKey(task.id, def, task.type as "image" | "video", args, pool, task.key_id);
      if (resume.kind === "resumed") {
        if (resume.info.syncUrls) return { text: completedText("image", resume.info.syncUrls) };
        return { text: processingText(task.id, 5) };
      }
      if (resume.kind === "failed") {
        await updateTask(task.id, { status: "failed", error_message: resume.reason });
        return failureText(resume.reason);
      }
      await updateTask(task.id, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
      return { text: processingText(task.id, task.progress) };
    }
    await updateTask(task.id, { status: "failed", error_message: msg });
    return failureText(msg);
  }

  if (check.kind === "processing") {
    let progress = task.progress;
    if (typeof check.progress === "number") {
      progress = Math.max(task.progress, Math.round(check.progress));
      await updateTask(task.id, { progress }).catch(() => {});
    }
    return { text: processingText(task.id, progress) };
  }

  // لا يمكن الفحص الآن (شبكة/لا مفاتيح) — تبقى جارية
  return { text: processingText(task.id, task.progress) };
}

// ================== الدمج (Video Merger API v2) ==================
// قفل في الذاكرة يمنع تزامن processJob مع get_task (single-flight)
const processInFlight = new Set<string>();

type ProcessOnceOutcome =
  | { kind: "done"; videoUrl: string }
  | { kind: "failed"; reason: string }
  | { kind: "processing" };

async function runProcessOnce(taskId: string, jobId: string): Promise<ProcessOnceOutcome> {
  if (processInFlight.has(jobId)) return { kind: "processing" };
  processInFlight.add(jobId);
  try {
    const out = await processJob(jobId);
    if (out.kind === "done") return { kind: "done", videoUrl: out.videoUrl };
    return { kind: "processing" };
  } catch (err) {
    if (err instanceof MergeFinalError || err instanceof MergeGoneError) {
      return { kind: "failed", reason: errMessage(err) };
    }
    return { kind: "processing" }; // شبكتنا — نستمر بالاستطلاع
  } finally {
    processInFlight.delete(jobId);
  }
}

export async function runMerge(args: MergeArgs): Promise<ToolResult> {
  if (!mergerConfigured()) return { text: MERGER_NOT_CONFIGURED, isError: true };

  // 1) حل الروابط من task_ids بالترتيب (فيديو مكتمل → أول رابط نتيجة)
  const problems: string[] = [];
  const resolved: string[] = [];
  for (const tid of args.task_ids ?? []) {
    const t = await getTask(String(tid)).catch(() => null);
    if (!t) { problems.push(`• المهمة "${tid}" غير موجودة في قاعدة البيانات`); continue; }
    if (t.type !== "video") { problems.push(`• المهمة "${tid}" ليست مهمة فيديو (النوع: ${TYPE_AR[t.type] ?? t.type})`); continue; }
    if (t.status !== "completed") { problems.push(`• المهمة "${tid}" لم تكتمل بعد (الحالة: ${STATUS_AR[t.status] ?? t.status})`); continue; }
    const urls = parseUrls(t.result_urls_json);
    if (urls.length === 0) { problems.push(`• المهمة "${tid}" مكتملة لكن بلا روابط نتائج`); continue; }
    resolved.push(urls[0]);
  }

  // 2) الروابط المباشرة — يجب أن تكون http/https
  const direct = (args.urls ?? []).map(String);
  const invalid = direct.filter((u) => !/^https?:\/\//i.test(u));
  const validDirect = direct.filter((u) => /^https?:\/\//i.test(u));

  if (problems.length > 0 || invalid.length > 0) {
    const lines = ["❌ تعذّر تجهيز مقاطع الدمج:", ...problems, ...invalid.map((u) => `• رابط غير صالح (يجب أن يكون http/https مباشرًا): ${u}`)];
    return { text: lines.join("\n"), isError: true };
  }

  // 3) حدود العدد: task_ids أولًا ثم urls بنفس ترتيبها
  const all = [...resolved, ...validDirect];
  if (all.length < 2) {
    return { text: "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.", isError: true };
  }
  if (all.length > 10) {
    return { text: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).", isError: true };
  }

  // 4) تسجيل المهمة أولًا ثم الإنشاء لدى الخدمة
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: "",
    params_json: JSON.stringify({ urls: all }),
    status: "pending",
    progress: 0,
  });

  let jobId: string;
  try {
    const job = await createJob(all);
    jobId = job.jobId;
  } catch (err) {
    if (err instanceof MergeFinalError || err instanceof MergeGoneError) {
      const reason = errMessage(err);
      await updateTask(taskId, { status: "failed", error_message: reason });
      return failureText(reason);
    }
    // خطأ شبكة مؤقت — get_task سيعيد الإنشاء لاحقًا
    await updateTask(taskId, { status: "processing", error_message: "بانتظار إعادة محاولة الاتصال بخدمة الدمج…" });
    return { text: processingText(taskId, 0) };
  }

  await updateTask(taskId, { provider_task_id: jobId, status: "processing", progress: 5 });

  // 5) تنفيذ الدمج مرة واحدة تحت القفل
  const processed = await runProcessOnce(taskId, jobId);
  if (processed.kind === "done") {
    await updateTask(taskId, { status: "completed", progress: 100, result_urls: [processed.videoUrl] });
    return { text: completedText("merge", [processed.videoUrl]) };
  }
  if (processed.kind === "failed") {
    await updateTask(taskId, { status: "failed", error_message: processed.reason });
    return failureText(processed.reason);
  }

  // 6) نافذة الانتظار (الافتراضي 60، بحد 0..240)
  const waitSeconds = clamp(Math.round(Number(args.wait_seconds ?? MERGE_DEFAULT_WAIT)) || 0, 0, 240);
  return await mergeWaitWindow(taskId, jobId, waitSeconds);
}

async function pollMergeJob(taskId: string, jobId: string): Promise<{ kind: "completed"; url: string } | { kind: "failed"; reason: string } | { kind: "processing"; progress?: number }> {
  try {
    const st = await getJob(jobId);
    if (st.status === "completed") {
      await updateTask(taskId, { status: "completed", progress: 100, result_urls: [st.url] });
      return { kind: "completed", url: st.url };
    }
    if (st.status === "failed") {
      await updateTask(taskId, { status: "failed", error_message: st.error });
      return { kind: "failed", reason: st.error };
    }
    // queued → لم يُنفَّذ process بعد (أو انقطع): نفّذه الآن تحت القفل
    if (st.queued) {
      const pr = await runProcessOnce(taskId, jobId);
      if (pr.kind === "done") {
        await updateTask(taskId, { status: "completed", progress: 100, result_urls: [pr.videoUrl] });
        return { kind: "completed", url: pr.videoUrl };
      }
      if (pr.kind === "failed") {
        await updateTask(taskId, { status: "failed", error_message: pr.reason });
        return { kind: "failed", reason: pr.reason };
      }
    }
    if (typeof st.progress === "number") await updateTask(taskId, { progress: st.progress }).catch(() => {});
    return { kind: "processing", progress: st.progress };
  } catch (err) {
    // 404 = المهمة حُذفت/انتهت صلاحيتها → فشل نهائي؛ خطأ معلن → نهائي؛ شبكتنا → مؤقت
    if (err instanceof MergeGoneError || err instanceof MergeFinalError) {
      await updateTask(taskId, { status: "failed", error_message: errMessage(err) });
      return { kind: "failed", reason: errMessage(err) };
    }
    return { kind: "processing" };
  }
}

async function mergeWaitWindow(taskId: string, jobId: string, waitSeconds: number): Promise<ToolResult> {
  const deadline = Date.now() + waitSeconds * 1000;
  let lastProgress = 5;
  while (Date.now() < deadline) {
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    const out = await pollMergeJob(taskId, jobId);
    if (out.kind === "completed") return { text: completedText("merge", [out.url]) };
    if (out.kind === "failed") return failureText(out.reason);
    if (typeof out.progress === "number") lastProgress = Math.max(lastProgress, out.progress);
  }
  return { text: processingText(taskId, lastProgress) };
}

// get_task لمهمة دمج
async function refreshMergeTask(task: TaskRow): Promise<ToolResult> {
  if (!mergerConfigured()) return { text: MERGER_NOT_CONFIGURED, isError: true };

  // لم تُنشأ لدى الخدمة بعد → أنشئ ونفّذ تحت القفل (بتهدئة 45 ثانية)
  if (!task.provider_task_id) {
    if (!cooldownOk(task.updated_at)) {
      return { text: processingText(task.id, task.progress) + "\n(تهدئة 45 ثانية قبل إعادة المحاولة — أعد الاستعلام بعد قليل)" };
    }
    const params = parseParams(task.params_json) as unknown as { urls?: string[] };
    const urls = Array.isArray(params.urls) ? params.urls.filter((u): u is string => typeof u === "string") : [];
    if (urls.length < 2) {
      const reason = "معطيات الدمج المخزنة غير صالحة (أقل من مقطعين)";
      await updateTask(task.id, { status: "failed", error_message: reason });
      return failureText(reason);
    }
    try {
      const job = await createJob(urls);
      await updateTask(task.id, { provider_task_id: job.jobId, status: "processing", progress: 5 });
      const pr = await runProcessOnce(task.id, job.jobId);
      if (pr.kind === "done") {
        await updateTask(task.id, { status: "completed", progress: 100, result_urls: [pr.videoUrl] });
        return { text: completedText("merge", [pr.videoUrl]) };
      }
      if (pr.kind === "failed") {
        await updateTask(task.id, { status: "failed", error_message: pr.reason });
        return failureText(pr.reason);
      }
      return await mergeWaitWindow(task.id, job.jobId, MERGE_DEFAULT_WAIT);
    } catch (err) {
      if (err instanceof MergeFinalError || err instanceof MergeGoneError) {
        await updateTask(task.id, { status: "failed", error_message: errMessage(err) });
        return failureText(errMessage(err));
      }
      return { text: processingText(task.id, task.progress) };
    }
  }

  const out = await pollMergeJob(task.id, task.provider_task_id);
  if (out.kind === "completed") return { text: completedText("merge", [out.url]) };
  if (out.kind === "failed") return failureText(out.reason);
  return { text: processingText(task.id, out.progress ?? task.progress) };
}

// ================== list_media ==================
export interface ListMediaArgs {
  type?: "image" | "video" | "merge";
  status?: "completed" | "failed" | "processing";
  limit?: number;
}

export async function listMedia(args: ListMediaArgs): Promise<ToolResult> {
  const limit = clamp(Math.round(Number(args.limit ?? 10)) || 10, 1, 50);
  const tasks = await listRecentTasks(limit, { type: args.type, status: args.status });
  if (tasks.length === 0) return { text: "لا توجد وسائط مخزنة بعد." };

  const lines: string[] = [`آخر ${tasks.length} وسيطة مخزنة (من الأحدث):`];
  tasks.forEach((t, i) => {
    lines.push("", `${i + 1}. ${TYPE_AR[t.type] ?? t.type} | ${STATUS_AR[t.status] ?? t.status} | ${t.model} | ${t.created_at ?? ""} UTC`);
    if (t.prompt) {
      lines.push(`   الوصف: ${t.prompt.length > 120 ? t.prompt.slice(0, 120) + "…" : t.prompt}`);
    }
    lines.push(`   task_id: ${t.id}`);
    for (const u of parseUrls(t.result_urls_json)) {
      lines.push(`   الرابط المباشر: ${u}`);
    }
    if (t.status === "failed" && t.error_message) lines.push(`   السبب: ${t.error_message}`);
    const attemptsCount = parseAttempts(t.attempts_json).length;
    if (attemptsCount > 0) lines.push(`   المحاولات: ${attemptsCount}`);
  });
  return { text: lines.join("\n") };
}

// تصدير للأنواع المستخدمة في MCP
export type { TaskPatch };
export { NoDatabaseError };
