// src/spawn-runner.ts
//
// 协议化 spawn 执行器（W7，impl-plan §2.7）——runSpawn 的引擎侧本体迁移。
//
// core engines/pi/session-runner.ts 的 runSpawn 在壳进程内直接操纵 ExecutionRecord /
// session-pending / settled-watchdog 等宿主编排件；协议化后引擎进程内只保留
// 「spawn pi 子进程 + stdout pump + 事件翻译 + UI 请求发射 + 结果收集」，宿主侧
// 记账由 core 经 `event` 通知与 host/* 反向通道完成（W8 宿主接线 / W10 conformance
// 收尾）。本文件是引擎侧的协议化形态：
//
//   - 子进程 spawn 必经 SDK spawnEngineChild（detached:false / 子 stdin 自有 pipe，
//     W10 静态断言目标）+ buildOutboundChildEnv（deny 键剥除）；
//   - 事件经 SdkEvent → AgentEvent 翻译（spawn-args 纯函数）→ SDK journal-replay
//     reducer 累积（ReplayRecordView——core updateFromEvent 的 SDK 下沉副本）；
//   - extension_ui_request 经 ui-request-queue FIFO → host/askUser 反向请求
//     （ack 两阶段，R9-2 语义；handler 缺失时本地去重告警 + cancelled）；
//   - childSpawned / childStateChanged 上报（core 镜像数据源）。
//
// 保留在 core 的面（deviations 登记）：record 状态回写与续聊轮派发
// （ConversationContinuation）在 core 侧。轮次执行与 agent_settled 轮终已由
// 本包承载（[modeless 波2] agent_end 轮收敛不 kill + agent_settled resolve 并收割
// 是唯一语义；[H1 U5] 原 chat-session 会话管理器已删除——续聊 = 新 run + resume
// 锚点）。

import type { ChildProcess } from "node:child_process";

import * as fs from "node:fs";
import { dirname } from "node:path";

import {
  createReplayRecord,
  getLogger,
  resolveEngineDataDir,
  spawnEngineChild,
  type AgentEvent,
  type EngineCapabilities,
  type UiRequest,
  type UiResponse,
} from "@zhushanwen/subagent-engine-sdk";
import { killPiProcess, type SpawnModelRef } from "@zhushanwen/pi-rpc";

import { registerActiveChild } from "./active-children.ts";
import { buildChildEnv } from "./child-env.ts";
import { SCHEMA_ENV_VAR } from "./constants.ts";
import { createHandledSettlement } from "./handled-settlement.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import {
  buildExitErrorText,
  collectOutcome,
  describePromptAckFailure,
  type CollectedOutcome,
} from "./output-collector.ts";
import { createPromptAckTracker, resolvePromptAckTimeoutMs, type PromptAckTracker } from "./prompt-ack.ts";
import { createFd3RawMirrorWriter, type RawMirrorWriter } from "./raw-mirror.ts";
import { toErrorMessage } from "./error-message.ts";
import {
  buildEnvBlock,
  buildSpawnArgs,
  parseSpawnModelRef,
} from "./spawn-args.ts";
import { createSdkEventTranslator, type SdkTranslatorOpts } from "./spawn-event-translator.ts";
import {
  createPromptRunCounters,
  createSessionIdentityTracker,
  reportChildSpawned,
  wireChildStdoutPump,
  type PromptRunCounters,
  type RunEndState,
  type SessionIdentityTracker,
} from "./spawn-run-pump.ts";
import { performGetStateHandshake } from "./get-state-handshake.ts";
import { sendPromptCommand } from "./stdin-writer.ts";
import { cleanupTempPrompt, writePromptToTempFile } from "./temp-prompt.ts";
import { WRAP_UP_HINT } from "./turn-limiter.ts";
import { createUiRequestQueue } from "./ui-request-queue.ts";
import {
  cleanupSiblingStderrLogs,
  rotateStderrLogIfNeeded,
  stderrLogPathFor,
  stderrRotationParams,
} from "./logs/stderr-rotation.ts";

const logger = getLogger("session-runner");

/** run 的宿主回调面（server.ts 注入：协议通知 + host/* 反向请求）。 */
export interface SpawnRunCallbacks {
  /** AgentEvent 出口（→ `event` 通知，runId + 单调 seq 由 server 层组装）。 */
  onEvent: (event: AgentEvent) => void;
  /** sessionFile/sessionId 就绪回填（→ host/handleReady）。 */
  onHandleReady?: (partial: { sessionRef: Record<string, string> }) => void;
  /** 一次性子进程 pid 上报（→ host/childSpawned）。 */
  onChildSpawned?: (pid: number, recordId: string) => void;
  /** 子进程状态变更（→ host/childStateChanged；killed 必含）。 */
  onChildStateChanged?: (p: {
    pid: number;
    recordId: string;
    state: "running" | "exited";
    killed: boolean;
    exitCode?: number;
    signal?: string;
  }) => void;
  /** host/askUser 两阶段等待体（handler 缺失时队列自动 cancelled 降级）。 */
  askUser?: (request: UiRequest) => Promise<UiResponse>;
  /** text_delta 分流出口（→ host/streamDelta）。 */
  onDelta?: (delta: string) => void;
}

/** runSpawnOnce 的入参（协议 RunParams 的引擎侧还原形态）。 */
export interface SpawnRunParams {
  /** record 锚（= run.params.runId）。 */
  recordId: string;
  /** 完整 task 文本（含 schema 指令——协议 task.prompt）。 */
  task: string;
  /** agent 名（slug 派生 + prompt 临时文件名）。 */
  agentName: string;
  /** canonical "provider/id"（缺省回落 pi 自身解析）。 */
  model: string | undefined;
  /** thinking level 白名单字面量（协议 ctx 透传）。 */
  thinkingLevel?: string;
  /** subagent session 目录（--session-dir）。 */
  sessionDir: string;
  /** spawn cwd。 */
  cwd: string;
  /**
   * [D1 schema 传输归位] 结构化产出 schema 本体（wire task.schema 单字段承载）。
   * PI_WORKFLOW_SCHEMA env 值由引擎侧从本字段派生（buildChildEnv 内
   * JSON.stringify），schema 不再以传输态 env 字符串跨层。
   */
  schema?: Record<string, unknown>;
  /** hard turn limit。 */
  maxTurns?: number;
  /** soft limit 后宽限轮数（默认 2）。 */
  graceTurns?: number;
  /** 中断信号（协议 cancel → server 层 AbortController）。 */
  signal?: AbortSignal;
  /** 根 session id（协议 ctx 还原；嵌套引擎 engine_open 归属键）。 */
  sessionRootId?: string;
  /** 追加 system prompt 片段（agent body 之外的调用方片段）。 */
  appendSystemPrompt?: string[];
  /** skill 路径（--skill 多值）。 */
  skillPaths?: string[];
  /** agent 工具白名单（--tools）。 */
  agentTools?: string[];
  /** fork 源 session 文件（--fork）。 */
  forkSource?: string;
  /**
   * [D2 扩展加载显式化] 孙进程显式加载的扩展路径集（协议 ctx.extensionPaths
   * 还原）——spawn-args 逐项拼 `--extension`。argv 镜像机制（mirrorMainProcessFlags）
   * 已废弃：引擎进程由 core spawn（argv 恒无 flag），镜像前提「从主 pi 进程 spawn」
   * 不存在。缺省 = 不拼 --extension。
   */
  extensionPaths?: string[];
  /**
   * [D4] record 身份信封（协议 ctx.identity 的还原）——整封写进子进程身份 env 的
   * slug / startedAt / mode 三键；缺省不写，壳读者按回落语义工作。
   */
  identity?: {
    slug?: string;
    startedAt?: number;
    mode?: string;
  };
  /** resume 目标 session 文件（冷续写：--session 续写原文件）。 */
  resumeSessionFile?: string;
}

/** runSpawnOnce 的产物。 */
export interface SpawnRunResult extends Omit<CollectedOutcome, "sessionId"> {
  /** 会话头身份（header / get_state 握手回填；全 miss 时 undefined）。 */
  sessionId: string | undefined;
  /**
   * [D5 诊断引用写入 journal 记录] 失败时子进程 stderr tee 文件绝对路径（成功缺省）。语义与
   * 上报判据见 AgentOutcome.stderrTeePath（SDK contract-types——本字段是其引擎侧
   * 装配源，经 pi-engine toOutcome 透传上协议）。
   */
  stderrTeePath?: string;
}

// ── [D3 止血版] 武装断言（run 开始后、孙进程 spawn 前；缺席即秒级 fail-fast） ──

/**
 * 孙进程 schema 强制的唯一必备扩展包（P-C5 白名单起步组成）。与宿主注入侧
 * （subagent-workflow pi-host `GRANDCHILD_EXCLUDED_PKG_SEGMENTS`）是同一契约的
 * 两端：宿主决定注入什么，本断言验证引擎确实收到——扩白名单时两处同批扩。
 *
 * 本常量 = npm 布局包名（错误文案/恢复指引用）；匹配判据 =
 * {@link SCHEMA_ENFORCEMENT_EXTENSION_SEGS}（与 pi-host 段集同批维护）。
 */
const SCHEMA_ENFORCEMENT_EXTENSION_PKG = "@zhushanwen/pi-structured-output";

/**
 * 断言②匹配段集（契约两端与 pi-host `GRANDCHILD_EXCLUDED_PKG_SEGMENTS` 同判据，
 * 扩白名单时两处同批扩）。两形态别名：
 *   - `@zhushanwen/pi-structured-output`：npm staged 布局
 *     `.../node_modules/@zhushanwen/pi-structured-output[/index.js]`。
 *   - `universal/structured-output`：dev 源码布局 `.../extensions/universal/structured-output`
 *     （dev 下 taiji 宿主注入 ctx.extensionPaths 即源码目录——只认 npm 布局时
 *     dev 真机恒判「未武装」秒级 fail-fast，schema 拦截链不可用）。
 *     选型两段连续匹配（分组名 + 包目录名）防尾段同名误伤，登记见 pi-host 同名常量。
 */
const SCHEMA_ENFORCEMENT_EXTENSION_SEGS: readonly (readonly string[])[] = [
  ["@zhushanwen", "pi-structured-output"],
  ["universal", "structured-output"],
];

/** 武装断言的判定输入（纯函数部分，测试直构）。 */
export interface SchemaArmingInput {
  /** 引擎能力位（协议 EngineCapabilities 词表，D3 分流唯一判据）。 */
  schemaEnforcement: EngineCapabilities["schemaEnforcement"];
  /** wire task.schema 声明形态（undefined = 无 schema 任务，无武装面）。 */
  schema: Record<string, unknown> | undefined;
  /** 孙进程终态 env（buildChildEnv 产物——断言拼装事实，不是意图）。 */
  childEnv: Readonly<Record<string, string>>;
  /** 孙进程 argv（buildSpawnArgs 产物，含 `--extension <path>` 对）。 */
  spawnArgs: readonly string[];
}

/**
 * [D3 止血版] 武装断言：native 引擎 + schema 任务的 run 在孙进程 spawn 前校验
 * 「schema 强制已武装」，缺席即抛错（宿主侧秒级 fail-fast，错误含按形态的恢复指引）。
 *
 * 断言集 ①env 注入 + ②扩展在场（③退化说明见下）。capability 分流（D3 防 emulated
 * 误伤）：仅 `schemaEnforcement === "native"` 生效——emulated 引擎（zcode 及
 * schema-emulation 登记域）在引擎侧消费 wire task.schema，无孙进程 env/扩展依赖，
 * 「武装」概念不适用，直接豁免。分流判据复用协议 EngineCapabilities 词表，不新造机制。
 *
 * 断言③（孙进程启动无扩展加载错误）经 P-C1 实施期核实（pi 实装版 0.84.4 dist）：
 * RPC 命令全集（rpc-types.d.ts 逐一枚举，32 条）无工具清单/扩展加载错误查询范围
 * （get_commands = slash 命令、get_state = RpcSessionState，均不暴露工具/扩展范围）；
 * 且扩展加载失败时 pi 在非交互模式（含 rpc）启动诊断 gate 直接 `process.exit(1)`
 * （main.js：runtime diagnostics 含 "Failed to load extension" → exit 1），到不了
 * RPC 服务侧。③不可作为主动查询断言，按设计预留路径退化为 ①+②；扩展加载破坏的
 * 秒级可见性由 pi 自身 exit(1) + 引擎既有 exitCode≠0 失败通路 + stderr tee
 * （诊断留痕）承接。
 */
export function assertSchemaEnforcementArmed(input: SchemaArmingInput): void {
  if (input.schemaEnforcement !== "native") return;
  if (input.schema === undefined) return;
  // ① 派生的 PI_WORKFLOW_SCHEMA 已进孙进程 env（D1 派生点 = buildChildEnv）
  if ((input.childEnv[SCHEMA_ENV_VAR] ?? "") === "") {
    throw new Error(
      `[schema-arming] native schema enforcement is not armed: task.schema is present but ` +
        `${SCHEMA_ENV_VAR} was not derived into the grandchild env. Failing fast because ` +
        `continuing would complete with an unvalidated structured output. This is engine-side ` +
        `derivation drift (the env value must be derived from task.schema in buildChildEnv), ` +
        `not a host configuration error. Recovery: upgrade or reinstall the engine package ` +
        `(@zhushanwen/pi-subagent-cli); if it persists after upgrade, inspect the schema ` +
        `derivation in spawn-runner buildChildEnv / applySchemaEnvToChildEnv.`,
    );
  }
  // ② --extension 列表含 structured-output 包路径（D2 ctx.extensionPaths →
  //    buildSpawnArgs 拼装的 argv 事实）
  if (!hasSchemaEnforcementExtension(input.spawnArgs)) {
    throw new Error(
      `[schema-arming] native schema enforcement is not armed: task.schema is present but the ` +
        `grandchild --extension list does not include ${SCHEMA_ENFORCEMENT_EXTENSION_PKG}, so no ` +
        `tool would validate the structured output (the run would silently complete with an ` +
        `untrustworthy result). Recovery — taiji host form: check the runtime extension-service ` +
        `diagnostics for the grandchild extension whitelist staging of ` +
        `${SCHEMA_ENFORCEMENT_EXTENSION_PKG}. Recovery — standalone pi form: install ` +
        `${SCHEMA_ENFORCEMENT_EXTENSION_PKG} (peerDependency) or use a schema-less workflow ` +
        `instead (drop the schema from the agent call).`,
    );
  }
}

/** argv 是否含指向 structured-output 包的 `--extension` 对：路径按 `/`|`\` 分段后
 * 对 {@link SCHEMA_ENFORCEMENT_EXTENSION_SEGS} 任一段集做连续段匹配（npm staged 与
 * dev 源码两布局、目录/入口文件两形态都命中；段必须精确，前缀相似目录不误判）。
 * 与 pi-host 注入侧 isGrandchildExtensionPath 同判据（契约两端）。 */
function hasSchemaEnforcementExtension(spawnArgs: readonly string[]): boolean {
  for (let i = 0; i + 1 < spawnArgs.length; i++) {
    if (spawnArgs[i] !== "--extension") continue;
    const segs = (spawnArgs[i + 1] ?? "").split(/[\\/]/).filter((s) => s.length > 0);
    if (
      SCHEMA_ENFORCEMENT_EXTENSION_SEGS.some((wanted) =>
        segs.some((_, j) => wanted.every((w, k) => segs[j + k] === w)),
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * canonical model ref 前置校验：prepare 期第一道门——model 缺失 fail-fast 先于临时
 * 文件创建（writeAppendPromptFile 会落盘 append-system-prompt 临时文件，校验在后会让
 * prepare 期失败的 run 泄漏临时文件：finally 清理路径在 try 内，校验抛错时 tempFile 尚无
 * 清理路径）。
 */
function requireCanonicalModelRef(model: string | undefined): SpawnModelRef {
  const modelRef = parseSpawnModelRef(model);
  if (modelRef === undefined) {
    throw new Error(
      `[pi-subagent-cli] run requires a canonical model ref ("provider/id") in ctx.model, got: ${JSON.stringify(model)}. ` +
        `Recovery: the host must resolve the model before dispatching (run.params.ctx.model); check the engine routing layer.`,
    );
  }
  return modelRef;
}

/** thinking level 原样透传收窄（缺省/空串 → undefined；合法性权威 = pi，本层不预判）。 */
function resolveThinkingLevel(params: SpawnRunParams): string | undefined {
  return typeof params.thinkingLevel === "string" && params.thinkingLevel.length > 0
    ? params.thinkingLevel
    : undefined;
}

/** stderr tee 装配；无 tee 形态（无 stderr / dataDir 不可解析 / pid 缺失）排空流
 * 防背压（stderr 无消费面写满会卡死子进程）。 */
function attachStderrTee(child: ChildProcess): { path: string; close(): void } | undefined {
  const stderrTee = createStderrTee(child);
  if (stderrTee === undefined && child.stderr !== null) {
    child.stderr.resume();
  }
  return stderrTee;
}

/** [D3 协议版 P6] 武装回执上报（仅 schema 任务；宿主 reducer 对本事件 no-op，记录归 run 事件 journal）。 */
function reportSchemaEnforcementArmed(params: SpawnRunParams, callbacks: SpawnRunCallbacks): void {
  if (params.schema !== undefined) {
    callbacks.onEvent({
      type: "armed",
      schemaEnvVar: SCHEMA_ENV_VAR,
      extensionPkg: SCHEMA_ENFORCEMENT_EXTENSION_PKG,
    });
  }
}

/**
 * prompt 命令投递 + [M2 D3] 即时失败路径：register（onRequestId，写前登记并武装零
 * 输出计时器）→ 写入（EPIPE 抛出 → failNow("epipe")）→ delivered:false（stdin 不可用，
 * 未登记未写）→ failNow("stdin-unavailable")。两条即时失败不等 30s（S9），killChild 由
 * onFailure 承接；delivered 后置 promptWritten（pump 的 stdout 计数进入「写入后」半面，
 * tracker 活性上报同步生效）。
 */
function sendPromptWithAck(
  child: ChildProcess,
  task: string,
  ackTracker: PromptAckTracker | undefined,
  runCounters: PromptRunCounters,
): void {
  try {
    const sent = sendPromptCommand(child, task, {
      onRequestId: (id) => ackTracker?.register(id),
      onBytesWritten: (n) => {
        runCounters.bytesWritten += n;
      },
    });
    if (!sent.delivered) {
      ackTracker?.failNow("stdin-unavailable", sent.reason ?? "stdin unavailable");
    } else {
      runCounters.promptWritten = true;
    }
  } catch (err) {
    ackTracker?.failNow("epipe", toErrorMessage(err));
  }
}

/**
 * 单次 spawn run：spawn pi rpc 子进程 → pump stdout → 收集结果。
 *
 * 生命周期（[modeless 波2] 唯一语义）：正常轮终 = agent_settled（真空闲）resolve
 * （exit 0 口径）并收割子进程；异常/abort = 子进程 close（exit/error，128+ 折算
 * 判据）。abort（signal）经 spawnEngineChild 的 signal 通道发 SIGTERM，升级链由
 * killPiProcess 兜底；[M2 ⑦] prepare 期已 abort（spawn 前 signal 置位）= 不 spawn
 * 短路取消终态（见 collectCancelledBeforeSpawn）。
 */
/**
 * stderr tee（W11）：实例维度路径 + 懒打开 + 尺寸轮转（超 TAIJI_LOG_MAX_BYTES rename
 * 副本重开）+ 三判据过期清理（同前缀 + pid 已死 + mtime 过期）。失败情形全部静默
 * 降级（取证侧不拖垮任务主通道——调用方对无 tee 形态 resume 排空防背压）。
 *
 * 返回 path（[D5 诊断引用写入 journal 记录] 失败时随终态应答上报宿主的取证文件指针）——路径在
 * tee 创建时即确定（stderrLogPathFor 纯派生），与懒打开时机无关：零字节 tee（子进程
 * 未写 stderr）也是合法诊断引用（「无 stderr 产出」本身是证据）。
 */
function createStderrTee(child: ChildProcess): { path: string; close(): void } | undefined {
  if (child.stderr === null) return undefined;
  let dataDir: string;
  try {
    dataDir = resolveEngineDataDir(process.env);
  } catch {
    return undefined;
  }
  const pid = child.pid;
  if (pid === undefined) return undefined;
  const logPath = stderrLogPathFor(dataDir, pid);
  let stream: fs.WriteStream | null = null;
  let failed = false;
  // tee 失败统一留痕（一次性）：tee 是诊断取证侧，失败不拖垮任务主通道，但
  // 「诊断引用可能不可用」必须出声——失败 run 上报的 stderrTeePath 将是空文件/
  // 缺 tail 的文件，宿主与人工排查需知道取证不可信。
  const warnTeeFailed = (where: string, err: unknown): void => {
    if (failed) return;
    failed = true;
    logger.warn(
      `[session-runner] stderr tee ${where} for pid ${pid} at ${logPath}; ` +
        `stderr capture abandoned, the diagnostic reference reported on failure may be unavailable or truncated`,
      { detail: toErrorMessage(err) },
    );
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (failed) return;
    try {
      if (stream === null) {
        fs.mkdirSync(dirname(logPath), { recursive: true });
        stream = fs.createWriteStream(logPath, { flags: "a" });
        stream.on("error", (err) => {
          warnTeeFailed("write stream error", err);
        });
        cleanupSiblingStderrLogs(logPath, process.env);
      }
      stream.write(chunk);
      if (rotateStderrLogIfNeeded(logPath, stderrRotationParams(process.env))) {
        stream.end();
        stream = null;
      }
    } catch (err) {
      warnTeeFailed("open/write failure", err);
    }
  });
  return {
    path: logPath,
    close() {
      try {
        stream?.end();
      } catch (err) {
        // best-effort：进程已在退出路径上，tee 关闭失败仅 debug 留痕（不抛——
        // close 挂在 onClose 清理链，抛出会遮蔽真实退出码处理）。
        logger.debug(`[session-runner] stderr tee close best-effort failed: ${toErrorMessage(err)}`);
      }
      stream = null;
    },
  };
}

/** append-system-prompt 临时文件装配（环境块 + wrap-up 提示 + 调用方片段）。 */
async function writeAppendPromptFile(params: SpawnRunParams) {
  const appendParts: string[] = [await buildEnvBlock(params.cwd)];
  if (params.maxTurns && params.maxTurns > 0) appendParts.push(WRAP_UP_HINT);
  if (params.appendSystemPrompt) appendParts.push(...params.appendSystemPrompt);
  return appendParts.length > 0
    ? await writePromptToTempFile(params.agentName, appendParts.join("\n\n"))
    : undefined;
}

/** SDK 事件翻译器 opts 装配（判定事实化 + P5 计账接线 + run 收尾状态）。 */
function buildTranslatorOpts(
  params: SpawnRunParams,
  callbacks: SpawnRunCallbacks,
  killChild: () => void,
  runEnd: RunEndState,
): SdkTranslatorOpts {
  // [§3.3.1 P9 迟到终态顺序契约] abort 决已事实位：宿主取消（signal 置位）或 limiter
  // 预算耗尽（直杀置位）任一在场 = abort 已裁决——此后到达的终态边沿按迟到处理。
  const isAbortDecided = (): boolean =>
    params.signal?.aborted === true || runEnd.turnBudgetExhausted === true;
  return {
    maxTurns: params.maxTurns,
    graceTurns: params.graceTurns,
    onEvent: callbacks.onEvent,
    onDelta: callbacks.onDelta,
    // [§3.3.1 三源判别] limiter abort 事实位镜像：limiter 耗尽走 SIGKILL 直杀（进程
    // 死前无停因可采），本位是 turn-budget 支的事实载体（→ harness.turn_budget_exhausted）。
    // [§3.3.9/UC-10] abort 签名携带耗尽事实（{used, limit}，translator/limiter 一次
    // 产出）——快照随事实位传入 collectOutcome，cause.budget 结构化承载。
    abort: (info) => {
      runEnd.turnBudgetExhausted = true;
      runEnd.turnBudgetExhaustion = info;
      killChild();
    },
    // [§3.3.1 三源判别] 宿主取消信号谓词（收尾边沿 host-cancel 支输入）。
    isHostAbortRequested: () => params.signal?.aborted === true,
    // [§3.3.1 P9 迟到终态顺序契约] abort（宿主取消 / limiter 预算耗尽）已发生后到达的
    // 终态边沿一律按迟到处理——终局以 abort 事实优先，不得翻成成功。谓词 = 两个 abort
    // 事实位（宿主 signal 置位 / limiter 直杀置位）。
    // agent_end（非 willRetry，队列排空）= 轮收敛：不 kill（等 agent_settled 收割
    // 边界——pi 的 compact/收尾在 agent_end 后执行）。本回调只在干净停因路径触发
    //（错误停因走 onErroredEnd）——置位「end 与 settled 之间被杀」的 close 按 0 收尾。
    onAgentEnd: () => {
      if (isAbortDecided()) return; // 迟到边沿：不置 clean（杀链 close 的非零码裁决轮终）
      runEnd.endedCleanly = true;
    },
    // [§3.3.1 settled 语义修正] settled = run 结束事实非成功证据：resolve 口径受收尾
    // 边沿事实门控——错误停因事实在场 → 不 resolve(0)、不置 endedCleanly，kill 收割后
    // close 按 128+signo 非零归一（第二条置 0 通路同点封堵）；干净轮维持 fast path。
    onAgentSettled: (snapshot) => {
      // [§3.3.1 P9 迟到终态] abort 已发生 → 迟到 settled：不 resolve、不置 clean、
      // 不记成功快照（快照会经收集侧回填轮数并参与防伪判据，迟到 settled 不是成功
      // 锚点——终局由杀链 close 的非零码 + abort 事实位裁决）。
      if (isAbortDecided()) return;
      runEnd.settledTurnCount = snapshot.turnsAtSettle;
      runEnd.settledStopReason = snapshot.stopReason;
      runEnd.settledAccounting = {
        finalAttemptTurnBase: snapshot.finalAttemptTurnBase,
        retryAttempts: snapshot.retryAttempts,
      };
      if (runEnd.terminalErrorFact !== undefined) {
        runEnd.endedCleanly = false;
        killChild();
        return;
      }
      runEnd.endedCleanly = true;
      runEnd.exitResolved = true;
      runEnd.resolveChatRun?.(0);
      killChild();
    },
    // [§3.3.1 停因事实优先] 收尾边沿错误事实落 runEnd：endedCleanly=false → 退出码
    // 非零 → 轮失败；真实死因经 collectRunResult 上报；分类输入一次产出。
    onErroredEnd: (fact) => {
      runEnd.endedCleanly = false;
      runEnd.terminalErrorFact = fact;
    },
  };
}

/**
 * run 尾段：退出码 → 终态 outcome 收集（含 spawn 'error' 形态文案、成功轮数快照
 * 恢复、失败时 stderr tee 取证指针、[M2 D3] prompt 送达失败分支）。返回
 * SpawnRunResult 终态载荷。
 */
function collectRunResult(
  record: ReturnType<typeof createReplayRecord>,
  runEnd: RunEndState,
  exitCode: number,
  identity: SessionIdentityTracker,
  stderrTee: { path: string; close(): void } | undefined,
  params: SpawnRunParams,
  startTime: number,
  callbacks: SpawnRunCallbacks,
): SpawnRunResult {
  // spawn 'error' 形态（子进程从未运行，典型 ENOENT）：错误事件消息（含 errno
  // code 与命令路径）直接进终态文案——比裸退出码可诊断，且不命中 stale 分诊
  // 词表。exitCode 判定优先（close 已 settle 0 后迟到的 error 事件只留日志，
  // 不产生 success=true + error 并存的自相矛盾终态）。
  // 成功边界（agent_settled 到达）已按轮清零 record.turnCount（SP-9）——收集前
  // 以 resolve 时刻快照恢复真实轮数（成功 run 的 outcome.turns/usage.turns 不为
  // 0；[P5 计账] 快照已按失败尝试排除）；失败路径 agent_settled 未到达，快照
  // 缺省，record 值即真实值。
  if (runEnd.settledTurnCount !== undefined) record.turnCount = runEnd.settledTurnCount;
  // [M2 D3] 送达失败分支优先：tracker 已结算（timeout/lost → engine_prompt_not_delivered；
  // rejected → engine_prompt_rejected），退出码只是杀链后果（SIGKILL → 137），
  // 终态呈现映射后的错误码文案而非裸「子进程退出 137」（设计 S7/S7b 反向断言）。
  // [subagent-observability §3.3.1] 错误停因事实在场时死因事实优先于退出码裸文案
  //（结构化轮终事实的 errorMessage = provider 层真实死因）。
  const ackFailure = runEnd.promptAckFailure;
  // [subagent-observability §3.3.1 P4 静默空成功防伪] 退出 0 不再单独构成成功证据
  //（pi 1.0.0 实装：stdin EOF → rpc-mode shutdown → 无条件 exit(0)，无 settled 的
  // 0 退出可达）。成功公式 = 退出 0 ∧ 无送达失败 ∧ 无错误停因事实 ∧ 非未解释空轮——
  // 未解释空轮 = 无 agent_settled 快照、无被接管标记（promptHandledNoRun——被接管
  // 轮的空是「有解释的空」，见 p6 收条设计）、零轮：按失联语义记失败，不产假成功。
  // 「end 与 settled 之间被杀」形态（endedCleanly=true 且有真实轮数）不受本判据影响
  //（有轮 = 有工作证据，非空成功）。
  const recordHasNoWork =
    record.turnCount === 0 &&
    record.turns.every((t) => t.text === "" && t.thinking === "" && t.toolCalls.length === 0);
  const unexplainedEmptyExit =
    exitCode === 0 &&
    ackFailure === undefined &&
    runEnd.settledTurnCount === undefined &&
    runEnd.promptHandledNoRun !== true &&
    recordHasNoWork;
  const success =
    exitCode === 0 && ackFailure === undefined && runEnd.terminalErrorFact === undefined && !unexplainedEmptyExit;
  const error = success
    ? undefined
    : unexplainedEmptyExit
      ? "pi child exited with code 0 without any agent activity (no agent_settled, zero turns): " +
        "treating as lost contact, not success. Recovery: retry the run; if it reproduces, " +
        "inspect the pi child stderr tee for the shutdown cause."
      : ackFailure !== undefined
        ? describePromptAckFailure(ackFailure)
        : runEnd.terminalErrorFact !== undefined
          ? runEnd.terminalErrorFact.errorMessage
          : buildExitErrorText(exitCode, runEnd.childErrorMessage);
  if (ackFailure !== undefined) {
    // 送达失败路径同时发 error 事件（设计 §3.4.2：让 journal 有记录；既有退出码
    // 失败不加发，行为面不变）。
    callbacks.onEvent({ type: "error", message: error ?? "prompt delivery failed" });
  }
  const outcome = collectOutcome(record, {
    startTime,
    success,
    error,
    sessionId: identity.sessionId ?? "",
    sessionFile: identity.sessionFile,
    // [F-1 信号解耦] schemaExpected 判定源 = task.schema 声明形态（schema 本体
    // 存在与否），与 env 派生/注入值不再同源——注入链路变化不影响检查期待。
    ...(params.schema !== undefined ? { schemaExpected: true } : {}),
    // [subagent-observability §3.3.1] 收尾边沿结构化事实 + 三源判别事实位。
    // turn-budget 事实位只在收尾边沿事实缺席时传入（limiter abort 是 SIGKILL 直杀
    // 路径、结构上无停因事实；两者并存的矛盾输入以收尾边沿裁决为权威——分类
    // 单源不双裁）。
    ...(runEnd.terminalErrorFact !== undefined ? { terminalError: runEnd.terminalErrorFact } : {}),
    ...(runEnd.turnBudgetExhausted === true && runEnd.terminalErrorFact === undefined
      ? {
        turnBudgetExhausted: true,
        // [§3.3.9/UC-10] 耗尽事实（{used, limit}）随事实位传入——cause.budget。
        ...(runEnd.turnBudgetExhaustion !== undefined ? { turnBudget: runEnd.turnBudgetExhaustion } : {}),
      }
      : {}),
    ...(runEnd.promptHandledNoRun === true ? { promptHandledNoRun: true } : {}),
    // [P5 计账] 最终尝试 usage 切片基 + 重试波次计数。
    ...(runEnd.settledAccounting !== undefined && runEnd.settledAccounting.retryAttempts > 0
      ? {
        finalAttemptTurnBase: runEnd.settledAccounting.finalAttemptTurnBase,
        retryAttempts: runEnd.settledAccounting.retryAttempts,
      }
      : {}),
  });
  // [D5 诊断引用写入 journal 记录] 失败时随终态应答上报 stderr tee 路径（引擎应答 failed /
  // 进程异常退出路径的共同汇聚点 = outcome.error 非空；成功不报——诊断引用只在
  // 失败语义下有意义）。tee 缺席（无 stderr / dataDir 不可解析 / pid 缺失）= 字段
  // 缺省，宿主按「无取证指针」消费。
  const stderrTeePath = outcome.error !== undefined ? stderrTee?.path : undefined;
  return {
    ...outcome,
    ...(stderrTeePath !== undefined ? { stderrTeePath } : {}),
    sessionId: identity.sessionId,
  };
}

/**
 * [M2 ⑦ / 设计 §3.4.1 prepare 期 abort] 取消先于 spawn 的终态装配：检查点位于
 * `spawnEngineChild`（AbortSignal 监听的唯一注册点）之前——已 abort 则不 spawn 子
 * 进程（无孤儿、无 childSpawned/pid 镜像），直接以取消语义收口。
 *
 * 取消 = cancelled 终态而非失败（设计 §3.4.1「取消不带恢复指引」）：载荷复用既有
 * 失败构造（collectOutcome，与中途 abort 的 143 路径同形），错误文案取宿主 cancel
 * 通道的既有措辞——server.ts `cancel` → `Error("cancelled by host: <reason>")`，经
 * `signal.reason` 承载（不新造错误码）；reason 缺失/非 Error/空串时回落同口径固定
 * 文案。不 emit error 事件（取消无失败面，事件/镜像面零产出）。宿主侧 record 的
 * cancelled 终态判定基于自身 signal 事实（terminal-actions 的 aborted 参数），本
 * 结果只承载引擎侧终态载荷。
 */
function collectCancelledBeforeSpawn(
  record: ReturnType<typeof createReplayRecord>,
  signal: AbortSignal,
  startTime: number,
): SpawnRunResult {
  const reason = signal.reason;
  const error = reason instanceof Error && reason.message !== "" ? reason.message : "cancelled by host";
  const outcome = collectOutcome(record, { startTime, success: false, error, sessionId: "", sessionFile: undefined });
  return { ...outcome, sessionId: undefined };
}

export async function runSpawnOnce(
  params: SpawnRunParams,
  callbacks: SpawnRunCallbacks,
): Promise<SpawnRunResult> {
  const record = createReplayRecord();
  const startTime = Date.now();
  const modelRef = requireCanonicalModelRef(params.model);
  // [M2 D3] prompt 回执 tracker（spawn 成功后装配；finally 必达 dispose——正常
  // 完成 / 异常 / 取消三路都经过）。
  let ackTracker: PromptAckTracker | undefined;
  // [M3 D6] fd3 raw mirror 写入器（env 宣告才创建；per-run，finally 必达 dispose
  // ——fd 属引擎进程不关闭，跨 run 复用）。seq 归属 recordId（进程级计数器）：
  // workflow 成员复用导致同 recordId 再次 run 时序号接续，不从 0 重开。
  let rawMirror: RawMirrorWriter | undefined;

  // prepare 期校验已前置（见 requireCanonicalModelRef）：model 缺失在临时文件创建前
  // fail-fast。

  // 1. append-system-prompt 文件（环境块 + wrap-up 提示 + 调用方片段）
  const tempFile = await writeAppendPromptFile(params);

  try {
    // 2. spawn 参数 + invocation
    const args = buildSpawnArgs({
      modelRef,
      // 档位原样透传（合法性权威 = 宿主入口层与 pi）——非法值由 pi 显式报错，
      // 本层不再做白名单收窄（收窄会把非法值静默换成 undefined = 「显式指定」变「没指定」）。
      // [pi 锚点] 档位以 --model "provider/id:level" 后缀传递（pi-rpc
      // buildPiSubagentSpawnArgs），pi CLI 链恒严格解析：dist/core/
      // model-resolver.js resolveCliModel 两处 parseModelPattern 传
      // allowInvalidThinkingLevelFallback:false，非法后缀在严格模式按
      // 模型 id 一部分处理返回 model:undefined（缺省 ?? true 放宽仅 scope
      // 模式走）→ resolveCliModel 收敛为 error "Model ... not found" → dist/main.js
      // 打印 Error 后 process.exit(1) → spawn run 失败可见（语义登记 PS-69，
      // verifiedWith 以 pi-semantics.json 为准，逐 claim 行号见该条目 piAnchor）。
      // pi 升级重验：两处 parseModelPattern 是否仍传 false——若 CLI 链改用缺省
      // 放宽，非法档位将静默剥后缀降级为「没指定」（docs/pi-semantics.json PS-62）。
      thinkingLevel: resolveThinkingLevel(params),
      agentTools: params.agentTools,
      appendSystemPromptPath: tempFile?.filePath,
      sessionDir: params.sessionDir,
      sessionFile: params.resumeSessionFile,
      forkSource: params.forkSource,
      skillPaths: params.skillPaths,
      extensionPaths: params.extensionPaths,
    });
    const invocation = getPiInvocation(args);
    const childEnv = buildChildEnv(params);
    // [M2 ⑦ / 设计 §3.4.1 prepare 期 abort 检查] 取消先于 spawn：在 spawnEngineChild
    // （AbortSignal 监听唯一注册点）之前短路——已 abort 的 run 不 spawn（防「启动即
    // 被杀」与「监听注册太晚漏杀」两窗口），直接返回取消终态。检查与 spawn 之间是
    // 同步块（无 await，且监听在 spawnEngineChild 内同步注册），不存在「检查后、监听
    // 前」的可交错漏杀窗口；武装断言与本次 spawn 绑定，取消优先于武装失败（已取消的
    // run 不产生失败面）。
    if (params.signal?.aborted === true) {
      return collectCancelledBeforeSpawn(record, params.signal, startTime);
    }
    // [D3 止血版 武装断言] run 开始后、孙进程 spawn 前校验武装状态，缺席即抛错
    // （秒级 fail-fast，host 侧收到含恢复指引的 engine_run_failed）。capability
    // 字面量与 PiEngine.capabilities().schemaEnforcement（pi-engine.ts，manifest
    // 同源）一致——引擎能力是进程级事实而非 per-run 参数，不经 run ctx 传递；
    // 本包是 pi 引擎进程，无第二 capability 源。
    assertSchemaEnforcementArmed({
      schemaEnforcement: "native",
      schema: params.schema,
      childEnv,
      spawnArgs: args,
    });
    const child = spawnEngineChild({
      command: invocation.command,
      args: invocation.args,
      env: childEnv,
      cwd: params.cwd,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });
    // [M3 D6] fd3 镜像写入器：与主解析链同一数据源（stdout 原始 Buffer tap，接线见
    // wireChildStdoutPump）；env 未宣告时 undefined（零 fd3 触点，既有路径不变）。
    rawMirror = createFd3RawMirrorWriter({ recordId: params.recordId, env: process.env });

    // [U1 归并] 杀链切 pi-rpc killPiProcess（SIGKILL 直杀 + 立即 resolve，与
    // runtime 主链路同源；原「SIGCONT → SIGTERM → grace → SIGKILL」阶梯随
    // ADR-0122 防御清理退役）。killChild 是 fire-and-forget，无 settle 消费方。
    const killChild = (): void => {
      void killPiProcess(child);
    };
    // agent_settled 收割（[modeless 波2] 唯一终结语义）：轮终（真空闲）resolve 后的
    // 主动 kill，close 带信号但语义是成功（旧 core waitForChildExit 的 code ?? 0
    // 同义——signal 退出码 143 只属异常路径）。
    // agent_settled 的 run resolve 句柄（inproc state.resolveRun 同款：
    // 声明先于 handler 装配，exitPromise executor 内落位——事件只会在 pump 启动后
    // 异步到达，无空窗）。
    const runEnd: RunEndState = { endedCleanly: false };
    // 身份写入口先行装配：stdout pump 的 get_state 应答回填与握手共用同一 tracker。
    const identity = createSessionIdentityTracker(params.sessionDir, callbacks);
    // [M2 D3] prompt 送达回执 tracker + 诊断计数器：prompt response 是唯一成功
    // 回执；onFailure = 记录 runEnd.promptAckFailure + 杀链（SIGKILL 直杀，run 以
    // 失败 outcome 收尾，终态文案带诊断五元组）；零输出窗口经
    // TAIJI_SUBAGENT_PROMPT_ACK_TIMEOUT_MS 覆盖（默认 30s；0 = 逃生舱关闭看门狗）。
    const runCounters = createPromptRunCounters();
    ackTracker = createPromptAckTracker({
      recordId: params.recordId,
      timeoutMs: resolvePromptAckTimeoutMs(process.env),
      diagnostics: () => ({
        pid: child.pid,
        bytesWritten: runCounters.bytesWritten,
        stdoutBytes: runCounters.stdoutBytes,
        stdoutBytesAfterPrompt: runCounters.stdoutBytesAfterPrompt,
        stdoutSeen: ackTracker?.stdoutSeen === true,
        getStateAnswered: runCounters.getStateAnswered,
        ...(runCounters.lastEventType !== undefined
          ? { lastEventType: runCounters.lastEventType }
          : {}),
      }),
      onFailure: (result) => {
        runEnd.promptAckFailure = result;
        killChild();
      },
      // [subagent-observability §3.3.1 P6] handled 结算分派接线（ack 结算后触发；
      // 零终态事件挂起的唯一修复点）。
      onHandled: createHandledSettlement(child, params, identity, runEnd),
    });
    const handleSdkEvent = createSdkEventTranslator(
      record,
      buildTranslatorOpts(params, callbacks, killChild, runEnd),
    );

    // 2b. stderr tee 落盘（W11，设计 §3.9 同款契约）：pi 任务子进程 stderr 此前
    // 无消费方（pipe 出来即弃，写满会背压卡死子进程）——tee 到实例维度文件
    // <engineDataDir>/logs/pi-task-stderr-<pid>.log（懒打开 + 尺寸轮转 + 三判据
    // 过期清理）；dataDir 不可解析（宿主未注入且无 fallback）时仅排空防背压。
    // [D5 诊断引用写入 journal 记录] tee 路径捕获：失败时随终态应答上报宿主（见 collectOutcome
    // 消费点）。
    const stderrTee = attachStderrTee(child);

    // 3. 镜像上报（childSpawned 先行——未收上报前宿主 = 无句柄）+ 引擎侧记账
    registerActiveChild(params.recordId, child);
    reportChildSpawned(child, params.recordId, callbacks);

    // [D3 协议版 P6] 武装回执上报：武装断言（本函数上方）通过 + 孙进程 spawn 成功
    //（spawnEngineChild 同步抛错即失败，成功返回 = 「孙进程启动确认」的最强可得
    // 形态——断言③已按 P-C1 核实退化，扩展加载破坏由 pi exit(1) 通路承接）。
    // 协议版上报 = 宿主的独立信号源（监控信号不与施控同源）：宿主等待窗据此判定
    // 武装链路活性，防「断言代码自身失效/被绕过」的自证盲区。仅 schema 任务上报
    // （本包是 native 引擎，capability 分流已由断言前置；无 schema 任务无武装面，
    // 上报零语义）。宿主 reducer 对本事件 no-op（C3 第④步），记录归 run 事件 journal。
    reportSchemaEnforcementArmed(params, callbacks);

    // 4. UI 请求队列（host/askUser 两阶段等待体注入）
    const enqueueUi = createUiRequestQueue(child, {
      ...(callbacks.askUser !== undefined ? { uiRequestHandler: callbacks.askUser } : {}),
    });

    // 5+6. session 身份回填 + stdout pump / close 收尾（身份三路同源与退出码口径
    // 见 spawn-run-pump.ts；get_state 监听表随 identity tracker 持有）
    const exitPromise = wireChildStdoutPump({
      child,
      recordId: params.recordId,
      callbacks,
      identity,
      handleSdkEvent,
      enqueueUi,
      stderrTee,
      runEnd,
      promptAck: ackTracker,
      runCounters,
      ...(rawMirror !== undefined ? { rawMirror } : {}),
    });

    // 7. get_state 握手 fire-and-forget（RPC mode 无 header 行，靠握手回填身份）——
    //    先于 prompt 发出：续聊轮的 idle 相位 anchor 与 run 应答 handle 都需要
    //    sessionFile，身份先知再驱动轮次（stdout 流序保证握手应答先于轮终事件）。
    //    身份回填主体在 identity 的响应行同步路径（见 spawn-run-pump.ts 头注），此处
    //    仅兜底超时重试轮次拿到的新值（同值去重，不重发 handleReady）。
    void performGetStateHandshake(child, identity.addStateListener).then((r) => {
      identity.applyGetStateFields(r);
    });

    // 8. prompt 命令（rpc mode 唯一任务驱动通道）+ [M2 D3] 送达回执装配（见 sendPromptWithAck）。
    sendPromptWithAck(child, params.task, ackTracker, runCounters);

    // 9. 等待退出
    const exitCode = await exitPromise;
    return collectRunResult(record, runEnd, exitCode, identity, stderrTee, params, startTime, callbacks);
  } finally {
    // [M2 D3] tracker 幂等清理：已 settle 的结果不受影响（runEnd.promptAckFailure
    // 已落位），未决的零输出计时器/登记表随 run 终止必达清理（迟到 response 由
    // settled/disposed 门自行忽略）。
    ackTracker?.dispose();
    // [M3 D6] 镜像写入器释放（不关 fd3；残留未成行字节按 NDJSON 语义丢弃）。
    rawMirror?.dispose();
    if (tempFile !== undefined) await cleanupTempPrompt(tempFile);
  }
}

// [subagent-model-switch §7.3] setModel 子进程通路（定位活跃子进程 → 命令写入 →
// 读应答 → get_state 回读）落 control-responses.ts——spawn-runner 职责 = spawn 执行
// 与 run 生命周期，模型热切控制范围与其正交（该编排移入即越本文件 max-lines 上限）；
// 接线原语复用不变：stdin-writer sendSetModelCommand / active-children 记账表 /
// pump 应答分发（spawn-run-pump.ts response 分支）。

// 活跃子进程记账（自本文件提取至 active-children.ts，行为等价）：
// re-export 保持既有导入范围（index.ts / pi-engine.ts / __tests__）。
export {
  getActiveChild,
  killAllActiveChildren,
  registerActiveChild,
} from "./active-children.ts";
