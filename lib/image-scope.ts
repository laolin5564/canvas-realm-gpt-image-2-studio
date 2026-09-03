/**
 * 列表接口的可见范围解析（管理员可见性调整）。
 *
 * 规则：管理员身份本身不再自动放大范围——工作台、/history 一律只看自己的内容；
 * 「查看所有用户生成的图片」只在管理后台显式带 scope=all 时生效，可再带 userId 收窄到某个用户。
 *
 * 返回值直接喂给 lib/db.ts 的 listImages / listGenerationTasks：
 * isAdmin=true 时 db 不按 user_id 过滤（全体），isAdmin=false 时按 userId 过滤（本人或指定用户）。
 */
import type { UserRole } from "./types";

export interface ResolveListScopeInput {
  role: UserRole;
  userId: string;
  scopeParam?: string | null;
  targetUserId?: string | null;
}

export interface ListScope {
  userId: string;
  isAdmin: boolean;
}

export function resolveListScope(input: ResolveListScopeInput): ListScope {
  // 非管理员，或管理员没显式要全体范围：都只看自己的。
  if (input.role !== "admin" || input.scopeParam !== "all") {
    return { userId: input.userId, isAdmin: false };
  }

  const targetUserId = input.targetUserId?.trim();
  if (targetUserId) {
    // 指定用户时走「非管理员」分支：db 层按 user_id 过滤，正好等于「只看这个用户」。
    return { userId: targetUserId, isAdmin: false };
  }

  return { userId: input.userId, isAdmin: true };
}
