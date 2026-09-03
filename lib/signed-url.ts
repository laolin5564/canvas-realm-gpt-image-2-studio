import crypto from "node:crypto";
import { PUBLIC_FILE_PREFIX } from "./config";

/** 签名下载链接默认有效期：7 天。 */
export const signedUrlTtlSeconds = 7 * 24 * 60 * 60;

const expPattern = /^[0-9]{1,15}$/;

export function signedUrlExpiry(nowMs = Date.now(), ttlSeconds = signedUrlTtlSeconds): number {
  return Math.floor(nowMs / 1000) + ttlSeconds;
}

/** 签名只覆盖 file_path 与过期时间；?thumb=1 不参与签名，同一把签名可取原图与缩略图。 */
export function signFilePath(filePath: string, expUnix: number, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${filePath}\n${expUnix}`).digest("base64url");
}

export function verifyFilePath(input: {
  filePath: string;
  sig: string | null | undefined;
  exp: string | number | null | undefined;
  secret: string;
  nowMs?: number;
}): boolean {
  if (!input.sig || !input.secret) {
    return false;
  }

  const rawExp = typeof input.exp === "number" ? String(input.exp) : (input.exp ?? "");
  if (!expPattern.test(rawExp)) {
    return false;
  }

  const exp = Number(rawExp);
  if (exp * 1000 <= (input.nowMs ?? Date.now())) {
    return false;
  }

  return timingSafeEqualString(signFilePath(input.filePath, exp, input.secret), input.sig);
}

/** 常量时间比较：长度不同直接判否，避免 timingSafeEqual 因长度不等抛错。 */
export function timingSafeEqualString(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

/** 拼出可免鉴权下载的绝对地址：<origin>/api/files/<file_path>?sig=..&exp=..[&thumb=1]。 */
export function signedFileUrl(input: {
  origin: string;
  filePath: string;
  secret: string;
  expUnix: number;
  thumb?: boolean;
}): string {
  const encodedPath = input.filePath.split("/").map(encodeURIComponent).join("/");
  const sig = signFilePath(input.filePath, input.expUnix, input.secret);
  const query = new URLSearchParams({ sig, exp: String(input.expUnix) });
  if (input.thumb) {
    query.set("thumb", "1");
  }
  return `${input.origin.replace(/\/+$/, "")}${PUBLIC_FILE_PREFIX}/${encodedPath}?${query.toString()}`;
}
