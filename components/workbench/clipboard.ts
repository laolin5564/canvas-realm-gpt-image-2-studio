"use client";

/**
 * 剪贴板 / 拖拽取图的辅助函数（从 WorkbenchClient 拆出来，逻辑保持不变）。
 * 顺序：DataTransfer 里的文件 → text/html 里的 img → text/plain 里的图片链接。
 */

export const supportedImageMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;

export function isSupportedImageMimeType(type: string): boolean {
  return supportedImageMimeTypes.includes(type as (typeof supportedImageMimeTypes)[number]);
}

export function isSupportedImageFile(file: File): boolean {
  return isSupportedImageMimeType(file.type);
}

export function imageExtensionFromMimeType(type: string): string {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  return "png";
}

export function inferSourceImagePurpose(name: string): string {
  const lowered = name.toLowerCase();
  if (/(logo|标志|商标|icon|头像)/i.test(lowered)) {
    return "Logo / 品牌图";
  }
  if (/(person|portrait|people|model|人物|人像|模特)/i.test(lowered)) {
    return "人物图";
  }
  if (/(poster|cover|banner|海报|封面|首图)/i.test(lowered)) {
    return "海报 / 封面图";
  }
  if (/(product|sku|goods|item|商品|产品|主图)/i.test(lowered)) {
    return "产品图";
  }
  return "参考图";
}

function makeClipboardImageFile(blob: Blob, prefix: string, index = 0): File | null {
  const type = blob.type || "image/png";
  if (!isSupportedImageMimeType(type)) {
    return null;
  }
  const extension = imageExtensionFromMimeType(type);
  return new File([blob], `${prefix}-${Date.now()}-${index}.${extension}`, { type });
}

async function imageFileFromUrl(url: string, prefix: string, index = 0): Promise<File | null> {
  if (!url) return null;
  if (!url.startsWith("data:image/") && !/^https?:\/\//i.test(url)) {
    return null;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return makeClipboardImageFile(blob, prefix, index);
  } catch {
    return null;
  }
}

async function imageFilesFromHtml(html: string, prefix: string): Promise<File[]> {
  if (!html.trim()) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const urls = Array.from(doc.querySelectorAll("img"))
    .flatMap((img) => [img.getAttribute("src"), img.getAttribute("data-src"), img.getAttribute("currentSrc")])
    .filter((url): url is string => Boolean(url));

  const files = await Promise.all(urls.map((url, index) => imageFileFromUrl(url, prefix, index)));
  return files.filter((file): file is File => file !== null);
}

async function imageFilesFromPlainText(text: string, prefix: string): Promise<File[]> {
  const value = text.trim();
  if (!value) return [];
  const file = await imageFileFromUrl(value, prefix);
  return file ? [file] : [];
}

export function imageFilesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  const itemFiles = Array.from(dataTransfer.items ?? [])
    .map((item) => (item.kind === "file" ? item.getAsFile() : null))
    .filter((file): file is File => file !== null && file.type.startsWith("image/"));
  if (itemFiles.length > 0) {
    return itemFiles;
  }
  return Array.from(dataTransfer.files ?? []).filter((file) => file.type.startsWith("image/"));
}

export async function imageFilesFromClipboardData(clipboardData: DataTransfer, prefix: string): Promise<File[]> {
  const directFiles = imageFilesFromDataTransfer(clipboardData);
  if (directFiles.length > 0) {
    return directFiles;
  }

  const htmlFiles = await imageFilesFromHtml(clipboardData.getData("text/html"), prefix);
  if (htmlFiles.length > 0) {
    return htmlFiles;
  }

  return imageFilesFromPlainText(clipboardData.getData("text/plain"), prefix);
}

export async function readClipboardImageFiles(prefix: string): Promise<File[]> {
  const files: File[] = [];

  if (navigator.clipboard?.read) {
    const clipboardItems = await navigator.clipboard.read();
    for (const item of clipboardItems) {
      const imageType = item.types.find((type) => type.startsWith("image/"));
      if (imageType) {
        const file = makeClipboardImageFile(await item.getType(imageType), prefix, files.length);
        if (file) files.push(file);
        continue;
      }

      if (item.types.includes("text/html")) {
        const html = await (await item.getType("text/html")).text();
        files.push(...await imageFilesFromHtml(html, prefix));
        continue;
      }

      if (item.types.includes("text/plain")) {
        const text = await (await item.getType("text/plain")).text();
        files.push(...await imageFilesFromPlainText(text, prefix));
      }
    }
  }

  if (files.length === 0 && navigator.clipboard?.readText) {
    files.push(...await imageFilesFromPlainText(await navigator.clipboard.readText(), prefix));
  }

  return files;
}

export function getValidImageFiles(files: FileList | File[] | null): File[] {
  if (!files) return [];
  return Array.from(files).filter((file) => file.type.startsWith("image/"));
}
