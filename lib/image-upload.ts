import path from "node:path";
import sharp from "sharp";

export interface ReferenceImageUpload {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

const compressionProfiles = [
  { maxDimension: 1536, quality: 82 },
  { maxDimension: 1280, quality: 72 },
  { maxDimension: 1024, quality: 62 },
  { maxDimension: 768, quality: 52 },
  { maxDimension: 512, quality: 42 },
] as const;

export async function fitReferenceImagesToBudget(
  images: ReferenceImageUpload[],
  maxTotalBytes: number,
): Promise<ReferenceImageUpload[]> {
  if (images.length === 0 || totalBytes(images) <= maxTotalBytes) {
    return images;
  }
  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes <= 0) {
    throw new Error("参考图上传预算配置无效");
  }

  let smallestResult: ReferenceImageUpload[] | null = null;
  for (const profile of compressionProfiles) {
    const compressed = await Promise.all(
      images.map(async (image) => {
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
      }),
    );

    smallestResult = compressed;
    if (totalBytes(compressed) <= maxTotalBytes) {
      return compressed;
    }
  }

  throw new Error(
    `参考图压缩后仍超过网关限制（${totalBytes(smallestResult ?? images)} > ${maxTotalBytes} 字节）`,
  );
}

function totalBytes(images: ReferenceImageUpload[]): number {
  return images.reduce((sum, image) => sum + image.bytes.byteLength, 0);
}
