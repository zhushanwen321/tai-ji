// Medium batch 2 — M10（壳侧 interface 守卫段）
//
// [u1-move 拆分] 原 robustness-medium-batch2.test.ts 的 M10 describe：读壳侧
// interface/helpers.ts 源文本做锚定断言。batch2 其余用例（M6/M9/M12，读 core 源文件）
// 随主体迁入 @zhushanwen/subagent-core。
//
// [u-sw-misc] boundedPrettySerialize 实现已下沉 core shared
// （@zhushanwen/subagent-core/shared/bounded-serialize.ts，u-core-atomic 逐字平移），
// helpers.ts 改为深路径消费——实现体源码锚定（祖先 Set 守卫 + 整体回退 try-catch）
// 随迁 core __tests__/bounded-serialize.test.ts，本文件仅保留壳侧调用点锚定。
//
// M10: notifyDone serialization circular-ref safe (IF13: boundedPrettySerialize + guard/fallback)

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

// ── M10: notifyDone 序列化有循环引用保护（IF13 后形态）─────────
//
// IF13（#19）：notifyDone 的 scriptResult 序列化从「整体 try { JSON.stringify(x, null, 2) }
// catch { String(x) }」重构为 boundedPrettySerialize（只生成 ≤8000 前缀）。循环引用
// 保护语义不变，锚定点：(1) notifyDone 调用 boundedPrettySerialize(scriptResult)；
// (2) 实现内祖先 Set 守卫（命中 throw）+ 顶层 try-catch 整体回退 String(value)
// ——(2) 已随实现下沉锚定于 core __tests__/bounded-serialize.test.ts。
// 行为级等价（回退输出与旧实现逐字节一致）由 helpers-bounded-serialize.test.ts 锚定。

describe("M10: notifyDone serialization has circular ref protection", () => {
  const src = readSrc(join("src", "interface", "helpers.ts"));

  it("notifyDone serializes scriptResult via boundedPrettySerialize", () => {
    // 调用点：scriptResult 不再直接 JSON.stringify，走 bounded 序列化
    const callMatch = src.match(/boundedPrettySerialize\(run\.state\.scriptResult,\s*MAX_RESULT_LENGTH\)/);
    expect(callMatch).toBeTruthy();
  });
});
