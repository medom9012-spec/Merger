// ============================================================
// /api/keys/{id} — تعطيل/تنشيط يدوي (PATCH) وحذف (DELETE)
// ============================================================
import { deleteKey, ensureSchema, getKeyById, updateKey } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { status?: string } | null;
    const status = body?.status;
    if (status !== "active" && status !== "disabled") {
      return Response.json({ error: "الحالة المطلوبة غير صالحة — المتاح: active أو disabled" }, { status: 400 });
    }
    const key = await getKeyById(id);
    if (!key) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
    // التنشيط اليدوي يعيد المفتاح المستنزف/المعطل إلى الخدمة
    await updateKey(id, { status, last_error: status === "active" ? null : key.last_error });
    return Response.json({ ok: true, id, status });
  } catch (e) {
    return Response.json({ error: `تعذر تحديث المفتاح: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureSchema();
    const { id } = await params;
    const ok = await deleteKey(id);
    if (!ok) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
    return Response.json({ ok: true, id });
  } catch (e) {
    return Response.json({ error: `تعذر حذف المفتاح: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
