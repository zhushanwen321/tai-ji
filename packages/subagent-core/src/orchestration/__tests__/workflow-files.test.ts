// src/orchestration/__tests__/workflow-files.test.ts
//
// C4-core-script-pipeline（convergence W4 / D-6）目录参数化测试：
// - saveWorkflow/deleteWorkflow 注入非 .pi 目录：真实落盘 / rename 迁移 / 删除；
// - 既有语义回归（文案逐字）：tmp 不存在拒、目标已存在拒、运行中拒、
//   两候选路径均无拒；
// - 缺省目录 = pi 布局（相对 cwd resolve，pi 现两参调用形态行为不变）。
// 设计权威源：docs/design/subagent-core-convergence.md §3.2 D-6。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { deleteWorkflow, saveWorkflow } from "../workflow-files.ts";

/** 构造注入布局（非 .pi）：{root}/host-tmp + {root}/host-saved（saved 不预创建，
 * 覆盖 saveWorkflow 内 mkdirSync recursive 自动建目录路径）。 */
function makeHostLayout(): { root: string; tmpDir: string; savedDir: string } {
  const root = mkdtempSync(join(tmpdir(), "subagent-core-wf-"));
  const tmpDir = join(root, "host-tmp");
  const savedDir = join(root, "host-saved");
  mkdirSync(tmpDir, { recursive: true });
  return { root, tmpDir, savedDir };
}

function seedTmp(tmpDir: string, name: string, body = "// tmp body"): void {
  writeFileSync(join(tmpDir, `${name}.js`), body);
}

// ============================================================
// saveWorkflow（目录注入）
// ============================================================

describe("saveWorkflow 目录注入（非 .pi 布局）", () => {
  it("注入 tmpDir/savedDir：tmp 落盘 → rename 迁移，savedDir 自动创建", async () => {
    const { root, tmpDir, savedDir } = makeHostLayout();
    try {
      seedTmp(tmpDir, "alpha", "// alpha body");
      const msg = await saveWorkflow("alpha", undefined, { tmpDir, savedDir });
      expect(msg).toBe(`Saved 'alpha' → 'alpha' (${join(savedDir, "alpha.js")})`);
      // rename 语义：tmp 文件保存后消失
      expect(existsSync(join(tmpDir, "alpha.js"))).toBe(false);
      expect(readFileSync(join(savedDir, "alpha.js"), "utf-8")).toBe("// alpha body");
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("newName 改名：tmp/alpha.js → saved/beta.js", async () => {
    const { root, tmpDir, savedDir } = makeHostLayout();
    try {
      seedTmp(tmpDir, "alpha", "// renamed body");
      const msg = await saveWorkflow("alpha", "beta", { tmpDir, savedDir });
      expect(msg).toBe(`Saved 'alpha' → 'beta' (${join(savedDir, "beta.js")})`);
      expect(existsSync(join(savedDir, "alpha.js"))).toBe(false);
      expect(existsSync(join(savedDir, "beta.js"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("目标已存在 → 拒（文案逐字）", async () => {
    const { root, tmpDir, savedDir } = makeHostLayout();
    try {
      seedTmp(tmpDir, "alpha");
      mkdirSync(savedDir, { recursive: true });
      writeFileSync(join(savedDir, "beta.js"), "// existing");
      await expect(saveWorkflow("alpha", "beta", { tmpDir, savedDir })).rejects.toThrow(
        "'beta' already exists in saved workflows. Use a different name.",
      );
      // 原文件不动
      expect(existsSync(join(tmpDir, "alpha.js"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("tmp 不存在 → 拒（文案逐字）", async () => {
    const { root, tmpDir, savedDir } = makeHostLayout();
    try {
      await expect(saveWorkflow("ghost", undefined, { tmpDir, savedDir })).rejects.toThrow(
        "Temporary workflow 'ghost' not found",
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ============================================================
// deleteWorkflow（目录注入）
// ============================================================

describe("deleteWorkflow 目录注入（非 .pi 布局）", () => {
  it("注入目录：tmp 候选优先删除", () => {
    const { root, tmpDir, savedDir } = makeHostLayout();
    try {
      seedTmp(tmpDir, "dup", "// tmp copy");
      mkdirSync(savedDir, { recursive: true });
      writeFileSync(join(savedDir, "dup.js"), "// saved copy");
      const msg = deleteWorkflow("dup", () => false, { tmpDir, savedDir });
      expect(msg).toBe(`Deleted workflow 'dup' (${join(tmpDir, "dup.js")})`);
      expect(existsSync(join(tmpDir, "dup.js"))).toBe(false);
      expect(existsSync(join(savedDir, "dup.js"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("注入目录：tmp 无 → saved 候选删除", () => {
    const { root, tmpDir, savedDir } = makeHostLayout();
    try {
      mkdirSync(savedDir, { recursive: true });
      writeFileSync(join(savedDir, "gamma.js"), "// saved body");
      const msg = deleteWorkflow("gamma", () => false, { tmpDir, savedDir });
      expect(msg).toBe(`Deleted workflow 'gamma' (${join(savedDir, "gamma.js")})`);
      expect(existsSync(join(savedDir, "gamma.js"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("运行中 → 拒（文案逐字，防删运行中脚本）", () => {
    const { root, tmpDir, savedDir } = makeHostLayout();
    try {
      seedTmp(tmpDir, "busy");
      expect(() =>
        deleteWorkflow("busy", (name) => name === "busy", { tmpDir, savedDir }),
      ).toThrow("Cannot delete 'busy': workflow is currently running. Abort it first.");
      expect(existsSync(join(tmpDir, "busy.js"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("两候选均无 → 拒（文案逐字）", () => {
    const { root, tmpDir, savedDir } = makeHostLayout();
    try {
      expect(() => deleteWorkflow("void", () => false, { tmpDir, savedDir })).toThrow(
        "Workflow file 'void' not found",
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ============================================================
// 缺省目录（pi 布局回归——向后兼容：pi 现两参调用形态行为不变）
// ============================================================

describe("缺省目录 = pi 布局（向后兼容回归）", () => {
  it("save 缺省：<cwd>/.pi/workflows/.tmp → <cwd>/.pi/workflows", async () => {
    const fakeCwd = mkdtempSync(join(tmpdir(), "subagent-core-cwd-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);
    try {
      const tmpDir = join(fakeCwd, ".pi", "workflows", ".tmp");
      mkdirSync(tmpDir, { recursive: true });
      seedTmp(tmpDir, "pi-wf", "// pi layout");
      const msg = await saveWorkflow("pi-wf");
      expect(msg).toBe(`Saved 'pi-wf' → 'pi-wf' (${join(fakeCwd, ".pi", "workflows", "pi-wf.js")})`);
      expect(existsSync(join(tmpDir, "pi-wf.js"))).toBe(false);
      expect(existsSync(join(fakeCwd, ".pi", "workflows", "pi-wf.js"))).toBe(true);
    } finally {
      cwdSpy.mockRestore();
      rmSync(fakeCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("delete 缺省：两候选 = .pi/workflows/.tmp 与 .pi/workflows", () => {
    const fakeCwd = mkdtempSync(join(tmpdir(), "subagent-core-cwd-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);
    try {
      const savedDir = join(fakeCwd, ".pi", "workflows");
      mkdirSync(savedDir, { recursive: true });
      writeFileSync(join(savedDir, "saved-only.js"), "// body");
      const msg = deleteWorkflow("saved-only", () => false);
      expect(msg).toBe(`Deleted workflow 'saved-only' (${join(savedDir, "saved-only.js")})`);
      expect(existsSync(join(savedDir, "saved-only.js"))).toBe(false);
    } finally {
      cwdSpy.mockRestore();
      rmSync(fakeCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
