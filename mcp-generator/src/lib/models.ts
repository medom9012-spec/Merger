// ============================================================
// سجل الموديلات — الاسم canonical كما يراه عميل MCP، مع قبول الصيغ البديلة
// (نقاط/شرطات) وتوحّدها. أسماء المزودات قابلة للتجاوز بمتغيرات البيئة.
// ============================================================
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL?.trim() || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL?.trim() || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL?.trim() || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL?.trim() || "grok-imagine-video-1-5-preview";

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: [
      "gpt-image-2.6/flare-text-to-image",
      "gpt-image-2.6-flare-text-to-image",
      "gpt-image-2-6-flare-text-to-image",
    ],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL },
  },
];

export function defaultModelFor(type: "image" | "video"): string {
  return type === "image" ? MODELS[0].canonical : MODELS[1].canonical;
}

/** توحيد اسم الموديل: نقبل الشرطات والنقاط بالتبادل ثم نطابق canonical/aliases */
export function resolveModel(input: string): ModelDef | null {
  const raw = (input || "").trim();
  if (!raw) return null;
  const low = raw.toLowerCase();
  const norm = low.replaceAll(".", "-").replaceAll("_", "-");
  for (const m of MODELS) {
    if (m.canonical.toLowerCase() === low) return m;
    if (m.aliases.some((a) => a.toLowerCase() === low)) return m;
    if (m.canonical.toLowerCase().replaceAll(".", "-") === norm) return m;
    if (m.aliases.some((a) => a.toLowerCase().replaceAll(".", "-") === norm)) return m;
  }
  return null;
}
