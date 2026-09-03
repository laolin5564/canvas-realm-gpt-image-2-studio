import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { ImageValidationError } from "@/lib/storage";
import {
  contentLengthExceeds,
  detectImageMime,
  prepareSourceImage,
  sourceImageNormalizeMaxInflight,
  sourceImageNormalizeSemaphore,
  SourceImageTooLargeError,
  sourceImageTooLargeMessage,
  sourceImageUploadHeadroom,
  withSourceImageNormalizeSlot,
} from "@/lib/source-image-upload";
import { maxSourceImageUploadBytes } from "@/lib/validation";

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

async function flatPng(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 140, b: 90 } } })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

describe("contentLengthExceeds：读 body 前的 Content-Length 预检", () => {
  const limit = maxSourceImageUploadBytes;
  const ceiling = Math.ceil(limit * sourceImageUploadHeadroom);

  test("30MB × 1.05 以内放行，超过拦下", () => {
    expect(contentLengthExceeds(String(limit), limit)).toBe(false);
    expect(contentLengthExceeds(String(ceiling), limit)).toBe(false);
    expect(contentLengthExceeds(String(ceiling + 1), limit)).toBe(true);
    expect(contentLengthExceeds(String(500 * 1024 * 1024), limit)).toBe(true);
  });

  test("缺少 / 非法的 Content-Length 不拦，交给现有路径", () => {
    expect(contentLengthExceeds(null, limit)).toBe(false);
    expect(contentLengthExceeds(undefined, limit)).toBe(false);
    expect(contentLengthExceeds("", limit)).toBe(false);
    expect(contentLengthExceeds("abc", limit)).toBe(false);
    expect(contentLengthExceeds("-1", limit)).toBe(false);
  });
});

describe("detectImageMime", () => {
  test("按魔数识别 png / jpeg / webp，其余 null", async () => {
    expect(detectImageMime(await flatPng(4, 4))).toBe("image/png");
    const jpeg = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } }).jpeg().toBuffer());
    expect(detectImageMime(jpeg)).toBe("image/jpeg");
    const webp = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } }).webp().toBuffer());
    expect(detectImageMime(webp)).toBe("image/webp");
    expect(detectImageMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBe(null);
  });
});

describe("prepareSourceImage：上限 → 魔数 → 归一化", () => {
  test("超过 30MB 抛 SourceImageTooLargeError（413，文案含 30 MB）", async () => {
    const bytes = new Uint8Array(maxSourceImageUploadBytes + 1);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const error = await prepareSourceImage({ bytes, mimeType: "image/png", originalName: "big.png" }).catch((caught: unknown) => caught);
    expect(error instanceof SourceImageTooLargeError).toBe(true);
    expect(error instanceof ImageValidationError).toBe(true);
    expect((error as SourceImageTooLargeError).status).toBe(413);
    expect((error as Error).message).toBe(sourceImageTooLargeMessage);
    expect((error as Error).message).toContain("30 MB");
  });

  test("刚好 30MB 不算超限（走到魔数校验）", async () => {
    const bytes = new Uint8Array(maxSourceImageUploadBytes);
    const error = await prepareSourceImage({ bytes, mimeType: "image/png", originalName: null }).catch((caught: unknown) => caught);
    expect(error instanceof SourceImageTooLargeError).toBe(false);
    expect(error instanceof ImageValidationError).toBe(true);
    expect((error as Error).message).toBe("图片内容与文件类型不匹配");
  });

  test("空内容 / 类型不支持 / 魔数不符都是 400 的 ImageValidationError", async () => {
    const empty = await prepareSourceImage({ bytes: new Uint8Array(0), mimeType: "image/png", originalName: null }).catch((caught: unknown) => caught);
    expect(empty instanceof ImageValidationError).toBe(true);
    expect((empty as Error).message).toBe("参考图内容为空");

    const gif = await prepareSourceImage({ bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), mimeType: "image/gif", originalName: null }).catch((caught: unknown) => caught);
    expect(gif instanceof ImageValidationError).toBe(true);
    expect((gif as Error).message).toBe("仅支持 PNG、JPG、WEBP 图片");
  });

  test("客户端没给类型时按魔数兜底；PNG 头 + 垃圾字节 → 「图片文件损坏或无法解析」", async () => {
    const junk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const error = await prepareSourceImage({ bytes: junk, mimeType: null, originalName: null }).catch((caught: unknown) => caught);
    expect(error instanceof ImageValidationError).toBe(true);
    expect((error as ImageValidationError).status).toBe(400);
    expect((error as Error).message).toBe("图片文件损坏或无法解析");
  });

  test("合法小图直通并带回 originalName 与真实宽高", async () => {
    const bytes = await flatPng(640, 480);
    const prepared = await prepareSourceImage({ bytes, mimeType: "", originalName: "photo.png" });
    expect(prepared.changed).toBe(false);
    expect(prepared.mimeType).toBe("image/png");
    expect(prepared.width).toBe(640);
    expect(prepared.height).toBe(480);
    expect(prepared.originalName).toBe("photo.png");
  });
});

describe("归一化信号量：进程内最多 2 张并行", () => {
  test("withSourceImageNormalizeSlot：第 3、4 个调用排队，前面释放后才进入", async () => {
    const semaphore = sourceImageNormalizeSemaphore();
    expect(semaphore.maxConcurrency).toBe(sourceImageNormalizeMaxInflight);
    expect(sourceImageNormalizeMaxInflight).toBe(2);

    const resolvers: Array<() => void> = [];
    const started: number[] = [];
    const jobs = [0, 1, 2, 3].map((index) =>
      withSourceImageNormalizeSlot(
        () =>
          new Promise<number>((resolve) => {
            started.push(index);
            resolvers.push(() => resolve(index));
          }),
      ),
    );

    // 槽位是同步占的；operation 本身在 acquire 的 await 之后才跑，flush 一次微任务再看。
    expect(semaphore.activeCount).toBe(2);
    expect(semaphore.pendingCount).toBe(2);
    await flushMicrotasks();
    expect(started.join(",")).toBe("0,1");

    resolvers[0]();
    await jobs[0];
    await flushMicrotasks();
    expect(started.join(",")).toBe("0,1,2");
    expect(semaphore.activeCount).toBe(2);
    expect(semaphore.pendingCount).toBe(1);

    resolvers[1]();
    resolvers[2]();
    await Promise.all([jobs[1], jobs[2]]);
    await flushMicrotasks();
    expect(started.join(",")).toBe("0,1,2,3");
    resolvers[3]();
    await jobs[3];
    expect(semaphore.activeCount).toBe(0);
    expect(semaphore.pendingCount).toBe(0);
  });

  test("prepareSourceImage 同步占槽：4 张需要重编码的图同时到达时只有 2 张在归一化", async () => {
    const semaphore = sourceImageNormalizeSemaphore();
    const bytes = await flatPng(2600, 1800);
    const jobs = [0, 1, 2, 3].map(() => prepareSourceImage({ bytes, mimeType: "image/png", originalName: null }));
    expect(semaphore.activeCount).toBe(2);
    expect(semaphore.pendingCount).toBe(2);

    const results = await Promise.all(jobs);
    expect(results.every((item) => item.changed && item.width === 2048)).toBe(true);
    expect(semaphore.activeCount).toBe(0);
    expect(semaphore.pendingCount).toBe(0);
  });
});
