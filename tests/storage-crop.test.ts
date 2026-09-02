import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { fitImageToTargetRatio, RATIO_TOLERANCE } from "@/lib/storage";
import { ratioForOption } from "@/lib/image-options";

async function makePng(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

describe("落图时按目标比例裁切", () => {
  test("上游返回方图、目标 3:4 时按比例居中裁切", async () => {
    // 上游实际返回约 1254px 方图，并不严格遵守 size。
    const bytes = await makePng(1254, 1254);
    const result = await fitImageToTargetRatio(bytes, ratioForOption("xhs_cover_3_4"));

    expect(result.height).toBe(1254);
    expect(result.width).toBe(941);
    expect(Math.abs(result.width / result.height - 3 / 4)).toBeLessThan(3 / 4 * RATIO_TOLERANCE);
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });

  test("横图裁到 16:9 时裁高不裁宽", async () => {
    const bytes = await makePng(1000, 1000);
    const result = await fitImageToTargetRatio(bytes, { width: 16, height: 9 });

    expect(result.width).toBe(1000);
    expect(result.height).toBe(563);
  });

  test("竖图裁到 9:16", async () => {
    const bytes = await makePng(1200, 1200);
    const result = await fitImageToTargetRatio(bytes, ratioForOption("douyin_cover_9_16"));

    expect(result.height).toBe(1200);
    expect(result.width).toBe(675);
  });

  test("比例偏差在 2% 以内时不裁切，只回报真实像素", async () => {
    const bytes = await makePng(1010, 1000);
    const result = await fitImageToTargetRatio(bytes, { width: 1, height: 1 });

    expect(result.width).toBe(1010);
    expect(result.height).toBe(1000);
    expect(result.bytes).toBe(bytes);
  });

  test("auto（比例为 0）不裁切，但仍返回真实像素", async () => {
    const bytes = await makePng(1254, 836);
    const result = await fitImageToTargetRatio(bytes, ratioForOption("auto"));

    expect(result.width).toBe(1254);
    expect(result.height).toBe(836);
    expect(result.bytes).toBe(bytes);
  });

  test("不传目标比例时只读像素", async () => {
    const bytes = await makePng(321, 123);
    const result = await fitImageToTargetRatio(bytes);

    expect(result.width).toBe(321);
    expect(result.height).toBe(123);
    expect(result.bytes).toBe(bytes);
  });

  test("解码失败时退回原始字节，尺寸标记为 0", async () => {
    const result = await fitImageToTargetRatio(new Uint8Array([1, 2, 3, 4]), { width: 1, height: 1 });

    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
    expect(result.bytes.byteLength).toBe(4);
  });

  test("裁切后仍然是可解码的 PNG", async () => {
    const bytes = await makePng(1254, 1254);
    const result = await fitImageToTargetRatio(bytes, { width: 235, height: 100 });
    const metadata = await sharp(Buffer.from(result.bytes)).metadata();

    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(result.width);
    expect(metadata.height).toBe(result.height);
    expect(result.width).toBe(1254);
    expect(result.height).toBe(534);
  });
});
