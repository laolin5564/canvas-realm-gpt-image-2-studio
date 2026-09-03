// 参考图装载与 413 兜底：和 HTTP/DB 细节分开，方便单测（bun 里 import lib/db 会碰 node:sqlite）。

import path from "node:path";
import { appConfig } from "./config";
import { isPayloadTooLargeError } from "./image-batch";
import {
  fitReferenceImagesToBudget,
  totalReferenceImageBytes,
  type ReferenceImageUpload,
} from "./image-upload";
import { readStorageFile } from "./storage";

// 参考图预算减半到这个线以下就不再收缩：再压下去图已经糊到没有参考价值了。
const minReferenceImageBytes = 256 * 1024;

export interface ReferenceImageLoader {
  /** 原始参考图字节（OpenAI OAuth 走 data URL 用）。 */
  raw: () => Promise<ReferenceImageUpload[]>;
  /** 压缩到网关上传预算内的参考图（multipart 上传用）。 */
  forUpload: () => Promise<ReferenceImageUpload[]>;
  /**
   * 413 兜底：把上传预算改为「当前 forUpload 总字节数的一半」从原图重压。
   * 成功返回 true，之后 forUpload() 给出的就是缩小后的结果（任务内各渠道共享，不回弹）；
   * 预算已低于下限或压不进去返回 false，不抛错。
   */
  shrink: () => Promise<boolean>;
  count: number;
}

export function createReferenceImageLoader(sourceImagePaths: string[]): ReferenceImageLoader {
  let rawPromise: Promise<ReferenceImageUpload[]> | null = null;
  let uploadPromise: Promise<ReferenceImageUpload[]> | null = null;
  let shrinkPromise: Promise<boolean> | null = null;
  const count = sourceImagePaths.length;

  const raw = (): Promise<ReferenceImageUpload[]> => {
    rawPromise ??= Promise.all(
      sourceImagePaths.map(async (sourceImagePath) => {
        const image = await readStorageFile(sourceImagePath);
        return { ...image, fileName: path.basename(sourceImagePath) };
      }),
    );
    return rawPromise;
  };

  const forUpload = (): Promise<ReferenceImageUpload[]> => {
    uploadPromise ??= raw().then((images) =>
      fitReferenceImagesToBudget(images, appConfig.sub2apiMaxUploadBytes, {
        maxImageBytes: appConfig.sub2apiMaxImageBytes,
      }),
    );
    return uploadPromise;
  };

  const shrink = (): Promise<boolean> => {
    // 同一批里几个并行请求同时吃到 413 时共用一次收缩，别把预算连砍好几刀。
    shrinkPromise ??= (async () => {
      try {
        const current = await forUpload();
        const currentBytes = totalReferenceImageBytes(current);
        const nextBudget = Math.floor(currentBytes / 2);
        if (count === 0 || nextBudget < minReferenceImageBytes * count) {
          return false;
        }
        const shrunk = await fitReferenceImagesToBudget(await raw(), nextBudget, {
          maxImageBytes: Math.min(appConfig.sub2apiMaxImageBytes, nextBudget),
        });
        if (totalReferenceImageBytes(shrunk) >= currentBytes) {
          return false;
        }
        uploadPromise = Promise.resolve(shrunk);
        return true;
      } catch {
        // 压不进去（fitReferenceImagesToBudget 抛错）：交给上层换渠道，这里不再抛。
        return false;
      } finally {
        shrinkPromise = null;
      }
    })();
    return shrinkPromise;
  };

  return { raw, forUpload, shrink, count };
}

/**
 * 413 兜底：先把参考图预算减半重压，同渠道立即重发一次；压不动了就原样上抛，
 * 由 runImageGenerationBatches 切到下一个渠道。两次发送各自独立记遥测。
 */
export async function sendWithPayloadTooLargeFallback<T>(
  references: ReferenceImageLoader,
  send: () => Promise<T>,
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (!isPayloadTooLargeError(error) || !(await references.shrink())) {
      throw error;
    }
    return send();
  }
}

/** 管理员详情里用的参考图体积描述，例如「本次参考图合计约 1.8 MB」。 */
export function describeReferencePayload(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  const text = megabytes >= 10 ? megabytes.toFixed(0) : megabytes.toFixed(1);
  return `本次参考图合计约 ${text} MB`;
}
