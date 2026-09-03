import { ImageValidationError } from "./storage";

/**
 * 参考图上传入口的归一化：EXIF 转正、最长边限制、体积软目标。
 *
 * 之前上传的参考图原样落盘，一张 1.8MB 的手机 JPEG 或 20MB 的 PNG 会一路带到图生图请求里，
 * 直连网关 1MB 的默认 body 上限一碰就 413。这里在落盘前把图片整理成模型真正需要的样子：
 * - 应用 EXIF 方向（手机竖拍常带 orientation=6），并剥掉 EXIF（隐私），尽量保留 ICC 色彩配置；
 * - 最长边压到 maxDimension 以内；
 * - 体积超过 targetBytes 时按质量阶梯 / 尺寸阶梯重编码成 webp（保留 alpha）；
 * - 三条都不触发时原字节直通，不做任何有损处理。
 *
 * targetBytes 是软目标：阶梯走到底仍超就返回最小的那份，不拒绝上传（原始上限由调用方另行校验）。
 */

export type NormalizedSourceMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface NormalizedSourceImage {
  bytes: Uint8Array;
  mimeType: NormalizedSourceMimeType;
  /** 转正后的真实像素宽度。 */
  width: number;
  /** 转正后的真实像素高度。 */
  height: number;
  /** 是否重编码过；false 表示 bytes 就是传入的原字节。 */
  changed: boolean;
  /** 传入的原始字节数。 */
  originalBytes: number;
}

export interface NormalizeSourceImageOptions {
  /** 最长边上限（像素），默认 2048。 */
  maxDimension?: number;
  /** 体积软目标（字节），默认 3MB。 */
  targetBytes?: number;
}

export const defaultSourceImageMaxDimension = 2048;
export const defaultSourceImageTargetBytes = 3_000_000;

/** 重编码时的 webp 质量阶梯。 */
export const sourceImageQualitySteps = [90, 85, 80, 75] as const;
/** 质量阶梯走完仍超目标时，最长边按此比例递减。 */
export const sourceImageShrinkRatio = 0.8;
/** 尺寸递减的下限：再小就影响参考效果，宁可超一点体积。 */
export const sourceImageMinDimension = 1024;

const decodeFailureMessage = "图片文件损坏或无法解析";

function mimeTypeFromFormat(format: string | undefined): NormalizedSourceMimeType | null {
  if (format === "png") return "image/png";
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return null;
}

function mimeTypeFromDeclared(mimeType: string | null): NormalizedSourceMimeType | null {
  return mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp" ? mimeType : null;
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * @param bytes 已通过 assertSupportedImageBytes 魔数校验的原始字节。
 * @param declaredMimeType 客户端声明的类型，只作兜底：以 sharp 实际识别出的格式为准。
 */
export async function normalizeSourceImage(
  bytes: Uint8Array,
  declaredMimeType: string | null,
  options: NormalizeSourceImageOptions = {},
): Promise<NormalizedSourceImage> {
  const maxDimension = Math.max(1, Math.floor(options.maxDimension ?? defaultSourceImageMaxDimension));
  const targetBytes = Math.max(1, Math.floor(options.targetBytes ?? defaultSourceImageTargetBytes));
  const { default: sharp } = await import("sharp");
  const input = toBuffer(bytes);
  // 动图只取首帧；failOn: error 对轻微损坏的手机 JPEG 更宽容。
  const open = () => sharp(input, { pages: 1, failOn: "error" });

  let metadata: Awaited<ReturnType<ReturnType<typeof open>["metadata"]>>;
  try {
    metadata = await open().metadata();
  } catch {
    throw new ImageValidationError(decodeFailureMessage);
  }

  const rawWidth = metadata.width ?? 0;
  const rawHeight = metadata.pageHeight ?? metadata.height ?? 0;
  if (rawWidth <= 0 || rawHeight <= 0) {
    throw new ImageValidationError(decodeFailureMessage);
  }

  const orientation = metadata.orientation ?? 1;
  const swapped = orientation >= 5;
  const width = swapped ? rawHeight : rawWidth;
  const height = swapped ? rawWidth : rawHeight;
  const longestSide = Math.max(width, height);
  const passthroughMime = mimeTypeFromFormat(metadata.format) ?? mimeTypeFromDeclared(declaredMimeType);
  const animated = (metadata.pages ?? 1) > 1;

  const needsRotate = orientation > 1;
  const needsResize = longestSide > maxDimension;
  const needsShrink = bytes.length > targetBytes;
  const needsReencode = needsRotate || needsResize || needsShrink || animated || passthroughMime === null;

  if (!needsReencode && passthroughMime) {
    return {
      bytes,
      mimeType: passthroughMime,
      width,
      height,
      changed: false,
      originalBytes: bytes.length,
    };
  }

  const encode = async (dimension: number, quality: number) => {
    const { data, info } = await open()
      .rotate()
      .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
      // sharp ≥ 0.33：只保留 ICC，不带 EXIF（去掉定位等隐私信息）。
      .keepIccProfile()
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });
    return { bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
  };

  let dimension = Math.min(longestSide, maxDimension);
  const floor = Math.min(sourceImageMinDimension, dimension);
  let best: Awaited<ReturnType<typeof encode>> | null = null;

  try {
    for (;;) {
      for (const quality of sourceImageQualitySteps) {
        const candidate = await encode(dimension, quality);
        if (!best || candidate.bytes.length < best.bytes.length) {
          best = candidate;
        }
        if (candidate.bytes.length <= targetBytes) {
          return finish(candidate, bytes.length);
        }
      }
      if (dimension <= floor) {
        break;
      }
      dimension = Math.max(floor, Math.floor(dimension * sourceImageShrinkRatio));
    }
  } catch {
    throw new ImageValidationError(decodeFailureMessage);
  }

  // 阶梯到底仍超：target 只是软目标，交出最小的那份。
  return finish(best as NonNullable<typeof best>, bytes.length);
}

function finish(
  encoded: { bytes: Uint8Array; width: number; height: number },
  originalBytes: number,
): NormalizedSourceImage {
  return {
    bytes: encoded.bytes,
    mimeType: "image/webp",
    width: encoded.width,
    height: encoded.height,
    changed: true,
    originalBytes,
  };
}
