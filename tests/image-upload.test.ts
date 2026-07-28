import assert from "node:assert/strict";
import { describe, test } from "node:test";
import sharp from "sharp";
import { fitReferenceImagesToBudget } from "../lib/image-upload";

describe("reference image upload budget", () => {
  test("keeps small source images unchanged", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await fitReferenceImagesToBudget(
      [{ bytes, mimeType: "image/png", fileName: "small.png" }],
      10,
    );

    assert.equal(result[0]?.bytes, bytes);
    assert.equal(result[0]?.fileName, "small.png");
  });

  test("converts an oversized reference image below the gateway budget", async () => {
    const width = 800;
    const height = 800;
    const pixels = Buffer.alloc(width * height * 3);
    let state = 0x12345678;
    for (let index = 0; index < pixels.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[index] = state & 0xff;
    }
    const oversizedPng = await sharp(pixels, {
      raw: { width, height, channels: 3 },
    }).png().toBuffer();

    const maxBytes = 300_000;
    assert.ok(oversizedPng.byteLength > maxBytes);

    const result = await fitReferenceImagesToBudget(
      [{ bytes: oversizedPng, mimeType: "image/png", fileName: "large.png" }],
      maxBytes,
    );

    assert.equal(result.length, 1);
    assert.equal(result[0]?.mimeType, "image/webp");
    assert.equal(result[0]?.fileName, "large.webp");
    assert.ok((result[0]?.bytes.byteLength ?? Infinity) <= maxBytes);
  });
});
