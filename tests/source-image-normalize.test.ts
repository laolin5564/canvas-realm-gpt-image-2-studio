import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { ImageValidationError } from "@/lib/storage";
import {
  normalizeSourceImage,
  pixelLimitMessage,
  sourceImageMinDimension,
  sourceImageQualitySteps,
  sourceImageShrinkRatio,
} from "@/lib/source-image-normalize";

function noiseRaw(width: number, height: number, channels: 3 | 4): Buffer {
  const raw = Buffer.alloc(width * height * channels);
  let seed = 0x9e3779b9;
  for (let i = 0; i < raw.length; i += 1) {
    // 简单 LCG，够随机让编码器压不动就行，不依赖 Math.random 保证可重复。
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    raw[i] = seed >>> 24;
  }
  return raw;
}

async function noisePng(width: number, height: number, channels: 3 | 4 = 3): Promise<Uint8Array> {
  const buffer = await sharp(noiseRaw(width, height, channels), { raw: { width, height, channels } })
    .png({ compressionLevel: 1 })
    .toBuffer();
  return new Uint8Array(buffer);
}

async function flatPng(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 140, b: 90 } } })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

describe("normalizeSourceImage: 直通", () => {
  test("小图不重编码，原字节原样返回并补真实宽高", async () => {
    const bytes = await flatPng(640, 480);
    const result = await normalizeSourceImage(bytes, "image/png");

    expect(result.bytes).toBe(bytes);
    expect(result.changed).toBe(false);
    expect(result.mimeType).toBe("image/png");
    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
    expect(result.originalBytes).toBe(bytes.length);
  });

  test("直通时以实际格式为准，不信客户端声明", async () => {
    const jpeg = new Uint8Array(await sharp({ create: { width: 200, height: 100, channels: 3, background: "#123456" } }).jpeg().toBuffer());
    const result = await normalizeSourceImage(jpeg, "image/png");
    expect(result.changed).toBe(false);
    expect(result.mimeType).toBe("image/jpeg");
  });
});

describe("normalizeSourceImage: 尺寸与体积", () => {
  test("4000×3000 噪声 PNG 压到最长边 2048 并输出 webp", async () => {
    const bytes = await noisePng(4000, 3000);
    const result = await normalizeSourceImage(bytes, "image/png");

    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe("image/webp");
    expect(result.width).toBe(2048);
    expect(result.height).toBe(1536);
    expect(result.originalBytes).toBe(bytes.length);
    const meta = await sharp(Buffer.from(result.bytes)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(1536);
  });

  test("最长边刚好等于上限、体积不超时不动", async () => {
    const bytes = await flatPng(2048, 100);
    const result = await normalizeSourceImage(bytes, "image/png");
    expect(result.changed).toBe(false);
    expect(result.width).toBe(2048);
  });

  test("自定义 maxDimension 生效且按 fit inside 等比缩放", async () => {
    const bytes = await flatPng(1000, 500);
    const result = await normalizeSourceImage(bytes, "image/png", { maxDimension: 400 });
    expect(result.changed).toBe(true);
    expect(result.width).toBe(400);
    expect(result.height).toBe(200);
  });

  test("质量阶梯足够时：输出 ≤ targetBytes，且与逐档直接编码逐字节一致（阶梯结果不因中间缓冲改变）", async () => {
    const bytes = await noisePng(1200, 900);
    const direct = await sharp(Buffer.from(bytes))
      .resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();
    // 目标略高于 q90 的产物：第一档就该命中，输出必须正是那一份。
    const targetBytes = direct.length + 1;

    const result = await normalizeSourceImage(bytes, "image/png", { maxDimension: 1000, targetBytes });
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe("image/webp");
    expect(result.width).toBe(1000);
    expect(result.height).toBe(750);
    expect(result.bytes.length <= targetBytes).toBe(true);
    expect(Buffer.from(result.bytes).equals(direct)).toBe(true);
  });

  test("阶梯到底仍超：尺寸缩到 1024 下限后返回所有候选里最小的一份", async () => {
    const bytes = await noisePng(1200, 900);
    // targetBytes = 1 永远达不到：1200 → 1024（下限）两档尺寸 × 4 档质量共 8 个候选，交出最小的。
    const result = await normalizeSourceImage(bytes, "image/png", { maxDimension: 1200, targetBytes: 1 });

    const dimensions = [1200, Math.max(sourceImageMinDimension, Math.floor(1200 * sourceImageShrinkRatio))];
    expect(dimensions[1]).toBe(1024);
    const candidates: number[] = [];
    for (const dimension of dimensions) {
      for (const quality of sourceImageQualitySteps) {
        const encoded = await sharp(Buffer.from(bytes))
          .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
          .webp({ quality })
          .toBuffer();
        candidates.push(encoded.length);
      }
    }
    expect(result.changed).toBe(true);
    expect(Math.max(result.width, result.height)).toBe(sourceImageMinDimension);
    expect(result.bytes.length).toBe(Math.min(...candidates));
    expect(result.bytes.length).toBeLessThan(bytes.length);
  });

  test("体积超目标但尺寸本来就小于 1024 时只走质量阶梯，不缩尺寸，返回最低质量档", async () => {
    const bytes = await noisePng(600, 400);
    const result = await normalizeSourceImage(bytes, "image/png", { targetBytes: 1 });
    const lowest = await sharp(Buffer.from(bytes))
      .webp({ quality: sourceImageQualitySteps[sourceImageQualitySteps.length - 1] })
      .toBuffer();
    expect(result.changed).toBe(true);
    expect(result.width).toBe(600);
    expect(result.height).toBe(400);
    expect(result.bytes.length).toBe(lowest.length);
  });
});

describe("normalizeSourceImage: 像素上限", () => {
  test("宽 × 高超过 maxPixels 直接拒绝（400），不进解码", async () => {
    const bytes = await flatPng(400, 300);
    const error = await normalizeSourceImage(bytes, "image/png", { maxPixels: 100_000 }).catch((caught: unknown) => caught);
    expect(error instanceof ImageValidationError).toBe(true);
    expect((error as ImageValidationError).status).toBe(400);
    expect((error as Error).message).toBe(pixelLimitMessage(100_000));
    expect((error as Error).message).toContain("图片像素过大");
  });

  test("刚好等于 maxPixels 放行", async () => {
    const bytes = await flatPng(400, 300);
    const result = await normalizeSourceImage(bytes, "image/png", { maxPixels: 120_000 });
    expect(result.width).toBe(400);
  });
});

describe("normalizeSourceImage: alpha / EXIF / 动图", () => {
  test("带 alpha 的 PNG 重编码后仍保留 alpha", async () => {
    const bytes = await noisePng(900, 700, 4);
    const result = await normalizeSourceImage(bytes, "image/png", { maxDimension: 512 });

    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe("image/webp");
    const meta = await sharp(Buffer.from(result.bytes)).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect(meta.width).toBe(512);
  });

  test("EXIF orientation=6 的 JPEG 转正：宽高对调且不再带 orientation", async () => {
    const jpeg = new Uint8Array(
      await sharp({ create: { width: 300, height: 100, channels: 3, background: "#ff8800" } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    );
    const before = await sharp(Buffer.from(jpeg)).metadata();
    expect(before.orientation).toBe(6);

    const result = await normalizeSourceImage(jpeg, "image/jpeg");
    expect(result.changed).toBe(true);
    expect(result.mimeType).toBe("image/webp");
    expect(result.width).toBe(100);
    expect(result.height).toBe(300);

    const after = await sharp(Buffer.from(result.bytes)).metadata();
    expect(after.width).toBe(100);
    expect(after.height).toBe(300);
    expect(after.orientation).toBe(undefined);
    expect(after.exif).toBe(undefined);
  });

  test("重编码时保留 ICC 色彩配置但不带 EXIF（keepIccProfile ≠ withMetadata）", async () => {
    const jpeg = new Uint8Array(
      await sharp({ create: { width: 3000, height: 100, channels: 3, background: "#ff8800" } })
        .jpeg()
        .withIccProfile("p3")
        .withExif({ IFD0: { Copyright: "canvas-realm-test" } })
        .toBuffer(),
    );
    const before = await sharp(Buffer.from(jpeg)).metadata();
    expect(before.icc?.length ?? 0).toBeGreaterThan(0);
    expect(before.exif?.length ?? 0).toBeGreaterThan(0);

    const result = await normalizeSourceImage(jpeg, "image/jpeg");
    expect(result.changed).toBe(true);
    expect(result.width).toBe(2048);

    const after = await sharp(Buffer.from(result.bytes)).metadata();
    expect(after.icc?.length).toBe(before.icc?.length);
    expect(after.exif).toBe(undefined);
  });

  test("直通路径不重编码：orientation=1 且尺寸 / 体积不超的 JPEG 原字节返回，EXIF 原样保留", async () => {
    const jpeg = new Uint8Array(
      await sharp({ create: { width: 300, height: 100, channels: 3, background: "#ff8800" } })
        .jpeg()
        .withExif({ IFD0: { Copyright: "canvas-realm-test" }, IFD3: { GPSLatitudeRef: "N" } })
        .toBuffer(),
    );
    const before = await sharp(Buffer.from(jpeg)).metadata();
    expect(before.exif?.length ?? 0).toBeGreaterThan(0);
    expect(before.orientation ?? 1).toBe(1);

    const result = await normalizeSourceImage(jpeg, "image/jpeg");
    expect(result.changed).toBe(false);
    expect(result.bytes).toBe(jpeg);
    expect(result.mimeType).toBe("image/jpeg");

    const after = await sharp(Buffer.from(result.bytes)).metadata();
    expect(after.exif?.length).toBe(before.exif?.length);
    expect(Buffer.from(result.bytes).includes("canvas-realm-test")).toBe(true);
  });

  test("动图只取首帧", async () => {
    const frame = (color: string) => sharp({ create: { width: 120, height: 80, channels: 3, background: color } }).png().toBuffer();
    const animated = new Uint8Array(
      await sharp([await frame("#ff0000"), await frame("#00ff00")], { join: { animated: true } })
        .webp()
        .toBuffer(),
    );
    const before = await sharp(Buffer.from(animated), { animated: true }).metadata();
    expect(before.pages).toBe(2);

    const result = await normalizeSourceImage(animated, "image/webp");
    expect(result.changed).toBe(true);
    expect(result.width).toBe(120);
    expect(result.height).toBe(80);
    const after = await sharp(Buffer.from(result.bytes), { animated: true }).metadata();
    expect(after.pages ?? 1).toBe(1);
    expect(after.height).toBe(80);
  });
});

describe("normalizeSourceImage: 损坏输入", () => {
  test("解析不了的字节抛 ImageValidationError(400)", async () => {
    const junk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const error = await normalizeSourceImage(junk, "image/png").catch((caught: unknown) => caught);
    expect(error instanceof ImageValidationError).toBe(true);
    expect((error as ImageValidationError).status).toBe(400);
    expect((error as Error).message).toBe("图片文件损坏或无法解析");
  });
});
