// Medium batch 2 robustness fixes verification
//
// M6: worktree cleanup not gated by patchOk (decoupled)
// M9: store.save not fire-and-forget (has .catch)
// M12: budget-done transition and onRunDone in separate try blocks
//   （D5-② coda 收敛后语义不变、落点转移：budget-done 分支改调 finalizeRun 单写点，
//   transition / unregister+onRunDone 的错误分离在 finalizeRun 函数体内断言）
// [u1-move] M10（notifyDone 序列化守卫，读壳侧 interface/helpers.ts 源文本）随壳件
// 留守 pi extension 包：src/__tests__/robustness-medium-batch2-interface.test.ts。

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

// ── M6: worktree cleanup decoupled from patchOk ──────────────

describe("M6: worktree cleanup not gated by patchOk", () => {
  // [H3/R3] worktree cleanup 调用点（disposeAllRecords / cancelBackground）已随终态
  // 写面迁 execution/service/record-lifecycle.ts（strangler 抽取，壳只留单行转发）——
  // 源文本守卫随被守卫本体改读聚合文件，断言强度不变（patchOk 解耦锁）。
  const src = readSrc(join("src", "execution", "service", "record-lifecycle.ts"));

  it("worktree cleanup condition does not reference patchOk", () => {
    // 找到 worktree cleanup 调用前的条件判断
    // [H3/R3] cleanup 通道字面随依赖注入改造为 deps.getWorktreeManager().cleanup
    //（this.worktreeManager → this.deps.getWorktreeManager()，方法体其余逐字节保留）。
    const cleanupMatch = src.match(/if\s*\([^)]*worktreeHandle[^)]*\)\s*\{[\s\S]*?getWorktreeManager\(\)\.cleanup/);
    expect(cleanupMatch).toBeTruthy();
    const condition = cleanupMatch![0];
    // 条件中不应包含 patchOk（解耦后 worktree cleanup 只依赖 worktreeHandle 存在）
    expect(condition).not.toContain("patchOk");
  });
});

// ── M9: store.save has .catch (not fire-and-forget) ──────────

describe("M9: store.save not fire-and-forget in dispatchAgentCall", () => {
  const src = readSrc(join("src", "orchestration", "worker-message-pump.ts"));

  it("no bare `void deps.store.save` without .catch", () => {
    // 查找所有 void deps.store.save(run) 的出现
    const bareSave = /void\s+deps\.store\.save\(run\)\s*;(?!\s*\.catch)/g;
    const matches = [...src.matchAll(bareSave)];
    // 修复后不应有裸 void store.save（应有 .catch 或 await）
    expect(matches.length).toBe(0);
  });
});

// ── M12: budget-done coda 经 finalizeRun 单写点（错误分离语义不变） ──

describe("M12: budget-done separates transition and onRunDone error handling", () => {
  const src = readSrc(join("src", "orchestration", "worker-message-pump.ts"));

  it("budget-done branch delegates to finalizeRun (D5-② single coda write point)", () => {
    // 找到 budget isExceeded 块
    const budgetMatch = src.match(/budget\.isExceeded\(\)[\s\S]*?\}\s*\}\s*\)/);
    expect(budgetMatch).toBeTruthy();
    const budgetBlock = budgetMatch![0];
    // coda 收敛后：budget-done 分支只调 finalizeRun（transition/save/unregister/onRunDone
    // 四步不再内联复制）
    expect(budgetBlock).toContain("finalizeRun(run, deps, \"budget_limited\"");
  });

  it("finalizeRun body separates transition and onRunDone error handling (>= 2 catch)", () => {
    // finalizeRun 函数体：transition 的 try/catch 与 unregister/onRunDone 的 try/catch
    // 分离（M12 语义锚定不变，随 coda 收敛转移至单写点内）
    const fnMatch = src.match(/export async function finalizeRun\([\s\S]*?\n\}/);
    expect(fnMatch, "finalizeRun 函数定义应存在").toBeTruthy();
    const catchCount = (fnMatch![0].match(/\bcatch\b/g) || []).length;
    expect(catchCount).toBeGreaterThanOrEqual(2);
  });
});
