// src/shared/__tests__/resource-discovery.test.ts
//
// 统一资源发现模块测试（ADR-031）。
// 验证：扫描源覆盖、优先级合并、manifest 校验、约定目录 fallback。
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 隔离真实用户全局目录：resource-discovery 用 homedir() 推导 user-agents 源
// （~/.agents/agents/），测试环境可能存在真实 agent 文件（如 tech-design-review.md），
// 不 mock 会导致「期望空列表/精确列表」用例被环境污染（2026-08 实测 4 个失败）。
// 用真实 tmpdir 下的子目录作 mock homedir（macOS SIP 禁止 mkdir /nonexistent-*）。
const mockHomeDir = vi.hoisted(() => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "res-disc-home-"));
  return dir;
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHomeDir };
});

// manifestCache 计数（原 resource-discovery-manifest-cache.test.ts 手法迁编）：
// 透传 actual 实现 + vi.fn 计数，行为零变化——async readPackageManifest 的
// readFile 计数断言依赖此包装（ESM 下 node:fs/promises 不可直接 spyOn）。
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(
      (...args: Parameters<typeof actual.readFile>) => actual.readFile(...args),
    ),
  };
});

import {
  discoverResources,
  findWorkspaceRoot,
  getCachedFile,
  getCachedFileContent,
  __testResetShadowDedup,
  __testInjectShadowDedupKey,
  isMachineSource,
  getCachedParsed,
  clearFileCache,
  type ResourceSource,
} from "../resource-discovery.ts";
// logger 断言目标随源切换（u0-data-discovery）：resource-discovery 的 logger 是
// core facade（同 component 单例引用），spyOn facade 实例即拦截模块内 logger 调用
import { getLogger } from "../../core/logger.ts";

// ============================================================
// helpers
// ============================================================

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "res-disc-test-"));
}

/** 与 pi 壳 agentDirKindRoots 同构的注入根：由旧 ScanConfig.agentDir 入参等价推导
 *  （user-pi 根 = <agentDir>/<kind>，npm 根 = <agentDir>/npm/node_modules，npm-dev
 *  根 = <agentDir>/extensions）——扫描目录与形状改造前逐字一致，expected 断言不动。 */
function hostRootsFor(agentDir: string, kind: "agents" | "workflows") {
  return [
    { dir: path.join(agentDir, kind), source: "user-pi" },
    { dir: path.join(agentDir, "npm", "node_modules"), source: "npm" },
    { dir: path.join(agentDir, "extensions"), source: "npm-dev" },
  ];
}

function writeFile(dir: string, name: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function writePackageJson(pkgDir: string, pi: Record<string, unknown> | undefined): void {
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "test-pkg", pi }),
    "utf-8",
  );
}

/** 定值 mtime（整数 ms，消除浮点 mtime 与 utimesSync 恢复的精度差）。 */
const T1 = new Date("2026-01-01T00:00:00Z");
const T2 = new Date("2026-01-01T00:00:10Z");

function setMtime(filePath: string, t: Date): void {
  fs.utimesSync(filePath, t, t);
}

/** node:fs/promises readFile 包装计数（async manifestCache 读者）。 */
function asyncReadCount(): number {
  return vi.mocked(fsp.readFile).mock.calls.length;
}

// ============================================================
// findWorkspaceRoot
// ============================================================

describe("findWorkspaceRoot", () => {
  it("returns cwd when no marker found", () => {
    const ws = tmpWorkspace();
    expect(findWorkspaceRoot(ws)).toBe(ws);
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("finds .git root", () => {
    const ws = tmpWorkspace();
    fs.mkdirSync(path.join(ws, ".git"));
    const sub = path.join(ws, "sub", "deep");
    fs.mkdirSync(sub, { recursive: true });
    expect(findWorkspaceRoot(sub)).toBe(ws);
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
});

// ============================================================
// discoverResources (async) — 基本冒烟
// ============================================================

describe("discoverResources (async)", () => {
  let ws: string;

  beforeEach(() => {
    ws = tmpWorkspace();
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    __testResetShadowDedup();
  });

  it("discovers agents from project .pi/agents/ (async)", async () => {
    writeFile(path.join(ws, ".pi", "agents"), "worker.md", "body");
    const result = await discoverResources({
      kind: "agents",
      workspaceRoot: ws,
      hostRoots: hostRootsFor(path.join(ws, ".fake-agent"), "agents"),
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.available).toBe(true);
  });

  it("discovers workflows with tmp source (async)", async () => {
    writeFile(path.join(ws, ".pi", "workflows"), "build.js", "x");
    writeFile(path.join(ws, ".pi", "workflows", ".tmp"), "temp.js", "x");
    const result = await discoverResources({
      kind: "workflows",
      workspaceRoot: ws,
      hostRoots: hostRootsFor(path.join(ws, ".fake-agent"), "workflows"),
      includeTmp: true,
    });
    expect(result).toHaveLength(2);
  });
});

// ============================================================
// user-extension-paths (TAIJI_EXTENSION_PATHS) — dev-link 扩展发现
// ============================================================

describe("user-extension-paths (TAIJI_EXTENSION_PATHS)", () => {
  let ws: string;
  let agentDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    ws = tmpWorkspace();
    agentDir = path.join(ws, ".fake-agent");
    savedEnv = process.env.TAIJI_EXTENSION_PATHS;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.TAIJI_EXTENSION_PATHS;
    else process.env.TAIJI_EXTENSION_PATHS = savedEnv;
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    __testResetShadowDedup();
  });

  it("async discoverResources also scans user-extension-paths", async () => {
    const pkgDir = path.join(ws, "my-ext");
    writePackageJson(pkgDir, { agents: ["./agents"] });
    writeFile(path.join(pkgDir, "agents"), "async.md", "body");
    process.env.TAIJI_EXTENSION_PATHS = pkgDir;
    const result = await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });
    const ext = result.filter((r) => r.source === "user-extension-paths");
    expect(ext.map((r) => path.basename(r.path))).toEqual(["async.md"]);
    expect(ext[0]?.source).toBe("user-extension-paths");
  });

  it("async: overrides npm on name clash (priority: user-extension-paths > npm)", async () => {
    const npmPkg = path.join(agentDir, "npm", "node_modules", "test-pkg");
    writePackageJson(npmPkg, { agents: ["./agents"] });
    writeFile(path.join(npmPkg, "agents"), "shared.md", "npm-body");
    const devPkg = path.join(ws, "dev-ext");
    writePackageJson(devPkg, { agents: ["./agents"] });
    writeFile(path.join(devPkg, "agents"), "shared.md", "dev-body");
    process.env.TAIJI_EXTENSION_PATHS = devPkg;
    const result = await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });
    const shared = result.find((r) => path.basename(r.path) === "shared.md");
    expect(shared?.source).toBe("user-extension-paths");
  });

  it("async: project-agents overrides user-extension-paths (project wins)", async () => {
    const devPkg = path.join(ws, "dev-ext");
    writePackageJson(devPkg, { agents: ["./agents"] });
    writeFile(path.join(devPkg, "agents"), "x.md", "dev-body");
    writeFile(path.join(ws, ".agents", "agents"), "x.md", "project-body");
    process.env.TAIJI_EXTENSION_PATHS = devPkg;
    const result = await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });
    const x = result.find((r) => path.basename(r.path) === "x.md");
    expect(x?.source).toBe("project-agents");
  });

  it("async: 4 源混合 fixture——输出序 + 优先级", async () => {
    // 源优先级低→高：npm < user-extension-paths < project-pi < project-agents
    const npmPkg = path.join(agentDir, "npm", "node_modules", "test-pkg");
    writePackageJson(npmPkg, { agents: ["./agents"] });
    writeFile(path.join(npmPkg, "agents"), "shared.md", "npm-body");
    const devPkg = path.join(ws, "dev-ext");
    writePackageJson(devPkg, { agents: ["./agents"] });
    writeFile(path.join(devPkg, "agents"), "dev.md", "dev-body");
    writeFile(path.join(ws, ".pi", "agents"), "pi.md", "pi-body");
    writeFile(path.join(ws, ".agents", "agents"), "shared.md", "project-body");
    writeFile(path.join(ws, ".agents", "agents"), "proj.md", "proj-body");
    process.env.TAIJI_EXTENSION_PATHS = devPkg;
    const config = { kind: "agents" as const, workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") };

    const asyncResult = await discoverResources(config);

    // 输出序：stem 首次插入位置固定（低优先级源先入 Map），同名后续覆盖值不移位
    expect(asyncResult.map((r) => path.basename(r.path))).toEqual([
      "shared.md", // 首现于 npm（最低源），位置固定
      "dev.md", // user-extension-paths
      "pi.md", // project-pi
      "proj.md", // project-agents
    ]);
    // 优先级：shared.md 两源同名，project-agents（高）last-writer-wins
    expect(asyncResult.find((r) => path.basename(r.path) === "shared.md")?.source).toBe(
      "project-agents",
    );
  });

  it("async: 同名遮蔽时机器源×机器源降 debug 不产生 warn（D8d 分级）", async () => {
    const npmPkg = path.join(agentDir, "npm", "node_modules", "test-pkg");
    writePackageJson(npmPkg, { agents: ["./agents"] });
    const npmFile = writeFile(path.join(npmPkg, "agents"), "dup.md", "npm-body");
    const projFile = writeFile(path.join(ws, ".agents", "agents"), "dup.md", "project-body");
    const warnSpy = vi.spyOn(getLogger("subagents"), "warn");
    const debugSpy = vi.spyOn(getLogger("subagents"), "debug");

    try {
      const result = await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });

      // 遮蔽仍生效（last-writer-wins 语义不变）
      expect(result.find((r) => path.basename(r.path) === "dup.md")?.source).toBe("project-agents");
      // npm 与 project-agents 均为机器源 → 降级 debug，不产生 warn
      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledTimes(1);
      const [msg, data] = debugSpy.mock.calls[0];
      expect(String(msg)).toContain('duplicate agents "dup"');
      expect(String(msg)).toContain("project-agents shadows npm");
      expect(data).toMatchObject({ shadowed: npmFile, kept: projFile });
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it("(a) 机器源×用户源降 debug：npm vs user-pi 不产生 warn", async () => {
    // npm 源（机器源）与 user-pi 源（用户源）——任一侧为机器源即降 debug
    const npmPkg = path.join(agentDir, "npm", "node_modules", "test-pkg");
    writePackageJson(npmPkg, { agents: ["./agents"] });
    writeFile(path.join(npmPkg, "agents"), "dup.md", "npm-body");
    // user-pi 源 = agentDir/<kind>/（agentDir 是独立于 homedir mock 的入参，
    // mockHomeDir 由 vi.hoisted mkdtempSync 创建真实 tmpdir）
    writeFile(path.join(agentDir, "agents"), "dup.md", "user-pi-body");
    const warnSpy = vi.spyOn(getLogger("subagents"), "warn");
    const debugSpy = vi.spyOn(getLogger("subagents"), "debug");

    try {
      await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalled();
      const [msg] = debugSpy.mock.calls[0];
      expect(String(msg)).toContain('duplicate agents "dup"');
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it("(a) npm vs user-extension-paths 机器源×机器源降 debug", async () => {
    // 两个机器源同名（npm 包 vs TAIJI_EXTENSION_PATHS 注入的 dev 包，后者 source 标签为 user-extension-paths）
    const npmPkg = path.join(agentDir, "npm", "node_modules", "test-pkg");
    writePackageJson(npmPkg, { agents: ["./agents"] });
    writeFile(path.join(npmPkg, "agents"), "shared.md", "npm-body");
    const devPkg = path.join(ws, "dev-ext");
    writePackageJson(devPkg, { agents: ["./agents"] });
    writeFile(path.join(devPkg, "agents"), "shared.md", "dev-body");
    process.env.TAIJI_EXTENSION_PATHS = devPkg;
    const warnSpy = vi.spyOn(getLogger("subagents"), "warn");
    const debugSpy = vi.spyOn(getLogger("subagents"), "debug");

    try {
      await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it("(b) 双用户源重复产生 warn 且同进程第二次 discoverResources 不重复（去重生效）", async () => {
    // user-pi 与 user-agents 都是用户源——需要构造两个源都有同名文件
    // user-pi = agentDir/agents/（buildScanTargets 第一个 target）
    // user-agents = mockHomeDir/.agents/agents/（vi.hoisted 创建的真实 tmpdir）
    const userAgentsDir = path.join(mockHomeDir, ".agents", "agents");
    fs.mkdirSync(userAgentsDir, { recursive: true });
    try {
      // user-pi: agentDir/agents/dup.md
      writeFile(path.join(agentDir, "agents"), "dup.md", "user-pi-body");
      // user-agents: mockHomeDir/.agents/agents/dup.md
      fs.writeFileSync(path.join(userAgentsDir, "dup.md"), "user-agents-body", "utf-8");

      const warnSpy = vi.spyOn(getLogger("subagents"), "warn");

      try {
        // 第一次调用——应产生 warn（双用户源）
        await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [msg] = warnSpy.mock.calls[0];
        expect(String(msg)).toContain('duplicate agents "dup"');

        // 第二次调用——同进程去重，不再报
        warnSpy.mockClear();
        await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      fs.rmSync(userAgentsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("(c) path 变化（新 key）重新报 warn", async () => {
    const userAgentsDir = path.join(mockHomeDir, ".agents", "agents");
    fs.mkdirSync(userAgentsDir, { recursive: true });
    try {
      writeFile(path.join(agentDir, "agents"), "dup.md", "user-pi-body");
      fs.writeFileSync(path.join(userAgentsDir, "dup.md"), "user-agents-body", "utf-8");

      const warnSpy = vi.spyOn(getLogger("subagents"), "warn");

      try {
        // 第一次调用——报 warn
        await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });
        expect(warnSpy).toHaveBeenCalledTimes(1);

        // 第二次调用——同 key 去重，不报
        warnSpy.mockClear();
        await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });
        expect(warnSpy).not.toHaveBeenCalled();

        // 真实 path 变化产生新 key：双用户目录各加一个不同 stem（dup2.md）
        // → 新遮蔽对（新 stem 新 path）→ 新 key → 重新报
        writeFile(path.join(agentDir, "agents"), "dup2.md", "user-pi-body-2");
        fs.writeFileSync(path.join(userAgentsDir, "dup2.md"), "user-agents-body-2", "utf-8");
        warnSpy.mockClear();
        await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [newMsg] = warnSpy.mock.calls[0];
        expect(String(newMsg)).toContain('duplicate agents "dup2"');
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      fs.rmSync(userAgentsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("分级穷举：全部 9 个 ResourceSource 的机器/用户归属与 D3 一致", () => {
    // 封闭枚举逐值断言，防止未来新增/修改枚举值时分级边界漂移
    // （W2② 新增 project-host——项目级宿主注入根，机器源）
    const machine: ResourceSource[] = ["npm", "npm-dev", "user-extension-paths", "project-pi", "project-pi-tmp", "project-host", "project-agents"];
    const user: ResourceSource[] = ["user-pi", "user-agents"];
    for (const s of machine) expect(isMachineSource(s), `${s} 应为机器源`).toBe(true);
    for (const s of user) expect(isMachineSource(s), `${s} 应为用户源`).toBe(false);
  });

  it("(d) cap 清空行为：超限后 clear 再 add，之前报过的 key 可重新报", async () => {
    const userAgentsDir = path.join(mockHomeDir, ".agents", "agents");
    fs.mkdirSync(userAgentsDir, { recursive: true });
    try {
      writeFile(path.join(agentDir, "agents"), "dup.md", "user-pi-body");
      fs.writeFileSync(path.join(userAgentsDir, "dup.md"), "user-agents-body", "utf-8");

      const warnSpy = vi.spyOn(getLogger("subagents"), "warn");

      try {
        // 步骤 1：首次调用——报 warn，dedup key 加入 set
        await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        warnSpy.mockClear();

        // 步骤 2：重置 set，注入 1024 个虚拟 key（不含 dedup key）
        // 使 set.size = MAX，dedup key 不在 set 中
        __testResetShadowDedup();
        for (let i = 0; i < 1024; i++) {
          __testInjectShadowDedupKey(`fake|key${i}|/a|/b`);
        }

        // 步骤 3：第二次调用——dedup key 不在 set → 进 else 分支 →
        // size(1024) >= MAX(1024) → clear() → set 空 → add dedup key → warn
        await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        warnSpy.mockClear();

        // 步骤 4：第三次调用——dedup key 在 set 中 → 去重跳过 warn
        await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });
        expect(warnSpy).not.toHaveBeenCalled();

        // 步骤 5：再次填充到 cap——重置 + 注入 1024 个虚拟 key
        // dedup key（步骤 3 add 的）已被 reset 清除
        __testResetShadowDedup();
        for (let i = 0; i < 1024; i++) {
          __testInjectShadowDedupKey(`fake2|key${i}|/a|/b`);
        }

        // 步骤 6：第四次调用——cap 再次触发 clear → dedup key 重新报
        await discoverResources({ kind: "agents", workspaceRoot: ws, hostRoots: hostRootsFor(agentDir, "agents") });
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
        __testResetShadowDedup();
      }
    } finally {
      fs.rmSync(userAgentsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── m5 TC4/TC5: 统一 mtime 缓存层（P-cache / P-cache-invalidation） ──

describe("m5: 统一 mtime 缓存层", () => {
  it("TC4a: P-cache——文件未变时二次读取命中同一缓存条目（对象引用）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-cache-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "---\nname: x\ndescription: y\n---\nbody", "utf-8");
    try {
      // ESM 下 node:fs 不可 spy（vitest 限制）——命中断言用对象引用：
      // getCachedFile 命中时返回缓存条目对象本身（非新建）
      const first = getCachedFile(f);
      const second = getCachedFile(f);
      expect(first?.content).toBe("---\nname: x\ndescription: y\n---\nbody");
      expect(second).toBe(first); // 同引用 = 命中缓存（未重 read）
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("TC4b: P-cache——两处消费方（getCachedFile/getCachedFileContent）共享同一缓存条目", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-cache2-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "---\nname: x\ndescription: y\n---\nbody", "utf-8");
    try {
      const a = getCachedFile(f);
      const b = getCachedFileContent(f);
      // 内容一致性（命中语义由 TC4a 的对象引用断言覆盖——此处验证两 API 一致）
      expect(a?.content).toBe(b);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("TC5: P-cache-invalidation——改内容（mtime 变）后重读新内容；删文件后驱逐", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m5-cache3-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "v1", "utf-8");
    try {
      expect(getCachedFileContent(f)).toBe("v1");
      fs.writeFileSync(f, "v2", "utf-8");
      expect(getCachedFileContent(f)).toBe("v2"); // mtime 变 → 重读
      // 删除 → 驱逐（不再返回旧内容）
      fs.rmSync(f);
      expect(getCachedFileContent(f)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── KV-cache 稳定性改造：解析结果缓存 getCachedParsed ──

describe("getCachedParsed（mtime 级解析缓存）", () => {
  beforeEach(() => {
    clearFileCache();
  });

  it("mtime 未变时 parse 只跑一次（缓存解析结果）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parsed-cache-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "---\nname: x\ndescription: y\n---", "utf-8");
    try {
      const parse = vi.fn((content: string) => (content.includes("name: x") ? "OK" : "BAD"));
      const first = getCachedParsed(f, parse);
      const second = getCachedParsed(f, parse);
      expect(first).toBe("OK");
      expect(second).toBe("OK");
      expect(parse).toHaveBeenCalledTimes(1); // 第二次命中缓存，不重 parse
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("mtime 变后重新 parse；文件删除后返回 null 并驱逐", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parsed-cache2-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "v1", "utf-8");
    try {
      const parse = (content: string) => content;
      expect(getCachedParsed(f, parse)).toBe("v1");
      fs.writeFileSync(f, "v2", "utf-8");
      expect(getCachedParsed(f, parse)).toBe("v2"); // mtime 变 → 重新 parse
      fs.rmSync(f);
      expect(getCachedParsed(f, parse)).toBeNull(); // 删除 → null
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("clearFileCache 同时清空解析缓存", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parsed-cache3-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "content", "utf-8");
    try {
      const parse = vi.fn(() => "OK");
      getCachedParsed(f, parse);
      clearFileCache();
      getCachedParsed(f, parse);
      expect(parse).toHaveBeenCalledTimes(2); // 缓存被清 → 重新 parse
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("同一 path 的不同 parse 各自独立缓存（缓存键含 parse 身份，防跨 parse 污染）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parsed-cache4-"));
    const f = path.join(dir, "a.md");
    fs.writeFileSync(f, "shared-content", "utf-8");
    try {
      // 模拟真实双 parse 场景：parseAgentFrontmatter vs parseWorkflowMeta 对同一
      // path（agent 与 workflow 发现源理论上可命中同一路径）各自解析
      const parseA = (content: string) => ({ kind: "agent" as const, content });
      const parseW = (content: string) => ({ kind: "workflow" as const, len: content.length });
      const a1 = getCachedParsed(f, parseA);
      // 修复前：缓存键只有 path，这里会命中 parseA 的缓存条目并 as T 断言返回
      // {kind:"agent"}——w1 被污染成错误类型
      const w1 = getCachedParsed(f, parseW);
      const a2 = getCachedParsed(f, parseA);
      expect(a1).toEqual({ kind: "agent", content: "shared-content" });
      expect(w1).toEqual({ kind: "workflow", len: 14 });
      expect(a2).toEqual({ kind: "agent", content: "shared-content" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});

// ── manifestCache（async readPackageManifest）缓存语义 ──
// 原 resource-discovery-manifest-cache.test.ts 的 async 侧语义迁编（C3 sync 轨删除：
// sync 读者消亡，双读者共享用例随之前提失效；读计数断言改走 node:fs/promises 包装）。
// readPackageManifest 是 module 私有，经 TAIJI_EXTENSION_PATHS → discoverResources 路径驱动；
// 其余源（user-agents / npm / project）无 package.json 可读，asyncReadCount 即
// pkgDir/package.json 的精确读计数。

describe("manifestCache（async readPackageManifest）", () => {
  let ws: string;
  let pkgDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    clearFileCache();
    vi.mocked(fsp.readFile).mockClear();
    ws = tmpWorkspace();
    pkgDir = path.join(ws, "my-ext");
    savedEnv = process.env.TAIJI_EXTENSION_PATHS;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.TAIJI_EXTENSION_PATHS;
    else process.env.TAIJI_EXTENSION_PATHS = savedEnv;
    fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  function extConfig(kind: "agents" | "workflows") {
    return { kind, workspaceRoot: ws, hostRoots: hostRootsFor(path.join(ws, ".fake-agent"), kind) };
  }

  it("命中：同 mtime 二次 discoverResources 不重读（async readFile 计数不增）", async () => {
    writePackageJson(pkgDir, { agents: ["./agents"] });
    writeFile(path.join(pkgDir, "agents"), "a.md", "body");
    setMtime(path.join(pkgDir, "package.json"), T1);
    process.env.TAIJI_EXTENSION_PATHS = pkgDir;

    const r1 = await discoverResources(extConfig("agents"));
    const ext1 = r1.filter((r) => r.source === "user-extension-paths");
    expect(ext1.map((r) => path.basename(r.path))).toEqual(["a.md"]);
    const first = asyncReadCount();
    expect(first).toBeGreaterThanOrEqual(1); // manifest 首读确实发生

    const r2 = await discoverResources(extConfig("agents"));
    // 同 mtime：manifestCache 命中，readFile 计数不增
    expect(asyncReadCount()).toBe(first);
    expect(r2.filter((r) => r.source === "user-extension-paths")).toHaveLength(1);
  });

  it("kind 共享一次 parse：同 package.json 的 agents/workflows 两 kind 只读一次", async () => {
    writePackageJson(pkgDir, { agents: ["./agents"], workflows: ["./w.js"] });
    writeFile(path.join(pkgDir, "agents"), "a.md", "body");
    writeFile(pkgDir, "w.js", "const meta={name:'w'};");
    setMtime(path.join(pkgDir, "package.json"), T1);
    process.env.TAIJI_EXTENSION_PATHS = pkgDir;

    const rAgents = await discoverResources(extConfig("agents"));
    expect(rAgents.filter((r) => r.source === "user-extension-paths").map((r) => path.basename(r.path)))
      .toEqual(["a.md"]);
    const afterFirst = asyncReadCount();
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    const rWorkflows = await discoverResources(extConfig("workflows"));
    expect(rWorkflows.filter((r) => r.source === "user-extension-paths").map((r) => path.basename(r.path)))
      .toEqual(["w.js"]);
    // 两 kind 共享同一条目：第二次调用命中缓存，不重 read
    expect(asyncReadCount()).toBe(afterFirst);
  });

  it("失效：package.json 重写（mtime 变）→ 重读新 manifest（计数递增 + 新内容生效）", async () => {
    writePackageJson(pkgDir, { agents: ["./agents"] });
    writeFile(path.join(pkgDir, "agents"), "a.md", "body");
    setMtime(path.join(pkgDir, "package.json"), T1);
    process.env.TAIJI_EXTENSION_PATHS = pkgDir;
    await discoverResources(extConfig("agents"));
    const first = asyncReadCount();

    // 重写 manifest 声明不存在的路径：不需显式设 mtime（新写入 mtime 必 ≠ 定值 T1）
    writePackageJson(pkgDir, { agents: ["./gone.md"] });
    const r2 = await discoverResources(extConfig("agents"));
    // mtime 变 → 重读（计数 +1）→ 新声明生效：路径不存在 → available=false 占位
    expect(asyncReadCount()).toBe(first + 1);
    const ext2 = r2.filter((r) => r.source === "user-extension-paths");
    expect(ext2).toHaveLength(1);
    expect(path.basename(ext2[0]?.path ?? "")).toBe("gone.md");
    expect(ext2[0]?.available).toBe(false);
  });

  // ── 失败/边缘路径（原 resource-discovery-manifest-cache.test.ts 迁编，impl-plan
  //    偏差 #9：缺则将对应用例改写为 async 形态并入，不丢缓存行为覆盖）。原版直接
  //    断言 readPackageManifestSync 返回值；async 形态观察面 = readFile 计数 +
  //    user-extension-paths 结果（manifest undefined → processPackage 约定目录
  //    fallback，pkgDir 无 {kind}/ 目录 → 零资源即 undefined 的行为面）。 ──

  it("坏 JSON → undefined 且不缓存：mtime 未变二次 discover 仍重读（计数递增）", async () => {
    // 起点即坏 JSON（无缓存条目）——若坏结果被缓存，二次调用不会重新 readFile。
    // （good→bad 且 mtime 未变的场景由「命中」用例路径覆盖：mtime 相等直接命中原好条目）
    writeFile(pkgDir, "package.json", "{ broken json");
    setMtime(path.join(pkgDir, "package.json"), T1);
    process.env.TAIJI_EXTENSION_PATHS = pkgDir;

    const r1 = await discoverResources(extConfig("agents"));
    // 坏 JSON → manifest undefined（约定目录 fallback 零资源），不抛
    expect(r1.filter((r) => r.source === "user-extension-paths")).toHaveLength(0);
    const first = asyncReadCount();
    expect(first).toBeGreaterThanOrEqual(1); // 首读确实发生

    const r2 = await discoverResources(extConfig("agents"));
    expect(r2.filter((r) => r.source === "user-extension-paths")).toHaveLength(0);
    // 二次调用仍重新 readFile = 坏结果未入缓存（毒条目永不入缓存）
    expect(asyncReadCount()).toBe(first + 1);
  });

  it("坏 JSON 不驱逐已有好条目：恢复原内容 + 原 mtime → 命中原条目（readFile 不增）", async () => {
    writePackageJson(pkgDir, { agents: ["./agents"] });
    writeFile(path.join(pkgDir, "agents"), "a.md", "body");
    const pkgJson = path.join(pkgDir, "package.json");
    setMtime(pkgJson, T1);
    process.env.TAIJI_EXTENSION_PATHS = pkgDir;
    await discoverResources(extConfig("agents"));
    const first = asyncReadCount();
    expect(first).toBeGreaterThanOrEqual(1);

    // 改坏且 mtime 变（T2）→ undefined（坏 JSON 路径：不缓存、不驱逐 {T1, pi} 好条目）
    writeFile(pkgDir, "package.json", "{ broken");
    setMtime(pkgJson, T2);
    await discoverResources(extConfig("agents"));
    expect(asyncReadCount()).toBe(first + 1);

    // 恢复原内容 + utimesSync 恢复原 mtime → 若好条目仍在则命中（无第 3 次 read）
    writePackageJson(pkgDir, { agents: ["./agents"] });
    setMtime(pkgJson, T1);
    const r3 = await discoverResources(extConfig("agents"));
    expect(
      r3.filter((r) => r.source === "user-extension-paths").map((r) => path.basename(r.path)),
    ).toEqual(["a.md"]);
    expect(asyncReadCount()).toBe(first + 1); // 无第 3 次 read = 命中保留的原条目
  });

  it("stat 失败（package.json 删除）→ 驱逐条目：重建同内容同 mtime 必重读", async () => {
    writePackageJson(pkgDir, { agents: ["./agents"] });
    writeFile(path.join(pkgDir, "agents"), "a.md", "body");
    const pkgJson = path.join(pkgDir, "package.json");
    setMtime(pkgJson, T1);
    process.env.TAIJI_EXTENSION_PATHS = pkgDir;
    await discoverResources(extConfig("agents"));
    const first = asyncReadCount();
    expect(first).toBeGreaterThanOrEqual(1);

    fs.rmSync(pkgJson);
    await discoverResources(extConfig("agents"));
    expect(asyncReadCount()).toBe(first); // stat 失败路径不触发 readFile

    // 重建同内容 + 恢复同 mtime：条目已被驱逐 → 必重 readFile（计数 +1）
    writePackageJson(pkgDir, { agents: ["./agents"] });
    setMtime(pkgJson, T1);
    const r3 = await discoverResources(extConfig("agents"));
    expect(
      r3.filter((r) => r.source === "user-extension-paths").map((r) => path.basename(r.path)),
    ).toEqual(["a.md"]);
    expect(asyncReadCount()).toBe(first + 1);
  });

  it("无 pi 字段（合法解析结果）也缓存：二次 discover 不重读", async () => {
    writePackageJson(pkgDir, undefined);
    setMtime(path.join(pkgDir, "package.json"), T1);
    process.env.TAIJI_EXTENSION_PATHS = pkgDir;

    const r1 = await discoverResources(extConfig("agents"));
    expect(r1.filter((r) => r.source === "user-extension-paths")).toHaveLength(0);
    const first = asyncReadCount();
    expect(first).toBeGreaterThanOrEqual(1);

    const r2 = await discoverResources(extConfig("agents"));
    expect(r2.filter((r) => r.source === "user-extension-paths")).toHaveLength(0);
    expect(asyncReadCount()).toBe(first); // 合法解析 + 无 manifest → undefined 条目入缓存
  });

  // [review 修复] 非对象 JSON 结构守卫：JSON.parse 对 "42" / '"str"' / "null" 等
  // 合法 JSON 产出非对象值，parsePiField 显式守卫归 undefined（「无 manifest」语义），
  // 不依赖 primitive 装箱 / null 抛 TypeError 落 catch 的巧合。
  it("非对象 JSON（42 / null / string / pi 字段非对象或数组）→ undefined 不抛，按合法解析结果缓存", async () => {
    const cases: Array<{ raw: string; label: string }> = [
      { raw: "42", label: "number" },
      { raw: "null", label: "null" },
      { raw: '"just-a-string"', label: "string" },
      { raw: '{"name":"p","pi":42}', label: "pi-field-not-object" },
      // 数组能骗过 typeof "object" 守卫（装箱对象）——非合法 pi 容器，显式归 undefined
      { raw: '{"name":"p","pi":[]}', label: "pi-field-array" },
    ];
    // 每 case 独立子目录（缓存 key = package.json 绝对路径），互不命中；
    // asyncReadCount 是跨 case 累积计数，断言用本 case 增量
    for (const { raw, label } of cases) {
      const caseDir = path.join(ws, label);
      writeFile(caseDir, "package.json", raw);
      setMtime(path.join(caseDir, "package.json"), T1);
      process.env.TAIJI_EXTENSION_PATHS = caseDir;

      const caseStart = asyncReadCount();
      const rAgents = await discoverResources(extConfig("agents"));
      expect(
        rAgents.filter((r) => r.source === "user-extension-paths"),
        `case ${label}`,
      ).toHaveLength(0);
      expect(asyncReadCount() - caseStart, `case ${label}`).toBe(1); // 首读恰一次
      const rWorkflows = await discoverResources(extConfig("workflows"));
      expect(
        rWorkflows.filter((r) => r.source === "user-extension-paths"),
        `case ${label}`,
      ).toHaveLength(0);
      // 合法解析 + 无 manifest → 缓存 undefined 条目（两 kind 共享，零重读）
      expect(asyncReadCount() - caseStart, `case ${label}`).toBe(1);
    }
  });
});
