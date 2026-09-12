// src/spawn-run-pump.ts
//
// stdout pump + close 收尾 + session 身份回填（自 runSpawnOnce 行为等价提取的
// 子进程生命周期接线面）。身份三路同源：header 行 / get_state 应答（响应行同步
// 路径 + 握手 promise 兜底）/ LC-4 后缀反查——写入口收敛在 identity tracker；
// close 收尾时三路全 miss = 应响亮报错的异常信号，warn 留痕不自动认领。

import type { ChildProcess } from "node:child_process";

import { getLogger, pumpNdjsonLines } from "@zhushanwen/subagent-engine-sdk";

import { unregisterActiveChild } from "./active-children.ts";
import { PI_POOL_KEY } from "./constants.ts";
import { toErrorMessage } from "./error-message.ts";
import { extractGetStateFields, type GetStateResult } from "./get-state-handshake.ts";
import {
  deriveSessionFilePath,
  findSessionFileByHeaderId,
  parseSpawnLine,
  type ExtensionUiRequest,
  type SdkEvent,
  type SpawnSessionHeader,
} from "./spawn-event-adapter.ts";
import type { SpawnRunCallbacks } from "./spawn-runner.ts";
import { recordEpipeFailure } from "./stdin-writer.ts";

const logger = getLogger("session-runner");

/** 无效 stdout 行的日志截断长度（够诊断、不刷屏）。 */
const INVALID_LINE_LOG_CHARS = 160;

/** 信号退出码合成值（close 无 code 只有 signal 时按 128+ 约定折算非零）。 */
const SIGNAL_EXIT_CODE_BASE = 128;

/**
 * child 'error' 事件（spawn 失败——子进程从未运行）的收尾退出码。POSIX
 * command-not-found 惯例值：与 128+ 信号折算族同为非零异常口径，且语义上贴近
 * 「找不到可执行文件」（典型 ENOENT）。
 */
const SPAWN_ERROR_EXIT_CODE = 127;

/** run 收尾状态（agent_end / agent_settled 与 close 收尾共享的可变句柄）。 */
export interface RunEndState {
  /** agent_end 置位：主动终结的 close 按成功口径（exit 0）收尾。 */
  endedCleanly: boolean;
  /**
   * child 'error' 事件的消息快照（spawn 失败形态：子进程从未运行）。error 事件
   * 先于真实 close 到达且 promise 已被手动收尾 settle——真实 close 的退出码参数
   * 不再生效，终态装配只能靠此快照区分「从未启动」与正常退出（exitCode 判定链
   * 见 spawn-runner collectOutcome）。
   */
  childErrorMessage?: string;
  /** [chatMode] agent_settled 的 run resolve 句柄（exitPromise executor 内落位）。 */
  resolveChatRun?: (code: number) => void;
}

/** session 身份回填状态机（三路写同源；get_state 监听表随行持有）。 */
export interface SessionIdentityTracker {
  readonly sessionId: string | undefined;
  readonly sessionFile: string | undefined;
  /** header 行：id + session 文件路径全量落位（handleReady 双字段条件展开）。 */
  noteHeader(header: SpawnSessionHeader): void;
  /** get_state response 监听登记（握手 + 迟到 response 自弃）。 */
  addStateListener(id: string, resolver: (data: unknown) => void): void;
  /** response 帧分发（一次性消费；未知 id 自弃；失败帧以 undefined resolve）。 */
  dispatchStateResponse(id: string | undefined, success: boolean, data: unknown): void;
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
        poolKey: PI_POOL_KEY,
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
        poolKey: PI_POOL_KEY,
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
      if (id === undefined || !stateListeners.has(id)) return;
      const resolver = stateListeners.get(id);
      stateListeners.delete(id);
      resolver?.(success ? data : undefined);
    },
    applyGetStateFields,
    fallbackSessionFileByHeaderId() {
      if (sessionFile !== undefined || sessionId === undefined) return;
      const found = findSessionFileByHeaderId(sessionDir, sessionId);
      if (found === undefined) return;
      // 走既有回填面（与 M2 回补同一条路）：sessionFile 落位（collectOutcome 的
      // outcome.sessionFile 生效）+ handleReady 通知宿主回写 record——chat 域的 run
      // 在 agent_settled 已应答，close 兜底是 record 补 transcript 锚点的最后时机
      // （只补 sessionFile，sessionId 已知不再变更）。
      applyGetStateFields({ sessionFile: found });
    },
    clearStateListeners() {
      stateListeners.clear();
    },
  };
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
}

/** stdout 行消费（parseSpawnLine 分类 → 身份/事件/响应/UI 各通道）。 */
function createLineConsumer(deps: StdoutPumpDeps): (line: string) => void {
  const { recordId, identity, handleSdkEvent, enqueueUi } = deps;
  return (line: string): void => {
    const parsed = parseSpawnLine(line);
    if (parsed === null) return;
    switch (parsed.kind) {
      case "header":
        identity.noteHeader(parsed.header);
        return;
      case "event":
        handleSdkEvent(parsed.event);
        return;
      case "response":
        identity.dispatchStateResponse(parsed.id, parsed.success, parsed.data);
        return;
      case "extension_ui_request":
        enqueueUi(parsed.id, parsed.request);
        return;
      case "invalid":
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

/** close 退出码口径：agent_end 主动终结 = 0；其余 signal 退出按 128+ 折算（异常判据）。 */
function normalizeExitCode(
  endedCleanly: boolean,
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  return endedCleanly ? 0 : code ?? (signal !== null ? SIGNAL_EXIT_CODE_BASE : 0);
}

/**
 * close 收尾的 sessionFile 仍缺响亮 warn：握手 / 迟到应答 / agent_end 补查 / LC-4
 * 后缀反查全 miss 本身是应响亮报错的异常信号，不做启发式自动认领（prompt 头键
 * 误配的代价——错 sessionFile 让冷续 resume 共写他 session 文件——高于收益，且旗舰
 * 并发形态头部同质必然多命中、结构性地采不中）。warn 附人工排查指引，不静默。
 */
function warnSessionFileUnobtainable(deps: StdoutPumpDeps): void {
  const { recordId, identity } = deps;
  if (identity.sessionFile !== undefined) return;
  logger.warn(
    `[sessionfile] unobtainable for ${recordId} (all acquisition paths missed: spawn handshake, late response, agent_end backfill, LC-4 suffix lookup); ` +
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
      // agent_end 主动终结的 close 是正常完成（exit code 0 口径）；其余信号退出
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
    // [chatMode] agent_settled resolve 句柄落位（见 runEnd 声明处注释）
    deps.runEnd.resolveChatRun = resolveExit;
    const consumeLine = createLineConsumer(deps);
    const onClose = createCloseFinalizer(deps, resolveExit);
    pumpNdjsonLines(child.stdout, consumeLine);
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
    // stdin 异步 error（EPIPE 半面②）：计数留痕（热路径投递据此判死）
    child.stdin?.on("error", (err) => {
      if (
        err !== null && typeof err === "object" && "code" in err &&
        ((err as NodeJS.ErrnoException).code === "EPIPE" ||
          (err as NodeJS.ErrnoException).code === "ERR_STREAM_DESTROYED")
      ) {
        recordEpipeFailure(deps.recordId);
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
