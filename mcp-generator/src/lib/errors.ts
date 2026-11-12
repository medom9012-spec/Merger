// تصنيف موحّد لأخطاء المزودين — يحدد سياسة التبديل بين المفاتيح (القسم 4.2 من المواصفة)

export type ProviderErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

// أي فشل لدى مزود خارجي يُرمى بهذا الشكل ليُصنَّف لاحقًا
export class ProviderError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

// أنماط رسائل الأخطاء (تُفحص حالة الأحرف بأي شكل)
const EXHAUSTED_RE = /insufficient|quota|balance|credit|out of credits|exhausted|充值/i;
const DISABLED_RE = /invalid api key|unauthorized|forbidden|authentication/i;
const PROVIDER_MODEL_RE = /model not found|unsupported model/i;

// نمط فشل مفتاح/رصيد في منتصف المهمة (فحص failMsg)
export const KEY_FAIL_RE = /insufficient|balance|credit|quota|充值|\b402\b|\b401\b|unauthorized|invalid api key/i;

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/*
 * ترتيب الفحص مقصود:
 * 1) الرصيد أولًا — بعض المزودين يرسلون نفاد الرصيد بحالة 400 فيجب فحصه قبل معاملة 400 كخطأ معطيات.
 * 2) مفتاح مرفوض (401/403 أو نمط الرسالة) → تعطيل تلقائي للمفتاح والانتقال للتالي.
 * 3) موديل غير مدعوم مع 400/404/422 → الانتقال للمفتاح التالي.
 * 4) 400/422 أخرى = خطأ معطيات → توقف فورًا (تبديل المفاتيح لن يحلّه).
 * 5) الباقي (429/5xx/شبكة/timeout/abort) = مؤقت → الانتقال للتالي الآن.
 */
export function classifyProviderError(err: unknown): ProviderErrorClass {
  const status = err instanceof ProviderError ? err.status : undefined;
  const message = errMessage(err);

  if (status === 402 || EXHAUSTED_RE.test(message)) return "exhausted";
  if (status === 401 || status === 403 || DISABLED_RE.test(message)) return "disabled";
  if ((status === 400 || status === 404 || status === 422) && PROVIDER_MODEL_RE.test(message)) return "provider";
  if (status === 400 || status === 422) return "params";
  return "temporary";
}

// تصنيف رسالة فشل منتصف المهمة لتحديد حالة المفتاح (exhausted يبقى في القاعدة، disabled يُعطَّل)
export function classifyKeyFailureMessage(message: string): "exhausted" | "disabled" | null {
  if (EXHAUSTED_RE.test(message) || /\b402\b/.test(message)) return "exhausted";
  if (DISABLED_RE.test(message) || /\b401\b/.test(message) || /\b403\b/.test(message)) return "disabled";
  return null;
}
