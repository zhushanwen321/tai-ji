// src/spawn-run-pump.ts
//
// stdout pump + close 收尾 + session 身份回填（自 runSpawnOnce 行为等价提取的
// 子进程生命周期接线面）。身份三路同源：header 行 / get_state 应答（响应行同步
// 路径 + 握手 promise 兜底）/ LC-4 后缀反查——写入口收敛在 identity tracker；
// close 收尾时三路全 miss = 应响亮报错的异常信号，warn 留痕不自动认领。

import type { ChildProcess } from "node:child_process";
import os from "node:os";
import { PassThrough } from "node:stream";

import { isBrokenPipeError } from "@zhushanwen/pi-rpc";
import { getLogger, pumpNdjsonLines } from "@zhushanwen/subagent-engine-sdk";

import { unregisterActiveChild } from "./active-children.ts";
import { dispatchControlResponse } from "./control-responses.ts";
import { toErrorMessage } from "./error-message.ts";
import { extractGetStateFields, type GetStateResult } from "./get-state-handshake.ts";
import type { PromptAckTracker, PromptAckResult } from "./prompt-ack.ts";
import type { RawMirrorWriter } from "./raw-mirror.ts";
import {
  deriveSessionFilePath,
  findSessionFileByHeaderId,
  parseSpawnLine,
  type ExtensionUiRequest,
  type SdkEvent,
  type SpawnSessionHeader,
} from "./spawn-event-adapter.ts";
import type { SpawnRunCallbacks } from "./spawn-runner.ts";

const logger = getLogger("session-runner");

/** 无效 stdout 行的日志截断长度（够诊断、不刷屏）。 */
const INVALID_LINE_LOG_CHARS = 160;

/** 信号退出码合成基值（close 无 code 只有 signal 时按 POSIX 128+signo 约定折算非零）。 */
const SIGNAL_EXIT_CODE_BASE = 128;

/** 信号名 → 编号（SIGTERM=15 等）。os.constants.signals 反查；未知信号回退 0（保持裸 128 口径）。 */
function signalNumberOf(signal: NodeJS.Signals): number {
  const signals = os.constants.signals as Record<string, number>;
  return signals[signal] ?? 0;
}

/**
 * child 'error' 事件（spawn 失败——子进程从未运行）的收尾退出码。POSIX
 * command-not-found 惯例值：与 128+ 信号折算族同为非零异常口径，且语义上贴近
 * 「找不到可执行文件」（典型 ENOENT）。
 */
const SPAWN_ERROR_EXIT_CODE = 127;

/** run 收尾状态（轮收敛（agent_end/agent_settled）与 close 收尾共享的可变句柄）。 */
export interface RunEndState {
  /** 轮终置位（agent_end / agent_settled）：主动收割的 close 按成功口径（exit 0）收尾。 */
  endedCleanly: boolean;
  /**
   * child 'error' 事件的消息快照（spawn 失败形态：子进程从未运行）。error 事件
   * 先于真实 close 到达且 promise 已被手动收尾 settle——真实 close 的退出码参数
   * 不再生效，终态装配只能靠此快照区分「从未启动」与正常退出（exitCode 判定链
   * 见 spawn-runner collectOutcome）。
   */
  childErrorMessage?: string;
  /** agent_settled 的 run resolve 句柄（exitPromise executor 内落位）。 */
  resolveChatRun?: (code: number) => void;
  /**
   * resolve 时刻的真实轮数快照（agent_settled 传出，见 SdkTranslatorOpts.onAgentSettled）。
   * agent_settled 消费面随后按轮清零 record.turnCount（SP-9），收集面以本快照恢复
   * 成功 run 的真实轮数；undefined = agent_settled 未到达（失败路径），record 值即真实值。
   */
  settledTurnCount?: number;
  /**
   * [M2 D3] prompt 送达失败的结算结果（tracker onFailure 落位；collectRunResult
   * 据此把退出码文案覆盖为 engine_prompt_not_delivered / engine_prompt_rejected
   * 错误码前缀终态——不是裸「子进程退出 137」）。undefined = 送达链路无失败。
   */
  promptAckFailure?: PromptAckResult;
}

/** session 身份回填状态机（三路写同源；get_state 监听表随行持有）。 */
export interface SessionIdentityTracker { // oe-exempt:20260930:framework:CLI 泵与 spawn 编排之间的接缝契约（唯一实装 createSessionIdentityTracker；非投机抽象，后续新增引擎会带来第二实装）
  readonly sessionId: string | undefined;
  readonly sessionFile: string | undefined;
  /** header 行：id + session 文件路径全量落位（handleReady 双字段条件展开）。 */
  noteHeader(header: SpawnSessionHeader): void;
  /** get_state response 监听登记（握手 + 迟到 response 自弃）。 */
  addStateListener(id: string, resolver: (data: unknown) => void): void;
  /** response 帧分发（一次性消费；未知 id 自弃；失败帧以 undefined resolve）。@returns 是否消费了已登记的 get_state 应答。 */
  dispatchStateResponse(id: string | undefined, success: boolean, data: unknown): boolean;
  /** get_state 字段落位（同步路径 + 握手兜底共用；新值才覆盖 + 重发 handleReady）。 */
  applyGetStateFields(fields: GetStateResult): void;
  /** 兜底反查（LC-4）：header/握手全 miss 时按 sessionId 后缀匹配 sessionDir。 */
  fallbackSessionFileByHeaderId(): void;
  /** close 收尾：未决监听表清空。 */
  clearStateListeners(): void;
}

/**
 * session 身份回填状态机。get_state 身份回填走响应行的同步路径（不经握手
 * promise 的 .then 微任务）：同一 stdout data 事件内握手应答行之后的轮终事件行
 * （chat 的 agent_settled → idle 相位 anchor）立即可见 sessionFile——整 chunk
 * 同帧处理时微任务时序不可靠。
 */
export function createSessionIdentityTracker(
  sessionDir: string,
  callbacks: SpawnRunCallbacks,
): SessionIdentityTracker {
  let sessionId: string | undefined;
  let sessionFile: string | undefined;
  const stateListeners = new Map<string, (data: unknown) => void>();

  const applyGetStateFields = (fields: GetStateResult): void => {
    if (fields.sessionId !== undefined && sessionId === undefined) sessionId = fields.sessionId;
    if (fields.sessionFile !== undefined && fields.sessionFile !== sessionFile) {
      sessionFile = fields.sessionFile;
      callbacks.onHandleReady?.({
        sessionRef: {
          ...(sessionId !== undefined ? { sessionId } : {}),
          sessionFile: fields.sessionFile,
        },
      });
    }
  };

  return {
    get sessionId() {
      return sessionId;
    },
    get sessionFile() {
      return sessionFile;
    },
    noteHeader(header) {
      sessionId = header.id;
      sessionFile = deriveSessionFilePath(header, sessionDir);
      callbacks.onHandleReady?.({
        sessionRef: {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(sessionFile !== undefined ? { sessionFile } : {}),
        },
      });
    },
    addStateListener(id, resolver) {
      stateListeners.set(id, (data: unknown) => {
        const picked: GetStateResult = {};
        extractGetStateFields(data, picked);
        applyGetStateFields(picked);
        resolver(data);
      });
    },
    dispatchStateResponse(id, success, data) {
      if (id === undefined || !stateListeners.has(id)) return false;
      const resolver = stateListeners.get(id);
      stateListeners.delete(id);
      resolver?.(success ? data : undefined);
      return true;
    },
    applyGetStateFields,
    fallbackSessionFileByHeaderId() {
      if (sessionFile !== undefined || sessionId === undefined) return;
      const found = findSessionFileByHeaderId(sessionDir, sessionId);
      if (found === undefined) return;
      // 走既有回填面（与 M2 回补同一条路）：sessionFile 落位（collectOutcome 的
      // outcome.sessionFile 生效）+ handleReady 通知宿主回写 record——run 在
      // agent_settled 已应答，close 兜底是 record 补 transcript 锚点的最后时机
      // （只补 sessionFile，sessionId 已知不再变更）。
      applyGetStateFields({ sessionFile: found });
    },
    clearStateListeners() {
      stateListeners.clear();
    },
  };
}

/** run 内 stdout/stdin 诊断计数（[M2 D3] 五元组的计数半面；spawn-runner 闭包读）。 */
export interface PromptRunCounters {
  /** stdin 已写字节（stdin-writer onBytesWritten 累计）。 */
  bytesWritten: number;
  /** 子进程 stdout 总字节（chunk 层累计，含 prompt 前的握手应答与未成行字节）。 */
  stdoutBytes: number;
  /** prompt 写入后的 stdout 字节（promptWritten 置位后按 chunk 累计，含未成行字节）。 */
  stdoutBytesAfterPrompt: number;
  /** prompt 已写入（spawn-runner 在 sendPromptCommand delivered 后置位）。 */
  promptWritten: boolean;
  /** get_state response 已应答（success 与否都算——证明 stdout 活着）。 */
  getStateAnswered: boolean;
  /** 最近一次 SdkEvent 的 type（pump event 分支更新）。 */
  lastEventType?: string;
}

/** 新建归零计数器（spawn-runner 每 run 装配）。 */
export function createPromptRunCounters(): PromptRunCounters {
  return { bytesWritten: 0, stdoutBytes: 0, stdoutBytesAfterPrompt: 0, promptWritten: false, getStateAnswered: false };
}

/** stdout pump 接线依赖（runSpawnOnce 装配后的每 run 依赖集）。 */
export interface StdoutPumpDeps {
  child: ChildProcess;
  recordId: string;
  callbacks: SpawnRunCallbacks;
  identity: SessionIdentityTracker;
  handleSdkEvent: (raw: SdkEvent) => void;
  enqueueUi: (id: string, request: ExtensionUiRequest) => void;
  stderrTee: { close(): void } | undefined;
  runEnd: RunEndState;
  /** [M2 D3] prompt 回执 tracker（response 分支分发 + chunk 层活性上报；缺省 = 旧形态直通，兼容既有装配/测试）。 */
  promptAck?: PromptAckTracker;
  /** [M2 D3] 诊断计数器（缺省 = 不计数，兼容既有装配/测试）。 */
  runCounters?: PromptRunCounters;
  /**
   * [M3 D6] fd3 raw mirror 写入器（缺省 = 镜像通道未开通，stdout 走原 setEncoding
   * 直路）。开通时 child.stdout 保持原始字节形态：tap 先挂（原始 Buffer，行切分在
   * 写入器内），主解析链经 PassThrough 桥接后再 setEncoding（pumpNdjsonLines 单点）
   * ——两条链消费同一次读取的同一 chunk 序列（tap 先注册，顺序一致）。
   */
  rawMirror?: RawMirrorWriter;
}

/**
 * stdout 行消费（parseSpawnLine 分类 → 身份/事件/响应/UI 各通道 + [M2 D3] 回执分发）。
 * 字节计数与零输出活性上报**不在这里**：它们是 chunk 级事实（{@link wireChildStdoutPump}
 * 的 noteStdoutChunk），行消费器只做解析——否则未成行的 partial chunk（极端大行
 * 慢写）不产生行、既不计字节也不取消计时器，健康 pi 会被误判 not_delivered。
 */
function createLineConsumer(deps: StdoutPumpDeps): (line: string) => void {
  const { recordId, identity, handleSdkEvent, enqueueUi, promptAck, runCounters } = deps;
  return (line: string): void => {
    const parsed = parseSpawnLine(line);
    if (parsed === null) return;
    switch (parsed.kind) {
      case "header":
        identity.noteHeader(parsed.header);
        return;
      case "event":
        if (runCounters !== undefined) runCounters.lastEventType = parsed.event.type;
        handleSdkEvent(parsed.event);
        return;
      case "response":
        // [M2 D3] get_state response（无论 success）证明 stdout 活着 → 五元组置位；
        // 同时分发 prompt 回执 tracker（只有 command==="prompt" 且 id 匹配才结算）。
        if (identity.dispatchStateResponse(parsed.id, parsed.success, parsed.data) && runCounters !== undefined) {
          runCounters.getStateAnswered = true;
        }
        promptAck?.dispatch(parsed.id, parsed.command, parsed.success, parsed.data, parsed.error);
        // [subagent-model-switch §7.3] 进程级控制应答等待表并行分发（setModel 通路
        // ——run 生命周期外的控制面操作等不到 per-run 监听表；两表按 id 各自一次性
        // 消费，未登记 id 各自自弃）。
        dispatchControlResponse(parsed.id, parsed.success, parsed.data, parsed.error);
        return;
      case "extension_ui_request":
        enqueueUi(parsed.id, parsed.request);
        return;
      case "invalid":
        // [C-U1] invalid 行不产生事件，但同样的字节已经在 chunk 层上报过活性
        // （noteStdoutChunk）——「只吐非 JSON / 缺 type 行」的健康 pi 不会在
        // 30s 窗口被误杀。此处只留解析失败诊断。
        logger.debug(
          `[session-runner] invalid stdout line from ${recordId} (ignored): ${parsed.raw.slice(0, INVALID_LINE_LOG_CHARS)}`,
          { error: parsed.error },
        );
        return;
    }
  };
}

/** 镜像上报：子进程退出态（core childStateChanged 数据源；pid 缺失不上报）。 */
function reportChildExited(
  child: ChildProcess,
  recordId: string,
  callbacks: SpawnRunCallbacks,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (child.pid === undefined) return;
  callbacks.onChildStateChanged?.({
    pid: child.pid,
    recordId,
    state: "exited",
    killed: child.killed,
    ...(code !== null ? { exitCode: code } : {}),
    ...(signal !== null ? { signal } : {}),
  });
}

/** close 退出码口径：轮终主动收割 = 0；其余 signal 退出按 POSIX 128+signo 折算（异常判据）。 */
function normalizeExitCode(
  endedCleanly: boolean,
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  return endedCleanly
    ? 0
    : code ?? (signal !== null ? SIGNAL_EXIT_CODE_BASE + signalNumberOf(signal) : 0);
}

/**
 * close 收尾的 sessionFile 仍缺响亮 warn：握手 / 迟到应答 / LC-4 后缀反查全 miss
 * 本身是应响亮报错的异常信号，不做启发式自动认领（prompt 头键误配的代价——错
 * sessionFile 让冷续 resume 共写他 session 文件——高于收益，且旗舰并发形态头部
 * 同质必然多命中、结构性地采不中）。warn 附人工排查指引，不静默。
 */
function warnSessionFileUnobtainable(deps: StdoutPumpDeps): void {
  const { recordId, identity } = deps;
  if (identity.sessionFile !== undefined) return;
  logger.warn(
    `[sessionfile] unobtainable for ${recordId} (all acquisition paths missed: spawn handshake, late response, LC-4 suffix lookup); ` +
      `record finalized without transcript anchor. Recovery: 若需 transcript 取证，用 session-reader 列 sessionDir 内 mtime 窗口文件人工归档；若需完整结果，重派任务。`,
  );
}

/**
 * close/exit 收尾：监听表清理 + tee 关闭 + 镜像上报 + LC-4 反查 + sessionFile 仍缺 warn + 退出码折算 resolve。
 *
 * 必达契约（U-A5，G1 破口）：链上任一步抛错都不许跳过后续步骤，尤其不许跳过
 * `resolveExit`——`reportChildExited` 直调宿主回调（server 组帧链）且原先无包裹，
 * 宿主回调抛出即让 LC-4 兜底与 resolveExit 全部丢失 = run 永挂（G1 要根除的形态）。
 * 故每步独立 best-effort（单个步骤抛错只降级该步并 warn 留痕），resolveExit 放
 * finally 必达区；异常也不得逃出 close 监听器（逃出即宿主 uncaughtException）。
 */
function createCloseFinalizer(
  deps: StdoutPumpDeps,
  resolveExit: (code: number) => void,
): (code: number | null, signal: NodeJS.Signals | null) => void {
  const { child, recordId, callbacks, identity, stderrTee, runEnd } = deps;
  const bestEffort = (step: string, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      logger.warn(
        `[session-runner] close finalizer step '${step}' failed for ${recordId} `
          + `(degraded; remaining steps and resolveExit still run)`,
        { detail: toErrorMessage(err) },
      );
    }
  };
  return (code, signal) => {
    try {
      bestEffort("clearStateListeners", () => identity.clearStateListeners());
      bestEffort("stderrTee.close", () => stderrTee?.close());
      bestEffort("unregisterActiveChild", () => unregisterActiveChild(recordId, child));
      // 宿主回调（onChildStateChanged → server 组帧链）：抛错不得阻断下面的兜底链
      bestEffort("reportChildExited", () => reportChildExited(child, recordId, callbacks, code, signal));
      bestEffort("LC-4 suffix lookup", () => identity.fallbackSessionFileByHeaderId());
      // LC-4 之后仍缺 = 全路 miss 的异常信号：响亮 warn + 人工排查指引（不自动认领）
      bestEffort("sessionfile unobtainable warn", () => warnSessionFileUnobtainable(deps));
    } finally {
      // 轮终主动收割（agent_settled reap）的 close 是正常完成（exit code 0 口径）；其余信号退出
      // 保持 128+ 折算（异常路径判据）。child 'error'（spawn 失败，子进程从未
      // 运行）必须按失败码收尾——(code=null, signal=null) 落回 0 折算会把从未
      // 启动的 run 伪成功（F4）。resolveExit 无条件必达。
      resolveExit(
        runEnd.childErrorMessage !== undefined
          ? SPAWN_ERROR_EXIT_CODE
          : normalizeExitCode(runEnd.endedCleanly, code, signal),
      );
    }
  };
}

/**
 * stdout pump + close 收尾接线（resolve = 子进程 close/exit/error；返回 exit
 * promise）。注册序（data → close → error → stdin error）与事件时序契约见
 * runSpawnOnce 各步注释。
 */
export function wireChildStdoutPump(deps: StdoutPumpDeps): Promise<number> {
  const { child } = deps;
  return new Promise<number>((resolveExit) => {
    // agent_settled resolve 句柄落位（见 runEnd 声明处注释）
    deps.runEnd.resolveChatRun = resolveExit;
    const consumeLine = createLineConsumer(deps);
    const onClose = createCloseFinalizer(deps, resolveExit);
    // [M2 D3 零输出判定] 活性/字节计数在 chunk 层（任意字节，含无换行的 partial
    // chunk）——行消费器只做解析，避免「极端大行慢写」不产出完整行时计时器不被
    // 取消而误走 engine_prompt_not_delivered + SIGKILL（设计 D3「任意字节」）。
    // 注册序在解析链监听器之后：同一 chunk 内的完整行先完成解析（get_state /
    // lastEventType 已落位），随后 chunk 上报只补「解析链仍在缓冲的未成行字节」的
    // 活性证据；timer 已清时 onChannelActivity 为 no-op，不会重复 warn。
    const noteStdoutChunk = (chunk: Buffer | string): void => {
      if (chunk.length === 0) return;
      if (deps.runCounters !== undefined) {
        const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;
        deps.runCounters.stdoutBytes += bytes;
        if (deps.runCounters.promptWritten) deps.runCounters.stdoutBytesAfterPrompt += bytes;
      }
      deps.promptAck?.onChannelActivity();
    };
    if (deps.rawMirror !== undefined && child.stdout !== null) {
      // [M3 D6] 镜像通道开通：tap 必须挂 setEncoding 之前——Node 的 setEncoding 是
      // 流级状态（同一流上先注册的监听器同样收到解码后的 string），保持 child.stdout
      // 不解码、把解码留给 PassThrough，tap 才能拿到原始 Buffer。
      child.stdout.on("data", (chunk: Buffer) => {
        deps.rawMirror?.tap(chunk);
      });
      const decoderInput = new PassThrough();
      child.stdout.pipe(decoderInput);
      pumpNdjsonLines(decoderInput, consumeLine);
      // 解析链监听器（pump）先注册 → 同 chunk 先解析；chunk 活性紧随其后。
      decoderInput.on("data", noteStdoutChunk);
    } else {
      pumpNdjsonLines(child.stdout, consumeLine);
      // 同上：pump 监听器先注册（其 setEncoding 对后续监听器同样生效）。
      child.stdout?.on("data", noteStdoutChunk);
    }
    child.once("close", onClose);
    child.once("error", (err) => {
      logger.error(`[session-runner] child ${deps.recordId} error event`, {
        detail: toErrorMessage(err),
      });
      // spawn 失败（典型 ENOENT）：error 事件先于真实 close 到达，promise 在此处
      // 手动收尾时 settle——真实 close 携带的退出码参数（negated errno）不再生效。
      // 先快照错误消息让收尾按失败口径 resolve（终态装配携带可诊断文案），不落回
      // (null, null) 的 0 折算伪成功。清理链仍复用 onClose（U-A5 必达契约的步骤
      // 一个不少；真实 close 再达时各步骤幂等）。
      deps.runEnd.childErrorMessage = toErrorMessage(err);
      onClose(null, null);
    });
    // stdin 异步 error 监听器必挂：'error' 事件无监听即进程级 uncaught exception。
    // 原 EPIPE 失败计数器（热路径投递判死的消费面）已随协议化删除，此处仅 debug
    // 留痕；不能 warn——agent_settled 收割（killPiProcess）每次正常 run 都会断
    // stdin 管道触发 EPIPE，属正常路径。判别经 pi-rpc isBrokenPipeError 单源
    // （同步半面①在 stdin-writer writeStdinLine 的 EPIPE throw）。
    child.stdin?.on("error", (err) => {
      if (isBrokenPipeError(err)) {
        logger.debug(`[session-runner] stdin EPIPE for ${deps.recordId} (expected on reap/exit; ignored)`);
      }
    });
  });
}

/** 镜像上报：spawn 成功（childSpawned 先行——未收上报前宿主 = 无句柄）。 */
export function reportChildSpawned(
  child: ChildProcess,
  recordId: string,
  callbacks: SpawnRunCallbacks,
): void {
  if (child.pid === undefined) return;
  callbacks.onChildSpawned?.(child.pid, recordId);
  callbacks.onChildStateChanged?.({
    pid: child.pid,
    recordId,
    state: "running",
    killed: false,
  });
}
