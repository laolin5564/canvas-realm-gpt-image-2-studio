import path from "node:path";
import sharp from "sharp";

export interface ReferenceImageUpload {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

export interface FitReferenceImagesOptions {
  /** 单张参考图上限：超过的那几张先单独压到线内，其余小图不动。 */
  maxImageBytes?: number;
}

interface CompressionProfile {
  maxDimension: number;
  quality: number;
}

// 首档尽量温和（2048px / q90）：正常的高清参考图只要能过线就别损失细节，越往后越激进。
const compressionProfiles: readonly CompressionProfile[] = [
  { maxDimension: 2048, quality: 90 },
  { maxDimension: 2048, quality: 82 },
  { maxDimension: 1536, quality: 82 },
  { maxDimension: 1280, quality: 72 },
  { maxDimension: 1024, quality: 62 },
  { maxDimension: 768, quality: 52 },
  { maxDimension: 512, quality: 42 },
];

/**
 * 把参考图压进网关预算。
 * 1. 总量 ≤ maxTotalBytes 且没有单张超过 maxImageBytes：原样返回，一个字节都不碰。
 * 2. 先逐张：只对超过 maxImageBytes 的图沿档位压到线内，小图保持原引用。
 * 3. 逐张压完总量仍超预算：再对所有图整体沿档位压，直到总量 ≤ maxTotalBytes。
 * 任何档位的产物比当前版本还大时保留当前版本（小 PNG 转 webp 反而变大的情况）。
 */
export async function fitReferenceImagesToBudget(
  images: ReferenceImageUpload[],
  maxTotalBytes: number,
  options: FitReferenceImagesOptions = {},
): Promise<ReferenceImageUpload[]> {
  const maxImageBytes = normalizeLimit(options.maxImageBytes);
  const hasOversizedImage =
    maxImageBytes !== null && images.some((image) => image.bytes.byteLength > maxImageBytes);

  if (images.length === 0 || (totalBytes(images) <= maxTotalBytes && !hasOversizedImage)) {
    return images;
  }
  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error("参考图上传预算配置无效");
  }

  let current = images;
  if (hasOversizedImage && maxImageBytes !== null) {
    current = await Promise.all(
      images.map((image) =>
        image.bytes.byteLength > maxImageBytes ? compressSingleImage(image, maxImageBytes) : image,
      ),
    );
  }
  if (totalBytes(current) <= maxTotalBytes) {
    return current;
  }

  for (const profile of compressionProfiles) {
    current = await Promise.all(
      current.map((image, index) => smallerOf(image, images[index], profile)),
    );
    if (totalBytes(current) <= maxTotalBytes) {
      return current;
    }
  }

  throw new Error(`参考图压缩后仍超过网关限制（${totalBytes(current)} > ${maxTotalBytes} 字节）`);
}

/** 单张沿档位压到 ≤ maxImageBytes；所有档位都压不进去就返回最小的那个版本，交给整体压缩兜底。 */
async function compressSingleImage(
  image: ReferenceImageUpload,
  maxImageBytes: number,
): Promise<ReferenceImageUpload> {
  let best = image;
  for (const profile of compressionProfiles) {
    best = await smallerOf(best, image, profile);
    if (best.bytes.byteLength <= maxImageBytes) {
      return best;
    }
  }
  return best;
}

/** 从原图按档位压一次，和当前版本比谁小留谁：档位永远不会把图压大。 */
async function smallerOf(
  current: ReferenceImageUpload,
  original: ReferenceImageUpload,
  profile: CompressionProfile,
): Promise<ReferenceImageUpload> {
  const candidate = await compressWithProfile(original, profile);
  return candidate.bytes.byteLength < current.bytes.byteLength ? candidate : current;
}

async function compressWithProfile(
  image: ReferenceImageUpload,
  profile: CompressionProfile,
): Promise<ReferenceImageUpload> {
  const bytes = await sharp(Buffer.from(image.bytes))
    .rotate()
    .resize({
      width: profile.maxDimension,
      height: profile.maxDimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({
      quality: profile.quality,
      alphaQuality: Math.max(profile.quality, 70),
      effort: 4,
    })
    .toBuffer();
  return {
    bytes: new Uint8Array(bytes),
    mimeType: "image/webp",
    fileName: `${path.parse(image.fileName).name}.webp`,
  };
}

function normalizeLimit(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

export function totalReferenceImageBytes(images: ReferenceImageUpload[]): number {
  return totalBytes(images);
}

function totalBytes(images: ReferenceImageUpload[]): number {
  return images.reduce((sum, image) => sum + image.bytes.byteLength, 0);
}
