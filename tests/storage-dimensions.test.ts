import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// lib/config.ts 在 import 时读 env：存储目录要先定死再动态 import，静态 import 会先于赋值执行。
const tempRoot = path.join(
  process.env.TMPDIR ?? "/tmp",
  `storage-dimensions-${process.pid}-${Date.now()}`,
);
process.env.IMAGE_STORAGE_DIR = tempRoot;

type StorageModule = typeof import("@/lib/storage");
type ConfigModule = typeof import("@/lib/config");

let storage: StorageModule;
let config: ConfigModule;
// 别的测试文件可能先加载过 config，落盘断言一律以它解析好的目录为准，收尾也照这个删。
const savedPaths: string[] = [];

async function makePng(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

async function save(imageId: string, bytes: Uint8Array): Promise<{ relativePath: string; width: number; height: number }> {
  const saved = await storage.saveGeneratedImageFile({
    taskId: `task_storage_dimensions_${process.pid}`,
    imageId,
    bytes,
    mimeType: "image/png",
  });
  savedPaths.push(saved.relativePath);
  return saved;
}

beforeAll(async () => {
  config = await import("@/lib/config");
  storage = await import("@/lib/storage");
});

afterAll(async () => {
  for (const relativePath of savedPaths) {
    await storage.deleteStorageFile(relativePath);
  }
  await rm(tempRoot, { recursive: true, force: true });
});

describe("落图只读像素、不裁切", () => {
  async function expectDimensions(bytes: Uint8Array, width: number, height: number): Promise<void> {
    const size = await storage.readImageDimensions(bytes);
    expect(size.width).toBe(width);
    expect(size.height).toBe(height);
  }

  test("上游返回方图、档位是 3:4 时也一刀不切", async () => {
    // 线上根因：上游把整幅画布当成完整作品构图，按档位裁切会切掉分镜编号和标题。
    await expectDimensions(await makePng(1254, 1254), 1254, 1254);
  });

  test("非常规比例的原生画布照样只回报真实像素", async () => {
    await expectDimensions(await makePng(1024, 1536), 1024, 1536);
    await expectDimensions(await makePng(1806, 871), 1806, 871);
    await expectDimensions(await makePng(1086, 1448), 1086, 1448);
  });

  test("解码失败时返回 0×0，不抛错", async () => {
    await expectDimensions(new Uint8Array([1, 2, 3, 4]), 0, 0);
  });

  test("saveGeneratedImageFile 落盘的字节与上游字节完全一致", async () => {
    const bytes = await makePng(1254, 1254);
    const saved = await save("img_no_crop", bytes);

    expect(saved.width).toBe(1254);
    expect(saved.height).toBe(1254);

    const onDisk = await readFile(path.resolve(config.appConfig.imageStorageDir, saved.relativePath));
    expect(onDisk.byteLength).toBe(bytes.byteLength);
    expect(Buffer.from(bytes).equals(onDisk)).toBe(true);
  });

  test("解码不了的字节也原样落盘，尺寸记 0", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const saved = await save("img_broken", bytes);

    expect(saved.width).toBe(0);
    expect(saved.height).toBe(0);

    const onDisk = await readFile(path.resolve(config.appConfig.imageStorageDir, saved.relativePath));
    expect(Buffer.from(bytes).equals(onDisk)).toBe(true);
  });
});
