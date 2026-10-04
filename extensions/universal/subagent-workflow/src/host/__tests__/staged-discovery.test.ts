// staged-discovery.test.ts — 打包态内置资产**发现结果**门禁（档 2，2026-10-03 B′）
//
// 为什么单独建这个文件：本次事故（打包版 `subagents` 批量工具报
// "Built-in workflow 'fan-out' is not available"）的根因是**发现层面**——esbuild
// 自包含 bundle 下 `require.resolve("@zhushanwen/subagent-core/…")` 必败，staged 布局
// 又无 node_modules，于是孝在包里的 `workflows/` 无人能扫到。既有门禁全是“文件在不在”
// 级断言（dry-run import 不调工厂、TC8 只比字节），对本类失效天然失明。
//
// 本文件的断言对象是**发现结果**（6 内置 workflow + 10 内置 agent 真的被列出来），
// 而非“文件存在”：前者才能拦住“路径/产物层”回归。两条通路都被锁：
//   ① 纯函数：bundle 形态模块路径 → scope 根；dev/异常形态 → undefined（不误触发）；
//   ② 集成：以合成 bundle 模块路径调 `corePackageNpmRoot()`（resolve 必败 → 回退分支），
//      再把回退根当 npm 槽根跑**真实** `discoverResources`，断言结果与源目录逐文件一致。
//
// 资产集不写死数量（口径：与 `packages/subagent-core/{workflows,agents}` 源目录集合比对，
// 源增删自动跟随）。

import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { discoverResources, isTargetFile } from "@zhushanwen/subagent-core";
import { afterAll, describe, expect, it, vi } from "vitest";

// pi 宿主协作件 mock：本文件只跑发现链，日志面给可调用桩（回退分支会走 debug）。
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => process.env.PI_CODING_AGENT_DIR ?? "/mock/agent-dir",
}));
vi.mock("@zhushanwen/pi-extension-logger", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { corePackageNpmRoot, stagedScopeRootFromModuleUrl } = await import("../pi-host.ts");

/** 本仓 `packages/subagent-core`（源单源：断言口径由此推导，不写死数量）。
 *  路径经与生产同一锚点解析得出（禁止手数 `..` 层级）。 */
const CORE_PKG = dirname(
  dirname(createRequire(import.meta.url).resolve("@zhushanwen/subagent-core/workflows/README.md")),
);

const tmpDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs) {
    // teardown 递归删除补 maxRetries：与在途异步写竞争时 ENOTEMPTY 满载 flake
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

/** 合成 staged 布局：<tmp>/@zhushanwen/pi-subagent-workflow/{index.js,workflows,agents}。 */
function makeStagedLayout(): { scopeDir: string; moduleUrl: string } {
  const root = makeTmp("staged-discovery-");
  const pkgDir = join(root, "@zhushanwen", "pi-subagent-workflow");
  mkdirSync(pkgDir, { recursive: true });
  const indexJs = join(pkgDir, "index.js");
  writeFileSync(indexJs, "// staged bundle placeholder\n", "utf8");
  for (const kind of ["workflows", "agents"] as const) {
    cpSync(join(CORE_PKG, kind), join(pkgDir, kind), { recursive: true });
  }
  return { scopeDir: join(root, "@zhushanwen"), moduleUrl: pathToFileURL(indexJs).href };
}

/** 源目录内可发现文件的集合——判据直接复用发现层导出的 isTargetFile（同一份
 *  函数，发现层口径变化时期望集自动跟随，无双源）。 */
function sourceExpected(kind: "workflows" | "agents"): string[] {
  return readdirSync(join(CORE_PKG, kind))
    .filter((f) => isTargetFile(f, kind))
    .sort();
}

describe("B′：staged/bundle 形态的 core 资产发现根", () => {
  it("stagedScopeRootFromModuleUrl：bundle 形态（<scope>/<pkg>/index.js）→ 返回 scope 目录", () => {
    const { scopeDir, moduleUrl } = makeStagedLayout();
    expect(stagedScopeRootFromModuleUrl(moduleUrl)).toBe(scopeDir);
  });

  it("stagedScopeRootFromModuleUrl：dev 形态（非 scope 布局）→ undefined（不误触发回退）", () => {
    const devLike = pathToFileURL(join(CORE_PKG, "workflows", "fan-out.js")).href;
    expect(stagedScopeRootFromModuleUrl(devLike)).toBeUndefined();
  });

  it("corePackageNpmRoot：dev/workspace 形态走 resolve 通路（不回退）", () => {
    const root = corePackageNpmRoot();
    expect(root).toBeDefined();
    // workspace 形态：scope 根下必须有 subagent-core 包目录（resolve 命中锚点的上三级）
    expect(readdirSync(root as string)).toContain("subagent-core");
  });

  it("corePackageNpmRoot：bundle 形态 resolve 必败 → 回退到 scope 根", () => {
    const { scopeDir, moduleUrl } = makeStagedLayout();
    expect(corePackageNpmRoot(moduleUrl)).toBe(scopeDir);
  });
});

describe("B′：回退根下的**发现结果**（本批防复发的核心断言）", () => {
  it("workflows：发现结果与源目录集合逐文件一致（内置模板全部可派发）", async () => {
    const { scopeDir } = makeStagedLayout();
    const found = await discoverResources({
      kind: "workflows",
      workspaceRoot: scopeDir,
      hostRoots: [{ dir: scopeDir, source: "npm" }],
    });
    // 只断言**回退根下**的发现结果（发现面还包括真实用户目录 ~/.agents/workflows
    // 等宿主/约定根——本用例的主题是回退根本身，故按路径范围收窄，噪声不介入）
    const names = found
      .filter((r) => r.available && r.path.startsWith(scopeDir))
      .map((r) => r.path.split("/").pop() as string)
      .sort();
    expect(names).toEqual(sourceExpected("workflows"));
    // 回归锚：批量入口的固定执行体必须在列
    expect(names).toContain("fan-out.js");
  });

  it("agents：发现结果与源目录集合逐文件一致（10 内置角色全部可选）", async () => {
    const { scopeDir } = makeStagedLayout();
    const found = await discoverResources({
      kind: "agents",
      workspaceRoot: scopeDir,
      hostRoots: [{ dir: scopeDir, source: "npm" }],
    });
    const names = found
      .filter((r) => r.available && r.path.startsWith(scopeDir))
      .map((r) => r.path.split("/").pop() as string)
      .sort();
    expect(names).toEqual(sourceExpected("agents"));
    expect(names).toContain("general-purpose.md");
  });

  it("负向：源资产缺席时发现结果为空（门禁失败方向正确，不会假绿）", async () => {
    const root = makeTmp("staged-discovery-empty-");
    const pkgDir = join(root, "@zhushanwen", "pi-subagent-workflow");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "index.js"), "// no assets\n", "utf8");
    const found = await discoverResources({
      kind: "workflows",
      workspaceRoot: join(root, "@zhushanwen"),
      hostRoots: [{ dir: join(root, "@zhushanwen"), source: "npm" }],
    });
    expect(found.filter((r) => r.available)).toEqual([]);
  });
});
