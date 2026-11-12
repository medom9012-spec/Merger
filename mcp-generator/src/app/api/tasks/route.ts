// GET /api/tasks — تغذية لوحة المهام الداخلية (إحصائيات + أحدث المهام)
// معاملات: limit (1..100، افتراضي 20)، type (image|video|merge)، status (completed|failed|processing)

import { listRecentTasks, taskStats, parseUrls, parseAttempts } from "@/lib/turso";
import { dbErrorResponse, clampInt } from "@/lib/api-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = clampInt(url.searchParams.get("limit"), 1, 100, 20);
    const type = url.searchParams.get("type") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;

    const [stats, tasks] = await Promise.all([
      taskStats(),
      listRecentTasks(limit, { type: type ?? undefined, status: status ?? undefined }),
    ]);

    return Response.json({
      stats,
      tasks: tasks.map((t) => ({
        ...t,
        result_urls: parseUrls(t.result_urls_json),
        attempts: parseAttempts(t.attempts_json),
      })),
    });
  } catch (err) {
    return dbErrorResponse(err);
  }
}
