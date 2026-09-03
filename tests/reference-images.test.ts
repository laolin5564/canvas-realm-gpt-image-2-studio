import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { UpstreamImageError } from "@/lib/image-retry";

// lib/config.ts 在 import 时读 env：存储目录、上传预算都先显式定死再动态 import，
// 下面的字节数断言全部依赖「总预算 15MB / 单张 4MB」这两个数。
const tempRoot = path.join(
  process.env.TMPDIR ?? "/tmp",
  `image-provider-references-${process.pid}-${Date.now()}`,
);
process.env.IMAGE_STORAGE_DIR = tempRoot;
process.env.SUB2API_MAX_UPLOAD_BYTES = "15000000";
process.env.SUB2API_MAX_IMAGE_BYTES = "4000000";

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
  // 别的测试文件若先加载了 config，这两个数也必须是默认值，否则下面的预算断言没意义。
  expect(config.appConfig.sub2apiMaxUploadBytes).toBe(15_000_000);
  expect(config.appConfig.sub2apiMaxImageBytes).toBe(4_000_000);
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
    // 噪声 PNG 约 1.5MB + 1.1MB，在默认 15MB 总预算 / 4MB 单张上限内，首轮不会被压：
    // forUpload 给的就是 raw() 同一个数组，仍是 PNG。
    expect(beforeBytes > 4 * 256 * 1024).toBe(true);
    expect(before).toBe(await loader.raw());
    expect(before.every((image) => image.mimeType === "image/png")).toBe(true);

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
    const after = await loader.forUpload();
    expect(total(after) <= Math.floor(beforeBytes / 2)).toBe(true);
    // 和「同样的图只 shrink 一次」逐张比对字节：完全相等才说明并发三次只砍了一刀，
    // 不靠 webp 编码结果碰巧落在哪个阈值上。
    const single = provider.createReferenceImageLoader(fixturePaths());
    expect(await single.shrink()).toBe(true);
    const singleAfter = await single.forUpload();
    expect(after.map((image) => image.bytes.byteLength).join(",")).toBe(
      singleAfter.map((image) => image.bytes.byteLength).join(","),
    );
    // 三个并发调用之后 forUpload 仍是同一个数组，没有被后到的调用再换一次。
    expect(await loader.forUpload()).toBe(after);
  });

  test("A 先 413 并 shrink 完成后 B 才 413：B 直接复用已缩小的结果，不再二次减半", async () => {
    const loader = provider.createReferenceImageLoader(fixturePaths());
    // A、B 在排队前都拿到了同一份体积 S 的参考图。
    const sentBytes = total(await loader.forUpload());

    // A 先吃到 413，按 S 收缩一次。
    expect(await loader.shrink(sentBytes)).toBe(true);
    const afterA = await loader.forUpload();
    expect(total(afterA) < sentBytes).toBe(true);

    // B 带着过期的 S 表单吃到 413：当前体积已经比它发出的小，直接返回 true，forUpload 保持同一个数组。
    expect(await loader.shrink(sentBytes)).toBe(true);
    expect(await loader.forUpload()).toBe(afterA);
    expect(await loader.shrink(sentBytes + 1)).toBe(true);
    expect(await loader.forUpload()).toBe(afterA);

    // 拿着缩小后的表单再吃 413 才是真的要再砍一刀（这里体积已接近下限，允许 false，但不能回弹）。
    const currentBytes = total(afterA);
    const shrunkAgain = await loader.shrink(currentBytes);
    const latest = await loader.forUpload();
    if (shrunkAgain) {
      expect(total(latest) < currentBytes).toBe(true);
    } else {
      expect(latest).toBe(afterA);
    }
  });

  test("没传 sentBytes 时行为不变：每次调用都按当前体积减半", async () => {
    const loader = provider.createReferenceImageLoader(fixturePaths());
    const before = total(await loader.forUpload());
    expect(await loader.shrink()).toBe(true);
    const afterFirst = total(await loader.forUpload());
    expect(afterFirst <= Math.floor(before / 2)).toBe(true);
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

describe("sendWithPayloadTooLargeFallback + 真实参考图", () => {
  test("413 后第二次 send 拿到的是缩小后的参考图数组，而不是第一次的引用", async () => {
    const loader = provider.createReferenceImageLoader(fixturePaths());
    const sends: Array<{ bytes: number; images: Array<{ bytes: Uint8Array; mimeType: string }> }> = [];

    const result = await provider.sendWithPayloadTooLargeFallback(loader, async (uploadImages) => {
      sends.push({ bytes: total(uploadImages), images: uploadImages });
      if (sends.length === 1) {
        throw new UpstreamImageError("参考图太大", 413);
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(sends.length).toBe(2);
    expect(sends[0]?.images).toBe(await loader.raw());
    expect(sends[1]?.images === sends[0]?.images).toBe(false);
    expect((sends[1]?.bytes ?? Infinity) <= Math.floor((sends[0]?.bytes ?? 0) / 2)).toBe(true);
    expect(sends[1]?.images.every((image) => image.mimeType === "image/webp")).toBe(true);
    expect(sends[1]?.images).toBe(await loader.forUpload());
  });

  test("A 先 413 并重发成功后，排队中的 B 才用过期大表单吃到 413：B 复用 A 缩小后的那份重发", async () => {
    const loader = provider.createReferenceImageLoader(fixturePaths());
    const sentA: number[] = [];
    const sentB: Array<{ bytes: number; images: unknown }> = [];
    let releaseB: () => void = () => {};
    const bMayFail = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const runA = provider.sendWithPayloadTooLargeFallback(loader, async (uploadImages) => {
      sentA.push(total(uploadImages));
      if (sentA.length === 1) {
        throw new UpstreamImageError("A 413", 413);
      }
      return "A ok";
    });
    const runB = provider.sendWithPayloadTooLargeFallback(loader, async (uploadImages) => {
      sentB.push({ bytes: total(uploadImages), images: uploadImages });
      if (sentB.length === 1) {
        // B 排在 A 后面拿到槽位：等 A 整个 413→shrink→重发 跑完再报 413。
        await bMayFail;
        throw new UpstreamImageError("B 413", 413);
      }
      return "B ok";
    });

    expect(await runA).toBe("A ok");
    releaseB();
    expect(await runB).toBe("B ok");

    expect(sentA.length).toBe(2);
    expect(sentB.length).toBe(2);
    // B 第一次发的就是过期的原始体积；第二次直接拿 A 缩小后的同一个数组，没有再砍一刀。
    expect(sentB[0]?.bytes).toBe(sentA[0]);
    expect(sentB[1]?.bytes).toBe(sentA[1]);
    expect(sentB[1]?.images).toBe(await loader.forUpload());
  });
});

describe("buildImageEditForm / formatUpstreamErrorDetail", () => {
  test("表单带上全部参考图与字段，空的可选字段不出现", async () => {
    const images = [
      { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", fileName: "a.png" },
      { bytes: new Uint8Array([4, 5]), mimeType: "image/webp", fileName: "b.webp" },
    ];
    const form = provider.buildImageEditForm(images, {
      model: "gpt-image-2",
      prompt: "换背景",
      n: 2,
      size: "1024x1024",
      quality: null,
      inputFidelity: "high",
    });

    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("换背景");
    expect(form.get("n")).toBe("2");
    expect(form.get("size")).toBe("1024x1024");
    expect(form.has("quality")).toBe(false);
    expect(form.get("input_fidelity")).toBe("high");
    const files = form.getAll("image") as File[];
    expect(files.length).toBe(2);
    expect(files.map((file) => file.name).join(",")).toBe("a.png,b.webp");
    expect(files.map((file) => file.type).join(",")).toBe("image/png,image/webp");
    expect(new Uint8Array(await files[1]!.arrayBuffer()).join(",")).toBe("4,5");
  });

  test("413 的管理员详情追加本次参考图体积，其余状态不追加", () => {
    const tooLarge = provider.formatUpstreamErrorDetail(413, "413 Request Entity Too Large", "image edit failed", 1_887_437);
    expect(tooLarge).toContain("参考图请求体过大（413）");
    expect(tooLarge).toContain("本次参考图合计约 1.8 MB");

    const serverError = provider.formatUpstreamErrorDetail(503, "upstream down", "image edit failed", 1_887_437);
    expect(serverError).toContain("模型服务暂时不可用（503）");
    expect(serverError.includes("本次参考图合计")).toBe(false);
    expect(provider.formatUpstreamErrorDetail(413, "", "image edit failed").includes("本次参考图合计")).toBe(false);
  });
});

describe("describeReferencePayload", () => {
  test("按 MB 描述本次参考图体积", () => {
    expect(provider.describeReferencePayload(1_887_437)).toBe("本次参考图合计约 1.8 MB");
    expect(provider.describeReferencePayload(12 * 1024 * 1024)).toBe("本次参考图合计约 12 MB");
    expect(provider.describeReferencePayload(0)).toBe("本次参考图合计约 0.0 MB");
  });
});
