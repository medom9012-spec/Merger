// GET /api/health — حالة عامة للتشخيص وربط العملاء
// يعمل رشيقًا حتى بدون متغيرات بيئة (لا ينهار أبدًا)

import { dbHealthy } from "@/lib/turso";
import { mergerBase, mergerHealthy } from "@/lib/merger";
import { MODELS } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(): Promise<Response> {
  const envConfigured =
    (process.env.TURSO_DATABASE_URL || "").trim().length > 0 &&
    (process.env.TURSO_AUTH_TOKEN || "").trim().length > 0;

  let database: "turso-connected" | "not-configured" | "turso-error" = "not-configured";
  let ok = false;
  if (envConfigured) {
    const healthy = await dbHealthy();
    database = healthy ? "turso-connected" : "turso-error";
    ok = healthy;
  }

  const base = mergerBase();
  const mergerIsHealthy = base ? await mergerHealthy() : false;

  return Response.json({
    ok,
    database,
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
    merger: { base: base ?? null, healthy: mergerIsHealthy },
    authRequired: (process.env.MCP_ACCESS_TOKEN || "").trim().length > 0,
  });
}
