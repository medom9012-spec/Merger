// ============================================================
// نظام المفاتيح المتسلسلة (قلب المشروع — قسم 4)
// • الترتيب تسلسلي صارم حسب الإضافة (created_at ASC, id ASC) — ليس round-robin.
// • تصنيف موحّد للأخطاء يحدد الإجراء: تعطيل/استنفاد/انتقال/توقف.
// • المفاتيح تُخفى دائمًا في كل الاستجابات والسجلات (maskKey).
// ============================================================
import { getKeyPool, nowIso, updateKey, type KeyRow } from "./turso";
import { ProviderError, type ErrorClass } from "./providers/types";
import { maskKey } from "./core";

/**
 * تصنيف موحّد لأخطاء المزود (جدول 4.2):
 * disabled   : 401/403 أو رسالة مفتاح غير صالح → تعليم المفتاح disabled والانتقال للتالي
 * exhausted  : 402 أو رسالة نفاد رصيد (تُفحص قبل 400 لأن بعض المزودين يرسلونها بحالة 400)
 * provider   : موديل غير مدعوم لدى هذا المزود → انتقل للتالي
 * params     : خطأ معطيات الطلب → توقف فورًا (تبديل المفاتيح لن يحلّه)
 * temporary  : 429/5xx/انقطاع شبكة → انتقل للتالي الآن والمفتاح يبقى سليمًا
 */
export function classifyProviderError(err: unknown): ErrorClass {
  const status = err instanceof ProviderError ? err.status : undefined;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // 1) مفتاح مرفوض
  if (status === 401 || status === 403) return "disabled";
  if (
    /invalid\s*api\s*key|invalid\s*key|api\s*key\s*invalid|unauthorized|forbidden|authentication\s*(error|failed)?|apikey\s*invalid/.test(msg) &&
    (status === undefined || status < 500)
  ) {
    return "disabled";
  }

  // 2) نفاد الرصيد — يُفحص قبل 400 عمدًا (بعض المزودين يرسلونه بحالة 400)
  if (/insufficient|quota|balance|credit|out\s*of\s*credits|exhausted|充值/.test(msg)) return "exhausted";
  if (status === 402) return "exhausted";

  // 3) موديل غير مدعوم لدى هذا المزود
  if (
    /model\s*not\s*found|unsupported\s*model|no\s*such\s*model|unknown\s*model|does\s*not\s*exist/.test(msg) &&
    status !== undefined && [400, 404, 422].includes(status)
  ) {
    return "provider";
  }

  // 4) معطيات الطلب — توقف فورًا
  if (status === 400 || status === 422) return "params";

  // 5) مؤقت: 429، 5xx، أو بلا status (انقطاع شبكة/timeout/abort)
  if (status === 429) return "temporary";
  if (status !== undefined && status >= 500) return "temporary";
  return "temporary";
}

/** تجيب المرشحين بالترتيب التسلسلي الصارم (أول مفتاح أُضيف يُجرَّب أولًا) */
export async function getOrderedKeyPool(providers: string[]): Promise<KeyRow[]> {
  return getKeyPool(providers);
}

/**
 * تسجيل محاولة إنشاء: عدّادات المفتاح (usage/success/fail + last_error)
 * تُحدَّث دائمًا، والحالة تُوسَم تلقائيًا disabled/exhausted بحسب التصنيف.
 */
export async function recordCreateAttempt(
  key: KeyRow,
  ok: boolean,
  errorClass?: ErrorClass,
  errorMsg?: string,
): Promise<void> {
  const now = nowIso();
  await updateKey(key.id, {
    usage_inc: 1,
    success_inc: ok ? 1 : 0,
    fail_inc: ok ? 0 : 1,
    last_used_at: now,
    last_checked_at: now,
    last_error: ok ? null : (errorMsg ?? "خطأ غير معروف").slice(0, 300),
    status:
      errorClass === "disabled"
        ? "disabled"
        : errorClass === "exhausted"
          ? "exhausted"
          : // نجاح على مفتاح كان مستنزفًا = عاد الرصيد → نعيده نشطًا تلقائيًا
            ok && key.status === "exhausted"
              ? "active"
              : undefined,
  });
}

/**
 * تسجيل نتيجة استعلام حالة (check): لا نعدّ العدادات إلا عند نجاح الفحص أو
 * عند ثبوت مشكلة مفتاح/رصيد — أخطاء الشبكة المؤقتة لا تلوّث إحصاءات المفتاح.
 */
export async function noteCheckResult(
  key: KeyRow,
  ok: boolean,
  errorClass?: ErrorClass,
  errorMsg?: string,
): Promise<void> {
  const now = nowIso();
  const markStatus =
    errorClass === "disabled" ? "disabled" : errorClass === "exhausted" ? "exhausted"
      : ok && key.status === "exhausted" ? "active" // عاد الرصيد → نشط تلقائيًا
      : undefined;
  await updateKey(key.id, {
    last_checked_at: now,
    usage_inc: 1,
    success_inc: ok ? 1 : 0,
    last_error: ok ? null : (errorMsg ?? "خطأ غير معروف").slice(0, 300),
    status: markStatus,
    fail_inc: !ok && markStatus ? 1 : 0,
  });
}

/** تسمية آمنة للمفتاح تظهر في سجل المحاولات فقط (داخل القاعدة/لوحة الإدارة) */
export function keyLabelFor(key: KeyRow): string {
  return key.label?.trim() || maskKey(key.api_key);
}
