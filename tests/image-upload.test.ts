import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { fitReferenceImagesToBudget, type ReferenceImageUpload } from "@/lib/image-upload";

/** 伪随机噪声图：几乎压不动，PNG 体积随尺寸线性增长，适合造「超大参考图」。 */
async function makeNoisePng(width: number, height: number, seed = 0x12345678): Promise<Uint8Array> {
  const pixels = Buffer.alloc(width * height * 3);
  let state = seed;
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state & 0xff;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return new Uint8Array(png);
}

/** 极低质量的小 JPEG：任何档位转成 webp 都只会更大。 */
async function makeTinyJpeg(): Promise<Uint8Array> {
  const pixels = Buffer.alloc(64 * 64 * 3);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = (index * 7) & 0xff;
  }
  const jpeg = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } })
    .jpeg({ quality: 1 })
    .toBuffer();
  return new Uint8Array(jpeg);
}

function upload(bytes: Uint8Array, fileName: string, mimeType = "image/png"): ReferenceImageUpload {
  return { bytes, mimeType, fileName };
}

function total(images: ReferenceImageUpload[]): number {
  return images.reduce((sum, image) => sum + image.bytes.byteLength, 0);
}

describe("参考图上传预算", () => {
  test("总量不超预算、单张不超上限：原样返回，字节引用不变", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await fitReferenceImagesToBudget([upload(bytes, "small.png")], 10, { maxImageBytes: 5 });

    expect(result[0]?.bytes).toBe(bytes);
    expect(result[0]?.fileName).toBe("small.png");
  });

  test("没传 maxImageBytes 时只看总量（旧行为）", async () => {
    const big = await makeNoisePng(400, 400);
    const result = await fitReferenceImagesToBudget([upload(big, "big.png")], big.byteLength + 1);

    expect(result[0]?.bytes).toBe(big);
  });

  test("总量超预算时整体压缩到预算内并转成 webp", async () => {
    const oversizedPng = await makeNoisePng(800, 800);
    const maxBytes = 300_000;
    expect(oversizedPng.byteLength > maxBytes).toBe(true);

    const result = await fitReferenceImagesToBudget([upload(oversizedPng, "large.png")], maxBytes);

    expect(result.length).toBe(1);
    expect(result[0]?.mimeType).toBe("image/webp");
    expect(result[0]?.fileName).toBe("large.webp");
    expect((result[0]?.bytes.byteLength ?? Infinity) <= maxBytes).toBe(true);
  });

  test("单张超上限时只压那一张，其余小图字节引用不变", async () => {
    const big = await makeNoisePng(800, 800);
    const small = await makeNoisePng(64, 64, 0x9e3779b9);
    const maxImageBytes = 400_000;
    expect(big.byteLength > maxImageBytes).toBe(true);
    expect(small.byteLength < maxImageBytes).toBe(true);

    const result = await fitReferenceImagesToBudget(
      [upload(big, "big.png"), upload(small, "small.png")],
      50_000_000,
      { maxImageBytes },
    );

    expect(result.length).toBe(2);
    expect(result[0]?.mimeType).toBe("image/webp");
    expect(result[0]?.fileName).toBe("big.webp");
    expect((result[0]?.bytes.byteLength ?? Infinity) <= maxImageBytes).toBe(true);
    expect(result[1]?.bytes).toBe(small);
    expect(result[1]?.fileName).toBe("small.png");
  });

  test("逐张压完总量仍超预算时，再整体压缩", async () => {
    const first = await makeNoisePng(800, 800, 0x1111);
    const second = await makeNoisePng(800, 800, 0x2222);
    const maxImageBytes = 1_000_000;
    const maxTotalBytes = 400_000;

    const result = await fitReferenceImagesToBudget(
      [upload(first, "a.png"), upload(second, "b.png")],
      maxTotalBytes,
      { maxImageBytes },
    );

    expect(result.length).toBe(2);
    expect(total(result) <= maxTotalBytes).toBe(true);
    expect(result.every((image) => image.mimeType === "image/webp")).toBe(true);
  });

  test("档位不放大：转 webp 反而变大的小图保留原图", async () => {
    const big = await makeNoisePng(800, 800);
    const tiny = await makeTinyJpeg();
    const webpOfTiny = await sharp(Buffer.from(tiny)).webp({ quality: 90 }).toBuffer();
    expect(webpOfTiny.byteLength > tiny.byteLength).toBe(true);

    const result = await fitReferenceImagesToBudget(
      [upload(big, "big.png"), upload(tiny, "tiny.jpg", "image/jpeg")],
      big.byteLength - 1,
    );

    expect(result[0]?.mimeType).toBe("image/webp");
    expect(result[1]?.bytes).toBe(tiny);
    expect(result[1]?.mimeType).toBe("image/jpeg");
    expect(result[1]?.fileName).toBe("tiny.jpg");
  });

  test("所有档位都压不进预算时抛出可识别的错误", async () => {
    const big = await makeNoisePng(800, 800);
    let message = "";
    try {
      await fitReferenceImagesToBudget([upload(big, "big.png")], 100);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message.includes("参考图压缩后仍超过网关限制")).toBe(true);
  });
});
