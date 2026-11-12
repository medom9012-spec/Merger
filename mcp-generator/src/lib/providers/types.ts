// واجهة المزودات — أي خطأ يُرمى كـ ProviderError ليُصنَّف في errors.ts
import type { ProviderId } from "../models";

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // 0..100
}

export interface ProviderAdapter {
  id: ProviderId;
  // مهمة غير متزامنة (فيديو وبعض الصور): تعيد providerTaskId
  createTask(key: string, model: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن دعمها المزود (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: string, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: string, providerTaskId: string): Promise<CheckResult>;
}
