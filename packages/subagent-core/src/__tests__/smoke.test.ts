import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CORE_PACKAGE_VERSION } from "../index";

// 对 package.json version 断言（单一事实源）：本测试是 src/index.ts 字面量与
// package.json 双源同步的执法者——任何一侧 bump 后未同步另一侧立即红，
// 替代旧硬编码 "0.1.0" 字面量（版本 bump 时必忘改的第三处双源）。
describe("subagent-core scaffold smoke", () => {
  it("exposes CORE_PACKAGE_VERSION synced with package.json", () => {
    const pkgVersion = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ).version;
    expect(CORE_PACKAGE_VERSION).toBe(pkgVersion);
  });
});
