// بناء خادم MCP الرسمي (McpServer + نقل Streamable HTTP) + جسر App Router
// وضع STATELESS: sessionIdGenerator: undefined + enableJsonResponse: true
// (مطلوب لتوافق ChatGPT Connectors على Vercel — تقدّم المهام يُضمَّن كنص في ردود get_task بدل SSE)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  runGeneration,
  refreshTask,
  runMerge,
  listMedia,
  type GenerationArgs,
  type ToolResult,
} from "../coordinator";
import { NoDatabaseError } from "../turso";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

// النص الحرفي المرسل مع initialize
export const SERVER_INSTRUCTIONS = [
  "AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).",
  "Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.",
  "If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).",
  "IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.",
  "To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
  "Use list_media to recall previously generated media from the database.",
].join("\n");

export const KNOWN_TOOL_NAMES = new Set([
  "generate_image",
  "generate_video",
  "merge_videos",
  "get_task",
  "list_media",
]);

// ================== نتائج الأدوات ==================
function textResult(r: ToolResult): CallToolResult {
  const out: CallToolResult = { content: [{ type: "text", text: r.text }] };
  if (r.isError) out.isError = true;
  return out;
}

// كل معالج داخل try/catch: NoDatabaseError → رسالة عربية، وأي خطأ آخر → رسالة عامة
async function safeRun(fn: () => Promise<ToolResult>): Promise<CallToolResult> {
  try {
    return textResult(await fn());
  } catch (err) {
    if (err instanceof NoDatabaseError) {
      return textResult({
        text: "❌ قاعدة البيانات غير مهيأة — عيّن TURSO_DATABASE_URL و TURSO_AUTH_TOKEN.",
        isError: true,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ text: `❌ حدث خطأ غير متوقع: ${msg}`, isError: true });
  }
}

// ================== مخططات الأدوات الخمس (zod) ==================
const generateImageSchema = {
  prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
  model: z
    .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
    .default("gpt-image-2-6/flare-text-to-image"),
  aspect_ratio: z
    .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
    .default("auto"),
  resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
  background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
  output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
  wait_seconds: z.number().int().min(0).max(240).default(90),
};

const generateVideoSchema = {
  prompt: z
    .string()
    .max(4096)
    .describe("Scene description. Dialogue in the prompt is spoken in the video."),
  image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
  model: z
    .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
    .default("grok-imagine-video-1-5-preview"),
  aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
  resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
  enable_audio: z.boolean().default(true),
  duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
  wait_seconds: z.number().int().min(0).max(240).default(25),
};

const mergeVideosSchema = {
  // بلا حدود عددية هنا — فحص «مقطعين على الأقل» و«10 كحد أقصى» يتم في المنسّق
  // ليعيد الرسائل العربية الصحيحة (القاعدة الذهبية 8: كل رسائل الأدوات بالعربية)
  urls: z
    .array(z.string())
    .optional()
    .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video. Accepts 2 to 10 URLs."),
  task_ids: z
    .array(z.string())
    .optional()
    .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order. Accepts 2 to 10 IDs."),
  wait_seconds: z.number().int().min(0).max(240).default(60),
};

const getTaskSchema = {
  task_id: z.string().min(1),
};

const listMediaSchema = {
  type: z.enum(["image", "video", "merge"]).optional(),
  status: z.enum(["completed", "failed", "processing"]).optional(),
  limit: z.number().int().min(1).max(50).default(10),
};

// ================== بناء الخادم (جديد لكل طلب — آمن للـ serverless) ==================
export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    capabilities: { tools: { listChanged: false } },
  });

  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      title: "Generate image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active keys). Returns the image URL directly if it completes within the wait window; otherwise returns task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: generateImageSchema,
    },
    async (args) => safeRun(() => runGeneration("image", args as GenerationArgs))
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      title: "Generate video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). Videos take minutes: short wait with live progress, then task_id — track with get_task every ~10 seconds.",
      inputSchema: generateVideoSchema,
    },
    async (args) => safeRun(() => runGeneration("video", args as GenerationArgs))
  );

  // 3) merge_videos
  server.registerTool(
    "merge_videos",
    {
      title: "Merge videos",
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (direct public video URLs) or 'task_ids' (completed video generation tasks, resolved from the database in order — ideal after generating several clips). Usually fast: short wait with progress, then a merge task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: mergeVideosSchema,
    },
    async (args) =>
      safeRun(() => runMerge(args as { urls?: string[]; task_ids?: string[]; wait_seconds?: number }))
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description:
        "Track any task by its ID — image/video generation AND merges (reads the database and refreshes live from the provider/merging service while running). Poll every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: getTaskSchema,
    },
    async (args) => safeRun(() => refreshTask(String(args.task_id)))
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      title: "List media",
      description:
        "Latest stored images/videos/merges with their result URLs from the database (no regeneration) — recall previous results.",
      inputSchema: listMediaSchema,
    },
    async (args) =>
      safeRun(() =>
        listMedia({
          type: args.type,
          status: args.status,
          limit: args.limit,
        })
      )
  );

  return server;
}

// ================== جسر App Router (Web Request مباشرة) ==================
/*
 * في الإصدار 1.3x من الـ SDK أصبح StreamableHTTPServerTransport غلافًا حول
 * WebStandardStreamableHTTPServerTransport عبر @hono/node-server ويتطلب IncomingMessage
 * حقيقيًا (rawHeaders/stream). داخل App Router لدينا Web Request أصلية — والنقل القياسي
 * للويب هو المسار الرسمي الموصى به من الـ SDK لبيئات الويب: نمرر الطلب مباشرة مع parsedBody
 * (بلا قراءة stream) ونعيد Web Response كما هي.
 */
export async function handleMcpPost(request: Request, parsedBody: unknown): Promise<Response> {
  const server = buildMcpServer();
  // وضع عديم الحالة + استجابة JSON واحدة (متوافق مع ChatGPT Connectors على Vercel)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    try { await server.close(); } catch { /* تجاهل */ }
  }
}
