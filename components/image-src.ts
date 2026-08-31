"use client";

import { useEffect, useState } from "react";

/**
 * 国内图床直连支持：
 * - 服务端通过 /api/site-settings 下发 imageDirectBaseUrl（如 https://imgd.laolin.ai:18443）。
 * - 热点视图用 withDirectBase 把相对图片路径拼成直连地址，绕开 CF 走国内家宽直连。
 * - 直连失败（家内网 NAT 回环 / 端口不通 / 证书问题）时 handleImgError 自动回退同源路径。
 */

let cachedBase: string | null = null;
let inflight: Promise<string> | null = null;

async function fetchDirectBase(): Promise<string> {
  try {
    const response = await fetch("/api/site-settings");
    const payload = (await response.json()) as { settings?: { imageDirectBaseUrl?: string } };
    return payload.settings?.imageDirectBaseUrl?.replace(/\/+$/, "") ?? "";
  } catch {
    return "";
  }
}

export function useImageDirectBase(): string {
  const [base, setBase] = useState(cachedBase ?? "");

  useEffect(() => {
    if (cachedBase !== null) {
      setBase(cachedBase);
      return;
    }
    let active = true;
    inflight = inflight ?? fetchDirectBase();
    inflight.then((value) => {
      cachedBase = value;
      if (active) {
        setBase(value);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  return base;
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
