import { createId, createSourceImage, deleteSourceImage } from "./db";
import type { PreparedSourceImage } from "./source-image-upload";
import { deleteStorageFile, saveSourceImageFile } from "./storage";
import type { SourceImageRow } from "./types";

/**
 * 参考图上传的后半段：把已经归一化好的图落盘并建 source_images 记录。
 * 多张图两阶段处理：调用方先把所有图都 prepare 完（任何一张校验失败都不会有文件写出来），
 * 再一次性交给这里；这里中途失败会把已写的文件和记录回滚掉，不留孤儿。
 */
export async function storeSourceImages(userId: string, images: readonly PreparedSourceImage[]): Promise<SourceImageRow[]> {
  const written: string[] = [];
  const rows: SourceImageRow[] = [];
  try {
    for (const image of images) {
      const sourceId = createId("src");
      const filePath = await saveSourceImageFile({
        sourceId,
        fileName: image.originalName ?? sourceId,
        bytes: image.bytes,
        mimeType: image.mimeType,
      });
      written.push(filePath);
      rows.push(
        createSourceImage({
          userId,
          filePath,
          width: image.width,
          height: image.height,
          originalName: image.originalName,
          mimeType: image.mimeType,
        }),
      );
    }
    return rows;
  } catch (error) {
    await Promise.allSettled([
      ...rows.map((row) => Promise.resolve().then(() => deleteSourceImage(row.id))),
      ...written.map((filePath) => deleteStorageFile(filePath)),
    ]);
    throw error;
  }
}

export async function storeSourceImage(userId: string, image: PreparedSourceImage): Promise<SourceImageRow> {
  const [row] = await storeSourceImages(userId, [image]);
  return row;
}
