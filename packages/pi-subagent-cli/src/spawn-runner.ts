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
// 保留在 core 的面（deviations 登记）：chatMode 编排（record 状态回写 / 续聊轮
// 派发——ConversationContinuation）在 core 侧。轮次执行与 agent_settled 轮终已由
// 本包承载（chatMode 参数；[H1 U5] 原 chat-session 会话管理器已删除——chat-run
// 统一后续聊 = 新 run + resume 锚点，见 SpawnRunParams.chatMode 注释）。

import type { ChildProcess } from "node:child_process";

import * as fs from "node:fs";
import { dirname } from "node:path";

import {
  buildOutboundChildEnv,
  createReplayRecord,
  getLogger,
  killChain,
  resolveEngineDataDir,
  spawnEngineChild,
  type AgentEvent,
  type UiRequest,
  type UiResponse,
} from "@zhushanwen/subagent-engine-sdk";

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
  type SessionIdentityTracker,
} from "./spawn-run-pump.ts";
import { performGetStateHandshake, requestGetStateOnce } from "./get-state-handshake.ts";
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

/**
 * agent_end 惰性回补的单次 get_state 超时（设计决策 2；超时哲学 §5.4：控制面单请求
 * 秒级）——kill 最多延后此时长，对已完成 turn 的子进程无副作用。
 */
const LAZY_GET_STATE_TIMEOUT_MS = 1_000;

/** run 的宿主回调面（server.ts 注入：协议通知 + host/* 反向请求）。 */
export interface SpawnRunCallbacks {
  /** AgentEvent 出口（→ `event` 通知，runId + 单调 seq 由 server 层组装）。 */
  onEvent: (event: AgentEvent) => void;
  /** sessionFile/sessionId 就绪回填（→ host/handleReady）。 */
  onHandleReady?: (partial: { sessionRef: Record<string, string>; poolKey: string }) => void;
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
   * [chatMode] agent_end（非 willRetry，队列排空）到达：本轮收敛。不 kill 子进程
   * （等 agent_settled——pi 的 compact/收尾在 agent_end 后执行）。[H1 U5] 原
   * chat-session 会话管理器的 settled 相位上报消费已随 registry 删除；本回调保留为
   * chatMode 语义的可观测面（run-spawn-once.integration 断言轮次时序）。
   */
  onChatRoundEnd?: () => void;
  /**
   * [chatMode] agent_settled（真空闲边界）到达：run 在此 resolve（exit 0 口径）并
   * 收割子进程（runSpawnOnce 内建，见 SpawnRunParams.chatMode 注释）。[H1 U5] 原
   * chat-session 会话管理器的 idle 相位上报消费已随 registry 删除；本回调保留为
   * chatMode 语义的可观测面。
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
  /**
   * [H1 U3 chat 轮 run 形态]（设计 docs/design/subagent-chat-run-unification.md
   * §3.3 D7）：agent_end 不 kill（pi 的 compact/收尾在 agent_end 后执行，提前 kill
   * 截断收尾截断 session 文件），agent_settled（真空闲）resolve run（exit 0 口径）
   * **并收割子进程**——每轮一进程，续聊 = 新 run + resume 锚点（--session 续写），
   * 进程不再保活（[H1 U5] ChatSessionRegistry 长驻语义已随 registry 删除）。
   * run 的 resolve 与 kill 均以 agent_settled 为准。缺省 = 一次性 run（agent_end 即
   * 终态）。字段名沿用会话形态参数的构造面（run.params.resume 传入）。
   */
  chatMode?: boolean;
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
 * 单次 spawn run（workflow 域形态）：spawn pi rpc 子进程 → pump stdout → 收集结果。
 *
 * 生命周期：resolve = 子进程 close（exit/error）。abort（signal）经 spawnEngineChild
 * 的 signal 通道发 SIGTERM，升级链由 killPiChild 兜底。
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

/**
 * agent_end 惰性 get_state 回补（设计决策 2：消费零调用方的 `requestGetStateOnce`）。
 *
 * 回补结果走 identity tracker 既有回填面（`addStateListener` 内部已过
 * `applyGetStateFields`；此处再显式调用一次与握手调用点同款，幂等——同值不重发
 * handleReady），落 `outcome.sessionFile`。查询失败/超时按 miss 处理（
 * `requestGetStateOnce` 契约：永不 reject），由 close 收尾与下游兜底接手。
 */
export async function backfillSessionFileAtAgentEnd(
  child: ChildProcess,
  identity: SessionIdentityTracker,
): Promise<void> {
  const fields = await requestGetStateOnce(
    child,
    identity.addStateListener,
    LAZY_GET_STATE_TIMEOUT_MS,
  );
  identity.applyGetStateFields(fields);
}

/** agent_end 回补编排入参（backfill 可注入：验收需构造回补链抛错证明 kill 必达）。 */
export interface AgentEndBackfillOrchestrationOpts {
  /** run 收尾状态句柄（同步段置 endedCleanly）。 */
  runEnd: RunEndState;
  /** 归因日志用 record id。 */
  recordId: string;
  /** 回补实现（生产 = backfillSessionFileAtAgentEnd 单次查询）。 */
  backfill: () => Promise<unknown>;
  /** 终结子进程（生产 = killChain 包装；回补链任意抛错的 finally 必达点）。 */
  killChild: (source: string) => void;
}

/**
 * agent_end 回补编排（R1 MF-2 kill 必达约束）：
 *   - **同步段**先置 `runEnd.endedCleanly`（agent_end 已到 = 本轮正常终结）——回补
 *     异步化不得破坏「end 与 close 之间被杀」的 exit 0 口径；
 *   - 回补段整体 try（异常按 miss 处理 + warn，不阻断收尾）；
 *   - `killChild` 放 finally **必达**：回补链任意位置抛错都不得跳过 kill，否则 run
 *     永挂（正常完成路径退化为依赖兜底 = 规则 20 红线）。
 */
export function orchestrateAgentEndBackfill(opts: AgentEndBackfillOrchestrationOpts): void {
  opts.runEnd.endedCleanly = true;
  void (async () => {
    try {
      await opts.backfill();
    } catch (err) {
      logger.warn(
        `[session-runner] agent_end get_state backfill failed for ${opts.recordId} `
          + `(treated as miss; kill proceeds): ${toErrorMessage(err)}`,
      );
    } finally {
      opts.killChild("agent_end final kill");
    }
  })();
}

/** SDK 事件翻译器 opts 装配（agent_end/agent_settled 的 chatMode 分派 + run 收尾状态接线）。 */
function buildTranslatorOpts(
  params: SpawnRunParams,
  callbacks: SpawnRunCallbacks,
  child: ChildProcess,
  identity: SessionIdentityTracker,
  killChild: (source: string) => void,
  runEnd: RunEndState,
): SdkTranslatorOpts {
  const chatMode = params.chatMode === true;
  return {
    maxTurns: params.maxTurns,
    graceTurns: params.graceTurns,
    onEvent: callbacks.onEvent,
    onDelta: callbacks.onDelta,
    abort: () => killChild("turn limiter abort"),
    onAgentEnd: chatMode
      ? () => {
        // [chatMode] 轮收敛（输出完整）：不 kill（等 agent_settled 收割边界）；
        // endedCleanly 置位让「end 与 settled 之间被杀」的 close 也按 0 口径收尾。
        runEnd.endedCleanly = true;
        callbacks.onChatRoundEnd?.();
      }
      : () => {
        // [一次性 run] agent_end 即终态：先惰性补一次 get_state（子进程刚完成 turn、
        // 空闲，成功率远高于 spawn 期；原事故形态的 sessionFile 缺失在此补回），再
        // kill 触发 close → run 应答。编排的同步段/kill 必达约束见
        // orchestrateAgentEndBackfill 头注。
        orchestrateAgentEndBackfill({
          runEnd,
          recordId: params.recordId,
          backfill: () => backfillSessionFileAtAgentEnd(child, identity),
          killChild,
        });
      },
    ...(chatMode
      ? {
        onAgentSettled: () => {
          // [H1 U3] agent_settled（真空闲）= chat 轮 run 的 resolve 与收割边界（D7）：
          // onChatAgentSettled 回调先于 run resolve（run-spawn-once.integration 的
          // 轮次时序断言面），resolveChatRun settle exitPromise（run 应答不等收割），
          // 随后 fire-and-forget
          // 杀链收割子进程——续聊 = 新 run + resume 锚点，进程不再保活。
          runEnd.endedCleanly = true;
          callbacks.onChatAgentSettled?.();
          runEnd.resolveChatRun?.(0);
          killChild("agent_settled reap");
        },
      }
      : {}),
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

    const killChild = (source: string): void => {
      void killChain(child, {
        graceMs: PI_KILL_GRACE_MS,
        unrefTimers: true,
        escalationNote: `child ${params.recordId} (source: ${source})`,
      });
    };
    // agent_end 终结（F1.2）：正常完成后的主动 kill，close 带信号但语义是成功
    // （旧 core waitForChildExit 的 code ?? 0 同义——signal 退出码 143 只属异常路径）。
    // [chatMode] agent_settled 的 run resolve 句柄（inproc state.resolveRun 同款：
    // 声明先于 handler 装配，exitPromise executor 内落位——事件只会在 pump 启动后
    // 异步到达，无空窗）。
    const runEnd: RunEndState = { endedCleanly: false };
    // 身份写入口先行装配：translator 的 agent_end 惰性回补与 stdout pump 共用同一
    // tracker（回补走既有 addStateListener + applyGetStateFields 回填面）。
    const identity = createSessionIdentityTracker(params.sessionDir, callbacks);
    const handleSdkEvent = createSdkEventTranslator(
      record,
      buildTranslatorOpts(params, callbacks, child, identity, killChild, runEnd),
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
    //    先于 prompt 发出：chat 会话形态的 idle 相位 anchor 与 run 应答 handle 都需要
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
