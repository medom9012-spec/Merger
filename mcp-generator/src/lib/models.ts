// سجل الموديلات المدمجة: الاسم الموحد (canonical) والبدائل وأسماء الموديل لكل مزود

export type ProviderId = "kie" | "cometapi";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string;   // الاسم كما يراه عميل MCP
  aliases: string[];   // صيغ بديلة نقبلها ونوحدّها
  type: MediaType;
  providers: ProviderId[]; // تُجرَّب مفاتيح كل هؤلاء بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

// تجاوز الأسماء عبر متغيرات البيئة إن وُجدت
function envOverride(key: string, fallback: string): string {
  const v = (process.env[key] || "").trim();
  return v || fallback;
}

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOverride("KIE_IMAGE_MODEL", "gpt-image-2-6/flare-text-to-image"),
      cometapi: envOverride("COMETAPI_IMAGE_MODEL", "gpt-image-2.6-flare-text-to-image"),
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOverride("KIE_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
      cometapi: envOverride("COMETAPI_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
    },
  },
];

export const DEFAULT_IMAGE_MODEL = MODELS[0].canonical;
export const DEFAULT_VIDEO_MODEL = MODELS[1].canonical;

// توحيد اسم الموديل عبر canonical + aliases (غير حساس لحالة الأحرف)
export function normalizeModel(name?: string | null): ModelDef | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return (
    MODELS.find(
      (m) => m.canonical.toLowerCase() === n || m.aliases.some((a) => a.toLowerCase() === n)
    ) ?? null
  );
}

export function modelByType(type: MediaType): ModelDef | null {
  return MODELS.find((m) => m.type === type) ?? null;
}
