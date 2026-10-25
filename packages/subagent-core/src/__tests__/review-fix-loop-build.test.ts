// review-fix-loop 双平台产物一致性门禁（等价 zsw-skills build --check 挂 pre-commit 的
// 防线，按本仓惯例落在 vitest 层：改 src 源（shared/双壳模板）忘重跑构建时本用例红）。
//
// 直接 import 构建脚本的 runBuildOrCheck({check:true})（免子进程 spawn）：三产物
//（仓内 pi/zcode 产物 + ~/.zcode saved 副本）与重生成结果逐字节比对，dirty > 0 = 过期。
// 注意：check 比对 ~/.zcode saved 副本——本用例因此在任何机器上都要求 saved 已同步
//（构建脚本 build 会一并同步，这是有意的：saved 滞后时实际执行的是旧版）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runBuildOrCheck } from "../../scripts/build-review-fix-loop.mjs";

const PKG_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

describe("review-fix-loop 双平台产物一致性（单源拼装管线）", () => {
  it("产物与源一致（shared/双壳模板改动后须重跑 pnpm build:workflows）", () => {
    const { dirty } = runBuildOrCheck({ check: true });
    expect(
      dirty,
      "产物过期或 saved 副本滞后（恢复动作：cd packages/subagent-core && pnpm build:workflows）",
    ).toBe(0);
  });

  it("源形态约束：两壳模板各含恰好 1 个 @@STITCH@@ 标记行，shared 段无字面 agent( 调用", () => {
    const countMarker = (p: string) =>
      readFileSync(join(PKG_ROOT, p), "utf8").split("\n").filter((l) => /^\s*@@STITCH@@\s*$/.test(l)).length;
    expect(countMarker("workflows/src/review-fix-loop.zcode.tpl.ts")).toBe(1);
    expect(countMarker("workflows/src/review-fix-loop.pi.tpl.js")).toBe(1);
    // shared 纯逻辑无平台 agent 调用（字面调用在各壳内；zcode GUI 泳道分析不受拼接影响）
    const shared = readFileSync(join(PKG_ROOT, "workflows/src/review-fix-loop.shared.ts"), "utf8");
    expect(/(?<![\w.$])agent\(/.test(shared.replace(/^\/\/.*$/gm, ""))).toBe(false);
  });
});
