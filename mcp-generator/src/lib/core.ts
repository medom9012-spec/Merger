// ============================================================
// ثوابت وأدوات مشتركة بين منسّق التوليد وخدمة الدمج
// (تُفصل هنا لتجنّب الاستيراد الدائري)
// ============================================================
import type { KeyRow } from "./turso";

/** خطأ معطيات الأداة — يُعاد للعميل فورًا كفشل حتمي (تبديل المفاتيح لن يحلّه) */
export class ToolInputError extends Error {}
/** لا توجد مفاتيح نشطة إطلاقًا لهذا الموديل */
export class NoKeysError extends Error {}

export type ProgressCb = (progress: number, message: string) => void | Promise<void>;

/** استعلام حالة المزود كل 3 ثوانٍ خلال نافذة الانتظار */
export const POLL_MS = 3_000;
/** تهدئة ~45 ثانية قبل إعادة محاولة الإنشاء مع كل get_task (قسم 4.3.3) */
export const RETRY_COOLDOWN_MS = 45_000;

/**
 * سقف انتظار أمان للسيرفر: افتراضي 45 ثانية ليتسع داخل حدود دوال Vercel
 * (maxDuration = 60). يُضبط عبر MAX_WAIT_SECONDS — وعلى Vercel Pro يمكن
 * رفع maxDuration إلى 300 ورفع هذا السقف حتى 240.
 */
export const SERVER_WAIT_CAP_S = Math.max(
  5,
  Math.min(240, Number(process.env.MAX_WAIT_SECONDS || 45)),
);

export function waitBudget(requestedSeconds: unknown): number {
  const n = Number(requestedSeconds);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(Math.min(n, SERVER_WAIT_CAP_S));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * نمط رسائل «مشكلة مفتاح/رصيد» التي قد يعلنها المزود في منتصف المهمة —
 * عند ظهوره نعيد إنشاء نفس المهمة بنفس task_id على المفتاح التالي (4.3.2)
 */
export const KEY_FAIL_PATTERN =
  /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|exhausted|invalid[_ -]?api[_ -]?key/i;

/**
 * حماية إضافية (قاعدة ذهبية 4): أي رسالة خطأ تخرج للعميل لا تحتوي أبدًا
 * إشارة لمفاتيح API أو الأرصدة — نمسح الأنماط الحساسة.
 */
export function sanitizeForClient(msg: string): string {
  return String(msg || "خطأ غير معروف")
    .replace(/api[_ -]?key/gi, "credentials")
    .replace(/bearer\s+[\w.\-]+/gi, "credentials")
    .replace(/\bsk-[\w\-]{8,}\b/g, "credentials")
    .replace(/balance|credit|quota|رصيد/gi, "resources")
    .slice(0, 300);
}

/** المفتاح كما يُمرَّر للمزود (بدون حقول القاعدة الزائدة) */
export function toProviderKey(k: KeyRow): {
  id: string; provider: "kie" | "cometapi"; label: string; api_key: string;
} {
  return { id: k.id, provider: k.provider as "kie" | "cometapi", label: k.label, api_key: k.api_key };
}

/** إخفاء المفتاح — إلزامي في كل الاستجابات والسجلات (قاعدة ذهبية 9) */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length > 11) return key.slice(0, 7) + "••••••••" + key.slice(-4);
  if (key.length > 6) return key.slice(0, 3) + "••••";
  return "••••";
}

export function timeAgoAr(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "الآن";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "قبل لحظات";
  const m = Math.floor(s / 60);
  if (m < 60) return `منذ ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `منذ ${h} ساعة`;
  const d = Math.floor(h / 24);
  return `منذ ${d} يوم`;
}
