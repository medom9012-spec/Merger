// ============================================================
// واجهة المزودات الموحدة + أخطاء تصنَّف في جدول 4.2
// ============================================================
import type { MediaType, ProviderId } from "../models";

export interface ProviderKey {
  id: string;
  provider: ProviderId;
  label: string;
  api_key: string;
}

/** أي خطأ من المزود يُرمى بهذا الشكل ليُصنَّف في classifyProviderError */
export class ProviderError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export interface CreateTaskResult {
  providerTaskId: string;
}

export interface CheckTaskResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId
  createTask(key: ProviderKey, model: string, input: Record<string, unknown>): Promise<CreateTaskResult>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: ProviderKey, model: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult>;
}

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export function isProviderId(v: string): v is ProviderId {
  return v === "kie" || v === "cometapi";
}

export type { MediaType, ProviderId };
