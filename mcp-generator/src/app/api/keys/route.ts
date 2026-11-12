// ============================================================
// /api/keys — إدارة المفاتيح للواجهة (قسم 4.4)
// GET    : القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey) — لا يُعاد
//          المفتاح الكامل في أي استجابة.
// POST   : إضافة مفتاح مع رفض التكرار لنفس المزود.
// ============================================================
import { ensureSchema, findKeyByProviderAndValue, insertKey, listKeys } from "@/lib/turso";
import { maskKey, timeAgoAr } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS = ["kie", "cometapi"] as const;

export async function GET() {
  try {
    await ensureSchema();
    const keys = await listKeys();
    return Response.json({
      keys: keys.map((k) => ({
        id: k.id,
        provider: k.provider,
        label: k.label,
        masked: maskKey(k.api_key),
        status: k.status,
        usageCount: k.usage_count,
        successCount: k.success_count,
        failCount: k.fail_count,
        lastError: k.last_error,
        lastUsedAt: k.last_used_at,
        lastCheckedAt: k.last_checked_at,
        createdAt: k.created_at,
        createdAtLabel: timeAgoAr(k.created_at),
      })),
    });
  } catch (e) {
    return Response.json({ error: `تعذر جلب المفاتيح: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await ensureSchema();
    const body = (await req.json().catch(() => null)) as
      | { provider?: string; api_key?: string; label?: string }
      | null;
    const provider = body?.provider?.trim() ?? "";
    const apiKey = body?.api_key?.trim() ?? "";
    const label = body?.label?.trim() ?? "";

    if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
      return Response.json({ error: "المزود غير صالح — المتاح: kie أو cometapi" }, { status: 400 });
    }
    if (apiKey.length < 8) {
      return Response.json({ error: "المفتاح قصير جدًا — تحقق من القيمة المُدخلة" }, { status: 400 });
    }
    const dup = await findKeyByProviderAndValue(provider, apiKey);
    if (dup) {
      return Response.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود — رفض التكرار" }, { status: 409 });
    }
    const key = await insertKey(provider, apiKey, label);
    return Response.json(
      {
        key: {
          id: key.id,
          provider: key.provider,
          label: key.label,
          masked: maskKey(key.api_key),
          status: key.status,
          createdAt: key.created_at,
        },
      },
      { status: 201 },
    );
  } catch (e) {
    return Response.json({ error: `تعذر إضافة المفتاح: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
