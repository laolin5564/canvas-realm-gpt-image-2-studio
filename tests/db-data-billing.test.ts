import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test } from "bun:test";

// lib/db.ts 依赖 node:sqlite，当前 bun 版本没有这个内建模块，所以数据层用例写成
// node:test（tests/*.node.ts）。这里把它们挂进 bun test，避免 `bun run test` 漏跑。
const repoRoot = path.resolve(".");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const nodeSuites = [
  "db-data-billing.node.ts",
  "db-migration.node.ts",
  "discount-codes.node.ts",
  "data-management.node.ts",
  "observability.node.ts",
  "permissions.node.ts",
  "queue-claim.node.ts",
];

describe("数据层与账务用例（node:test）", () => {
  test("跑通 tests/*.node.ts", () => {
    // TAP reporter 输出格式稳定，能直接断言失败数；子进程退出码非 0 时 execFileSync 会抛。
    const output = execFileSync(
      tsxBin,
      ["--test", "--test-reporter=tap", ...nodeSuites.map((suite) => path.join("tests", suite))],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(output).toContain("# fail 0");
    expect(output).toContain("# cancelled 0");
  });
});
