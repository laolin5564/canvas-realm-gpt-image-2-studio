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
  return (
    <html lang="zh-CN">
      <body>
        <AppShell initialSiteSettings={siteSettings}>{children}</AppShell>
      </body>
    </html>
  );
}
