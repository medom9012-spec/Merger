// أدوات مشتركة لردود REST الداخلية — معالجة رشيقة دون إسقاط العملية
import { NoDatabaseError } from "./turso";

export const DB_NOT_CONFIGURED_MSG = "❌ قاعدة البيانات غير مهيأة — عيّن TURSO_DATABASE_URL و TURSO_AUTH_TOKEN.";

export function dbErrorResponse(err: unknown): Response {
  if (err instanceof NoDatabaseError) {
    return Response.json({ ok: false, error: DB_NOT_CONFIGURED_MSG }, { status: 503 });
  }
  return Response.json({ ok: false, error: "خطأ داخلي غير متوقع في الخادم" }, { status: 500 });
}

export function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
