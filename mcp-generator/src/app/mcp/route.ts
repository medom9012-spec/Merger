// مسار /mcp — نقطة دخول MCP بوضع عديم الحالة (Stateless Streamable HTTP)
// POST = رسائل JSON-RPC | DELETE = لا جلسات ننهيها (204) | GET = 405 (لا SSE في الوضع عديم الحالة)

import { handleMcpPost, KNOWN_TOOL_NAMES } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function jsonRpcError(id: unknown, code: number, message: string, status: number): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

// فحص Bearer token إذا ضُبط MCP_ACCESS_TOKEN
function checkAuth(request: Request): boolean {
  const token = (process.env.MCP_ACCESS_TOKEN || "").trim();
  if (!token) return true;
  return (request.headers.get("authorization") || "") === `Bearer ${token}`;
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!checkAuth(request)) {
      return jsonRpcError(null, -32001, "Unauthorized — مطلوب الترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>", 401);
    }

    // تحليل الجسم — JSON تالف → -32700
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return jsonRpcError(null, -32700, "Parse error — الجسم ليس JSON صالحًا", 400);
    }

    // أداة غير معروفة → رد عربي مباشر بنفس شكل نتيجة الأداة
    if (
      parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).method === "tools/call"
    ) {
      const params = (parsed as Record<string, unknown>).params as Record<string, unknown> | undefined;
      const name = typeof params?.name === "string" ? params.name : undefined;
      if (name && !KNOWN_TOOL_NAMES.has(name)) {
        return Response.json({
          jsonrpc: "2.0",
          id: (parsed as Record<string, unknown>).id ?? null,
          result: {
            content: [{
              type: "text",
              text: `❌ أداة غير معروفة: ${name}. المتاح: generate_image, generate_video, merge_videos, get_task, list_media`,
            }],
            isError: true,
          },
        });
      }
    }

    return await handleMcpPost(request, parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonRpcError(null, -32603, `Internal error: ${msg}`, 500);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  if (!checkAuth(request)) {
    return jsonRpcError(null, -32001, "Unauthorized — مطلوب الترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>", 401);
  }
  // وضع عديم الحالة: لا جلسات ننهيها
  return new Response(null, { status: 204 });
}

export async function GET(request: Request): Promise<Response> {
  if (!checkAuth(request)) {
    return jsonRpcError(null, -32001, "Unauthorized — مطلوب الترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>", 401);
  }
  return jsonRpcError(null, -32000, "Method Not Allowed — هذا الخادم عديم الحالة ويقبل POST فقط لرسائل JSON-RPC", 405);
}
