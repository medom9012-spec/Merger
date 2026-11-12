// ============================================================
// تنظيف آثار الاختبار — يحذف المهام التجريبية والمفتاح التجريبي الخاطئ
// يُبقي على مفاتيح المستخدم الحقيقية كما هي.
// الاستخدام: node scripts/cleanup-test-data.mjs
// ============================================================
import { createClient } from "@libsql/client";
import fs from "node:fs";

const envFile = fs.existsSync("/home/z/my-project/mcp-media-generator/.env.local")
  ? "/home/z/my-project/mcp-media-generator/.env.local"
  : ".env.local";
const env = Object.fromEntries(
  fs.readFileSync(envFile, "utf8")
    .split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"))
    .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

// المهام التجريبية: كل مهام الصورة/الفيديو/الدمج التي أُنشئت أثناء الاختبار
const delTasks = await db.execute("DELETE FROM tasks");
console.log(`حُذفت المهام التجريبية: ${delTasks.rows_affected} صف`);

// المفتاح التجريبي الخاطئ فقط
const delKeys = await db.execute({ sql: "DELETE FROM api_keys WHERE label = ?", args: ["اختبار-خاطئ"] });
console.log(`حُذف المفتاح التجريبي: ${delKeys.rows_affected} صف`);

const keys = await db.execute("SELECT label, provider, status FROM api_keys ORDER BY created_at ASC");
console.log("المفاتيح المتبقية (معلومات فقط):");
for (const k of keys.rows) console.log(`  - ${k.label} (${k.provider}) [${k.status}]`);
