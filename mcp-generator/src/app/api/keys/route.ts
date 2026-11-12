// إدارة المفاتيح: GET القائمة (المفاتيح مُقنَّعة دائمًا) + POST إضافة مفتاح

import { listKeys, insertKey, maskKey, DuplicateKeyError, type ApiKeyRow } from "@/lib/turso";
import { dbErrorResponse } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// شكل آمن للمفتاح — لا يُعاد api_key الكامل في أي استجابة أبدًا
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

export async function GET(): Promise<Response> {
  try {
    const keys = await listKeys();
    return Response.json({ keys: keys.map(masked) });
  } catch (err) {
    return dbErrorResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const provider = String(body?.provider ?? "").trim();
    const apiKey = String(body?.api_key ?? "").trim();
    const label = String(body?.label ?? "").trim();

    if (provider !== "kie" && provider !== "cometapi") {
      return Response.json({ ok: false, error: "المزود غير صالح — القيمتان المسموحتان: kie أو cometapi" }, { status: 400 });
    }
    if (!apiKey) {
      return Response.json({ ok: false, error: "مفتاح API مطلوب" }, { status: 400 });
    }

    const created = await insertKey(provider, apiKey, label);
    return Response.json({ ok: true, key: masked(created) }, { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateKeyError) {
      return Response.json({ ok: false, error: "هذا المفتاح مسجَّل مسبقًا لنفس المزود." }, { status: 409 });
    }
    return dbErrorResponse(err);
  }
}
