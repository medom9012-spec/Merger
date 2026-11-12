// ============================================================
// مسار /mcp — خادم MCP عبر Streamable HTTP (قسم 8)
// runtime="nodejs" و dynamic="force-dynamic" كما تشترط المواصفة.
// SDK الرسمي بنسخته WebStandard: handleRequest(Request) → Response
// تكامل مباشر مع Route Handlers في Next.js دون أي محوّلات.
//
// قرار معماري: وضع stateless (sessionIdGenerator: undefined) — خادم وترانسبورت
// جديدان لكل طلب. هذا إلزامي للعمل الصحيح على Vercel serverless حيث لا تُضمن
// مشاركة الذاكرة بين الاستدعاءات، وكل طلب مكتمل بذاته.
//
// وضع SSE الافتراضي (enableJsonResponse: false): تُبث progress notifications
// حيًا خلال نافذة الانتظار، ثم تُكتب النتيجة النهائية في نفس التدفق ويُغلق.
// ============================================================
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// سقف دالة Vercel: 60 ثانية (Hobby). نافذة انتظار الأدوات مقيدة بـ
// MAX_WAIT_SECONDS (افتراضي 45) لتبقى دونه دائمًا — وعلى Pro يمكن رفع الاثنين.
export const maxDuration = 60;

const MCP_TOKEN = (process.env.MCP_ACCESS_TOKEN || "").trim();

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: مطلوب ترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>" },
      id: null,
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

async function guard(req: Request): Promise<Response | null> {
  if (!MCP_TOKEN) return null; // لا توثيق مطلوب إن لم يُضبط المتغير
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${MCP_TOKEN}` ? null : unauthorized();
}

async function handle(req: Request): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);

  // انقطاع العميل → نظّف فورًا (يوقف مؤقتات keep-alive ويغلق التدفقات)
  const cleanup = () => {
    try { void transport.close(); } catch { /* أُغلق مسبقًا */ }
    try { void server.close(); } catch { /* أُغلق مسبقًا */ }
  };
  if (req.signal) {
    if (req.signal.aborted) cleanup();
    else req.signal.addEventListener("abort", cleanup, { once: true });
  }

  try {
    // في وضع SSE تعيد handleRequest الاستجابة فورًا ويستمر تنفيذ الأداة
    // في الخلفية داخل نفس التدفق حتى كتابة النتيجة النهائية وإغلاقه.
    return await transport.handleRequest(req);
  } catch (e) {
    console.error("[mcp] transport error:", e);
    cleanup();
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}

export async function DELETE(req: Request) {
  return handle(req);
}
