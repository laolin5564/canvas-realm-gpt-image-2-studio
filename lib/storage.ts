import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { appConfig } from "./config";
import { ratioForOption } from "./image-options";

const supportedImageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

export class ImageValidationError extends Error {
  status = 400;
}

export function assertSupportedImage(type: string | null): void {
  if (!type || !supportedImageMimeTypes.has(type)) {
    throw new ImageValidationError("仅支持 PNG、JPG、WEBP 图片");
  }
}

export function assertSupportedImageBytes(bytes: Uint8Array, mimeType: string | null): void {
  assertSupportedImage(mimeType);

  if (mimeType === "image/png" && bytes.length >= 8) {
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (pngSignature.every((byte, index) => bytes[index] === byte)) {
      return;
    }
  }

  if (mimeType === "image/jpeg" && bytes.length >= 3) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return;
    }
  }

  if (mimeType === "image/webp" && bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    if (riff === "RIFF" && webp === "WEBP") {
      return;
    }
  }

  throw new ImageValidationError("图片内容与文件类型不匹配");
}

export function extensionForMime(type: string | null): string {
  if (type === "image/jpeg") {
    return "jpg";
  }
  if (type === "image/webp") {
    return "webp";
  }
  return "png";
}

export function mimeFromFileName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  return "image/png";
}

export function parseSize(size: string): { width: number; height: number } {
  return ratioForOption(size);
}

export function datedPathParts(date = new Date()): string[] {
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ];
}

export const THUMBNAIL_SUFFIX = ".thumb.webp";

export function thumbnailPathFor(relativePath: string): string {
  return `${relativePath}${THUMBNAIL_SUFFIX}`;
}

export async function generateThumbnailFile(relativePath: string, bytes: Uint8Array): Promise<void> {
  const { default: sharp } = await import("sharp");
  const thumbBytes = await sharp(Buffer.from(bytes))
    .rotate()
    .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();
  await writeStorageFile(thumbnailPathFor(relativePath), new Uint8Array(thumbBytes));
}

export async function saveGeneratedImageFile(input: {
  taskId: string;
  imageId: string;
  bytes: Uint8Array;
  mimeType: string | null;
}): Promise<string> {
  const extension = extensionForMime(input.mimeType);
  const relativePath = path.posix.join(
    ...datedPathParts(),
    input.taskId,
    `${input.imageId}.${extension}`,
  );
  await writeStorageFile(relativePath, input.bytes);
  try {
    await generateThumbnailFile(relativePath, input.bytes);
  } catch {
    // 缩略图失败不影响原图落盘，列表端会自动回退加载原图。
  }
  return relativePath;
}

export async function saveSourceImageFile(input: {
  sourceId: string;
  fileName: string;
  bytes: Uint8Array;
  mimeType: string | null;
}): Promise<string> {
  assertSupportedImage(input.mimeType);
  const extension = extensionForMime(input.mimeType);
  const relativePath = path.posix.join(
    "source",
    ...datedPathParts(),
    `${input.sourceId}.${extension}`,
  );
  await writeStorageFile(relativePath, input.bytes);
  return relativePath;
}

export async function readStorageFile(relativePath: string): Promise<{
  bytes: Uint8Array;
  mimeType: string;
}> {
  const absolutePath = resolveStoragePath(relativePath);
  const bytes = await readFile(absolutePath);
  return { bytes: new Uint8Array(bytes), mimeType: mimeFromFileName(relativePath) };
}

export async function deleteStorageFile(relativePath: string): Promise<void> {
  const absolutePath = resolveStoragePath(relativePath);
  await rm(absolutePath, { force: true });
  if (!relativePath.endsWith(THUMBNAIL_SUFFIX)) {
    await rm(resolveStoragePath(thumbnailPathFor(relativePath)), { force: true });
  }
  await removeEmptyParentDirectories(path.dirname(absolutePath));
}

export function resolveStoragePath(relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.includes("..")) {
    throw new Error("图片路径不合法");
  }

  const absolutePath = path.resolve(appConfig.imageStorageDir, relativePath);
  const root = path.resolve(appConfig.imageStorageDir);
  if (!absolutePath.startsWith(`${root}${path.sep}`) && absolutePath !== root) {
    throw new Error("图片路径不合法");
  }
  return absolutePath;
}

async function writeStorageFile(relativePath: string, bytes: Uint8Array): Promise<void> {
  const absolutePath = resolveStoragePath(relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
}

async function removeEmptyParentDirectories(directory: string): Promise<void> {
  const root = path.resolve(appConfig.imageStorageDir);
  let current = path.resolve(directory);
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    try {
      await rmdir(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}
