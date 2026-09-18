#!/usr/bin/env node
// scripts/probe-pi-sw-snapshot.mjs
//
// ⛔1 实施前基线探针（D10 / §5.4 ⛔1）：
// 对真实 pi agentDir 产出两份快照，作为 subagent-core sink 收口 wave（u-probe-verify）
// 「实施前后 diff 逐项一致」的外部事实锚。
//
//   ① 发现清单快照（discovery-snapshot.txt）
//      用 subagent-workflow 的资源发现逻辑（core resource-discovery 深路径）列出全部
//      agents/workflows：原始发现（stem / source 标签 / 胜出路径 / available）+
//      注入器装配后清单（name / 胜出路径），全部按码点序排序。
//   ② 注入 XML 快照（injection-snapshot.txt）
//      pi-sw 注入器（subagent-list-injector / workflow-list-injector）对同一目录集
//      产出的注入 XML 全文（<available_subagents> / <available_workflows>）。
//      <available_provider_models> 段依赖 pi 运行时 ctx.modelRegistry.getAvailable()
//      （auth 态，非目录集派生、非本 wave 任一单元触碰面，且属非确定字段）——不进
//      快照，仅记恒定说明行（见文件内该节）。
//
// 确定性契约（S7 负面验证的前提）：排序一律码点序（sortByCodepoint 语义，禁
// localeCompare）；快照不含时间戳 / mtime / 进程态等非确定字段；幂等覆盖可重复运行。
//
// 运行方式：npx tsx scripts/probe-pi-sw-snapshot.mjs [--out <dir>]
//   TS 源码经 tsx 直接加载（scripts 是 ESM；脚本以相对路径 import 本仓 core 与
//   pi-sw 注入器源文件——根 node_modules 无 workspace 包链接，包名解析不可达，
//   相对路径 import 的实现与包名深路径 import 的实现是同一份文件）。
//
// agentDir 探测顺序（对齐 taiji 运行时注入语义）：
//   1. 环境变量 PI_CODING_AGENT_DIR
//   2. ~/.taiji/agent 存在性（taiji 生产布局，rpc-client 注入源）
//   3. ~/.pi/agent（pi 核心缺省）

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── 入参 ─────────────────────────────────────────────────────

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseOutDir(argv) {
  const idx = argv.indexOf("--out");
  if (idx === -1) return join(repoRoot, ".review", "sink-probe");
  const value = argv[idx + 1];
  if (!value) {
    console.error("[probe] --out 需要一个目录参数，例如 --out .review/sink-probe");
    process.exit(2);
  }
  return resolve(value);
}

const outDir = parseOutDir(process.argv);

// ── agentDir 探测（顺序 = 契约，见文件头） ────────────────────

function resolveAgentDir() {
  const viaEnv = process.env.PI_CODING_AGENT_DIR;
  if (viaEnv) return { dir: resolve(viaEnv), via: "env PI_CODING_AGENT_DIR" };
  const taijiAgentDir = join(homedir(), ".taiji", "agent");
  if (existsSync(taijiAgentDir)) return { dir: taijiAgentDir, via: "~/.taiji/agent existence" };
  return { dir: join(homedir(), ".pi", "agent"), via: "~/.pi/agent (pi default)" };
}

const agentDirInfo = resolveAgentDir();
const agentDir = agentDirInfo.dir;

// workspaceRoot 复刻 pi 壳语义（pi 传 findWorkspaceRoot(ctx.cwd)，ctx.cwd = 进程 cwd）。
// 惰性 import core 后再取（见下方动态 import 段）。

// ── 动态 import TS 源（tsx 加载；相对路径 = 本仓实现同一份文件） ──

const { configureCore, findWorkspaceRoot, sortByCodepoint, formatAgentList, formatWorkflowList } =
  await import("../packages/subagent-core/src/index.ts");
// getHostServices 刻意不经 barrel 导出（semver 契约面，见 index.ts 头注）——探针走深路径。
const { getHostServices } = await import("../packages/subagent-core/src/core/host-services.ts");
const { discoverResources } = await import("../packages/subagent-core/src/shared/resource-discovery.ts");
const agentInjector = await import(
  "../extensions/universal/subagent-workflow/src/injectors/subagent-list-injector.ts"
);
const workflowInjector = await import(
  "../extensions/universal/subagent-workflow/src/injectors/workflow-list-injector.ts"
);

const workspaceRoot = findWorkspaceRoot(process.cwd());

// ── hostRoots：复刻 pi 壳 agentDirKindRoots（pi-host.ts） ─────
//
// 根清单/顺序/source 标签与 pi 壳逐项一致：user-pi → npm → npm-dev，agents kind
// 追加第 4 根 core 包一级父目录（C5⑥）。coreNpmRoot 等价解析：pi 壳用
// require.resolve("@zhushanwen/subagent-core/workflows/README.md") 锚点 dirname³；
// 探针跑在本仓 workspace 形态，同一锚点的确定性等价路径 = <repo>/packages（锚点
// README 存在性校验，缺失时降级不注入并 warn——对齐 pi-host 失败语义）。

function corePackageNpmRoot() {
  const anchor = join(repoRoot, "packages", "subagent-core", "workflows", "README.md");
  if (!existsSync(anchor)) return undefined;
  return dirname(dirname(dirname(anchor)));
}

const coreNpmRoot = corePackageNpmRoot();

function agentDirKindRoots(kind) {
  const roots = [
    { dir: join(agentDir, kind), source: "user-pi" },
    { dir: join(agentDir, "npm", "node_modules"), source: "npm" },
    { dir: join(agentDir, "extensions"), source: "npm-dev" },
  ];
  if (kind === "agents" && coreNpmRoot !== undefined) {
    roots.push({ dir: coreNpmRoot, source: "npm" });
  }
  return roots;
}

// configureCore 注入（完整 HostServices）：log 端口把 warn/error 引到 stderr——
// 出声但不进快照（stderr 不参与 diff）。
configureCore({
  dataRoot: () => agentDir,
  log: (level, component, message, data) => {
    if (level === "debug") return;
    console.error(`[${component}] ${level}: ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);
  },
  discoveryRoots: () => ({
    agents: agentDirKindRoots("agents"),
    workflows: agentDirKindRoots("workflows"),
  }),
});

// ── 发现清单快照 ─────────────────────────────────────────────

/** 文件名 stem（与 resource-discovery 内部去重键同语义）。 */
function stem(filePath) {
  const base = filePath.split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * 原始发现层：discoverResources 输出（last-writer-wins 合并后），按 stem 码点序
 * 排序输出——name / source 标签 / available / 胜出路径。
 */
async function rawDiscoveryLines(kind, includeTmp) {
  const resources = await discoverResources({
    kind,
    workspaceRoot,
    hostRoots: getHostServices().discoveryRoots()?.[kind] ?? [],
    includeTmp,
  });
  const sorted = sortByCodepoint(resources, (r) => stem(r.path));
  return sorted.map(
    (r) =>
      `${stem(r.path)}\tsource=${r.source}\t${r.available ? "available" : "UNAVAILABLE"}\t${r.path}`,
  );
}

/** 装配层：注入器 discoverAll* 输出（frontmatter 解析 + name 去重 + 码点序）。 */
function assembledLines(entries) {
  return entries.map((e) => `${e.name}\t${e.path}`);
}

const agentsRaw = await rawDiscoveryLines("agents", false);
const workflowsRaw = await rawDiscoveryLines("workflows", true);
const agentsAssembled = assembledLines(await agentInjector.discoverAllAgents(workspaceRoot));
const workflowsAssembled = assembledLines(await workflowInjector.discoverAllWorkflows(workspaceRoot));

// ── 注入 XML 快照（真实注入器渲染函数 + 注入器 guide 文案常量） ──

const agentXml = formatAgentList(await agentInjector.discoverAllAgents(workspaceRoot), {
  guide: agentInjector.SUBAGENT_LIST_GUIDE,
});
const workflowXml = formatWorkflowList(await workflowInjector.discoverAllWorkflows(workspaceRoot), {
  guide: workflowInjector.WORKFLOW_LIST_GUIDE,
});

// ── 写快照（幂等覆盖；无时间戳/进程态字段） ───────────────────

const HEADER_FIELDS = [
  `# agentDir探测: ${agentDir}`,
  `# agentDir探测来源: ${agentDirInfo.via}`,
  `# workspaceRoot: ${workspaceRoot}`,
  `# 排序: 码点序（sortByCodepoint 语义）；本快照不含时间戳等非确定字段`,
];

function sectionLines(title, lines) {
  return [`## ${title}`, ...lines];
}

const discoverySnapshot = [
  ...HEADER_FIELDS,
  "",
  ...sectionLines("agents 原始发现（stem / source / available / 胜出路径）", agentsRaw),
  "",
  ...sectionLines("agents 装配后清单（name / 胜出路径）——注入器 discoverAllAgents 输出", agentsAssembled),
  "",
  ...sectionLines(
    "workflows 原始发现（stem / source / available / 胜出路径，includeTmp）",
    workflowsRaw,
  ),
  "",
  ...sectionLines(
    "workflows 装配后清单（name / 胜出路径）——注入器 discoverAllWorkflows 输出",
    workflowsAssembled,
  ),
  "",
].join("\n");

const injectionSnapshot = [
  ...HEADER_FIELDS,
  "",
  "## <available_subagents>（subagent-list-injector 全文）",
  agentXml === "" ? "(empty——无可用 agent，pi 运行时不注入该段)" : agentXml,
  "",
  "## <available_workflows>（workflow-list-injector 全文）",
  workflowXml === "" ? "(empty——无可用 workflow，pi 运行时不注入该段)" : workflowXml,
  "",
  "## <available_provider_models>",
  "(not probed——该段由 pi 运行时 ctx.modelRegistry.getAvailable() 产出，auth 态派生，",
  " 非目录集派生且非 sink wave 任一单元触碰面；auth 状态属非确定字段，不进快照)",
  "",
].join("\n");

mkdirSync(outDir, { recursive: true });
const discoveryPath = join(outDir, "discovery-snapshot.txt");
const injectionPath = join(outDir, "injection-snapshot.txt");
writeFileSync(discoveryPath, discoverySnapshot);
writeFileSync(injectionPath, injectionSnapshot);

// ── 摘要（stdout，非快照内容） ────────────────────────────────

console.log(`[probe] agentDir=${agentDir} (via ${agentDirInfo.via})`);
console.log(`[probe] workspaceRoot=${workspaceRoot}`);
console.log(
  `[probe] agents: raw=${agentsRaw.length} assembled=${agentsAssembled.length} | workflows: raw=${workflowsRaw.length} assembled=${workflowsAssembled.length}`,
);
console.log(`[probe] discovery snapshot -> ${discoveryPath}`);
console.log(`[probe] injection snapshot -> ${injectionPath}`);
