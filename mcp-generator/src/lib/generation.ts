// ============================================================
// منسّق التوليد — runGeneration / refreshTask (قسم 6)
// • تسجيل المهمة في Turso قبل أي نداء خارجي.
// • تجربة المرشحين بالترتيب التسلسلي الصارم حتى نجاح الإنشاء.
// • نافذة انتظار قصيرة تستعلم كل 3 ثوانٍ وتبث تقدمًا حيًا.
// • فشل مفتاح/رصيد في منتصف المهمة → إعادة إنشاء نفس المهمة بنفس task_id
//   على المفتاح التالي دون علم العميل إطلاقًا (4.3.2).
// • فشل الإنشاء على كل المفاتيح → تبقى processing وتُعاد مع كل get_task
//   بعد تهدئة ~45 ثانية (4.3.3).
// ============================================================
import {
  ensureSchema, getKeyPool, getTask, getKeyById, insertTask, updateTask,
  type AttemptEntry, type KeyRow, type TaskRow,
} from "./turso";
import { defaultModelFor, resolveModel, type ModelDef, type ProviderId } from "./models";
import { getAdapter } from "./providers";
import { ProviderError } from "./providers/types";
import { classifyProviderError, keyLabelFor, noteCheckResult, recordCreateAttempt } from "./keys";
import {
  KEY_FAIL_PATTERN, NoKeysError, POLL_MS, RETRY_COOLDOWN_MS, ToolInputError,
  sanitizeForClient, sleep, toProviderKey, waitBudget, type ProgressCb,
} from "./core";

// ------------------------------------------------------------
// بناء input المزود من معطيات الأداة — القيم "auto" تُحذف فتختارها الخدمة
// ------------------------------------------------------------
export function buildProviderInput(
  type: "image" | "video",
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (type === "image") {
    const input: Record<string, unknown> = { prompt: args.prompt };
    if (typeof args.aspect_ratio === "string" && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
    if (typeof args.resolution === "string" && args.resolution) input.resolution = args.resolution;
    if (typeof args.background === "string" && args.background !== "auto") input.background = args.background;
    if (typeof args.output_format === "string" && args.output_format) input.output_format = args.output_format;
    return input;
  }
  const input: Record<string, unknown> = {
    prompt: args.prompt,
    enable_audio: args.enable_audio !== false,
  };
  if (typeof args.image_url === "string" && args.image_url) input.image_url = args.image_url;
  if (typeof args.aspect_ratio === "string" && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
  if (typeof args.resolution === "string" && args.resolution) input.resolution = args.resolution;
  if (Number.isFinite(Number(args.duration)) && Number(args.duration) > 0) input.duration = Number(args.duration);
  return input;
}

// ------------------------------------------------------------
// محاولة الإنشاء على مرشحي المفاتيح بالترتيب حتى أول نجاح
// ------------------------------------------------------------
interface CreationOutcome {
  ok: boolean;
  task: TaskRow;
  syncUrls?: string[];
  /** فشل حتمي (معطيات/سياسة) — لا إعادة محاولة */
  fatal?: boolean;
}

async function attemptCreation(
  task: TaskRow,
  modelDef: ModelDef,
  input: Record<string, unknown>,
  skip: Set<string>,
): Promise<CreationOutcome> {
  // الترتيب التسلسلي الصارم: created_at ASC, id ASC — المفتاح المستنزف يبقى
  // في القائمة (قد يُشحن رصيده لاحقًا فيكتمل من تلقاء نفسه) والمعطّل فقط يُستبعد.
  const pool = await getKeyPool(modelDef.providers);
  for (const key of pool) {
    if (skip.has(key.id)) continue;
    const adapter = getAdapter(key.provider);
    const at = new Date().toISOString();
    const base: Omit<AttemptEntry, "ok"> = {
      provider: key.provider,
      keyId: key.id,
      keyLabel: keyLabelFor(key),
      at,
    };
    try {
      // CometAPI يدعم صورًا متزامنة تعيد الرابط فورًا
      if (modelDef.type === "image" && adapter.createImageSync && key.provider === "cometapi") {
        const { urls } = await adapter.createImageSync(toProviderKey(key), modelDef.providerModel[key.provider as ProviderId] ?? modelDef.canonical, input);
        await recordCreateAttempt(key, true);
        await updateTask(task.id, {
          attempt: { ...base, ok: true, at },
          provider: key.provider,
          key_id: key.id,
        });
        const done = await updateTask(task.id, {
          status: "completed", result_urls: urls, progress: 100, error_message: null,
        });
        return { ok: true, task: done!, syncUrls: urls };
      }

      const pm = modelDef.providerModel[key.provider as ProviderId] ?? modelDef.canonical;
      const r = await adapter.createTask(toProviderKey(key), pm, input);
      await recordCreateAttempt(key, true);
      const updated = await updateTask(task.id, {
        attempt: { ...base, ok: true, at },
        provider: key.provider,
        provider_task_id: r.providerTaskId,
        key_id: key.id,
        progress: 5,
      });
      return { ok: true, task: updated! };
    } catch (err) {
      const cls = classifyProviderError(err);
      const msg = err instanceof Error ? err.message : String(err);
      await recordCreateAttempt(key, false, cls, msg);
      await updateTask(task.id, {
        attempt: { ...base, ok: false, errorClass: cls, error: msg.slice(0, 300), at },
      });
      if (cls === "params") {
        // خطأ معطيات — توقف فورًا، تبديل المفاتيح لن يحلّه
        const failed = await updateTask(task.id, { status: "failed", error_message: sanitizeForClient(msg) });
        return { ok: false, task: failed!, fatal: true };
      }
      // disabled/exhausted/provider/temporary → انتقل للمفتاح التالي فورًا
      continue;
    }
  }
  // فشل الإنشاء على كل المفاتيح: تبقى processing (ليست failed) برسالة داخلية،
  // وتُعاد المحاولة تلقائيًا مع كل استدعاء get_task بعد تهدئة ~45 ثانية.
  const t = await updateTask(task.id, {
    status: "processing",
    progress: 0,
    error_message: "بانتظار توفر مفتاح صالح…",
  });
  return { ok: false, task: t! };
}

// ------------------------------------------------------------
// استعلام واحد حي من المزود + منطق التبديل عند الفشل
// ------------------------------------------------------------
async function pollProviderOnce(taskId: string): Promise<TaskRow> {
  const task = await getTask(taskId);
  if (!task) throw new ToolInputError(`لا توجد مهمة بالمعرّف: ${taskId}`);
  if (task.status !== "processing" && task.status !== "pending") return task;

  const modelDef = resolveModel(task.model);
  const params = safeParse(task.params_json);
  const input = (params.input ?? {}) as Record<string, unknown>;
  const providerList = modelDef?.providers ?? (task.provider ? [task.provider] : []);

  if (task.provider && task.provider_task_id) {
    // مرشحو الفحص: المفتاح المرتبط بالمهمة أولًا ثم بقية المفاتيح بالترتيب
    const pool = providerList.length ? await getKeyPool(providerList) : [];
    const ids = [task.key_id, ...pool.map((k) => k.id)].filter((x): x is string => !!x);
    const seen = new Set<string>();
    const candidates: KeyRow[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const k = pool.find((p) => p.id === id) ?? (await getKeyById(id));
      if (k) candidates.push(k);
    }

    for (const k of candidates) {
      const adapter = getAdapter(k.provider);
      try {
        const r = await adapter.checkTask(toProviderKey(k), task.provider_task_id);
        noteCheckResult(k, true);
        if (r.status === "completed" && r.urls?.length) {
          return (await updateTask(taskId, {
            status: "completed", result_urls: r.urls, progress: 100, error_message: null,
          }))!;
        }
        if (r.status === "failed") {
          const errText = r.error || "فشل التوليد لدى المزود";
          if (KEY_FAIL_PATTERN.test(errText)) {
            // فشل منتصف المهمة بسبب مفتاح/رصيد → علّم المفتاح وأعد إنشاء نفس
            // المهمة بنفس task_id على المفتاح التالي — العميل يرى «قيد المعالجة» فقط.
            const cls: "disabled" | "exhausted" = /401|unauthorized|forbidden|invalid/i.test(errText)
              ? "disabled"
              : "exhausted";
            noteCheckResult(k, false, cls, errText);
            const cur = (await getTask(taskId))!;
            const out = await attemptCreation(cur, modelDef!, input, new Set([k.id]));
            return out.task;
          }
          // فشل حقيقي (انتهاك سياسة/معطيات) → failed
          return (await updateTask(taskId, {
            status: "failed", error_message: sanitizeForClient(errText),
          }))!;
        }
        // processing → تقدم يصعد فقط (بدون تجاوز 90 قبل الاكتمال الفعلي)
        const mapped = r.progress ?? 0;
        const next = Math.max(task.progress, Math.min(90, mapped));
        if (next > task.progress) return (await updateTask(taskId, { progress: next }))!;
        return task;
      } catch (err) {
        const cls = classifyProviderError(err);
        noteCheckResult(k, false, cls, err instanceof Error ? err.message : String(err));
        // مفتاح مرفوض/مستنزف أثناء الفحص → جرّب مفتاحًا آخر؛ مؤقت → تابع الانتظار
        continue;
      }
    }
    return task;
  }

  // لا يوجد provider_task_id بعد (فشل الإنشاء على كل المفاتيح) → أعد المحاولة
  // بعد فترة تهدئة ~45 ثانية حتى لا نضغط المزودين. لو شُحن رصيد أي مفتاح
  // تكتمل المهمة من تلقاء نفسها.
  const ageMs = Date.now() - Date.parse(task.updated_at || task.created_at);
  if (ageMs >= RETRY_COOLDOWN_MS) {
    if (!modelDef) {
      return (await updateTask(taskId, { status: "failed", error_message: "موديل المهمة غير معروف" }))!;
    }
    const out = await attemptCreation(task, modelDef, input, new Set());
    return out.task;
  }
  return task;
}

// ------------------------------------------------------------
// runGeneration — التدفق الكامل لأداة generate_image / generate_video
// ------------------------------------------------------------
export async function runGeneration(
  tool: "image" | "video",
  args: Record<string, unknown>,
  onProgress?: ProgressCb,
): Promise<TaskRow> {
  await ensureSchema();

  // 1) توحيد اسم الموديل عبر aliases — غير معروف → خطأ معطيات فوري
  const requested = typeof args.model === "string" && args.model ? args.model : defaultModelFor(tool);
  const modelDef = resolveModel(requested);
  if (!modelDef || modelDef.type !== tool) {
    throw new ToolInputError(
      `❌ موديل غير معروف: ${requested}. المتاح: صورة → ${defaultModelFor("image")} / فيديو → ${defaultModelFor("video")}`,
    );
  }

  // 2) تجمع المفاتيح بالترتيب — فارغ → رد no_keys عربي واضح
  const pool = await getKeyPool(modelDef.providers);
  if (!pool.length) {
    throw new NoKeysError(
      `❌ لا توجد مفاتيح نشطة لخدمة ${modelDef.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    );
  }

  // 3) سجّل المهمة في Turso قبل أي نداء خارجي (لو انقطع الاتصال تبقى قابلة للتتبع)
  const input = buildProviderInput(tool, args);
  const task = await insertTask({
    model: modelDef.canonical,
    type: tool,
    prompt: typeof args.prompt === "string" ? args.prompt : "",
    params: { ...args, input },
  });

  // 4) جرّب المرشحين بالترتيب حتى نجاح الإنشاء
  const out = await attemptCreation(task, modelDef, input, new Set());
  if (out.syncUrls) return out.task; // صورة متزامنة اكتملت فورًا
  if (!out.ok) return out.task;      // processing — بانتظار مفتاح صالح

  // 5) نافذة الانتظار: استعلام كل 3 ثوانٍ + بث progress notifications عربية
  const defaultWait = tool === "image" ? 90 : 25;
  const waitS = waitBudget(args.wait_seconds ?? defaultWait);
  const deadline = Date.now() + waitS * 1000;
  let t = out.task;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try {
      t = await pollProviderOnce(t.id);
    } catch (err) {
      // أخطاء الشبكة المؤقتة لا توقف النافذة
      if (err instanceof ProviderError) continue;
      throw err;
    }
    await onProgress?.(
      t.progress,
      tool === "image" ? `قيد التوليد… ${t.progress}%` : `جارٍ توليد الفيديو… ${t.progress}%`,
    );
    if (t.status === "completed" || t.status === "failed") return t;
  }

  // 7) انتهت النافذة والنتيجة لم تظهر → أعد المهمة processing والعميل يتابع بـ get_task
  return t;
}

// ------------------------------------------------------------
// refreshTask — يستدعيه get_task: يحدّث المهمة الجارية حيًا من المزود/الخدمة
// ------------------------------------------------------------
export async function refreshTask(taskId: string): Promise<TaskRow> {
  await ensureSchema();
  let task = await getTask(taskId.trim());
  if (!task) {
    throw new ToolInputError(`❌ لا توجد مهمة بهذا المعرّف: ${taskId}. تحقق من task_id أو استخدم list_media لعرض المهام المخزنة.`);
  }
  if (task.status === "processing" || task.status === "pending") {
    if (task.type === "merge") {
      const { refreshMergeTask } = await import("./merger");
      task = await refreshMergeTask(task);
    } else {
      task = await pollProviderOnce(task.id);
    }
  }
  return task;
}

function safeParse(json: string): Record<string, unknown> {
  try { return JSON.parse(json || "{}"); } catch { return {}; }
}
