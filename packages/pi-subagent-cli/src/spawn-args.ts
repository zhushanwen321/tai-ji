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
// 不再保留同型私有实现（S7 grep 无双轨）。本地保留的是非同型面：schemaEnv
// bridge（pi-subagent-cli 特有）、环境信息块、SdkEvent 翻译纯函数。

import { execFile } from "node:child_process";

import { buildOutboundChildEnv, getLogger } from "@zhushanwen/subagent-engine-sdk";

import {
  asThinkingLevel,
  buildPiSubagentSpawnArgs,
  parseSpawnModelRef,
  type PiMirrorFlags,
  type SpawnModelRef,
  type ThinkingLevel,
} from "@zhushanwen/pi-rpc";

import type { MirrorFlags } from "./argv-mirror.ts";
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
    /** 镜像自主进程 argv 的 flag（--no-extensions/--approve/--extension/--no-context-files）。 */
    mirrorFlags?: MirrorFlags;
  },
): string[] {
  // MirrorFlags（argv-mirror 解析结果）与 PiMirrorFlags 结构同形（TS 结构化类型），
  // 直传无需转换——字段集与语义见 pi-rpc spawn-args.ts PiMirrorFlags 注释。
  const mirrorFlags: PiMirrorFlags | undefined = params.mirrorFlags;
  return buildPiSubagentSpawnArgs({
    modelRef: params.modelRef,
    thinkingLevel: params.thinkingLevel,
    agentTools: params.agentTools,
    appendSystemPromptPath: params.appendSystemPromptPath,
    sessionDir: params.sessionDir,
    ...(params.sessionFile !== undefined ? { sessionFile: params.sessionFile } : {}),
    forkSource: params.forkSource,
    skillPaths: params.skillPaths,
    ...(mirrorFlags !== undefined ? { mirrorFlags } : {}),
  });
}

// ── schemaEnv bridge（D-A6） ──

/**
 * 将 schemaEnv 注入 childEnv。
 *
 * [SO-DATA-4] 注入前按 UTF-8 字节长度校验，超 SCHEMA_ENV_MAX_BYTES（256KiB）
 * fail-fast 拒绝：env 值过大叠加全量继承的 process.env 可能触发 execve 的 E2BIG。
 *
 * @throws Error schemaEnv 序列化后超过 SCHEMA_ENV_MAX_BYTES
 */
export function applySchemaEnvToChildEnv(
  childEnv: Record<string, string | undefined>,
  schemaEnv?: string,
): void {
  if (schemaEnv) {
    const sizeBytes = Buffer.byteLength(schemaEnv, "utf8");
    if (sizeBytes > SCHEMA_ENV_MAX_BYTES) {
      throw new Error(
        `[subagent-workflow] schema env too large: ${sizeBytes} bytes exceeds the ${SCHEMA_ENV_MAX_BYTES}-byte limit for ${SCHEMA_ENV_VAR}. ` +
          "Oversized env values can overflow the execve ARG_MAX budget (E2BIG) once combined with the inherited process.env, failing the spawn with a hard-to-attribute error. " +
          "Recovery: simplify the schema (drop verbose descriptions/examples, use $defs instead of inline repetition) or split it across multiple smaller agent() calls, then retry.",
      );
    }
    childEnv[SCHEMA_ENV_VAR] = schemaEnv;
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
