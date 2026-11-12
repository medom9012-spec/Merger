// ============================================================
// GET /api/health — فحص جهوزية النظام (قسم 9)
// ============================================================
import { dbHealthy, ensureSchema } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerBase, mergerConfigured } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ */
async function mergerHealthy(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const res = await fetch(`${mergerBase()}/api/config`, {
      signal: AbortSignal.timeout(4_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function GET() {
  let databaseOk = false;
  try {
    await ensureSchema();
    databaseOk = await dbHealthy();
  } catch {
    databaseOk = false;
  }

  return Response.json(
    {
      ok: databaseOk,
      database: databaseOk ? "turso-connected" : "turso-error",
      mcpEndpoint: "/mcp",
      models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
      merger: {
        base: mergerBase() || null,
        configured: mergerConfigured(),
        healthy: await mergerHealthy(),
      },
      authRequired: Boolean((process.env.MCP_ACCESS_TOKEN || "").trim()),
    },
    { status: databaseOk ? 200 : 503 },
  );
}
