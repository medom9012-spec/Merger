// ============================================================
// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP
// قرار معماري: لا ملفات SQLite محلية إطلاقًا لتوافق Vercel serverless.
// المخطط يُنشأ عند أول وصول (CREATE TABLE IF NOT EXISTS) بلا أداة migrations.
// ============================================================
import { createClient, type Client } from "@libsql/client";

declare global {
  // eslint-disable-next-line no-var
  var __tursoClient: Client | undefined;
  // eslint-disable-next-line no-var
  var __tursoSchemaPromise: Promise<void> | undefined;
}

export function getDb(): Client {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
  }
  if (!globalThis.__tursoClient) {
    globalThis.__tursoClient = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return globalThis.__tursoClient;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  provider TEXT,
  provider_task_id TEXT,
  key_id TEXT,
  model TEXT NOT NULL,
  type TEXT NOT NULL,
  prompt TEXT DEFAULT '',
  params_json TEXT DEFAULT '{}',
  status TEXT NOT NULL,
  progress INTEGER DEFAULT 0,
  result_urls_json TEXT,
  error_message TEXT,
  attempts_json TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT DEFAULT '',
  api_key TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

export async function ensureSchema(): Promise<void> {
  if (!globalThis.__tursoSchemaPromise) {
    globalThis.__tursoSchemaPromise = (async () => {
      await getDb().executeMultiple(SCHEMA_SQL);
    })().catch((err) => {
      // نسمح بإعادة المحاولة لاحقًا إن فشل الإنشاء الأول
      globalThis.__tursoSchemaPromise = undefined;
      throw err;
    });
  }
  return globalThis.__tursoSchemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// الأنواع
// ------------------------------------------------------------
export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string; // image | video | merge
  prompt: string;
  params_json: string;
  status: string; // pending | processing | completed | failed
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface AttemptEntry {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface KeyRow {
  id: string;
  provider: string; // kie | cometapi
  label: string;
  api_key: string;
  status: string; // active | exhausted | disabled
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

// ISO بدقة ميلي ثانية — ضروري للترتيب التسلسلي الصارم للمفاتيح حسب الإضافة
export function nowIso(): string {
  return new Date().toISOString();
}

function rowsAs<T>(rs: { rows: unknown }): T[] {
  return (rs as { rows: T[] }).rows ?? [];
}

// ------------------------------------------------------------
// عمليات المهام
// ------------------------------------------------------------
export async function insertTask(t: {
  model: string;
  type: string;
  prompt: string;
  params: object;
}): Promise<TaskRow> {
  const id = crypto.randomUUID();
  const now = nowIso();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, model, type, prompt, params_json, status, progress, attempts_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'processing', 0, '[]', ?, ?)`,
    args: [id, t.model, t.type, t.prompt, JSON.stringify(t.params), now, now],
  });
  return (await getTask(id))!;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const rs = await getDb().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return rowsAs<TaskRow>(rs)[0] ?? null;
}

export interface TaskPatch {
  provider?: string;
  provider_task_id?: string;
  key_id?: string;
  status?: "pending" | "processing" | "completed" | "failed";
  progress?: number;
  result_urls?: string[];
  error_message?: string | null;
  /** اندماج معلومة إضافية داخل params_json (مثل processStarted لمهام الدمج) */
  params_merge?: Record<string, unknown>;
  /** محاولة جديدة تُلحق بسجل attempts_json */
  attempt?: AttemptEntry;
}

export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
  const cur = await getTask(id);
  if (!cur) return null;

  const sets: string[] = [];
  const args: (string | number | null)[] = [];

  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(Math.max(0, Math.min(100, Math.round(patch.progress)))); }
  if (patch.result_urls !== undefined) { sets.push("result_urls_json = ?"); args.push(JSON.stringify(patch.result_urls)); }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }

  if (patch.params_merge) {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(cur.params_json || "{}"); } catch { /* نبدأ من جديد */ }
    sets.push("params_json = ?");
    args.push(JSON.stringify({ ...p, ...patch.params_merge }));
  }

  if (patch.attempt) {
    let attempts: AttemptEntry[] = [];
    try { attempts = JSON.parse(cur.attempts_json || "[]"); } catch { /* نبدأ من جديد */ }
    attempts.push(patch.attempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts));
  }

  if (patch.status === "completed" && !cur.completed_at) {
    sets.push("completed_at = ?");
    args.push(nowIso());
  }

  sets.push("updated_at = ?");
  args.push(nowIso());
  args.push(id);

  await getDb().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
  return getTask(id);
}

export async function listRecentTasks(
  limit = 10,
  filter?: { type?: string; status?: string },
): Promise<TaskRow[]> {
  const args: (string | number)[] = [];
  const conds: string[] = [];
  if (filter?.type) { conds.push("type = ?"); args.push(filter.type); }
  if (filter?.status) { conds.push("status = ?"); args.push(filter.status); }
  args.push(Math.max(1, Math.min(50, limit)));
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rs = await getDb().execute({
    sql: `SELECT * FROM tasks ${where} ORDER BY created_at DESC, updated_at DESC LIMIT ?`,
    args,
  });
  return rowsAs<TaskRow>(rs);
}

export async function taskStats(): Promise<{
  total: number; completed: number; failed: number; processing: number;
}> {
  const rs = await getDb().execute("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status");
  const byStatus = new Map<string, number>();
  for (const r of rowsAs<{ status: string; c: number }>(rs)) byStatus.set(r.status, Number(r.c));
  const total = [...byStatus.values()].reduce((a, b) => a + b, 0);
  return {
    total,
    completed: byStatus.get("completed") ?? 0,
    failed: byStatus.get("failed") ?? 0,
    processing: (byStatus.get("processing") ?? 0) + (byStatus.get("pending") ?? 0),
  };
}

// ------------------------------------------------------------
// عمليات المفاتيح
// ------------------------------------------------------------
export async function insertKey(provider: string, apiKey: string, label: string): Promise<KeyRow> {
  const id = crypto.randomUUID();
  const now = nowIso();
  await getDb().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status, created_at)
          VALUES (?, ?, ?, ?, 'active', ?)`,
    args: [id, provider, label, apiKey, now],
  });
  return (await getKeyById(id))!;
}

export async function getKeyById(id: string): Promise<KeyRow | null> {
  const rs = await getDb().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return rowsAs<KeyRow>(rs)[0] ?? null;
}

export async function findKeyByProviderAndValue(provider: string, apiKey: string): Promise<KeyRow | null> {
  const rs = await getDb().execute({
    sql: "SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return rowsAs<KeyRow>(rs)[0] ?? null;
}

export async function listKeys(): Promise<KeyRow[]> {
  const rs = await getDb().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return rowsAs<KeyRow>(rs);
}

/**
 * تجمع مفاتيح المزودات المطلوبة — بالترتيب التسلسلي الصارم حسب الإضافة:
 * أول مفتاح أُضيف يُجرَّب أولًا ثم التالي ثم التالي...
 * هذا ترتيب مقصود وليس round-robin وليس «الأقل استخدامًا أولًا».
 * المفتاح المستنزف (exhausted) يبقى في القائمة والقاعدة — الاستثناء الوحيد disabled.
 */
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  const placeholders = providers.map(() => "?").join(", ");
  const rs = await getDb().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return rowsAs<KeyRow>(rs);
}

export interface KeyPatch {
  status?: "active" | "exhausted" | "disabled";
  last_error?: string | null;
  last_used_at?: string;
  last_checked_at?: string;
  usage_inc?: number;
  success_inc?: number;
  fail_inc?: number;
}

export async function updateKey(id: string, patch: KeyPatch): Promise<void> {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.last_error !== undefined) { sets.push("last_error = ?"); args.push(patch.last_error); }
  if (patch.last_used_at !== undefined) { sets.push("last_used_at = ?"); args.push(patch.last_used_at); }
  if (patch.last_checked_at !== undefined) { sets.push("last_checked_at = ?"); args.push(patch.last_checked_at); }
  if (patch.usage_inc) { sets.push("usage_count = usage_count + ?"); args.push(patch.usage_inc); }
  if (patch.success_inc) { sets.push("success_count = success_count + ?"); args.push(patch.success_inc); }
  if (patch.fail_inc) { sets.push("fail_count = fail_count + ?"); args.push(patch.fail_inc); }
  if (!sets.length) return;
  args.push(id);
  await getDb().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function deleteKey(id: string): Promise<boolean> {
  const rs = await getDb().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return Number((rs as unknown as { rows_affected?: number }).rows_affected ?? 0) > 0;
}
