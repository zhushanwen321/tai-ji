// src/pi-engine.ts
//
// PiEngine 协议化引擎适配器（W7，impl-plan §2.7）——core engines/pi/pi-engine.ts
// 的引擎进程内形态。
//
// 归属对照（设计 §3.8 D2 表；[H1 U3/U5] chat-run 统一 docs/design/subagent-chat-run-unification.md
// §3.3 D6/D7 后形态）：
//   - spawn 执行链（runSpawn 本体 / sendPromptCommand / EPIPE 兜底 / stdin 驱动）
//     → 本包 spawn-runner（迁移物）；
//   - chat 轮次 → run 派发形态（每轮一进程：首轮无锚点新建，续聊 resume 锚点
//     --session 续写原文件；agent_settled resolve + 收割——D7）。U5 起 registry 本体
//     与 interact 控制面已删除（续聊不经 interact——deliverChatMessage 面 = U2 建
//     ConversationContinuation 后的 run 域派发）；
//   - HostBridge 编排面（executeAndAwait / record 状态回写 / idle+activate lock 定时器）
//     → core（W3 改线消费本引擎的事件面）；
//   - read：①级 pi 原生读取依赖 core session-reconstructor（§2.7「保持 core」），
//     引擎包 read 走 ②级 journal 重放（SDK journal-replay）→ ③级 outcome-only
//     降级链（deviations 登记：①级留在 core 侧过渡期链路，W10 conformance 定夺）。
//
// capabilities 与 core PiEngine.capabilities() 逐位一致（manifest 快照同源）。

import { execFile } from "node:child_process";

import { buildOutboundChildEnv } from "@zhushanwen/subagent-engine-sdk";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  EngineSdkError,
  getLogger,
  type AgentEvent,
  type AgentOutcome,
  type EngineCapabilities,
  type ProbeReport,
  type SessionView,
  type UiRequest,
  type UiResponse,
} from "@zhushanwen/subagent-engine-sdk";

import { PI_ADAPTER_VERSION, PI_ENGINE_ID, PI_POOL_KEY } from "./constants.ts";
import { toErrorMessage } from "./error-message.ts";
import type { AgentCallOpts, EngineHandle, EnginePort, EngineCtxModel, RunContext } from "./port-types.ts";
import type { PiInvocation } from "./pi-invocation.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import { resetAllEpipeFailures } from "./stdin-writer.ts";
import {
  killAllActiveChildren,
  type SpawnRunCallbacks,
  type SpawnRunParams,
  type SpawnRunResult,
  runSpawnOnce,
} from "./spawn-runner.ts";
import { replayJournalToSessionView } from "./read-fallback.ts";

const logger = getLogger("pi-engine");

/** probe 的版本探测超时（ms）。二进制无响应时按探针失败处理，不静默挂死。 */
const PROBE_VERSION_TIMEOUT_MS = 10_000;

/** PiEngine 构造依赖。 */
export interface PiEngineDeps {
  /**
   * 数据根（session 目录 [LEGACY] fallback 与 journal 重放的锚）。来源 = 显式注入
   * 或 env XYZ_AGENT_DATA_DIR——注意协议 initialize 的 hostInfo.dataRoot 引擎**不
   * 消费**（initialize 仅版本协商 + capabilities 应答）；权威 session 目录也不由
   * 它推导（ctx.sessionDir 宿主注入，Option C）。两者皆无时 run 报错
   * （resolveEngineDataRootOrThrow 语义，显式报 engine_not_found 附期望路径，不猜
   * cwd）。
   */
  dataDir?: string;
  /** 版本探测执行器（测试注入 fake 避免真实子进程）。 */
  probeVersion?: (invocation: PiInvocation) => Promise<string | undefined>;
  /** spawn 执行器（测试注入 fake；缺省 runSpawnOnce）。 */
  spawnRunner?: (params: Parameters<typeof runSpawnOnce>[0], callbacks: SpawnRunCallbacks) => Promise<SpawnRunResult>;
}

/** subagent session 目录的 [LEGACY] fallback（仅独立运行/测试形态）：旧推导
 *  <dataDir>/subagents/sessions/<encoded(cwd)> 与宿主权威布局
 *  <agentDir>/subagents/<encodeCwd(rootCwd)>/sessions 三处不等价（根/段序/编码），
 *  曾致 session 文件与 .record-binding 落到宿主冷查扫描根之外（Gate B S6 全灭）。
 *  权威 = 宿主注入 ctx.sessionDir（协议化 Option C，宿主 getSubagentSessionDir
 *  单一权威）；本函数只在 ctx.sessionDir 缺省（旧宿主/直构引擎/测试）时兜底。 */
function resolveSessionDir(dataDir: string, cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return path.join(dataDir, "subagents", "sessions", encoded);
}

/** 数据根解析：显式注入 > env；皆无 → undefined（run/probe 时显式报错）。 */
function resolveDataRoot(explicit: string | undefined): string | undefined {
  if (explicit !== undefined && explicit !== "") return explicit;
  const env = process.env.XYZ_AGENT_DATA_DIR;
  return env !== undefined && env !== "" ? env : undefined;
}

/** pi 引擎适配器（EnginePort 实现，协议服务器的驱动对象）。 */
export class PiEngine implements EnginePort {
  readonly id = PI_ENGINE_ID;

  private readonly deps: PiEngineDeps;
  private probeCache: ProbeReport | undefined;

  constructor(deps: PiEngineDeps = {}) {
    this.deps = deps;
  }

  /** pi 链路实际接通的能力（与 core PiEngine.capabilities() 逐位一致——manifest 同源）。 */
  capabilities(): EngineCapabilities {
    return {
      // PI_WORKFLOW_SCHEMA env 注入 + structured-output 扩展（方案 A 唯一校验权威）
      schemaEnforcement: "native",
      // pi RPC 有 steer，但 spawn 链路未接通（turn-limiter steer no-op）
      steer: "unsupported",
      // chat 轮 = run 派发形态（每轮新 run + resume 锚点续写，D7）——conversation 位
      // 语义收窄为 resume 能力位（D5）
      conversation: "native",
      // persona 经 --skill / --append-system-prompt flag 通道注入
      personaInjection: "flag",
      // 30+ 事件流（六引擎最细粒度）
      eventGranularity: "stream",
      // 无 OS sandbox；worktree 隔离（公共层）= emulated
      sandbox: "emulated",
      // pi session JSONL 完整重建（session-reconstructor）
      sessionRead: "full",
      // 每轮新 run + resume 锚点（--session 续写原文件，冷续链路经真机验收）
      resume: "native",
      // 现链路 abort = SIGTERM（pi 子进程 trap 后 graceful shutdown）
      interrupt: "kill-only",
      // argv-mirror 镜像主进程 --approve 等 flag
      permissionMode: "native",
      // turn limiter + spawn watchdog 估算兑现轮数上限
      maxTurns: true,
    };
  }

  /** 探针（D7）：invocation 可解析（二进制/脚本存在）+ 版本解析。relay:false 显式
   *  直连——探针测 pi 本体可解析性，经 relay 探到的是 runtime 健康，语义错位。 */
  async probe(opts?: { force?: boolean }): Promise<ProbeReport> {
    if (!opts?.force && this.probeCache) return this.probeCache;

    const invocation = getPiInvocation(["--version"], { relay: false });
    const invocationOk = isInvocationResolvable(invocation);
    const checks: ProbeReport["checks"] = [
      {
        name: "invocation",
        ok: invocationOk,
        detail: invocationOk
          ? `${invocation.command} ${invocation.args.join(" ")}`
          : `cannot resolve pi executable: ${invocation.command} (script missing and not on PATH)`,
      },
    ];

    let engineVersion = "";
    if (invocationOk) {
      const runVersion = this.deps.probeVersion ?? defaultProbeVersion;
      const version = await runVersion(invocation);
      const versionOk = version !== undefined && version.length > 0;
      checks.push({
        name: "version",
        ok: versionOk,
        detail: versionOk ? version : "pi --version returned empty or failed",
      });
      engineVersion = version ?? "";
    }

    const ok = checks.every((c) => c.ok);
    const report: ProbeReport = {
      ok,
      engineVersion,
      checks,
      ...(ok ? {} : {
        error: {
          code: "engine_probe_failed",
          recovery:
            `Run \`${invocation.command} --version\` to confirm the pi binary works, then retry the probe. ` +
            `If the binary is missing, reinstall pi (npm i -g @earendil-works/pi-coding-agent) or fix PATH.`,
        },
      }),
    };
    this.probeCache = report;
    return report;
  }

  /** run 的引擎侧实现：协议 RunParams → spawn-runner 单次执行（chat 轮 = run 派发
   * 形态，[H1 U3] 不再经 ChatSessionRegistry——见 buildRunParams）。
   *
   * run 期间事件经 ctx.onEvent（server 层 → `event` 通知）；session 身份经
   * ctx.onHandleReady（→ host/handleReady）；子进程 pid/状态经镜像回调上报。
   * 抛错语义（core PiEngine.run ①）：prepare 期失败 reject，不产生 handle。 */
  async run(task: AgentCallOpts, ctx: RunContext): Promise<{ handle: EngineHandle; outcome: AgentOutcome }> {
    const dataDir = resolveEngineDataRootOrThrow(this.deps.dataDir);
    // pi 无隔离池（poolKey 恒 'shared'）——恒值声明，宿主 journal writer 无需重定向
    ctx.onPoolResolved?.(PI_POOL_KEY);

    const cwd = task.cwd ?? process.cwd();
    const spawn = this.deps.spawnRunner ?? runSpawnOnce;
    const result = await spawn(
      buildRunParams(task, ctx, dataDir, cwd),
      buildRunCallbacks(ctx, this.askUserHandler),
    );
    return buildEngineRunResult(ctx.resume?.recordId ?? ctx.taskId, result);
  }

  /**
   * read 三级降级（协议化形态）：②级 journal 重放（SDK journal-replay 纯投影）
   * → ③级 outcome-only。①级 pi 原生读取（session-reconstructor）按 §2.7 保持
   * core，不随迁（deviations 登记）。
   */
  async read(handle: EngineHandle): Promise<SessionView> {
    const sessionFile = refString(handle.data.sessionRef, "sessionFile");
    const journaled = replayJournalToSessionView(handle, PI_ENGINE_ID);
    if (journaled !== undefined) return journaled;
    void sessionFile;
    return { engineId: PI_ENGINE_ID, turns: [], source: "outcome-only" };
  }

  /** dispose：全量收割活跃子进程 + 清 EPIPE 计数（幂等）。 */
  async dispose(): Promise<void> {
    killAllActiveChildren();
    resetAllEpipeFailures();
  }

  // ── 反向通道注入面（server 构造后接线 host/askUser） ──

  private askUserHandler: ((req: UiRequest) => Promise<UiResponse>) | undefined;

  /** server 层注入 host/askUser 两阶段等待体（ui-request-queue 消费）。 */
  bindAskUser(handler: ((req: UiRequest) => Promise<UiResponse>) | undefined): void {
    this.askUserHandler = handler;
  }
}

/** 数据根解析：显式注入 > env；皆无 → engine_not_found（prepare 期失败 reject，不产生 handle）。 */
function resolveEngineDataRootOrThrow(explicit: string | undefined): string {
  const dataDir = resolveDataRoot(explicit);
  if (dataDir !== undefined) return dataDir;
  throw new EngineSdkError(
    "engine_not_found",
    "pi-subagent-cli cannot resolve the engine data root (neither the explicit deps.dataDir nor env XYZ_AGENT_DATA_DIR is set)",
    "The host must inject XYZ_AGENT_DATA_DIR into the engine child env (initialize hostInfo.dataRoot is "
      + "not consumed by this engine). Expected shape: <xyz-agent dataDir> (legacy fallback sessions live "
      + "under <dataDir>/subagents/sessions/; authoritative sessionDir arrives per-run via ctx.sessionDir).",
  );
}

/** run 的 spawn 入参还原（协议 RunParams → SpawnRunParams；一次性 run 与续聊轮
 * 共用同一派发形态——[H1 U3/U6] chat-run 统一 + resume 键为唯一会话形态键，设计 §3.3 D6/D7）：
 *   - record 锚：续聊轮 = ctx.resume.recordId（childSpawned 帧的关联键），
 *     一次性 run = runId；
 *   - resume 锚点穿透：ctx.resume.resume.sessionRef.sessionFile → resumeSessionFile →
 *     spawn-args `--session` 续写原文件（首轮无锚点 = 新建）；
 *   - chatMode（agent_settled resolve + 收割，D7）仅在会话形态轮置位。 */
function buildRunParams(
  task: AgentCallOpts,
  ctx: RunContext,
  dataDir: string,
  cwd: string,
): SpawnRunParams {
  const resumeParams = ctx.resume;
  const resumeFile = resumeParams === undefined ? undefined : refString(resumeParams.resume?.sessionRef ?? {}, "sessionFile");
  return {
    recordId: resumeParams?.recordId ?? ctx.taskId,
    task: task.prompt,
    agentName: task.description ?? task.agent ?? (resumeParams !== undefined ? "chat-agent" : "workflow-agent"),
    model: ctx.ctxModel !== undefined
      ? `${(ctx.ctxModel as EngineCtxModel).provider}/${(ctx.ctxModel as EngineCtxModel).id}`
      : task.model,
    ...(task.thinkingLevel !== undefined ? { thinkingLevel: task.thinkingLevel } : {}),
    // [Option C 协议化] session 目录：宿主注入 ctx.sessionDir 权威优先（宿主
    // getSubagentSessionDir 推导）；缺省走 [LEGACY] fallback（独立运行/测试形态，
    // 旧推导与宿主布局不等价——见 resolveSessionDir 注释）。
    sessionDir: ctx.sessionDir ?? resolveSessionDir(dataDir, cwd),
    cwd,
    ...(task.schemaEnv !== undefined ? { schemaEnv: task.schemaEnv } : {}),
    ...(task.maxTurns !== undefined ? { maxTurns: task.maxTurns } : {}),
    ...(task.graceTurns !== undefined ? { graceTurns: task.graceTurns } : {}),
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(task.skillPath !== undefined ? { skillPaths: [task.skillPath] } : {}),
    ...(task.appendSystemPrompt !== undefined ? { appendSystemPrompt: task.appendSystemPrompt } : {}),
    // fork-from 显式分叉源（协议 task.forkSource → --fork）。fork-from 与会话形态轮
    // 互不相交（fork-from 无 resume 键——宿主保证，续写走 resumeSessionFile）。
    ...(task.forkSource !== undefined ? { forkSource: task.forkSource } : {}),
    // [F6] 根 session id 透传（relay 归属键 SESSION_ID 权威源；undefined 不挂键）。
    ...(ctx.sessionRootId !== undefined ? { sessionRootId: ctx.sessionRootId } : {}),
    ...(resumeParams !== undefined ? { chatMode: true } : {}),
    ...(resumeFile !== undefined ? { resumeSessionFile: resumeFile } : {}),
  };
}

/** 一次性 run 的回调装配（事件/句柄/镜像回调 + stream/askUser 接线）。 */
function buildRunCallbacks(
  ctx: RunContext,
  askUserHandler: ((req: UiRequest) => Promise<UiResponse>) | undefined,
): SpawnRunCallbacks {
  return {
    onEvent: (event: AgentEvent) => ctx.onEvent?.(event),
    onHandleReady: (partial) => ctx.onHandleReady?.(partial),
    onChildSpawned: (pid) => {
      ctx.onChildSpawned?.({ pid, killed: false });
    },
    onChildStateChanged: (p) => {
      ctx.onChildStateChanged?.(p);
    },
    ...(ctx.stream !== undefined
      ? { onDelta: (delta: string) => ctx.stream?.onDelta(delta) }
      : {}),
    ...(askUserHandler !== undefined
      ? { askUser: (req: UiRequest) => askUserHandler(req) }
      : {}),
  };
}

/** EngineHandle + AgentOutcome 应答装配（一次性 run 与 chat 轮共用应答形态）。 */
function buildEngineRunResult(
  recordId: string,
  result: SpawnRunResult,
): { handle: EngineHandle; outcome: AgentOutcome } {
  return {
    handle: {
      data: {
        v: 1,
        engineId: PI_ENGINE_ID,
        sessionRef: {
          recordId,
          ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
          ...(result.sessionFile !== undefined ? { sessionFile: result.sessionFile } : {}),
        },
        poolKey: PI_POOL_KEY,
        adapterVersion: PI_ADAPTER_VERSION,
      },
    },
    outcome: toOutcome(result),
  };
}

/** SpawnRunResult → AgentOutcome（core workflowResultToOutcome 的引擎侧等价）。 */
function toOutcome(result: SpawnRunResult): AgentOutcome {
  return {
    content: result.content,
    ...(result.failureKind !== undefined ? { failureKind: result.failureKind } : {}),
    ...(result.parsedOutput !== undefined ? { parsedOutput: result.parsedOutput } : {}),
    ...(result.usage !== undefined
      ? { usage: toOutcomeUsage(result) }
      : {}),
    durationMs: result.durationMs,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
    ...(result.sessionFile !== undefined ? { sessionFile: result.sessionFile } : {}),
    toolCalls: result.toolCalls.map((tc) => ({
      name: tc.toolName,
      input: tc.args === undefined ? "" : JSON.stringify(tc.args),
    })),
    engineId: PI_ENGINE_ID,
  };
}

/** usage 域映射（collector 聚合面 → AgentOutcomeUsage 的必填字段装配）。 */
function toOutcomeUsage(result: SpawnRunResult): import("@zhushanwen/subagent-engine-sdk").AgentOutcomeUsage {
  const u = result.usage!;
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    cost: u.cost ?? 0,
    contextTokens: u.input + u.cacheRead,
    turns: result.turns,
  };
}

/** sessionRef 取 string 值的运行时 guard。 */
function refString(ref: Record<string, string>, key: string): string | undefined {
  const v = ref[key];
  return typeof v === "string" ? v : undefined;
}

/** 默认版本探测：spawn `<command> --version`（probe 超时按探针失败处理）。 */
async function defaultProbeVersion(invocation: PiInvocation): Promise<string | undefined> {
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      execFile(
        invocation.command,
        invocation.args,
        { encoding: "utf8", timeout: PROBE_VERSION_TIMEOUT_MS, env: buildOutboundChildEnv({ parentEnv: process.env }) },
        (err: Error | null, stdout: string) => {
          if (err) reject(err);
          else resolve(stdout.trim().split("\n")[0]?.trim() || undefined);
        },
      );
    });
  } catch (err) {
    // 版本探测是 best-effort（失败经 checks 反映进 ProbeReport），debug 级留线索
    logger.debug(
      `[pi-engine] probe version check failed (best-effort continue): ${toErrorMessage(err)}`,
    );
    return undefined;
  }
}

/**
 * invocation 是否可解析：非 PATH 依赖形态直接认；PATH 形态扫 PATH 目录核实。
 */
function isInvocationResolvable(invocation: PiInvocation): boolean {
  if (invocation.command !== "pi") return true;
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === "") continue;
    try {
      if (fs.existsSync(path.join(dir, "pi"))) return true;
    } catch (err) {
      logger.debug(
        `[pi-engine] PATH dir probe failed (continue scanning): ${dir}: ${toErrorMessage(err)}`,
      );
    }
  }
  return false;
}
