// src/shared/__tests__/resource-discovery-host-roots.test.ts
//
// C2-core-discovery（convergence W2）单元测试：发现链扩面四工作项的行为锁定。
// 覆盖：async 链 realpath 去重（W2①）、project-host 槽位（W2②）、hostRoots 同标签
// 多根语义（W2④，Map→列表 + 硬编码槽合并原根后置）、单层扫描维持（红线 3）、
// pi 单条目形态回归快照（回归红线：Map→列表是行为敏感改动）。
// 设计权威源：docs/design/subagent-core-convergence.md §3.2 D-2 / §3.3 红线 1-4。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 隔离真实用户全局目录（~/.agents/agents/）——与 resource-discovery.test.ts 同款
// 手法：mock homedir 到真实 tmpdir 子目录（macOS SIP 禁止 mkdir /nonexistent-*）。
const mockHomeDir = vi.hoisted(() => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  return fs.mkdtempSync(path.join(os.tmpdir(), "res-disc-hr-home-"));
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomeDir };
});

import { discoverResources } from "../resource-discovery.ts";
// logger spy 断言（facade 同 component 单例引用，spyOn 即拦截模块内 logger 调用）
import { getLogger } from "../../core/logger.ts";
import type { DiscoveryRoot } from "../../core/host-services.ts";

// ============================================================
// helpers（与 resource-discovery.test.ts 同构）
// ============================================================

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "res-disc-hr-"));
}

function writeFile(dir: string, name: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function writePackageJson(pkgDir: string, pi?: Record<string, unknown>): void {
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "test-pkg", ...(pi ? { pi } : {}) }),
    "utf-8",
  );
}

/** pi 壳单条目形态三根（agentDirKindRoots 同构）：user-pi / npm / npm-dev。 */
function piHostRoots(agentDir: string, kind: "agents" | "workflows"): DiscoveryRoot[] {
  return [
    { dir: path.join(agentDir, kind), source: "user-pi" },
    { dir: path.join(agentDir, "npm", "node_modules"), source: "npm" },
    { dir: path.join(agentDir, "extensions"), source: "npm-dev" },
  ];
}

// ============================================================
// W2①: async 链 realpath 去重（多链同文件）
// ============================================================

describe("C2 W2①: async 链 realpath 去重", () => {
  let ws: string;

  beforeEach(() => {
    ws = tmpWorkspace();
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("多链同文件（a.md 本体 + b.md symlink → a.md）清单只留 1 条", async () => {
    const agentDir = path.join(ws, ".fake-agent");
    const dir = path.join(agentDir, "agents");
    const realFile = writeFile(dir, "a.md", "shared-body");
    fs.symlinkSync(realFile, path.join(dir, "b.md"));

    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: piHostRoots(agentDir, "agents"),
    });

    // stem 去重（a/b 不同 stem）防不住多链同文件——realpath 归一后只留首遇者 a.md
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe(realFile);
    expect(result[0]?.source).toBe("user-pi");
  });

  it("多链同文件不是遮蔽——不产生 duplicate 遮蔽报告（warn/debug 均无）", async () => {
    const agentDir = path.join(ws, ".fake-agent");
    const dir = path.join(agentDir, "agents");
    const realFile = writeFile(dir, "a.md", "shared-body");
    fs.symlinkSync(realFile, path.join(dir, "b.md"));

    const warnSpy = vi.spyOn(getLogger("subagents"), "warn");
    const debugSpy = vi.spyOn(getLogger("subagents"), "debug");
    try {
      await discoverResources({
        kind: "agents",
        workspaceRoot: ws,
        hostRoots: piHostRoots(agentDir, "agents"),
      });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it("跨源多链同文件同样归一（user-pi 链 + user-agents 硬编码根链 → 1 条）", async () => {
    const agentDir = path.join(ws, ".fake-agent");
    // 物理文件在 ws 库目录；user-pi 根与 user-agents 硬编码根各挂一个不同名 symlink
    const libFile = writeFile(path.join(ws, "lib"), "origin.md", "lib-body");
    const userPiLink = path.join(agentDir, "agents", "alpha.md");
    fs.mkdirSync(path.dirname(userPiLink), { recursive: true });
    fs.symlinkSync(libFile, userPiLink);
    const userAgentsLink = path.join(mockHomeDir, ".agents", "agents", "beta.md");
    fs.mkdirSync(path.dirname(userAgentsLink), { recursive: true });
    fs.symlinkSync(libFile, userAgentsLink);

    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: piHostRoots(agentDir, "agents"),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe(userPiLink); // 首遇者（user-pi 序位在前）
    expect(result[0]?.source).toBe("user-pi");
    // 清理 mockHome 内 fixture
    fs.rmSync(userAgentsLink, { force: true });
  });

  it("同 stem 不同物理文件仍按 last-writer-wins 覆盖（realpath 去重不伤遮蔽语义）", async () => {
    const agentDir = path.join(ws, ".fake-agent");
    writeFile(path.join(agentDir, "agents"), "clash.md", "user-pi-body");
    writeFile(path.join(ws, ".agents", "agents"), "clash.md", "project-body");

    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: piHostRoots(agentDir, "agents"),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("project-agents"); // 高优先级覆盖，语义不变
    expect(result[0]?.path).toBe(path.join(ws, ".agents", "agents", "clash.md"));
  });
});

// ============================================================
// W2④: hostRoots 同标签多根语义（Map→列表）
// ============================================================

describe("C2 W2④: hostRoots 同标签多根语义", () => {
  let ws: string;
  let agentDir: string;

  beforeEach(() => {
    ws = tmpWorkspace();
    agentDir = path.join(ws, ".fake-agent");
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("同标签两条 user-pi 根都被扫描（非靠后者整体覆盖）", async () => {
    const root1 = path.join(ws, "multi-root-a");
    const root2 = path.join(ws, "multi-root-b");
    writeFile(root1, "one.md", "one");
    writeFile(root2, "two.md", "two");

    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: [
        { dir: root1, source: "user-pi" },
        { dir: root2, source: "user-pi" },
        { dir: path.join(agentDir, "npm", "node_modules"), source: "npm" },
        { dir: path.join(agentDir, "extensions"), source: "npm-dev" },
      ],
    });

    // 旧 Map 语义：root2 覆盖 root1 → one.md 消失；列表语义：两根同序位依次扫描
    const userPi = result.filter((r) => r.source === "user-pi");
    expect(userPi.map((r) => path.basename(r.path)).sort()).toEqual(["one.md", "two.md"]);
  });

  it("同标签多根 + 同 stem 撞名：后注入的本体根胜（红线 2 本体在后）", async () => {
    // 宿主（zsw）注入形态：目录 symlink 展开目标在前、本体根在后
    const expanded = path.join(ws, "expanded-from-lib");
    const own = path.join(ws, "own-agents");
    writeFile(expanded, "shared.md", "lib-body");
    writeFile(own, "shared.md", "own-body");

    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: [
        { dir: expanded, source: "user-pi" },
        { dir: own, source: "user-pi" },
        { dir: path.join(agentDir, "npm", "node_modules"), source: "npm" },
        { dir: path.join(agentDir, "extensions"), source: "npm-dev" },
      ],
    });

    expect(result).toHaveLength(1);
    // core 合并 last-writer-wins（靠后者胜）→ 本体根注入在后 = 本体胜
    expect(result[0]?.path).toBe(path.join(own, "shared.md"));
    expect(result[0]?.source).toBe("user-pi");
  });

  it("user-agents 标签注入与硬编码根合并（硬编码本体根在后 = 硬编码胜）", async () => {
    const injected = path.join(ws, "inj-agents");
    writeFile(injected, "h.md", "injected-body");
    const hardFile = writeFile(path.join(mockHomeDir, ".agents", "agents"), "h.md", "hard-body");

    try {
      const result = await discoverResources({
        kind: "agents",
        workspaceRoot: ws,
        hostRoots: [
          { dir: injected, source: "user-agents" },
          { dir: path.join(agentDir, "npm", "node_modules"), source: "npm" },
          { dir: path.join(agentDir, "extensions"), source: "npm-dev" },
        ],
      });

      expect(result).toHaveLength(1);
      // 注入条目在前、硬编码根（本体）在后——last-writer-wins 落硬编码
      expect(result[0]?.path).toBe(hardFile);
      expect(result[0]?.source).toBe("user-agents");
    } finally {
      fs.rmSync(path.join(mockHomeDir, ".agents", "agents", "h.md"), { force: true });
    }
  });

  it("project-agents 标签注入与硬编码根合并（硬编码本体根在后 = 硬编码胜）", async () => {
    const injected = path.join(ws, "inj-proj-agents");
    writeFile(injected, "p.md", "injected-body");
    const hardFile = writeFile(path.join(ws, ".agents", "agents"), "p.md", "hard-body");

    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: [
        { dir: injected, source: "project-agents" },
        { dir: path.join(agentDir, "npm", "node_modules"), source: "npm" },
        { dir: path.join(agentDir, "extensions"), source: "npm-dev" },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe(hardFile);
    expect(result[0]?.source).toBe("project-agents");
  });

  it("project-host 标签同标签多根依注入序生效（project-host 支持列表语义）", async () => {
    const r1 = path.join(ws, "ph-root-a");
    const r2 = path.join(ws, "ph-root-b");
    writeFile(r1, "ph1.md", "one");
    writeFile(r2, "ph2.md", "two");

    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: [
        { dir: r1, source: "project-host" },
        { dir: r2, source: "project-host" },
      ],
    });

    const ph = result.filter((r) => r.source === "project-host");
    expect(ph.map((r) => path.basename(r.path)).sort()).toEqual(["ph1.md", "ph2.md"]);
  });
});

// ============================================================
// W2②: project-host 槽位序位
// ============================================================

describe("C2 W2②: project-host 槽位序位", () => {
  let ws: string;
  let agentDir: string;
  let hostRoot: string;

  beforeEach(() => {
    ws = tmpWorkspace();
    agentDir = path.join(ws, ".fake-agent");
    hostRoot = path.join(ws, ".zcode", "agents");
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("project-host 同名被 project-agents 遮蔽（project-agents 是项目级最高逃生门）", async () => {
    writeFile(hostRoot, "clash.md", "host-body");
    writeFile(path.join(ws, ".agents", "agents"), "clash.md", "proj-body");

    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: [
        ...piHostRoots(agentDir, "agents"),
        { dir: hostRoot, source: "project-host" },
      ],
    });

    const clash = result.find((r) => path.basename(r.path) === "clash.md");
    expect(clash?.source).toBe("project-agents");
    expect(clash?.path).toBe(path.join(ws, ".agents", "agents", "clash.md"));
  });

  it("project-host 压过 project-pi（序位：project-pi < project-pi-tmp < project-host）", async () => {
    writeFile(path.join(ws, ".pi", "agents"), "ph.md", "pi-body");
    writeFile(hostRoot, "ph.md", "host-body");

    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: [
        ...piHostRoots(agentDir, "agents"),
        { dir: hostRoot, source: "project-host" },
      ],
    });

    const ph = result.find((r) => path.basename(r.path) === "ph.md");
    expect(ph?.source).toBe("project-host");
    expect(ph?.path).toBe(path.join(hostRoot, "ph.md"));
  });

  it("宿主未注入 project-host 标签时槽位缺席（输出无 project-host 条目）", async () => {
    writeFile(path.join(ws, ".pi", "agents"), "only.md", "body");
    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: piHostRoots(agentDir, "agents"),
    });
    expect(result.filter((r) => r.source === "project-host")).toEqual([]);
    expect(result.map((r) => path.basename(r.path))).toEqual(["only.md"]);
  });
});

// ============================================================
// 红线 3: 单层扫描维持（不递归 / node_modules 不灌清单）
// ============================================================

describe("C2 红线 3: 单层扫描维持", () => {
  let ws: string;
  let agentDir: string;

  beforeEach(() => {
    ws = tmpWorkspace();
    agentDir = path.join(ws, ".fake-agent");
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("子目录不递归（nested/deep.md 不入清单）", async () => {
    writeFile(path.join(ws, ".pi", "agents", "nested"), "deep.md", "body");
    writeFile(path.join(ws, ".pi", "agents"), "top.md", "body");

    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: piHostRoots(agentDir, "agents"),
    });

    const project = result.filter((r) => r.source === "project-pi");
    expect(project.map((r) => path.basename(r.path))).toEqual(["top.md"]);
  });

  it("源目录内 node_modules 目录在单层语义下不灌清单", async () => {
    // user-pi 根内的 node_modules/ 是目录（非 .md 文件）——单层扫描不展开
    writeFile(path.join(agentDir, "agents", "node_modules", "some-pkg"), "pkg-agent.md", "body");
    writeFile(path.join(agentDir, "agents"), "real.md", "body");

    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: piHostRoots(agentDir, "agents"),
    });

    const userPi = result.filter((r) => r.source === "user-pi");
    expect(userPi.map((r) => path.basename(r.path))).toEqual(["real.md"]);
  });
});

// ============================================================
// 回归红线: pi 单条目形态快照（Map→列表行为敏感改动的锁定）
// ============================================================

describe("C2 回归红线: pi 单条目形态快照", () => {
  let ws: string;
  let agentDir: string;

  beforeEach(() => {
    ws = tmpWorkspace();
    agentDir = path.join(ws, ".fake-agent");
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("与 pi 真实 agentDir 同构 fixture——source 标签与胜出路径逐项稳定", async () => {
    // fixture 同构本机真实 agentDir（probe-c2 探针 2026-08-30 输出形态）：
    // user-pi 三文件 / npm 包 10 内置角色（pi.agents manifest）/ user-agents 撞名
    // tech-design-review / npm-dev 一包 / project 两源为空
    writeFile(path.join(agentDir, "agents"), "general-purpose.md", "user-pi-gp");
    writeFile(path.join(agentDir, "agents"), "tech-design-review.md", "user-pi-tdr");
    writeFile(path.join(agentDir, "agents"), "vision-analyze.md", "user-pi-va");
    writeFile(path.join(mockHomeDir, ".agents", "agents"), "tech-design-review.md", "user-agents-tdr");

    const npmPkg = path.join(agentDir, "npm", "node_modules", "@zhushanwen", "pi-subagent-workflow");
    writePackageJson(npmPkg, { agents: ["./agents"] });
    for (const role of [
      "general-purpose", "analyst", "coder", "debugger", "doc-reviewer",
      "explorer", "orchestrator", "planner", "researcher", "reviewer",
    ]) {
      writeFile(path.join(npmPkg, "agents"), `${role}.md`, `npm-${role}`);
    }

    const devPkg = path.join(agentDir, "extensions", "local-dev-pkg");
    writePackageJson(devPkg); // 无 pi manifest → 约定目录
    writeFile(path.join(devPkg, "agents"), "dev-extra.md", "npm-dev-body");

    try {
      const result = await discoverResources({
        kind: "agents",
        workspaceRoot: ws,
        hostRoots: piHostRoots(agentDir, "agents"),
      });

      // 逐项断言（序 = stem 首插序，值 = last-writer-wins 胜出者）：
      // 前 3 个 stem 首插于 user-pi（真实探针同构），general-purpose 被 npm 覆盖、
      // tech-design-review 被 user-agents 覆盖（胜出 source/路径随之变化、位置不动）
      expect(
        result.map((r) => ({ source: r.source, base: path.basename(r.path) })),
      ).toEqual([
        { source: "npm", base: "general-purpose.md" },
        { source: "user-agents", base: "tech-design-review.md" },
        { source: "user-pi", base: "vision-analyze.md" },
        { source: "npm", base: "analyst.md" },
        { source: "npm", base: "coder.md" },
        { source: "npm", base: "debugger.md" },
        { source: "npm", base: "doc-reviewer.md" },
        { source: "npm", base: "explorer.md" },
        { source: "npm", base: "orchestrator.md" },
        { source: "npm", base: "planner.md" },
        { source: "npm", base: "researcher.md" },
        { source: "npm", base: "reviewer.md" },
        { source: "npm-dev", base: "dev-extra.md" },
      ]);
      // 胜出路径逐项锚定（绝对路径，非仅 basename）
      expect(result[0]?.path).toBe(path.join(npmPkg, "agents", "general-purpose.md"));
      expect(result[1]?.path).toBe(path.join(mockHomeDir, ".agents", "agents", "tech-design-review.md"));
      expect(result[2]?.path).toBe(path.join(agentDir, "agents", "vision-analyze.md"));
      expect(result[12]?.path).toBe(path.join(devPkg, "agents", "dev-extra.md"));
    } finally {
      fs.rmSync(path.join(mockHomeDir, ".agents", "agents", "tech-design-review.md"), { force: true });
    }
  });
});
