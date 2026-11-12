// ============================================================
// خادم MCP — media-generator-mcp v1.2.0 (قسم 8)
// • SDK رسمي: McpServer + WebStandardStreamableHTTPServerTransport
//   (وضع stateless: خادم جديد لكل طلب — متوافق مع Vercel serverless).
// • الأدوات الخمس بأوصاف إنجليزية دقيقة يقرأها العميل، ونتائجها عربية.
// • progress notifications أثناء نافذة الانتظار إذا زوّد العميل
//   الطلب بـ _meta.progressToken.
// ============================================================
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_INSTRUCTIONS, formatListMedia, formatTaskForClient } from "./texts";
import { NoKeysError, ToolInputError } from "./core";
import { refreshTask, runGeneration } from "./generation";
import { runMerge } from "./merger";
import { listRecentTasks } from "./turso";
import type { ProgressCb } from "./core";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

type Extra = RequestHandlerExtra<never, never>;

/** يبث progress notifications عربية كل ~3 ثوانٍ إذا وفر العميل progressToken */
function makeProgress(extra: Extra): ProgressCb | undefined {
  const token = (extra?._meta as unknown as { progressToken?: string | number } | undefined)?.progressToken;
  if (token === undefined || token === null) return undefined;
  return async (progress: number, message: string) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total: 100, message },
      } as never);
    } catch {
      // انقطاع بث العميل لا يوقف المهمة
    }
  };
}

/** غلاف موحد لكل الأدوات: نتيجة نصية عربية أو خطأ isError بلا أي ذكر لمفاتيح/أرصدة */
async function wrap(fn: () => Promise<{ text: string; isError?: boolean }>) {
  try {
    const r = await fn();
    return {
      content: [{ type: "text" as const, text: r.text }],
      ...(r.isError ? { isError: true } : {}),
    };
  } catch (e) {
    if (e instanceof ToolInputError || e instanceof NoKeysError) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text" as const, text: `❌ حدث خطأ غير متوقع: ${msg.slice(0, 200)}` }],
      isError: true,
    };
  }
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // ----------------------------------------------------------
  // 1) generate_image
  // ----------------------------------------------------------
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys). " +
        "Returns the finished image URL if it completes within the wait window; otherwise returns a task_id — " +
        "then call get_task with that task_id every ~10 seconds until status is completed, show the URL, and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z
          .enum(["auto", "transparent", "opaque"])
          .default("auto")
          .describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) =>
      wrap(async () => {
        const task = await runGeneration("image", args, makeProgress(extra));
        return formatTaskForClient(task);
      }),
  );

  // ----------------------------------------------------------
  // 2) generate_video
  // ----------------------------------------------------------
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio: dialogue/effects/music; optional image-to-video). " +
        "Videos take minutes: the tool waits briefly while streaming progress, then returns a task_id — " +
        "track it with get_task every ~10 seconds until completed, then show the URL.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) =>
      wrap(async () => {
        const task = await runGeneration("video", args, makeProgress(extra));
        return formatTaskForClient(task);
      }),
  );

  // ----------------------------------------------------------
  // 3) merge_videos
  // ----------------------------------------------------------
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video URLs) or " +
        "'task_ids' (COMPLETED video generation tasks — their result URLs are resolved from the database in this order; " +
        "ideal after generating several clips). Merging is usually fast: the tool waits briefly while streaming progress, " +
        "then returns a merge task_id — track it with get_task the same way. " +
        "NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(1)
          .max(10)
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video. 2–10 clips."),
        task_ids: z
          .array(z.string())
          .min(1)
          .max(10)
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order. 2–10 ids."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) =>
      wrap(async () => {
        const task = await runMerge(args, makeProgress(extra));
        return formatTaskForClient(task);
      }),
  );

  // ----------------------------------------------------------
  // 4) get_task
  // ----------------------------------------------------------
  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes live from the provider/merging service while processing). " +
        "Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args) =>
      wrap(async () => {
        const task = await refreshTask(args.task_id);
        return formatTaskForClient(task);
      }),
  );

  // ----------------------------------------------------------
  // 5) list_media
  // ----------------------------------------------------------
  server.registerTool(
    "list_media",
    {
      description:
        "Recall the latest images/videos/merges stored with their URLs from the database (no regeneration) — for retrieving previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) =>
      wrap(async () => {
        const tasks = await listRecentTasks(args.limit ?? 10, { type: args.type, status: args.status });
        return formatListMedia(tasks);
      }),
  );

  return server;
}
