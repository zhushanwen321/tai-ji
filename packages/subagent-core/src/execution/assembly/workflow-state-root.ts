// src/execution/assembly/workflow-state-root.ts
//
// [F-1 修复] pi 宿主 WorkflowRun state 目录解析（与 pi 壳 JsonlRunStore 同源布局）。
//
// 为什么存在：pi 宿主 workflow 域的 run state 真实落盘 = JsonlRunStore 的
// `<sessionDir>/workflow-state/<runId>.jsonl`，sessionDir 布局推导（slug + 探测）
// 的单一权威源在本文件（resolvePiSessionScopedDir）。core 读侧装配点
// （round-supervisor 的注册对账 sweep、idle-gc 的 WorkflowRun GC）曾用
// FileRunStore 缺省根 `<dataRoot>/workflow-state`（zcode 宿主布局）——两目录
// 生产不相交，读侧恒 ENOENT：sweep 把活跃 run 判 missing 补注销（误注销活跃
// run），WorkflowRun GC 恒空转。
//
// 分层约束：core 不能 import extension——pi 壳 extensions/universal/
// subagent-workflow/src/session-lifecycle.ts 的 resolveSessionDir() 薄消费本
// 文件：经 opts.agentDir 注入 pi SDK 活源 getAgentDir()（pi 升级自动跟随）；
// core 缺省 agentDir 锚定自推，供引擎侧 / zsw 等无 pi SDK 环境消费。agentDir
// 双源是有意差异，slug + 探测布局恒单源。
//
// core 缺省 agentDir 推导锚定 pi 实装版 0.84.4 dist config.js getAgentDir：
// `process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")`
// （ENV_AGENT_DIR = PI_CODING_AGENT_DIR、CONFIG_DIR_NAME = piConfig.configDir = ".pi"，
// 无 piConfig.name 覆盖）。pi 升级若改 getAgentDir 语义 → 本推导漂移，可见信号
// 同 F-1（sweep 补注销活跃 run / GC 空转）。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** pi SDK getAgentDir 的 env 覆盖通道（实装版 dist config.js ENV_AGENT_DIR）。 */
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** pi SDK 缺省 agent 目录分量（实装版 dist config.js：CONFIG_DIR_NAME + "agent"）。 */
const DEFAULT_PI_AGENT_DIR_PARTS = [".pi", "agent"] as const;

/** resolvePiSessionScopedDir 的注入面（测试用；生产缺省全走真实推导）。 */
export interface PiSessionScopedDirOptions {
  /** agent 配置目录覆盖（缺省 = PI_CODING_AGENT_DIR env 或 ~/.pi/agent）。 */
  agentDir?: string;
  /** cwd 覆盖（缺省 process.cwd()——锚进程 cwd 而非 ctx.cwd，pi 壳建目录方语义）。 */
  cwd?: string;
}

/**
 * 解析 pi 宿主 session 锚定目录（sessionDir）——pi 壳 JsonlRunStore 的落盘根，
 * 也是壳侧 resolveSessionDir 的单源实装。
 *
 * 布局规则：
 *   - cwd-slug = `--<cwd 去开头分隔符、`/`→`-`>--`（pi 壳建目录方字面规则——core 的
 *     encodeCwd 额外折叠 `:` 与 `\`，服务 subagents/ 布局族（C-ext-21），与建
 *     目录方不一致，此处不共用）；
 *   - `<agentDir>/sessions/<slug>` 目录存在则用之（该目录由 workflow 域首次落盘
 *     创建——cwd 有过 workflow run 才存在），否则回退 agentDir 根
 *     （JsonlRunStore 的 mkdir recursive 使首写直接落 agentDir 根，两侧探测一致）。
 *
 * 只读解析（existsSync 探测），无目录创建副作用——与 FileRunStore 的 save 侧
 * mkdir 职责分离。
 */
export function resolvePiSessionScopedDir(opts?: PiSessionScopedDirOptions): string {
  const agentDir = opts?.agentDir ?? resolvePiAgentDir();
  const cwd = opts?.cwd ?? process.cwd();
  const sessionSlug = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
  const sessionScopedDir = join(agentDir, "sessions", sessionSlug);
  return existsSync(sessionScopedDir) ? sessionScopedDir : agentDir;
}

/**
 * 解析 pi 宿主 WorkflowRun state 目录（`<sessionDir>/workflow-state`）——
 * resolvePiSessionScopedDir 的纯后缀派生（同 opts 注入面）。
 */
export function resolvePiWorkflowStateDir(opts?: PiSessionScopedDirOptions): string {
  return join(resolvePiSessionScopedDir(opts), "workflow-state");
}

/** pi agent 目录（getAgentDir 同语义；core 缺省推导锚定见文件头注）。 */
function resolvePiAgentDir(): string {
  const envDir = process.env[PI_AGENT_DIR_ENV];
  if (envDir !== undefined && envDir !== "") return envDir;
  return join(homedir(), ...DEFAULT_PI_AGENT_DIR_PARTS);
}
