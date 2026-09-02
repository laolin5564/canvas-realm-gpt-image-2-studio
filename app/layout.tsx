import type { Metadata } from "next";
// tldraw/tldraw.css 只在 app/canvas/layout.tsx 里引入，避免其它页面白白下载画布样式表。
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { getPublicSiteSettings } from "@/lib/db";

export function generateMetadata(): Metadata {
  const settings = getPublicSiteSettings();
  return {
    title: settings.siteTitle,
    description: settings.siteSubtitle,
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const siteSettings = getPublicSiteSettings();
  // 直连图床前缀在服务端就注入：AppShell 走 props（首帧 SSR 就是最终地址），
  // window 全局给脱离 AppShell 的零散场景兜底。
  const directBaseScript = `window.__IMAGE_DIRECT_BASE__=${JSON.stringify(siteSettings.imageDirectBaseUrl ?? "")};`;
  return (
    <html lang="zh-CN">
      <body>
        <script dangerouslySetInnerHTML={{ __html: directBaseScript }} />
        <AppShell initialSiteSettings={siteSettings}>{children}</AppShell>
      </body>
    </html>
  );
}
