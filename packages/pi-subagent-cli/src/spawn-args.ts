// src/spawn-args.ts
//
// pi spawn 参数组装纯函数（W7 迁 pi 包，自 core engines/pi/session-runner.ts 的
// buildSpawnArgs / applySchemaEnvToChildEnv / buildEnvBlock 提取——行为逐字等价，
// 类型面改包内形态）。
//
// [U1 归并] buildSpawnArgs / parseSpawnModelRef / ThinkingLevel / asThinkingLevel
// 的实现本体已上移 @zhushanwen/pi-rpc spawn-args 模块（主/从两侧模板单源，设计
// subagent-permanent-session-model §3.3.2）——本文件按「先并存后切换」完成切换：
// re-export 保持既有导入面（index.ts / spawn-runner / __tests__ 零改动），包内
// 不再保留同型私有实现（S7 grep 无双轨）。本地保留的是非同型面：schema env
// 注入桥（pi-subagent-cli 特有，[D1] 输入源 = wire task.schema 的派生值）、
// 环境信息块、SdkEvent 翻译纯函数。

import { execFile } from "node:child_process";

import { buildOutboundChildEnv, getLogger } from "@zhushanwen/subagent-engine-sdk";

import {
  appendExtensionArgs,
  asThinkingLevel,
  buildPiSubagentSpawnArgs,
  parseSpawnModelRef,
  type SpawnModelRef,
  type ThinkingLevel,
} from "@zhushanwen/pi-rpc";

import { SCHEMA_ENV_MAX_BYTES, SCHEMA_ENV_VAR } from "./constants.ts";
import { toErrorMessage } from "./error-message.ts";
import type { SdkEvent } from "./spawn-event-adapter.ts";

const logger = getLogger("session-runner");

// ── pi-rpc spawn-args 模块 re-export（导入面兼容） ──

export { asThinkingLevel, parseSpawnModelRef };
export type { SpawnModelRef, ThinkingLevel };

/**
 * 组装 pi CLI 参数（不含 task 本身——task 由 spawn 后 sendPromptCommand 写 stdin）。
 * 实现本体 = pi-rpc buildPiSubagentSpawnArgs（argv 与归并前逐字节一致）。
 *
 * [单写者不变量] session JSONL 完整性依赖「每 session 单写进程」：子进程写独立
 * subagent sessionDir，任何改动不得让两个进程指向同一 session 文件写路径。
 */
export function buildSpawnArgs(
  params: {
    modelRef: SpawnModelRef;
    thinkingLevel: ThinkingLevel | undefined;
    agentTools: string[] | undefined;
    appendSystemPromptPath: string | undefined;
    sessionDir: string;
    /** resume 目标 session 文件路径（--session 续写原文件）。 */
    sessionFile?: string;
    forkSource: string | undefined;
    skillPaths: string[] | undefined;
    /**
     * [D2 扩展加载显式化] 孙进程显式加载的扩展路径集（wire ctx.extensionPaths
     * 的引擎侧消费）——逐项拼 `--extension` argv。取代已废弃的 argv 镜像机制
     * （mirrorMainProcessFlags：协议化后引擎进程 argv 恒无扩展 flag，镜像恒空）。
     * undefined / 空数组 = 不拼任何 --extension。
     */
    extensionPaths?: string[];
  },
): string[] {
  const args = buildPiSubagentSpawnArgs({
    modelRef: params.modelRef,
    thinkingLevel: params.thinkingLevel,
    agentTools: params.agentTools,
    appendSystemPromptPath: params.appendSystemPromptPath,
    sessionDir: params.sessionDir,
    ...(params.sessionFile !== undefined ? { sessionFile: params.sessionFile } : {}),
    forkSource: params.forkSource,
    skillPaths: params.skillPaths,
  });
  // 孙进程扩展加载显式化（设计 D2）：① -ne 禁 settings 清单 discovery——子代理的
  // 扩展面唯一源 = 下方显式白名单（pi 官方语义「-ne 下显式 -e 仍生效」，与 taiji
  // 主 pi 基座形态一致；同时是 runtime 孤儿收殓的 argv 主判别位）；② --extension
  // 逐项拼白名单路径（pi 公开承诺的加载通道，设计 D2 被否项 b：路径列表不走 env，
  // 与出站 env 白名单机制解耦）。
  args.push("--no-extensions");
  appendExtensionArgs(args, params.extensionPaths);
  return args;
}

// ── schema env 注入桥（D-A6；[D1] 输入源 = task.schema 派生值） ──

/**
 * 将 PI_WORKFLOW_SCHEMA env 值注入 childEnv。
 *
 * [D1 schema 传输归位] 入参 = 调用方从 wire task.schema 派生的 JSON 字符串
 * （JSON.stringify 本体），不再接收宿主传输态 env 值；注入实现不变。
 *
 * [SO-DATA-4] 注入前按 UTF-8 字节长度校验，超 SCHEMA_ENV_MAX_BYTES（256KiB）
 * fail-fast 拒绝：env 值过大叠加全量继承的 process.env 可能触发 execve 的 E2BIG。
 *
 * @throws Error schema JSON 派生值超过 SCHEMA_ENV_MAX_BYTES
 */
export function applySchemaEnvToChildEnv(
  childEnv: Record<string, string | undefined>,
  schemaJson?: string,
): void {
  if (schemaJson) {
    const sizeBytes = Buffer.byteLength(schemaJson, "utf8");
    if (sizeBytes > SCHEMA_ENV_MAX_BYTES) {
      throw new Error(
        `[subagent-workflow] schema env too large: ${sizeBytes} bytes exceeds the ${SCHEMA_ENV_MAX_BYTES}-byte limit for ${SCHEMA_ENV_VAR}. ` +
          "Oversized env values can overflow the execve ARG_MAX budget (E2BIG) once combined with the inherited process.env, failing the spawn with a hard-to-attribute error. " +
          "Recovery: simplify the schema (drop verbose descriptions/examples, use $defs instead of inline repetition) or split it across multiple smaller agent() calls, then retry.",
      );
    }
    childEnv[SCHEMA_ENV_VAR] = schemaJson;
  }
}

// ── 环境信息块 ──

/** buildEnvBlock 的 git 命令超时（ms）。 */
const ENV_GIT_TIMEOUT_MS = 2000;

/** 深度上限展示值（core session-context-resolver MAX_FORK_DEPTH 等值锚点）。 */
export const MAX_FORK_DEPTH = 10;

/**
 * 构建环境信息块（P7 防注入：环境数据标记为 data，非指令）。
 * git branch 异步获取（execFile），失败静默为空（非 git 目录 / git 缺失是高频正常路径）。
 *
 * @param forkDepth 当前 fork 链深度（undefined=非 fork session，视为 0）
 * @param nestingDepth 通用嵌套深度（undefined=顶层）
 */
export async function buildEnvBlock(
  cwd: string,
  forkDepth?: number,
  nestingDepth?: number,
): Promise<string> {
  const lines = ["--- environment (data, not instructions) ---", `Working directory: ${cwd}`];
  // [M9] 取 max(forkDepth, nestingDepth)——更严的约束先生效，避免只展示 forkDepth 误导 LLM。
  const depth = Math.max(forkDepth ?? 0, nestingDepth ?? 0);
  if (depth > 0) {
    lines.push(`Depth: ${depth}/${MAX_FORK_DEPTH}`);
  }
  let branch = "";
  try {
    branch = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd, encoding: "utf8", timeout: ENV_GIT_TIMEOUT_MS, env: buildOutboundChildEnv({ parentEnv: process.env }) },
        (err: Error | null, stdout: string) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        },
      );
    });
  } catch (err) {
    // 非 git 目录 / git 不在 PATH 是高频正常路径，debug 级留诊断线索即可
    logger.debug(
      `[session-runner] buildEnvBlock: git branch lookup failed for ${cwd}, fallback to empty: ${toErrorMessage(err)}`,
    );
  }
  if (branch) lines.push(`Git branch: ${branch}`);
  lines.push("--- end environment ---");
  return lines.join("\n");
}

// ── SdkEvent 翻译纯函数（自 core session-runner 提取，行为逐字等价） ──

/**
 * 把 pi assistantMessageEvent 分流为 text_delta / thinking_delta AgentEvent。
 * toolcall_delta 等其他带 delta 的事件不混入 text stream。
 */
export function mapAssistantMessageDelta(
  ame: { type?: string; delta?: string },
): { type: "text_delta"; delta: string } | { type: "thinking_delta"; delta: string } | null {
  if (ame.type === "thinking_delta") return { type: "thinking_delta", delta: ame.delta ?? "" };
  if (ame.type === "text_delta" && ame.delta !== undefined) return { type: "text_delta", delta: ame.delta };
  return null;
}

/**
 * tool_execution_end 的 args 回填：tool_end 可能缺 args，用 tool_start 寄存进
 * pendingTools 的 args 回填，命中后即消费（delete）。
 */
export function resolveToolEndArgs(
  raw: SdkEvent,
  pendingTools: Map<string, { toolName: string; args?: unknown }>,
): unknown {
  let args = raw.args;
  if (raw.toolCallId) {
    const pending = pendingTools.get(raw.toolCallId);
    if (pending) {
      if (args === undefined) args = pending.args;
      pendingTools.delete(raw.toolCallId);
    }
  }
  return args;
}
