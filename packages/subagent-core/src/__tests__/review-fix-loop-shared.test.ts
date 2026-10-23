// review-fix-loop.shared.ts — 单源机制段单测。
//
// 覆盖三类：① 跨轮字段继承（自 review-fix-loop-utils.test.ts 迁移的
// inheritCarryoverFields 用例 + refreshTrackedFields 防空壳覆盖）；
// ② parsePorcelain（porcelain 解析：rename/引号/自持目录过滤）；
// ③ contentRepairLoop（mock ctx 全路径：成功/上限/不可修/结构化非法回注/快照差集对账）。
import { describe, expect, it } from "vitest";

import {
  contentRepairLoop,
  inheritCarryoverFields,
  isValidRepairReport,
  parsePorcelain,
  refreshTrackedFields,
  type CmdResult,
  type ContentRepairCtx,
} from "../../workflows/src/review-fix-loop.shared";

// ── 跨轮字段继承 ──────────────────────────────────────────────

describe("B3b 延续条目字段继承（wf-1792073055433 空壳缺陷修复；AC1 收窄签名）", () => {
  const mkTracked = (extra: Record<string, unknown> = {}): { title?: string; severity?: string; [key: string]: unknown } => ({
    id: "MF-1", status: "open", ...extra,
  });
  it("inheritCarryoverFields：清单缺 title 时从重报回填（防跨轮身份锚点断链）", () => {
    const tracked = mkTracked({ severity: "major" });
    expect(inheritCarryoverFields(tracked, { id: "S-1", severity: "major", title: "fit 容器尺寸竞态" })).toBe(true);
    expect(tracked.title).toBe("fit 容器尺寸竞态");
  });

  it("inheritCarryoverFields：清单已有 title 为权威，重报不覆盖（措辞漂移不污染身份锚点）", () => {
    const tracked = mkTracked({ title: "原始标题", severity: "major" });
    expect(inheritCarryoverFields(tracked, { id: "MF-1", severity: "major", title: "同题换措辞" })).toBe(false);
    expect(tracked.title).toBe("原始标题");
  });

  it("inheritCarryoverFields：severity 采信本轮显式标注（聚合权威语义，与 regressed 分支一致）", () => {
    const tracked = mkTracked({ title: "t", severity: "minor" });
    expect(inheritCarryoverFields(tracked, { id: "MF-1", severity: "critical" })).toBe(true);
    expect(tracked.severity).toBe("critical");
    // 相同值不记变更
    expect(inheritCarryoverFields(tracked, { id: "MF-1", severity: "critical" })).toBe(false);
  });

  it("inheritCarryoverFields：空壳重报（无 title/severity）不动已追踪字段——旧 zcode 无条件覆盖缺陷的回归锚点", () => {
    const tracked = mkTracked({ title: "原始标题", severity: "major" });
    expect(inheritCarryoverFields(tracked, { id: "MF-1" })).toBe(false);
    expect(tracked.title).toBe("原始标题");
    expect(tracked.severity).toBe("major");
  });

  it("refreshTrackedFields：非空刷新、空值不覆盖（防聚合器空壳条目把 evidence/files 抹空）", () => {
    const tracked: Record<string, unknown> = { files: ["a.ts"], evidence: "旧证据", guidance: "旧指引" };
    refreshTrackedFields(tracked, { files: ["b.ts"], evidence: "", guidance: undefined }, ["files", "evidence", "guidance"]);
    expect(tracked.files).toEqual(["b.ts"]);
    expect(tracked.evidence).toBe("旧证据");
    expect(tracked.guidance).toBe("旧指引");
  });

  it("refreshTrackedFields：空数组不覆盖（length 0 视为空）", () => {
    const tracked: Record<string, unknown> = { files: ["a.ts"] };
    refreshTrackedFields(tracked, { files: [] }, ["files"]);
    expect(tracked.files).toEqual(["a.ts"]);
  });
});

// ── porcelain 解析 ────────────────────────────────────────────

describe("parsePorcelain — git status --porcelain → 路径数组", () => {
  it("普通行取路径（XY 前缀后段）", () => {
    expect(parsePorcelain(" M packages/a.ts\n?? b.ts\n")).toEqual(["packages/a.ts", "b.ts"]);
  });
  it("rename 行取新路径（old -> new）", () => {
    expect(parsePorcelain("R  old-name.ts -> new-name.ts")).toEqual(["new-name.ts"]);
  });
  it("引号包裹剥除", () => {
    expect(parsePorcelain('?? "path with space.ts"')).toEqual(["path with space.ts"]);
  });
  it("过滤脚本自持目录 .review/ 与 .tmp/（差集对账不得把脚本自产文件算作补修改动）", () => {
    expect(parsePorcelain("?? .review/x.md\n?? .tmp/y.json\n?? keep.ts")).toEqual(["keep.ts"]);
  });
  it("空输入 → 空数组", () => {
    expect(parsePorcelain("")).toEqual([]);
  });
});

// ── contentRepairLoop（mock ctx 全路径）──────────────────────

/** 测试侧 ctx 装配：dirty 状态机 + agent 应答序列 + commit 结果序列 + 观测口。 */
interface TestCtx extends ContentRepairCtx { // oe-exempt:20261023:test:测试装配 ctx 接口（mock 工厂单一消费点）
  __logs: string[];
  __prompts: string[];
  __staged: string[][];
  setDirty(paths: string[]): void;
  setCommitResults(results: Array<CmdResult>): void;
}

function mkCtx(agentReplies: unknown[], commitResults: Array<CmdResult> = []): TestCtx {
  const logs: string[] = [];
  const prompts: string[] = [];
  const staged: string[][] = [];
  let dirty = new Set<string>(["fix/a.ts"]);
  let commits = [...commitResults];
  return {
    roundLabel: "第 1 轮",
    maxRepairs: 2,
    initialErr: "pre-commit failed: e2e-map 缺登记 docs/testing/e2e-map.json",
    initialExitCode: 1,
    dirtyPaths: async () => [...dirty],
    retryCommit: async () => commits.shift() ?? { exitCode: 0, stdout: "", stderr: "" },
    stageFiles: async (paths) => {
      staged.push(paths);
      for (const p of paths) dirty.add(p);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    askRepairAgent: async (_attemptNo, prompt) => {
      prompts.push(prompt);
      return agentReplies[prompts.length - 1];
    },
    log: (m) => { logs.push(m); },
    __logs: logs,
    __prompts: prompts,
    __staged: staged,
    setDirty: (paths) => { dirty = new Set(paths); },
    setCommitResults: (results) => { commits = [...results]; },
  };
}

describe("contentRepairLoop — content 补修子循环（mock ctx）", () => {
  it("成功路径：补修 agent 申报 → add 申报文件 → 重跑 commit 成功 → repaired", async () => {
    const ctx = mkCtx([{ repairedFiles: ["docs/e2e-map.json"], note: "补登记" }], [{ exitCode: 0, stdout: "", stderr: "" }]);
    const r = await contentRepairLoop(ctx);
    expect(r.outcome).toBe("repaired");
    expect(r.tries).toBe(1);
    expect(r.allRepairFiles).toEqual(["docs/e2e-map.json"]);
    expect(ctx.__staged).toEqual([["docs/e2e-map.json"]]);
  });

  it("快照差集对账：补修期间新增未申报脏文件并入补修清单并披露（越权改动防线）", async () => {
    const ctx = mkCtx([{ repairedFiles: ["docs/e2e-map.json"], note: "补登记" }], [{ exitCode: 0, stdout: "", stderr: "" }]);
    const origAsk = ctx.askRepairAgent.bind(ctx);
    let asked = false;
    ctx.askRepairAgent = async (n, p) => {
      const v = await origAsk(n, p);
      if (!asked) { asked = true; ctx.setDirty(["fix/a.ts", "docs/e2e-map.json", "sneaky.ts"]); }
      return v;
    };
    const r = await contentRepairLoop(ctx);
    expect(r.allRepairFiles).toContain("sneaky.ts");
    expect(ctx.__logs.some((l) => l.includes("sneaky.ts"))).toBe(true);
  });

  it("空申报 = 判不可修，立即终止不空耗剩余次数（unrepairable，tries=1）", async () => {
    const ctx = mkCtx([{ repairedFiles: [], note: "报错未写明可改文件的恢复动作" }]);
    const r = await contentRepairLoop(ctx);
    expect(r.outcome).toBe("unrepairable");
    expect(r.tries).toBe(1);
    expect(r.why).toContain("报错未写明");
  });

  it("结构化非法 → 回注重试一次（不消耗补修次数），仍败 → invalid-return", async () => {
    const ctx = mkCtx(["这不是 JSON", { repairedFiles: "不是数组", note: "x" }]);
    const r = await contentRepairLoop(ctx);
    expect(r.outcome).toBe("invalid-return");
    expect(r.tries).toBe(1);
    // 两次 ask：首次 + 回注
    expect(ctx.__prompts).toHaveLength(2);
    expect(ctx.__prompts[1]).toContain("上一次返回被判为无效");
  });

  it("回注后返回有效 → 继续正常补修流程（repaired）", async () => {
    const ctx = mkCtx(["garbage", { repairedFiles: ["docs/x.json"], note: "ok" }], [{ exitCode: 0, stdout: "", stderr: "" }]);
    const r = await contentRepairLoop(ctx);
    expect(r.outcome).toBe("repaired");
    expect(r.tries).toBe(1);
  });

  it("重跑仍败回循环，达上限 → exhausted（tries = maxRepairs）", async () => {
    const ctx = mkCtx(
      [
        { repairedFiles: ["docs/a.json"], note: "1" },
        { repairedFiles: ["docs/b.json"], note: "2" },
      ],
      [
        { exitCode: 1, stdout: "", stderr: "pre-commit failed: still blocked" },
        { exitCode: 1, stdout: "", stderr: "pre-commit failed: still blocked 2" },
      ],
    );
    const r = await contentRepairLoop(ctx);
    expect(r.outcome).toBe("exhausted");
    expect(r.tries).toBe(2);
    expect(r.lastErr).toContain("still blocked 2");
    expect(r.allRepairFiles).toEqual(["docs/a.json", "docs/b.json"]);
  });

  it("isValidRepairReport：repairedFiles 数组 + note 非空串才有效", () => {
    expect(isValidRepairReport({ repairedFiles: [], note: "x" })).toBe(true);
    expect(isValidRepairReport({ repairedFiles: ["a"], note: " " })).toBe(false);
    expect(isValidRepairReport({ repairedFiles: "a", note: "x" })).toBe(false);
    expect(isValidRepairReport(null)).toBe(false);
    expect(isValidRepairReport(undefined)).toBe(false);
  });
});
