/**
 * config-loader — 单元测试。
 *
 * 覆盖：discoverWorkflows / loadWorkflows / getWorkflow / invalidateCache /
 *      meta 正则提取、缓存 TTL、坏配置容错、目录优先级、来源标签。
 *
 * 策略：真实临时目录 + 真实 workflow 脚本文件（meta 提取走真实文件读取）。
 * 只 mock `findWorkspaceRoot`（getWorkflow 的 workspace 推导依赖它，且耦合
 * process.cwd()，难以隔离），保留 `discoverResources` 真实实现——扫描逻辑
 * 本身是 resource-discovery 的职责。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// homedir 只影响 normalizeRef 的 `~/` 展开（getWorkflowByPath 路径），
// mock 成可写临时目录（测试内动态改），其余 node:os 保持真实。
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => "/nonexistent-home-for-tests") };
});

// resource-discovery 位于 src/shared/（从 __tests__/ 看是 ../../shared/）。
// 只覆盖 findWorkspaceRoot；其余（discoverResources 等）保持真实实现。
vi.mock("../../shared/resource-discovery.ts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../shared/resource-discovery.ts")
  >();
  return {
    ...actual,
    findWorkspaceRoot: vi.fn(() => "/unused-by-default"),
  };
});

import {
  discoverWorkflows,
  getWorkflow,
  getWorkflowByPath,
  invalidateCache,
  type WorkflowScanConfig,
} from "../config-loader.ts";
import { findWorkspaceRoot } from "../../shared/resource-discovery.ts";
import { homedir } from "node:os";

const mockedFindWorkspaceRoot = vi.mocked(findWorkspaceRoot);
const mockedHomedir = vi.mocked(homedir);

// ── 临时工作区工具 ────────────────────────────────────────────

interface TempWorkspace {
  /** workspace 根（= toScanConfig 推导出的 workspaceRoot） */
  root: string;
  /** <root>/.pi/workflows —— WorkflowScanConfig.projectDir */
  projectDir: string;
  /** <root>/.pi/workflows/.tmp */
  tmpDir: string;
  /** <root>/.agents/workflows */
  agentsDir: string;
}

async function makeTempWorkspace(): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "wf-cfg-test-"));
  const projectDir = join(root, ".pi", "workflows");
  const tmpDir = join(projectDir, ".tmp");
  const agentsDir = join(root, ".agents", "workflows");
  await mkdir(projectDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  await mkdir(agentsDir, { recursive: true });
  return { root, projectDir, tmpDir, agentsDir };
}

async function writeScript(
  dir: string,
  name: string,
  content: string,
): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, content, "utf-8");
  return p;
}

/** 合法的单行 meta 脚本。 */
function validScript(
  name: string,
  opts: { description?: string; phases?: string[] } = {},
): string {
  const description = opts.description ?? `${name} desc`;
  const phases = JSON.stringify(opts.phases ?? []);
  return `/* @pi-meta\nname: ${name}\ndescription: ${description}\nphases: ${phases}\n*/\nagent({ prompt: "x" });\n`;
}

// ── Setup / Teardown ──────────────────────────────────────────

let ws: TempWorkspace;

beforeEach(async () => {
  invalidateCache();
  mockedFindWorkspaceRoot.mockReturnValue("/unused-by-default");
  ws = await makeTempWorkspace();
});

afterEach(async () => {
  vi.useRealTimers();
  if (ws) await rm(ws.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** 过滤掉可能从真实 homedir 泄漏进来的 user-agents 文件，只保留临时工作区内结果。 */
function inTemp(wfs: Awaited<ReturnType<typeof discoverWorkflows>>) {
  return wfs.filter((w) => w.path.startsWith(ws.root));
}

// ── 测试 ──────────────────────────────────────────────────────

describe("discoverWorkflows — 加载合法配置", () => {
  it("正确加载合法 workflow 并提取 meta", async () => {
    await writeScript(ws.projectDir, "foo.js", validScript("foo"));

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const foo = result.find((w) => w.name === "foo");

    expect(foo).toBeDefined();
    expect(foo!.available).toBe(true);
    expect(foo!.description).toBe("foo desc");
    expect(foo!.phases).toEqual([]);
    expect(foo!.path).toBe(join(ws.projectDir, "foo.js"));
  });

  it("多行 @pi-meta YAML 正确解析", async () => {
    await writeScript(
      ws.projectDir,
      "multi.js",
      [
        "/* @pi-meta",
        "name: multi",
        "description: multi-line",
        "phases: [a, b]",
        "*/",
        'agent({ prompt: "x" });',
        "",
      ].join("\n"),
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const multi = result.find((w) => w.name === "multi");

    expect(multi).toBeDefined();
    expect(multi!.available).toBe(true);
    expect(multi!.description).toBe("multi-line");
    expect(multi!.phases).toEqual(["a", "b"]);
  });

  it("phases 为空数组合法", async () => {
    await writeScript(
      ws.projectDir,
      "nophase.js",
      `/* @pi-meta\nname: nophase\ndescription: x\nphases: []\n*/\n`,
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const noPhase = result.find((w) => w.name === "nophase");

    expect(noPhase).toBeDefined();
    expect(noPhase!.phases).toEqual([]);
  });

  it("parameters/usage 整对象透传不丢（m2 exec-review MAJOR-2 回归护栏）", async () => {
    await writeScript(
      ws.projectDir,
      "params.js",
      [
        "/* @pi-meta",
        "name: params",
        "description: x",
        "phases: [a]",
        "parameters:",
        "  type: object",
        "  properties:",
        "    autoCommit: { type: boolean, default: false }",
        "  required: [autoCommit]",
        "usage: |",
        "  ## 使用说明",
        "  - 示例：workflow run params --args autoCommit=true",
        "*/",
        'agent({ prompt: "x" });',
        "",
      ].join("\n"),
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const p = result.find((w) => w.name === "params");

    expect(p).toBeDefined();
    expect(p!.available).toBe(true);
    // 若未来有人重引入 {name,description,phases} 解构重映射（m2 消灭的反模式），
    // 此断言会失败——parameters/usage 是 m3 args-validator 与 m4 meta 消费的依赖。
    const params = p!.parameters as
      | { type: string; properties: { autoCommit: { type: string } }; required: string[] }
      | undefined;
    expect(params?.type).toBe("object");
    expect(params?.properties?.autoCommit?.type).toBe("boolean");
    expect(params?.required).toEqual(["autoCommit"]);
    expect(p!.usage).toContain("autoCommit=true");
  });
});

describe("getWorkflow — 按名查找", () => {
  beforeEach(() => {
    // getWorkflow 内部用 findWorkspaceRoot() 推导 bucket key，指向临时根。
    mockedFindWorkspaceRoot.mockReturnValue(ws.root);
  });

  it("按名查找存在的 workflow", async () => {
    await writeScript(ws.projectDir, "foo.js", validScript("foo"));

    // 先 discoverWorkflows 填充缓存（bucket key = ws.root）
    await discoverWorkflows({ projectDir: ws.projectDir });
    const foo = await getWorkflow("foo");

    expect(foo).toBeDefined();
    expect(foo!.name).toBe("foo");
    expect(foo!.available).toBe(true);
  });

  it("查找不存在的 workflow 返回 undefined", async () => {
    await writeScript(ws.projectDir, "foo.js", validScript("foo"));
    await discoverWorkflows({ projectDir: ws.projectDir });

    const missing = await getWorkflow("does-not-exist");
    expect(missing).toBeUndefined();
  });
});

describe("缓存 — invalidateCache 与 TTL", () => {
  beforeEach(() => {
    mockedFindWorkspaceRoot.mockReturnValue(ws.root);
  });

  it("TC6: mtime 判变——文件修改后 getWorkflow 立即反映新内容（删 60s TTL）", async () => {
    const scriptPath = await writeScript(
      ws.projectDir,
      "foo.js",
      validScript("foo", { description: "v1" }),
    );

    await discoverWorkflows({ projectDir: ws.projectDir });
    let foo = await getWorkflow("foo");
    expect(foo!.description).toBe("v1");

    // 修改文件内容（mtime 变）→ getWorkflow 立即反映（不再有 60s 陈旧窗口）
    await writeFile(
      scriptPath,
      validScript("foo", { description: "v2" }),
      "utf-8",
    );
    foo = await getWorkflow("foo");
    expect(foo!.description).toBe("v2");

    // 文件未变 → 再次调用命中缓存（同内容）
    foo = await getWorkflow("foo");
    expect(foo!.description).toBe("v2");
  });

  it("invalidateCache 清统一缓存层后 getWorkflow 强制重读（mtime 漏判场景兜底）", async () => {
    const scriptPath = await writeScript(
      ws.projectDir,
      "foo.js",
      validScript("foo", { description: "v1" }),
    );

    await discoverWorkflows({ projectDir: ws.projectDir });
    expect((await getWorkflow("foo"))!.description).toBe("v1");

    // 修改文件 → mtime 判变立即反映（不等 invalidateCache）
    await writeFile(
      scriptPath,
      validScript("foo", { description: "v2" }),
      "utf-8",
    );
    expect((await getWorkflow("foo"))!.description).toBe("v2");

    // invalidateCache 后仍强制重读（内容变 mtime 未变场景的兜底——cp -p 类）
    invalidateCache();
    expect((await getWorkflow("foo"))!.description).toBe("v2");
  });
});

describe("坏配置容错 — 不 crash，标记 available=false", () => {
  it("缺少 @pi-meta 声明的脚本被标记不可用", async () => {
    await writeScript(
      ws.projectDir,
      "broken.js",
      `// this script has no meta\nconsole.log("nothing");\n`,
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const broken = result.find((w) => w.path.endsWith("broken.js"));

    expect(broken).toBeDefined();
    expect(broken!.available).toBe(false);
    expect(broken!.name).toBe("broken"); // fallback 到文件名 stem
    expect(broken!.description).toBe("");
    expect(broken!.phases).toEqual([]);
  });

  it("meta.name 非字符串被标记不可用", async () => {
    await writeScript(
      ws.projectDir,
      "badname.js",
      `/* @pi-meta\nname: 123\ndescription: x\nphases: []\n*/\n`,
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const bad = result.find((w) => w.path.endsWith("badname.js"));

    expect(bad).toBeDefined();
    expect(bad!.available).toBe(false);
    expect(bad!.name).toBe("badname"); // fallback stem
  });

  it("语法损坏的 meta 不 crash 并 fallback", async () => {
    await writeScript(
      ws.projectDir,
      "garbage.js",
      `/* @pi-meta\nname: oops\ndescription: d\nphases: [a\n*/\n`,
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const garbage = result.find((w) => w.path.endsWith("garbage.js"));

    expect(garbage).toBeDefined();
    expect(garbage!.available).toBe(false);
    expect(garbage!.name).toBe("garbage");
  });

  it("混合可用/不可用脚本时可用脚本仍正确返回", async () => {
    await writeScript(ws.projectDir, "good.js", validScript("good"));
    await writeScript(ws.projectDir, "bad.js", `// no meta here\n`);

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const good = result.find((w) => w.name === "good");
    const bad = result.find((w) => w.path.endsWith("bad.js"));

    expect(good!.available).toBe(true);
    expect(bad!.available).toBe(false);
  });
});

describe("来源标签（WorkflowSource）", () => {
  it("project .pi/workflows 下的脚本 source = saved", async () => {
    await writeScript(ws.projectDir, "foo.js", validScript("foo"));

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const foo = result.find((w) => w.name === "foo");

    expect(foo!.source).toBe("saved");
  });

  it(".pi/workflows/.tmp 下的脚本 source = tmp", async () => {
    await writeScript(ws.tmpDir, "temp.js", validScript("temp"));

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));
    const temp = result.find((w) => w.name === "temp");

    expect(temp).toBeDefined();
    expect(temp!.source).toBe("tmp");
  });
});

describe("目录优先级 — 同名资源高优先级覆盖", () => {
  it("project-agents(.agents) 覆盖 project-pi(.pi/workflows)", async () => {
    // 两个文件 stem 均为 "dup"，但 meta.name 不同
    await writeScript(
      ws.projectDir,
      "dup.js",
      validScript("dup-from-pi", { description: "lower priority" }),
    );
    await writeScript(
      ws.agentsDir,
      "dup.js",
      validScript("dup-from-agents", { description: "higher priority" }),
    );

    const result = inTemp(await discoverWorkflows({ projectDir: ws.projectDir }));

    // 优先级：project-pi < project-agents，后者胜出
    const dup = result.find((w) => w.path.includes(".agents"));
    expect(dup).toBeDefined();
    expect(dup!.name).toBe("dup-from-agents");
    expect(dup!.path).toBe(join(ws.agentsDir, "dup.js"));

    // 低优先级版本不应出现
    expect(result.find((w) => w.name === "dup-from-pi")).toBeUndefined();
  });
});

describe("getWorkflowByPath — 按绝对路径加载（S2 路径统一核心新入口）", () => {
  it("合法文件：返回完整 CachedWorkflowMeta 结构（available=true）", async () => {
    const scriptPath = await writeScript(
      ws.projectDir,
      "bypath.js",
      validScript("bypath", { description: "path loaded", phases: ["a"] }),
    );

    const meta = await getWorkflowByPath(scriptPath);

    expect(meta).toBeDefined();
    expect(meta!.available).toBe(true);
    expect(meta!.name).toBe("bypath");
    expect(meta!.description).toBe("path loaded");
    expect(meta!.phases).toEqual(["a"]);
    expect(meta!.path).toBe(scriptPath);
    // toCachedMeta 的 source 参数 "user-pi" → saved（非 project-pi-tmp）
    expect(meta!.source).toBe("saved");
  });

  it("相对路径返回 undefined（引用唯一形态 = 绝对路径）", async () => {
    await expect(getWorkflowByPath("workflows/foo.js")).resolves.toBeUndefined();
    await expect(getWorkflowByPath("./foo.js")).resolves.toBeUndefined();
  });

  it("非 .js 扩展名返回 undefined", async () => {
    await expect(getWorkflowByPath("/tmp/foo.ts")).resolves.toBeUndefined();
    await expect(getWorkflowByPath("/tmp/foo.js.txt")).resolves.toBeUndefined();
  });

  it("~/ 前缀展开为 homedir 下绝对路径后正常加载", async () => {
    mockedHomedir.mockReturnValue(ws.root);
    const scriptPath = await writeScript(ws.root, "tilda.js", validScript("tilda"));

    const meta = await getWorkflowByPath("~/tilda.js");

    expect(meta).toBeDefined();
    expect(meta!.available).toBe(true);
    expect(meta!.name).toBe("tilda");
    expect(meta!.path).toBe(scriptPath);
  });

  it("文件不存在：available=false 不抛（fail-safe），name fallback 到文件 stem", async () => {
    const meta = await getWorkflowByPath("/nonexistent/ghost.js");

    expect(meta).toBeDefined(); // 不是 undefined——normalizeRef 通过，meta 提取失败标不可用
    expect(meta!.available).toBe(false);
    expect(meta!.name).toBe("ghost");
    expect(meta!.description).toBe("");
    expect(meta!.phases).toEqual([]);
    expect(meta!.path).toBe("/nonexistent/ghost.js");
  });

  // ── IF4（外部 #5 残留）：source 按路径推导（.tmp → tmp） ──
  // 修复前：任意路径硬编码 "user-pi" → .tmp 下脚本按路径加载被错标 saved，
  // 与 discoverWorkflows 对 project-pi-tmp 源的正确映射矛盾。

  it("IF4: workspaceRoot/.pi/workflows/.tmp 下的脚本按路径加载 source = tmp", async () => {
    // findWorkspaceRoot 指向临时工作区 → tmp 前缀判定生效
    mockedFindWorkspaceRoot.mockReturnValue(ws.root);
    const tmpScriptPath = await writeScript(ws.tmpDir, "adhoc.js", validScript("adhoc"));

    const meta = await getWorkflowByPath(tmpScriptPath);

    expect(meta).toBeDefined();
    expect(meta!.available).toBe(true);
    expect(meta!.source).toBe("tmp");
  });

  it("IF4: 非 .tmp 路径按路径加载 source = saved（输出不变，DS4）", async () => {
    mockedFindWorkspaceRoot.mockReturnValue(ws.root);
    const savedPath = await writeScript(ws.projectDir, "byfile.js", validScript("byfile"));

    const meta = await getWorkflowByPath(savedPath);

    expect(meta).toBeDefined();
    expect(meta!.available).toBe(true);
    expect(meta!.source).toBe("saved");
  });

  it("IF4: tmp 前缀判定不误伤同名前缀目录（.tmp-other/ 非 .tmp/）", async () => {
    mockedFindWorkspaceRoot.mockReturnValue(ws.root);
    const siblingDir = join(ws.projectDir, ".tmp-other");
    await mkdir(siblingDir, { recursive: true });
    const siblingPath = await writeScript(siblingDir, "sib.js", validScript("sib"));

    const meta = await getWorkflowByPath(siblingPath);

    expect(meta!.source).toBe("saved");
  });
});

describe("WorkflowScanConfig 类型接口", () => {
  it("接受完整 WorkflowScanConfig（仅 projectDir 即可触发隔离模式）", async () => {
    await writeScript(ws.projectDir, "foo.js", validScript("foo"));

    const config: WorkflowScanConfig = {
      projectDir: ws.projectDir,
      userDir: "/nonexistent-user",
      tmpDir: ws.tmpDir,
      npmDirs: [],
    };
    const result = inTemp(await discoverWorkflows(config));

    expect(result.find((w) => w.name === "foo")).toBeDefined();
  });
});
