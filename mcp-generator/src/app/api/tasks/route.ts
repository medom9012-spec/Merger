// ============================================================
// GET /api/tasks — لوحة المهام: إحصائيات + أحدث المهام (تتحدث كل ~5 ثوانٍ)
// ============================================================
import { ensureSchema, listRecentTasks, taskStats } from "@/lib/turso";
import { timeAgoAr } from "@/lib/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await ensureSchema();
    const url = new URL(req.url);
    const type = url.searchParams.get("type") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? 20);

    const [stats, tasks] = await Promise.all([
      taskStats(),
      listRecentTasks(Number.isFinite(limit) ? limit : 20, { type, status }),
    ]);

    return Response.json({
      stats,
      tasks: tasks.map((t) => ({
        id: t.id,
        type: t.type,
        model: t.model,
        provider: t.provider,
        status: t.status,
        progress: t.progress,
        prompt: t.prompt,
        urls: t.result_urls_json ? safeParseArray(t.result_urls_json) : [],
        error: t.error_message,
        attemptsCount: safeParseArray(t.attempts_json).length,
        createdAt: t.created_at,
        createdAtLabel: timeAgoAr(t.created_at),
        completedAt: t.completed_at,
      })),
    });
  } catch (e) {
    return Response.json({ error: `تعذر جلب المهام: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}

function safeParseArray(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
