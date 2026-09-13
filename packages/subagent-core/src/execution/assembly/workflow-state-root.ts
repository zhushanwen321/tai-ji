// src/execution/assembly/workflow-state-root.ts
//
// [F-1 修复] pi 宿主 WorkflowRun state 目录解析（与 pi 壳 JsonlRunStore 同源布局）。
//
// 为什么存在：pi 宿主 workflow 域的 run state 真实落盘 = JsonlRunStore 的
// `<sessionDir>/workflow-state/<runId>.jsonl`，sessionDir 由 extension 侧
// `extensions/universal/subagent-workflow/src/session-lifecycle.ts` 的
// resolveSessionDir() 推导。core 侧两个读侧装配点（round-supervisor 的注册对账
// sweep、idle-gc 的 WorkflowRun GC）曾用 FileRunStore 缺省根
// `<dataRoot>/workflow-state`（zcode 宿主布局）——两目录生产不相交，读侧恒 ENOENT：
// sweep 把活跃 run 判 missing 补注销（误注销活跃 run），WorkflowRun GC 恒空转。
//
// core 不能 import extension——本文件按 resolveSessionDir 同规则在 core 侧重写推导，
// 两处注释互指锚定（[同步纪律] 改 sessionDir 布局时必须同批改本文件与
// session-lifecycle.ts，漂移信号 = sweep 补注销活跃 run / GC 空转）。
//
// agentDir 推导锚定 pi 实装版 0.84.4 dist config.js getAgentDir：
// `process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")`
// （ENV_AGENT_DIR = PI_CODING_AGENT_DIR、CONFIG_DIR_NAME = piConfig.configDir = ".pi"，
// 无 piConfig.name 覆盖）。pi 升级若改 getAgentDir 语义 → 本推导漂移，可见信号同上。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** pi SDK getAgentDir 的 env 覆盖通道（实装版 dist config.js ENV_AGENT_DIR）。 */
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** pi SDK 缺省 agent 目录分量（实装版 dist config.js：CONFIG_DIR_NAME + "agent"）。 */
const DEFAULT_PI_AGENT_DIR_PARTS = [".pi", "agent"] as const;

/** resolvePiWorkflowStateDir 的注入面（测试用；生产缺省全走真实推导）。 */
export interface PiWorkflowStateDirOptions {
  /** agent 配置目录覆盖（缺省 = PI_CODING_AGENT_DIR env 或 ~/.pi/agent）。 */
  agentDir?: string;
  /** cwd 覆盖（缺省 process.cwd()——对齐 session-lifecycle 用进程 cwd 而非 ctx.cwd）。 */
  cwd?: string;
}

/**
 * 解析 pi 宿主 WorkflowRun state 目录（`<sessionDir>/workflow-state`）。
 *
 * sessionDir 推导（与 session-lifecycle.resolveSessionDir 逐段同构，见文件头注）：
 *   - cwd-slug = `--<cwd 去开头分隔符、`/`→`-`>--`（extension 侧字面规则——core 的
 *     encodeCwd 额外折叠 `:` 与 `\`，与建目录方不一致，此处不共用）；
 *   - `<agentDir>/sessions/<slug>` 目录存在则用之（该目录由 workflow 域首次落盘
 *     创建——cwd 有过 workflow run 才存在），否则回退 agentDir 根
 *     （JsonlRunStore 的 mkdir recursive 使首写直接落 agentDir 根，两侧探测一致）。
 *
 * 只读解析（existsSync 探测），无目录创建副作用——与 FileRunStore 的 save 侧
 * mkdir 职责分离。
 */
export function resolvePiWorkflowStateDir(opts?: PiWorkflowStateDirOptions): string {
  const agentDir = opts?.agentDir ?? resolvePiAgentDir();
  const cwd = opts?.cwd ?? process.cwd();
  const sessionSlug = `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`;
  const sessionScopedDir = join(agentDir, "sessions", sessionSlug);
  const sessionDir = existsSync(sessionScopedDir) ? sessionScopedDir : agentDir;
  return join(sessionDir, "workflow-state");
}

/** pi agent 目录（getAgentDir 同语义；推导锚定见文件头注）。 */
function resolvePiAgentDir(): string {
  const envDir = process.env[PI_AGENT_DIR_ENV];
  if (envDir !== undefined && envDir !== "") return envDir;
  return join(homedir(), ...DEFAULT_PI_AGENT_DIR_PARTS);
}
