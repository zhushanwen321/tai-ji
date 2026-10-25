import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 对 package.json version 断言（单一事实源）：本测试是 src/index.ts 字面量与
// package.json 双源同步的执法者——任何一侧 bump 后未同步另一侧立即红，
// 替代旧硬编码 "0.1.0" 字面量（版本 bump 时必忘改的第三处双源）。
// 读 barrel 源码提取声明字面量比对，不 import barrel（入 barrel 边零容忍，D1 决策二）。
describe("subagent-core scaffold smoke", () => {
  it("exposes CORE_PACKAGE_VERSION synced with package.json", () => {
    const pkgVersion = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ).version;
    const barrelSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    // 须匹配完整声明形态（含 export 前缀与引号）：barrel 头注含裸版本字面量诱饵，
    // 「取文件中首个版本形态串」类宽松提取首命中即注释假红——完整声明形态在注释行
    // 中不可构造，结构上免疫。三态 fail-loud（未命中 / 多命中 / 值不等一律红），
    // 判据基准同 scripts/check-subagent-core-closure.mjs 检查项 0（同源同判据）。
    const matches = [
      ...barrelSource.matchAll(/export const CORE_PACKAGE_VERSION = "([^"]+)"/g),
    ];
    expect(
      matches.length,
      "src/index.ts 缺少 CORE_PACKAGE_VERSION 导出字面量（版本双源断言锚点丢失）",
    ).not.toBe(0);
    expect(
      matches.length,
      `src/index.ts CORE_PACKAGE_VERSION 声明出现 ${matches.length} 处（复制残留？锚点必须唯一）`,
    ).toBe(1);
    expect(
      matches[0][1],
      `版本双源漂移: src/index.ts CORE_PACKAGE_VERSION = "${matches[0][1]}" ≠ package.json version = "${pkgVersion}"（两处字面量须同步修改）`,
    ).toBe(pkgVersion);
  });
});
