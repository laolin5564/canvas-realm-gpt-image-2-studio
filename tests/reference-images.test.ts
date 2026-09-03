import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { UpstreamImageError } from "@/lib/image-retry";

// 先把存储目录指到临时目录再动态 import：lib/config.ts 在 import 时读 env。
const tempRoot = path.join(
  process.env.TMPDIR ?? "/tmp",
  `image-provider-references-${process.pid}-${Date.now()}`,
);
process.env.IMAGE_STORAGE_DIR ??= tempRoot;

type ProviderModule = typeof import("@/lib/reference-images");
type ConfigModule = typeof import("@/lib/config");

let provider: ProviderModule;
let config: ConfigModule;
// 实际使用的存储根目录（若 config 已被别的测试文件先加载，就落到它已解析好的目录里）。
let fixtureDir = "";
let fixtureRelativeDir = "";

async function makeNoisePng(width: number, height: number, seed: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  let state = seed;
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[index] = state & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

const fixtureNames = ["ref-a.png", "ref-b.png"];

beforeAll(async () => {
  config = await import("@/lib/config");
  provider = await import("@/lib/reference-images");
  fixtureRelativeDir = `test-shrink-${process.pid}-${Date.now()}`;
  fixtureDir = path.join(config.appConfig.imageStorageDir, fixtureRelativeDir);
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, fixtureNames[0]), await makeNoisePng(700, 700, 0x1234_5678));
  await writeFile(path.join(fixtureDir, fixtureNames[1]), await makeNoisePng(600, 600, 0x9e37_79b9));
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
  await rm(tempRoot, { recursive: true, force: true });
});

function fixturePaths(): string[] {
  return fixtureNames.map((name) => `${fixtureRelativeDir}/${name}`);
}

function total(images: Array<{ bytes: Uint8Array }>): number {
  return images.reduce((sum, image) => sum + image.bytes.byteLength, 0);
}

describe("createReferenceImageLoader.shrink", () => {
  test("shrink 后 forUpload 总字节数 ≤ 之前的一半，张数不变", async () => {
    const loader = provider.createReferenceImageLoader(fixturePaths());
    const before = await loader.forUpload();
    const beforeBytes = total(before);
    expect(before.length).toBe(2);
    // 噪声 PNG 约 1.5MB + 1.1MB，在默认 15MB 总预算 / 4MB 单张上限内，首轮不会被压。
    expect(beforeBytes > 4 * 256 * 1024).toBe(true);

    expect(await loader.shrink()).toBe(true);

    const after = await loader.forUpload();
    expect(after.length).toBe(2);
    expect(loader.count).toBe(2);
    expect(total(after) <= Math.floor(beforeBytes / 2)).toBe(true);
    expect(after.every((image) => image.mimeType === "image/webp")).toBe(true);
    // raw() 不受影响，仍是原图。
    expect(total(await loader.raw())).toBe(beforeBytes);
  });

  test("连续 shrink 到下限后返回 false，且不回弹", async () => {
    const loader = provider.createReferenceImageLoader(fixturePaths());
    const floor = 256 * 1024 * loader.count;

    let rounds = 0;
    let lastTrueBytes = total(await loader.forUpload());
    while (await loader.shrink()) {
      rounds += 1;
      const current = total(await loader.forUpload());
      expect(current < lastTrueBytes).toBe(true);
      lastTrueBytes = current;
      expect(rounds < 10).toBe(true);
    }

    expect(rounds >= 1).toBe(true);
    // 停下来的原因：再减半就低于下限（每张 256KB）。
    expect(Math.floor(lastTrueBytes / 2) < floor).toBe(true);
    // 返回 false 之后 forUpload 仍是最后一次成功收缩的结果。
    expect(total(await loader.forUpload())).toBe(lastTrueBytes);
    expect(await loader.shrink()).toBe(false);
    expect(total(await loader.forUpload())).toBe(lastTrueBytes);
  });

  test("并发调用 shrink 共用同一次收缩", async () => {
    const loader = provider.createReferenceImageLoader(fixturePaths());
    const beforeBytes = total(await loader.forUpload());

    const results = await Promise.all([loader.shrink(), loader.shrink(), loader.shrink()]);

    expect(results.join(",")).toBe("true,true,true");
    const afterBytes = total(await loader.forUpload());
    // 只砍了一刀：仍然高于 1/4，不会被并发连砍三次。
    expect(afterBytes > Math.floor(beforeBytes / 4)).toBe(true);
    expect(afterBytes <= Math.floor(beforeBytes / 2)).toBe(true);
  });

  test("没有参考图时 shrink 返回 false", async () => {
    const loader = provider.createReferenceImageLoader([]);
    expect(await loader.shrink()).toBe(false);
    expect((await loader.forUpload()).length).toBe(0);
  });
});

function fakeLoader(shrinkResults: boolean[]): {
  loader: import("@/lib/reference-images").ReferenceImageLoader;
  shrinkCalls: () => number;
} {
  let calls = 0;
  return {
    loader: {
      raw: async () => [],
      forUpload: async () => [],
      shrink: async () => {
        const result = shrinkResults[calls] ?? false;
        calls += 1;
        return result;
      },
      count: 1,
    },
    shrinkCalls: () => calls,
  };
}

describe("sendWithPayloadTooLargeFallback", () => {
  test("413 且 shrink 成功：同渠道立即重发一次", async () => {
    const { loader, shrinkCalls } = fakeLoader([true]);
    let sends = 0;

    const result = await provider.sendWithPayloadTooLargeFallback(loader, async () => {
      sends += 1;
      if (sends === 1) {
        throw new UpstreamImageError("参考图太大", 413);
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(sends).toBe(2);
    expect(shrinkCalls()).toBe(1);
  });

  test("413 但 shrink 失败：原样上抛，不重发", async () => {
    const { loader, shrinkCalls } = fakeLoader([false]);
    let sends = 0;
    let failure: unknown = null;

    try {
      await provider.sendWithPayloadTooLargeFallback(loader, async () => {
        sends += 1;
        throw new UpstreamImageError("参考图太大", 413);
      });
    } catch (error) {
      failure = error;
    }

    expect(sends).toBe(1);
    expect(shrinkCalls()).toBe(1);
    expect((failure as UpstreamImageError).status).toBe(413);
  });

  test("重发仍 413：只重发一次，第二个 413 上抛", async () => {
    const { loader, shrinkCalls } = fakeLoader([true, true]);
    let sends = 0;
    let failure: unknown = null;

    try {
      await provider.sendWithPayloadTooLargeFallback(loader, async () => {
        sends += 1;
        throw new UpstreamImageError(`第 ${sends} 次 413`, 413);
      });
    } catch (error) {
      failure = error;
    }

    expect(sends).toBe(2);
    expect(shrinkCalls()).toBe(1);
    expect((failure as Error).message).toBe("第 2 次 413");
  });

  test("非 413 错误不碰 shrink，直接上抛", async () => {
    const { loader, shrinkCalls } = fakeLoader([true]);
    let sends = 0;
    let failure: unknown = null;

    try {
      await provider.sendWithPayloadTooLargeFallback(loader, async () => {
        sends += 1;
        throw new UpstreamImageError("模型服务暂时不可用（503）", 503);
      });
    } catch (error) {
      failure = error;
    }

    expect(sends).toBe(1);
    expect(shrinkCalls()).toBe(0);
    expect((failure as UpstreamImageError).status).toBe(503);
  });
});

describe("describeReferencePayload", () => {
  test("按 MB 描述本次参考图体积", () => {
    expect(provider.describeReferencePayload(1_887_437)).toBe("本次参考图合计约 1.8 MB");
    expect(provider.describeReferencePayload(12 * 1024 * 1024)).toBe("本次参考图合计约 12 MB");
    expect(provider.describeReferencePayload(0)).toBe("本次参考图合计约 0.0 MB");
  });
});
