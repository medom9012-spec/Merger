// ============================================================
// الصياغات العربية لردود أدوات MCP + تعليمات السيرفر المرسلة مع initialize
// القاعدة: المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية، والرسائل عربية.
// القاعدة الذهبية 4: لا رسالة تخرج للعميل تذكر مفاتيح أو أرصدة أبدًا.
// ============================================================
import type { TaskRow } from "./turso";
import { timeAgoAr } from "./core";

/** نص SERVER_INSTRUCTIONS يُرسل مع initialize (بالإنجليزية — يقرأه النموذج) */
export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

export interface ClientFacing {
  text: string;
  isError: boolean;
}

/** الصياغة العربية الجاهزة للعرض لأي مهمة حسب حالتها (قسم 8) */
export function formatTaskForClient(task: TaskRow): ClientFacing {
  const urls: string[] = task.result_urls_json ? safeParseArray(task.result_urls_json) : [];

  if (task.status === "completed") {
    if (task.type === "image") {
      const u = urls[0] ?? "";
      return { text: `✅ تم توليد الصورة بنجاح\n\n![image](${u})\n\nالرابط المباشر: ${u}`, isError: false };
    }
    if (task.type === "merge") {
      return {
        text:
          `✅ تم دمج المقاطع بنجاح\n\n${urls.map((u) => `الرابط المباشر: ${u}`).join("\n")}` +
          `\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`,
        isError: false,
      };
    }
    return {
      text: `✅ تم توليد الفيديو بنجاح\n\n${urls.map((u) => `الرابط المباشر: ${u}`).join("\n")}`,
      isError: false,
    };
  }

  if (task.status === "failed") {
    return { text: `❌ فشلت المهمة: ${task.error_message ?? "سبب غير معروف"}`, isError: true };
  }

  return {
    text: `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`,
    isError: false,
  };
}

const TYPE_LABEL: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_LABEL: Record<string, string> = {
  completed: "مكتملة",
  failed: "فاشلة",
  processing: "جارية",
  pending: "بالانتظار",
};

/** عرض list_media — أحدث الوسائط المخزنة بروابطها من قاعدة البيانات */
export function formatListMedia(tasks: TaskRow[]): ClientFacing {
  if (!tasks.length) {
    return { text: "لا توجد وسائط مخزنة بعد — ابدأ بتوليد صورة أو فيديو وسيتم حفظ الروابط هنا تلقائيًا.", isError: false };
  }
  const lines: string[] = [`📚 أحدث الوسائط المخزنة (${tasks.length}):`, ""];
  tasks.forEach((t, i) => {
    const urls = t.result_urls_json ? safeParseArray(t.result_urls_json) : [];
    lines.push(
      `${i + 1}) [${TYPE_LABEL[t.type] ?? t.type}] ${STATUS_LABEL[t.status] ?? t.status} — ${t.model} — ${timeAgoAr(t.created_at)}`,
    );
    if (t.prompt) lines.push(`   الوصف: ${t.prompt.slice(0, 120)}${t.prompt.length > 120 ? "…" : ""}`);
    for (const u of urls) lines.push(`   الرابط: ${u}`);
    if (t.status === "failed" && t.error_message) lines.push(`   السبب: ${t.error_message}`);
    lines.push(`   task_id: ${t.id}`);
    lines.push("");
  });
  return { text: lines.join("\n").trim(), isError: false };
}

function safeParseArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
