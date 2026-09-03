import { describe, expect, test } from "bun:test";
import { resolveListScope } from "@/lib/image-scope";

function scopeText(scope: { userId: string; isAdmin: boolean }): string {
  return `${scope.userId}|${scope.isAdmin ? "all" : "self"}`;
}

describe("resolveListScope", () => {
  test("普通成员永远只看自己的内容", () => {
    expect(
      scopeText(
        resolveListScope({ role: "member", userId: "u_self", scopeParam: "all", targetUserId: "u_other" }),
      ),
    ).toBe("u_self|self");
  });

  test("管理员没带 scope 时也只看自己的内容", () => {
    expect(scopeText(resolveListScope({ role: "admin", userId: "u_admin" }))).toBe("u_admin|self");
    expect(
      scopeText(resolveListScope({ role: "admin", userId: "u_admin", scopeParam: null, targetUserId: "u_other" })),
    ).toBe("u_admin|self");
  });

  test("管理员带 scope=all 且未指定用户时看全体", () => {
    expect(scopeText(resolveListScope({ role: "admin", userId: "u_admin", scopeParam: "all" }))).toBe(
      "u_admin|all",
    );
  });

  test("管理员带 scope=all 且指定用户时只看该用户", () => {
    expect(
      scopeText(
        resolveListScope({ role: "admin", userId: "u_admin", scopeParam: "all", targetUserId: " u_other " }),
      ),
    ).toBe("u_other|self");
  });
});
