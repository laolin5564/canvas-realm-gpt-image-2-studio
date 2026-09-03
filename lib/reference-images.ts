// 参考图装载与 413 兜底：和 HTTP/DB 细节分开，方便单测（bun 里 import lib/db 会碰 node:sqlite）。

import path from "node:path";
import { appConfig } from "./config";
import { isPayloadTooLargeError } from "./image-batch";
import {
  fitReferenceImagesToBudget,
  totalReferenceImageBytes,
  type ReferenceImageUpload,
} from "./image-upload";
import { formatModelErrorDetail } from "./model-error";
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
   *
   * sentBytes 是吃到 413 的那次请求实际发出去的参考图字节数：若当前 forUpload 已经比它小，
   * 说明同批别的请求已经为这份体积收缩过，直接返回 true 让调用方用新结果重发，不再砍第二刀。
   */
  shrink: (sentBytes?: number) => Promise<boolean>;
  count: number;
}

export function createReferenceImageLoader(sourceImagePaths: string[]): ReferenceImageLoader {
  let rawPromise: Promise<ReferenceImageUpload[]> | null = null;
  let uploadPromise: Promise<ReferenceImageUpload[]> | null = null;
  let shrinkPromise: Promise<boolean> | null = null;
  // 已经收缩到底（低于下限 / 压不动）：之后的 shrink 直接返回 false，别每个 413 都重跑一遍 sharp。
  let exhausted = false;
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

  const shrinkOnce = async (): Promise<boolean> => {
    try {
      const current = await forUpload();
      const currentBytes = totalReferenceImageBytes(current);
      const nextBudget = Math.floor(currentBytes / 2);
      if (count === 0 || nextBudget < minReferenceImageBytes * count) {
        exhausted = true;
        return false;
      }
      const shrunk = await fitReferenceImagesToBudget(await raw(), nextBudget, {
        maxImageBytes: Math.min(appConfig.sub2apiMaxImageBytes, nextBudget),
      });
      if (totalReferenceImageBytes(shrunk) >= currentBytes) {
        exhausted = true;
        return false;
      }
      uploadPromise = Promise.resolve(shrunk);
      return true;
    } catch {
      // 压不进去（fitReferenceImagesToBudget 抛错）：交给上层换渠道，这里不再抛。
      exhausted = true;
      return false;
    } finally {
      shrinkPromise = null;
    }
  };

  const shrink = async (sentBytes?: number): Promise<boolean> => {
    if (sentBytes !== undefined && !shrinkPromise) {
      // 同批并行请求：A 的 413 先到并已收缩完，B 的 413 晚到时看到的体积已经比它发出的小，直接复用。
      const currentBytes = totalReferenceImageBytes(await forUpload());
      if (currentBytes < sentBytes) {
        return true;
      }
    }
    if (exhausted) {
      return false;
    }
    // 同一批里几个并行请求同时吃到 413 时共用一次收缩，别把预算连砍好几刀。
    shrinkPromise ??= shrinkOnce();
    return shrinkPromise;
  };

  return { raw, forUpload, shrink, count };
}

/**
 * 413 兜底：先把参考图预算减半重压，同渠道立即重发一次；压不动了就原样上抛，
 * 由 runImageGenerationBatches 切到下一个渠道。两次发送各自独立记遥测。
 * send 拿到的是本次要发的参考图（每次重新取 forUpload()，413 后就是缩小后的那份）。
 */
export async function sendWithPayloadTooLargeFallback<T>(
  references: ReferenceImageLoader,
  send: (uploadImages: ReferenceImageUpload[]) => Promise<T>,
): Promise<T> {
  const uploadImages = await references.forUpload();
  try {
    return await send(uploadImages);
  } catch (error) {
    if (!isPayloadTooLargeError(error) || !(await references.shrink(totalReferenceImageBytes(uploadImages)))) {
      throw error;
    }
    return send(await references.forUpload());
  }
}

export interface ImageEditFormFields {
  model: string;
  prompt: string;
  n: number;
  size?: string | null;
  quality?: string | null;
  inputFidelity?: string | null;
}

/** 拼 /images/edits 的 multipart 表单：参考图字节原样进 image 部件，可选字段为空就不带。 */
export function buildImageEditForm(uploadImages: ReferenceImageUpload[], fields: ImageEditFormFields): FormData {
  const form = new FormData();
  form.append("model", fields.model);
  for (const image of uploadImages) {
    const blob = new Blob([new Uint8Array(image.bytes)], { type: image.mimeType });
    form.append("image", blob, image.fileName);
  }
  form.append("prompt", fields.prompt);
  form.append("n", String(fields.n));
  if (fields.size) {
    form.append("size", fields.size);
  }
  if (fields.quality) {
    form.append("quality", fields.quality);
  }
  if (fields.inputFidelity) {
    form.append("input_fidelity", fields.inputFidelity);
  }
  return form;
}

/** 管理员详情里用的参考图体积描述，例如「本次参考图合计约 1.8 MB」。 */
export function describeReferencePayload(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  const text = megabytes >= 10 ? megabytes.toFixed(0) : megabytes.toFixed(1);
  return `本次参考图合计约 ${text} MB`;
}

/**
 * 上游失败的管理员详情：413 时追加本次参考图体积，方便对照网关的 client_max_body_size。
 * 用户文案由 formatModelError 单独给出，这里只管管理员看的那份。
 */
export function formatUpstreamErrorDetail(
  status: number,
  text: string,
  fallback: string,
  referenceBytes?: number,
): string {
  const detail = formatModelErrorDetail(status, text, fallback);
  if (status === 413 && referenceBytes !== undefined) {
    return `${detail}（${describeReferencePayload(referenceBytes)}）`;
  }
  return detail;
}
