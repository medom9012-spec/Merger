// تعطيل/تنشيط مفتاح (PATCH) وحذفه (DELETE) — المفاتيح مُقنَّعة دائمًا

import { updateKey, deleteKey, maskKey, NoDatabaseError, type ApiKeyRow } from "@/lib/turso";
import { dbErrorResponse } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function masked(k: ApiKeyRow) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    masked: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_error: k.last_error,
    created_at: k.created_at,
  };
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const status = String(body?.status ?? "").trim();
    if (status !== "active" && status !== "disabled") {
      return Response.json({ ok: false, error: "الحالة غير صالحة — القيمتان المسموحتان: active أو disabled" }, { status: 400 });
    }
    const updated = await updateKey(id, { status });
    if (!updated) {
      return Response.json({ ok: false, error: "المفتاح غير موجود" }, { status: 404 });
    }
    return Response.json({ ok: true, key: masked(updated) });
  } catch (err) {
    return dbErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const deleted = await deleteKey(id);
    if (!deleted) {
      return Response.json({ ok: false, error: "المفتاح غير موجود" }, { status: 404 });
    }
    return Response.json({ deleted: true });
  } catch (err) {
    if (err instanceof NoDatabaseError) return dbErrorResponse(err);
    return dbErrorResponse(err);
  }
}
