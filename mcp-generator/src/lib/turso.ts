// طبقة قاعدة البيانات (Turso عبر HTTP — @libsql/client)
// عميل واحد + مخطط يُنشأ عند أول وصول، وكل الدوال ترمي NoDatabaseError إذا غابت متغيرات البيئة

import { createClient, type Client, type InValue } from "@libsql/client";
import { randomUUID } from "node:crypto";

// ================== الأخطاء ==================
export class NoDatabaseError extends Error {
  constructor() {
    super("قاعدة البيانات غير مهيأة — عيّن TURSO_DATABASE_URL و TURSO_AUTH_TOKEN");
    this.name = "NoDatabaseError";
  }
}

export class DuplicateKeyError extends Error {
  constructor() {
    super("هذا المفتاح مسجَّل مسبقًا لنفس المزود");
    this.name = "DuplicateKeyError";
  }
}

// ================== الأنواع ==================
export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
}

// سجل محاولة واحد داخل attempts_json
export interface Attempt {
  provider?: string;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface ApiKeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string | null;
}

// رقعة تحديث جزئية للمهمة
export interface TaskPatch {
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model?: string;
  status?: TaskStatus;
  progress?: number;
  result_urls?: string[] | null;
  error_message?: string | null;
  attempt?: Attempt; // تُضاف إلى attempts_json
  params?: Record<string, unknown>;
}

// ================== العميل والمخطط ==================
let client: Client | null = null;
let schemaPromise: Promise<void> | null = null;

function getClient(): Client {
  const url = (process.env.TURSO_DATABASE_URL || "").trim();
  const token = (process.env.TURSO_AUTH_TOKEN || "").trim();
  if (!url || !token) throw new NoDatabaseError();
  if (!client) client = createClient({ url, authToken: token });
  return client;
}

// إنشاء الجداول عند أول وصول — نفس شكل جداول الإنتاج حرفيًا (لا تعارض)
async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    const c = getClient();
    schemaPromise = (async () => {
      await c.execute(`CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, provider TEXT, provider_task_id TEXT, key_id TEXT, model TEXT NOT NULL, type TEXT NOT NULL,
  prompt TEXT DEFAULT '', params_json TEXT DEFAULT '{}', status TEXT NOT NULL, progress INTEGER DEFAULT 0,
  result_urls_json TEXT, error_message TEXT, attempts_json TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT
)`);
      await c.execute(`CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT DEFAULT '', api_key TEXT NOT NULL,
  status TEXT DEFAULT 'active', usage_count INTEGER DEFAULT 0, success_count INTEGER DEFAULT 0, fail_count INTEGER DEFAULT 0,
  last_used_at TEXT, last_checked_at TEXT, last_error TEXT, created_at TEXT DEFAULT (datetime('now'))
)`);
    })().catch((err) => {
      schemaPromise = null; // اسمح بإعادة المحاولة لاحقًا
      throw err;
    });
  }
  return schemaPromise;
}

// ================== أدوات مساعدة ==================
type RawRow = Record<string, unknown>;

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : v == null ? null : String(v);
}
function asNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function rowToTask(r: RawRow): TaskRow {
  return {
    id: String(r.id),
    provider: asString(r.provider),
    provider_task_id: asString(r.provider_task_id),
    key_id: asString(r.key_id),
    model: String(r.model ?? ""),
    type: String(r.type ?? ""),
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: (String(r.status ?? "pending") as TaskStatus),
    progress: asNum(r.progress),
    result_urls_json: asString(r.result_urls_json),
    error_message: asString(r.error_message),
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: asString(r.created_at),
    updated_at: asString(r.updated_at),
    completed_at: asString(r.completed_at),
  };
}

function rowToKey(r: RawRow): ApiKeyRow {
  return {
    id: String(r.id),
    provider: String(r.provider ?? ""),
    label: String(r.label ?? ""),
    api_key: String(r.api_key ?? ""),
    status: String(r.status ?? "active"),
    usage_count: asNum(r.usage_count),
    success_count: asNum(r.success_count),
    fail_count: asNum(r.fail_count),
    last_used_at: asString(r.last_used_at),
    last_checked_at: asString(r.last_checked_at),
    last_error: asString(r.last_error),
    created_at: asString(r.created_at),
  };
}

// إخفاء المفتاح — إلزامي في كل الاستجابات (لا يُعاد المفتاح الكامل أبدًا)
export function maskKey(key: string): string {
  if (key.length < 8) return "••••";
  if (key.length <= 14) return key.slice(0, 3) + "••••";
  return key.slice(0, 7) + "••••••••" + key.slice(-4);
}

export function parseUrls(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

export function parseAttempts(json: string | null): Attempt[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Attempt[]) : [];
  } catch {
    return [];
  }
}

// ================== الصحة ==================
export async function dbHealthy(): Promise<boolean> {
  try {
    const c = getClient();
    await c.execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ================== عمليات المهام ==================
export async function insertTask(t: {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: string;
  prompt?: string;
  params_json?: string;
  status?: TaskStatus;
  progress?: number;
}): Promise<void> {
  const c = getClient();
  await ensureSchema();
  await c.execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      t.id,
      t.provider ?? null,
      t.provider_task_id ?? null,
      t.key_id ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      t.params_json ?? "{}",
      t.status ?? "pending",
      t.progress ?? 0,
      "[]",
    ],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const c = getClient();
  await ensureSchema();
  const res = await c.execute({ sql: "SELECT * FROM tasks WHERE id = ? LIMIT 1", args: [id] });
  if (res.rows.length === 0) return null;
  return rowToTask(res.rows[0] as unknown as RawRow);
}

/*
 * تحديث جزئي: يضيف attempt إلى attempts_json، ويضبط completed_at تلقائيًا عند الاكتمال،
 * ويحدّث updated_at دائمًا.
 */
export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
  const c = getClient();
  await ensureSchema();
  const current = await getTask(id);
  if (!current) return null;

  const sets: string[] = [];
  const args: InValue[] = [];

  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.model !== undefined) { sets.push("model = ?"); args.push(patch.model); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) {
    sets.push("progress = ?");
    args.push(Math.max(0, Math.min(100, Math.round(patch.progress))));
  }
  if (patch.result_urls !== undefined) {
    sets.push("result_urls_json = ?");
    args.push(patch.result_urls ? JSON.stringify(patch.result_urls) : null);
  }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }
  if (patch.params !== undefined) { sets.push("params_json = ?"); args.push(JSON.stringify(patch.params)); }
  if (patch.attempt) {
    const attempts = parseAttempts(current.attempts_json);
    attempts.push(patch.attempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts));
  }
  if (patch.status === "completed" && current.status !== "completed") {
    sets.push("completed_at = datetime('now')");
  }
  sets.push("updated_at = datetime('now')");

  await c.execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args: [...args, id] });
  return getTask(id);
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: string; status?: string }
): Promise<TaskRow[]> {
  const c = getClient();
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters?.type) { where.push("type = ?"); args.push(filters.type); }
  if (filters?.status) {
    // الفلترة بـ processing تشمل pending (لم تبدأ فعليًا بعد)
    if (filters.status === "processing") where.push("status IN ('processing','pending')");
    else { where.push("status = ?"); args.push(filters.status); }
  }
  const lim = Math.max(1, Math.min(100, Math.round(limit) || 10));
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ${lim}`;
  const res = await c.execute({ sql, args });
  return res.rows.map((r) => rowToTask(r as unknown as RawRow));
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  const c = getClient();
  await ensureSchema();
  const res = await c.execute(`SELECT
    COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
    COALESCE(SUM(CASE WHEN status IN ('processing','pending') THEN 1 ELSE 0 END), 0) AS processing
  FROM tasks`);
  const r = res.rows[0] as unknown as RawRow;
  return {
    total: asNum(r.total),
    completed: asNum(r.completed),
    failed: asNum(r.failed),
    processing: asNum(r.processing),
  };
}

// ================== عمليات المفاتيح ==================
export async function listKeys(): Promise<ApiKeyRow[]> {
  const c = getClient();
  await ensureSchema();
  const res = await c.execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return res.rows.map((r) => rowToKey(r as unknown as RawRow));
}

export async function getKeyById(id: string): Promise<ApiKeyRow | null> {
  const c = getClient();
  await ensureSchema();
  const res = await c.execute({ sql: "SELECT * FROM api_keys WHERE id = ? LIMIT 1", args: [id] });
  if (res.rows.length === 0) return null;
  return rowToKey(res.rows[0] as unknown as RawRow);
}

export async function insertKey(provider: string, apiKey: string, label?: string): Promise<ApiKeyRow> {
  const c = getClient();
  await ensureSchema();
  // رفض التكرار لنفس المزود
  const dup = await c.execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  if (dup.rows.length > 0) throw new DuplicateKeyError();
  const id = randomUUID();
  await c.execute({
    sql: "INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)",
    args: [id, provider, label ?? "", apiKey],
  });
  const created = await getKeyById(id);
  if (!created) throw new Error("فشل إنشاء المفتاح");
  return created;
}

export async function updateKey(id: string, patch: { status?: string }): Promise<ApiKeyRow | null> {
  const c = getClient();
  await ensureSchema();
  const existing = await getKeyById(id);
  if (!existing) return null;
  if (patch.status !== undefined) {
    await c.execute({
      sql: "UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?",
      args: [patch.status, id],
    });
  }
  return getKeyById(id);
}

export async function deleteKey(id: string): Promise<boolean> {
  const c = getClient();
  await ensureSchema();
  const res = await c.execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return res.rowsAffected > 0;
}

/*
 * تجيب كل المفاتيح غير المعطّلة لهذه المزودات بترتيب تسلسلي صارم:
 * أول مفتاح أُضيف يُجرَّب أولًا (created_at ASC, id ASC) — ليس round-robin.
 * المفتاح المستنزف (exhausted) يبقى في القائمة؛ الاستثناء الوحيد هو disabled اليدوي.
 */
export async function getKeyPool(providers: string[]): Promise<ApiKeyRow[]> {
  const c = getClient();
  await ensureSchema();
  const list = providers.filter((p) => typeof p === "string" && p);
  if (list.length === 0) return [];
  const placeholders = list.map(() => "?").join(",");
  const res = await c.execute({
    sql: `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    args: list,
  });
  return res.rows.map((r) => rowToKey(r as unknown as RawRow));
}

// تحديث عدّادات المفتاح دائمًا بعد كل استخدام، مع تعليم الحالة عند التصنيف
export async function bumpKeyCounters(
  id: string,
  info: { ok: boolean; errorClass?: string; error?: string }
): Promise<void> {
  const c = getClient();
  await ensureSchema();
  const sets: string[] = ["usage_count = usage_count + 1", "last_used_at = datetime('now')", "last_checked_at = datetime('now')"];
  const args: InValue[] = [];
  if (info.ok) {
    sets.push("success_count = success_count + 1");
    sets.push("last_error = NULL");
  } else {
    sets.push("fail_count = fail_count + 1");
    sets.push("last_error = ?");
    args.push(info.error ?? "خطأ غير معروف");
    if (info.errorClass === "disabled") sets.push("status = 'disabled'");
    else if (info.errorClass === "exhausted") sets.push("status = 'exhausted'");
  }
  await c.execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args: [...args, id] });
}
