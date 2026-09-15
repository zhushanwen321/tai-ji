// src/spawn-runner.ts
//
// 协议化 spawn 执行器（W7，impl-plan §2.7）——runSpawn 的引擎侧本体迁移。
//
// core engines/pi/session-runner.ts 的 runSpawn 在壳进程内直接操纵 ExecutionRecord /
// session-pending / settled-watchdog 等宿主编排件；协议化后引擎进程内只保留
// 「spawn pi 子进程 + stdout pump + 事件翻译 + UI 请求发射 + 结果收集」，宿主侧
// 记账由 core 经 `event` 通知与 host/* 反向通道完成（W8 宿主接线 / W10 conformance
// 收口）。本文件是引擎侧的协议化形态：
//
//   - 子进程 spawn 必经 SDK spawnEngineChild（detached:false / 子 stdin 自有 pipe，
//     W10 静态断言目标）+ buildOutboundChildEnv（deny 键剥除）；
//   - 事件经 SdkEvent → AgentEvent 翻译（spawn-args 纯函数）→ SDK journal-replay
//     reducer 累积（ReplayRecordView——core updateFromEvent 的 SDK 下沉副本）；
//   - extension_ui_request 经 ui-request-queue FIFO → host/askUser 反向请求
//     （ack 两阶段，R9-2 语义；handler 缺失时本地去重告警 + cancelled）；
//   - childSpawned / childStateChanged 上报（core 镜像数据源）；
//   - relay 归属键按 W8/H12 重写：SOCKET/NODE/SCRIPT 原样转发，SESSION_ID/
//     RECORD_ID 从 run ctx 重写（不靠 env 继承——spawn env 的 deny 清单已剥）。
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
  buildOutboundChildEnv,
  createReplayRecord,
  getLogger,
  resolveEngineDataDir,
  spawnEngineChild,
  type AgentEvent,
  type UiRequest,
  type UiResponse,
} from "@zhushanwen/subagent-engine-sdk";
import { killPiProcess } from "@zhushanwen/pi-rpc";

import { mirrorMainProcessFlags, type MirrorFlags } from "./argv-mirror.ts";
import { registerActiveChild } from "./active-children.ts";
import { PI_KILL_GRACE_MS } from "./constants.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import { collectOutcome, type CollectedOutcome } from "./output-collector.ts";
import { toErrorMessage } from "./error-message.ts";
import {
  asThinkingLevel,
  buildEnvBlock,
  buildSpawnArgs,
  parseSpawnModelRef,
} from "./spawn-args.ts";
import { createSdkEventTranslator, type SdkTranslatorOpts } from "./spawn-event-translator.ts";
import {
  createSessionIdentityTracker,
  reportChildSpawned,
  wireChildStdoutPump,
  type RunEndState,
} from "./spawn-run-pump.ts";
import { performGetStateHandshake } from "./get-state-handshake.ts";
import { clearEpipeFailure, sendPromptCommand } from "./stdin-writer.ts";
import { cleanupTempPrompt, writePromptToTempFile } from "./temp-prompt.ts";
import { WRAP_UP_HINT } from "./turn-limiter.ts";
import { applySchemaEnvToChildEnv } from "./spawn-args.ts";
import { createUiRequestQueue } from "./ui-request-queue.ts";
import { isRelayActive, RELAY_ENV_RECORD_ID, RELAY_ENV_SESSION_ID } from "@zhushanwen/subagent-engine-sdk";
import {
  cleanupSiblingStderrLogs,
  rotateStderrLogIfNeeded,
  stderrLogPathFor,
  stderrRotationParams,
} from "./logs/stderr-rotation.ts";

const logger = getLogger("session-runner");

// 毫秒→秒换算（SIGKILL 升级 warn 日志的秒数显示）。文件内私有定义：工程内
// MS_PER_SECOND 惯例是各使用文件私有常量（subagent-engine-sdk kill-chain 等
// 先例），无共享导出源可 import，保持同惯例不另立导出点。
const MS_PER_SECOND = 1_000;

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
  /**
   * agent_end（非 willRetry，队列排空）到达：本轮收敛（输出完整即轮终）。不 kill
   * 子进程（等 agent_settled——pi 的 compact/收尾在 agent_end 后执行）。[H1 U5] 原
   * chat-session 会话管理器的 settled 相位上报消费已随 registry 删除；本回调保留为
   * 轮次时序的可观测面（run-spawn-once.integration 断言轮次时序）。
   */
  onChatRoundEnd?: () => void;
  /**
   * agent_settled（真空闲边界）到达：run 在此 resolve（exit 0 口径）并收割子进程
   * （runSpawnOnce 内建，见 runSpawnOnce 生命周期注释）。[H1 U5] 原 chat-session
   * 会话管理器的 idle 相位上报消费已随 registry 删除；本回调保留为轮次时序的
   * 可观测面。
   */
  onChatAgentSettled?: () => void;
}

/** runSpawnOnce 的入参（协议 RunParams 的引擎侧还原形态）。 */
export interface SpawnRunParams {
  /** record 锚（= run.params.runId；镜像键 / relay RECORD_ID 重写源）。 */
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
  /** schema env JSON 字符串（PI_WORKFLOW_SCHEMA 注入）。 */
  schemaEnv?: string;
  /** hard turn limit。 */
  maxTurns?: number;
  /** soft limit 后宽限轮数（默认 2）。 */
  graceTurns?: number;
  /** 中断信号（协议 cancel → server 层 AbortController）。 */
  signal?: AbortSignal;
  /** 根 session id（relay SESSION_ID 重写源，协议 ctx 还原）。 */
  sessionRootId?: string;
  /** 追加 system prompt 片段（agent body 之外的调用方片段）。 */
  appendSystemPrompt?: string[];
  /** skill 路径（--skill 多值）。 */
  skillPaths?: string[];
  /** agent 工具白名单（--tools）。 */
  agentTools?: string[];
  /** fork 源 session 文件（--fork）。 */
  forkSource?: string;
  /** 镜像 flag 覆盖（缺省自动镜像主进程 argv）。 */
  mirrorFlags?: MirrorFlags;
  /** resume 目标 session 文件（冷续写：--session 续写原文件）。 */
  resumeSessionFile?: string;
}

/** runSpawnOnce 的产物。 */
export interface SpawnRunResult extends Omit<CollectedOutcome, "sessionId"> {
  /** 会话头身份（header / get_state 握手回填；全 miss 时 undefined）。 */
  sessionId: string | undefined;
}

/** 子进程 env 组装（deny 剥除 + schemaEnv 注入 + relay 归属键重写）。 */
function buildChildEnv(params: SpawnRunParams): Record<string, string> {
  const extras: Record<string, string | undefined> = {};
  applySchemaEnvToChildEnv(extras, params.schemaEnv);
  const childEnv = buildOutboundChildEnv({ parentEnv: process.env, extras });
  // relay 归属键重写（W8/H12）：SESSION_ID/RECORD_ID 在 ENGINE_ENV_DENY_LIST，
  // buildOutboundChildEnv 的 deny 在 extras 之后执行——经 extras 注入会被剥掉
  // （旧实现的 RECORD_ID 重写因此从未送达 relay.mjs，归属键缺失 → 退出码 13）。
  // 必须在 deny 终态之后按 run ctx 显式写回（不靠 env 继承）。SESSION_ID 权威源
  // = 协议 ctx.sessionRootId（F6 已收敛：core SubagentService 注入的根 session id
  // 经 wire → server 还原 → SpawnRunParams 一线透传至此）；env 回落
  // PI_SUBAGENT_ROOT_SESSION_ID 保留给 standalone / 裸 CLI 形态（无宿主 run ctx）。
  if (isRelayActive(process.env)) {
    const rootId = params.sessionRootId ?? process.env["PI_SUBAGENT_ROOT_SESSION_ID"];
    if (rootId !== undefined && rootId !== "") childEnv[RELAY_ENV_SESSION_ID] = rootId;
    childEnv[RELAY_ENV_RECORD_ID] = params.recordId;
  }
  return childEnv;
}

/**
 * 单次 spawn run：spawn pi rpc 子进程 → pump stdout → 收集结果。
 *
 * 生命周期（[modeless 波2] 唯一语义）：正常轮终 = agent_settled（真空闲）resolve
 * （exit 0 口径）并收割子进程；异常/abort = 子进程 close（exit/error，128+ 折算
 * 判据）。abort（signal）经 spawnEngineChild 的 signal 通道发 SIGTERM，升级链由
 * killPiProcess 兜底。
 */
/**
 * stderr tee（W11）：实例维度路径 + 懒打开 + 尺寸轮转（超 XYZ_LOG_MAX_BYTES rename
 * 副本重开）+ 三判据过期清理（同前缀 + pid 已死 + mtime 过期）。失败面全部静默
 * 降级（取证面不拖垮任务主通道——调用方对无 tee 形态 resume 排空防背压）。
 */
function createStderrTee(child: ChildProcess): { close(): void } | undefined {
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
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (failed) return;
    try {
      if (stream === null) {
        fs.mkdirSync(dirname(logPath), { recursive: true });
        stream = fs.createWriteStream(logPath, { flags: "a" });
        stream.on("error", () => {
          failed = true;
        });
        cleanupSiblingStderrLogs(logPath, process.env);
      }
      stream.write(chunk);
      if (rotateStderrLogIfNeeded(logPath, stderrRotationParams(process.env))) {
        stream.end();
        stream = null;
      }
    } catch {
      failed = true;
    }
  });
  return {
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

/** SDK 事件翻译器 opts 装配（agent_end 轮收敛不 kill / agent_settled resolve+收割 + run 收尾状态接线）。 */
function buildTranslatorOpts(
  params: SpawnRunParams,
  callbacks: SpawnRunCallbacks,
  killChild: (source: string) => void,
  runEnd: RunEndState,
): SdkTranslatorOpts {
  return {
    maxTurns: params.maxTurns,
    graceTurns: params.graceTurns,
    onEvent: callbacks.onEvent,
    onDelta: callbacks.onDelta,
    abort: () => killChild("turn limiter abort"),
    // agent_end（非 willRetry，队列排空）= 轮收敛（输出完整即轮终）：不 kill（等
    // agent_settled 收割边界——pi 的 compact/收尾在 agent_end 后执行，提前 kill 截断
    // 收尾截断 session 文件）；endedCleanly 置位让「end 与 settled 之间被杀」的 close
    // 也按 0 口径收尾。
    onAgentEnd: () => {
      runEnd.endedCleanly = true;
      callbacks.onChatRoundEnd?.();
    },
    // agent_settled（真空闲，agent_end 之后、post-run 完成后才 emit）= run 的 resolve
    // 与收割边界（[H1 U3] D7，[modeless 波2] 唯一语义）：onChatAgentSettled 回调先于
    // run resolve（run-spawn-once.integration 的轮次时序断言面），resolveChatRun
    // settle exitPromise（run 应答不等收割），随后 fire-and-forget 杀链收割子进程
    // ——每轮一进程，续聊 = 新 run + resume 锚点，进程不再保活。
    onAgentSettled: () => {
      runEnd.endedCleanly = true;
      callbacks.onChatAgentSettled?.();
      runEnd.resolveChatRun?.(0);
      killChild("agent_settled reap");
    },
  };
}

export async function runSpawnOnce(
  params: SpawnRunParams,
  callbacks: SpawnRunCallbacks,
): Promise<SpawnRunResult> {
  const record = createReplayRecord();
  const startTime = Date.now();
  const modelRef = parseSpawnModelRef(params.model);

  // 1. append-system-prompt 文件（环境块 + wrap-up 提示 + 调用方片段）
  const tempFile = await writeAppendPromptFile(params);

  if (modelRef === undefined) {
    throw new Error(
      `[pi-subagent-cli] run requires a canonical model ref ("provider/id") in ctx.model, got: ${JSON.stringify(params.model)}. ` +
        `Recovery: the host must resolve the model before dispatching (run.params.ctx.model); check the engine routing layer.`,
    );
  }

  try {
    // 2. spawn 参数 + invocation
    const args = buildSpawnArgs({
      modelRef,
      thinkingLevel: asThinkingLevel(params.thinkingLevel),
      agentTools: params.agentTools,
      appendSystemPromptPath: tempFile?.filePath,
      sessionDir: params.sessionDir,
      sessionFile: params.resumeSessionFile,
      forkSource: params.forkSource,
      skillPaths: params.skillPaths,
      mirrorFlags: params.mirrorFlags ?? mirrorMainProcessFlags(process.argv),
    });
    const invocation = getPiInvocation(args);
    const child = spawnEngineChild({
      command: invocation.command,
      args: invocation.args,
      env: buildChildEnv(params),
      cwd: params.cwd,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });

    // [U1 归并] 杀链切 pi-rpc killPiProcess（SIGCONT 前置 + SIGTERM → grace →
    // SIGKILL 阶梯，与 runtime 主链路同源；grace 维持 PI_KILL_GRACE_MS 现状值，
    // timer unref 维持迁移前 dispose 语义）。相对 SDK killChain 的行为面差异：
    // +SIGCONT（唤醒 SIGSTOP 冻结形态，防御增强）、-SIGKILL 后 10s 收尸等待
    // （killChild 是 fire-and-forget，无 settle 消费方，无行为影响）。
    const killChild = (source: string): void => {
      void killPiProcess(child, {
        graceMs: PI_KILL_GRACE_MS,
        unrefTimers: true,
        onEscalate: () => {
          logger.warn(
            `[kill-chain] child ${params.recordId} (source: ${source}) still alive ${PI_KILL_GRACE_MS / MS_PER_SECOND}s after SIGTERM, escalating to SIGKILL`,
          );
        },
      });
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
    const handleSdkEvent = createSdkEventTranslator(
      record,
      buildTranslatorOpts(params, callbacks, killChild, runEnd),
    );

    // 2b. stderr tee 落盘（W11，设计 §3.9 同款契约）：pi 任务子进程 stderr 此前
    // 无消费面（pipe 出来即弃，写满会背压卡死子进程）——tee 到实例维度文件
    // <engineDataDir>/logs/pi-task-stderr-<pid>.log（懒打开 + 尺寸轮转 + 三判据
    // 过期清理）；dataDir 不可解析（宿主未注入且无 fallback）时仅排空防背压。
    const stderrTee = createStderrTee(child);
    if (stderrTee === undefined && child.stderr !== null) {
      child.stderr.resume();
    }

    // 3. 镜像上报（childSpawned 先行——未收上报前宿主 = 无句柄）+ 引擎侧记账
    registerActiveChild(params.recordId, child);
    reportChildSpawned(child, params.recordId, callbacks);

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
    });

    // 7. get_state 握手 fire-and-forget（RPC mode 无 header 行，靠握手回填身份）——
    //    先于 prompt 发出：续聊轮的 idle 相位 anchor 与 run 应答 handle 都需要
    //    sessionFile，身份先知再驱动轮次（stdout 流序保证握手应答先于轮终事件）。
    //    身份回填主体在 identity 的响应行同步路径（见 spawn-run-pump.ts 头注），此处
    //    仅兜底超时重试轮次拿到的新值（同值去重，不重发 handleReady）。
    void performGetStateHandshake(child, identity.addStateListener).then((r) => {
      identity.applyGetStateFields(r);
    });

    // 8. prompt 命令（rpc mode 唯一任务驱动通道）
    sendPromptCommand(child, params.task);

    // 9. 等待退出
    const exitCode = await exitPromise;
    clearEpipeFailure(params.recordId);

    // spawn 'error' 形态（子进程从未运行，典型 ENOENT）：错误事件消息（含 errno
    // code 与命令路径）直接进终态文案——比裸退出码可诊断，且不命中 stale 分诊
    // 词表。exitCode 判定优先（close 已 settle 0 后迟到的 error 事件只留日志，
    // 不产生 success=true + error 并存的自相矛盾终态）。
    const outcome = collectOutcome(record, {
      startTime,
      success: exitCode === 0,
      error: exitCode === 0
        ? undefined
        : runEnd.childErrorMessage !== undefined
          ? `pi child error: ${runEnd.childErrorMessage} (exit code ${exitCode})`
          : `pi child exited with code ${exitCode}`,
      sessionId: identity.sessionId ?? "",
      sessionFile: identity.sessionFile,
      ...(params.schemaEnv !== undefined ? { schemaExpected: true } : {}),
    });
    return { ...outcome, sessionId: identity.sessionId };
  } finally {
    if (tempFile !== undefined) await cleanupTempPrompt(tempFile);
  }
}

// 活跃子进程记账（自本文件提取至 active-children.ts，行为等价）：
// re-export 保持既有导入面（index.ts / pi-engine.ts / __tests__）。
export {
  getActiveChild,
  killAllActiveChildren,
  registerActiveChild,
} from "./active-children.ts";
