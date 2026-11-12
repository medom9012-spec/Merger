import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // قرار معماري: تعطيل cacheComponents لأن المواصفة تشترط على كل مسارات الـ API
  // تصريحات runtime = "nodejs" و dynamic = "force-dynamic" (خادم MCP طويل
  // الاتصال وبث حي لا يصلح مع التخزين المؤقت للمكونات).
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
