"use client";

import { createContext, useContext, useEffect, useState } from "react";

/**
 * 国内图床直连支持：
 * - 服务端在 app/layout.tsx 里把 appConfig.imagePublicBaseUrl 同时注入
 *   window.__IMAGE_DIRECT_BASE__ 和 AppShell 的 props（再经 ImageDirectBaseContext 下发），
 *   因此首帧渲染出来的 img src 就是最终地址，不再「先同源、再切直连」闪一下。
 * - 热点视图用 withDirectBase 把相对图片路径拼成直连地址，绕开 CF 走国内家宽直连。
 * - 直连失败（家内网 NAT 回环 / 端口不通 / 证书问题）时 handleImgError 自动回退同源路径。
 */

declare global {
  interface Window {
    __IMAGE_DIRECT_BASE__?: string;
  }
}

/** null 表示「服务端没下发」，此时才需要走 window 全局 / /api/site-settings 兜底。 */
export const ImageDirectBaseContext = createContext<string | null>(null);

let cachedBase: string | null = null;
let inflight: Promise<string> | null = null;

export function normalizeDirectBase(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function readInjectedBase(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const injected = window.__IMAGE_DIRECT_BASE__;
  return typeof injected === "string" ? normalizeDirectBase(injected) : null;
}

async function fetchDirectBase(): Promise<string> {
  try {
    const response = await fetch("/api/site-settings");
    const payload = (await response.json()) as { settings?: { imageDirectBaseUrl?: string } };
    return normalizeDirectBase(payload.settings?.imageDirectBaseUrl);
  } catch {
    return "";
  }
}

export function useImageDirectBase(): string {
  const provided = useContext(ImageDirectBaseContext);
  // 服务端已下发时首帧就是最终值；只有脱离 AppShell 的场景才需要下面这份异步兜底。
  const [fallback, setFallback] = useState("");

  useEffect(() => {
    if (provided !== null) {
      return;
    }
    const injected = readInjectedBase();
    if (injected !== null) {
      cachedBase = injected;
      setFallback(injected);
      return;
    }
    if (cachedBase !== null) {
      setFallback(cachedBase);
      return;
    }
    let active = true;
    inflight = inflight ?? fetchDirectBase();
    inflight.then((value) => {
      cachedBase = value;
      if (active) {
        setFallback(value);
      }
    });
    return () => {
      active = false;
    };
  }, [provided]);

  return provided ?? fallback;
}

export function withDirectBase(base: string, url: string): string {
  return base && url.startsWith("/") ? `${base}${url}` : url;
}

export function handleImgError(event: { currentTarget: HTMLImageElement }): void {
  const img = event.currentTarget;
  if (img.dataset.fellBack === "1") {
    return;
  }
  try {
    const parsed = new URL(img.src, window.location.href);
    if (parsed.origin !== window.location.origin) {
      img.dataset.fellBack = "1";
      img.src = parsed.pathname + parsed.search;
    }
  } catch {
    // ignore malformed src
  }
}
