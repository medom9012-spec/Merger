// فحص حالة قاعدة البيانات — تشخيص مفاتيح/محاولات
import { createClient } from "@libsql/client";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync("/home/z/my-project/mcp-media-generator/.env.local", "utf8")
    .split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"))
    .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

const keys = await db.execute("SELECT id, provider, label, status, usage_count, success_count, fail_count, created_at FROM api_keys ORDER BY created_at ASC");
console.log("=== API KEYS (بالترتيب التسلسلي) ===");
for (const k of keys.rows) console.log(JSON.stringify(k));

const tasks = await db.execute("SELECT id, type, status, provider, attempts_json, created_at FROM tasks ORDER BY created_at DESC LIMIT 5");
console.log("\n=== TASKS ===");
for (const t of tasks.rows) {
  const attempts = JSON.parse(t.attempts_json || "[]");
  console.log(JSON.stringify({ id: t.id, type: t.type, status: t.status, provider: t.provider, created: t.created_at, attempts }));
}
