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
  type EngineCapabilities,
  type UiRequest,
  type UiResponse,
} from "@zhushanwen/subagent-engine-sdk";
import { killPiProcess } from "@zhushanwen/pi-rpc";

import { registerActiveChild } from "./active-children.ts";
import { PI_KILL_GRACE_MS, SCHEMA_ENV_VAR } from "./constants.ts";
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
  /**
   * [D2 扩展加载显式化] 孙进程显式加载的扩展路径集（协议 ctx.extensionPaths
   * 还原）——spawn-args 逐项拼 `--extension`。argv 镜像机制（mirrorMainProcessFlags）
   * 已废弃：引擎进程由 core spawn（argv 恒无 flag），镜像前提「从主 pi 进程 spawn」
   * 不存在。缺省 = 不拼 --extension。
   */
  extensionPaths?: string[];
  /** resume 目标 session 文件（冷续写：--session 续写原文件）。 */
  resumeSessionFile?: string;
}

/** runSpawnOnce 的产物。 */
export interface SpawnRunResult extends Omit<CollectedOutcome, "sessionId"> {
  /** 会话头身份（header / get_state 握手回填；全 miss 时 undefined）。 */
  sessionId: string | undefined;
  /**
   * [D5 诊断引用落账] 失败时子进程 stderr tee 文件绝对路径（成功缺省）。语义与
   * 上报判据见 AgentOutcome.stderrTeePath（SDK contract-types——本字段是其引擎侧
   * 装配源，经 pi-engine toOutcome 透传上协议）。
   */
  stderrTeePath?: string;
}

/** 子进程 env 组装（deny 剥除 + PI_WORKFLOW_SCHEMA 派生注入 + relay 归属键重写）。 */
function buildChildEnv(params: SpawnRunParams): Record<string, string> {
  const extras: Record<string, string | undefined> = {};
  // [D1 schema 传输归位] env 值派生点：schema 本体的唯一 env 消费点就在此处，
  // 按数据流最短路径就地派生（JSON.stringify 本体），注入实现沿用
  // applySchemaEnvToChildEnv（含 E2BIG 上限校验）。
  applySchemaEnvToChildEnv(
    extras,
    params.schema !== undefined ? JSON.stringify(params.schema) : undefined,
  );
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

// ── [D3 止血版] 武装断言（run 开始后、孙进程 spawn 前；缺席即秒级 fail-fast） ──

/**
 * 孙进程 schema 强制的唯一必备扩展包（P-C5 白名单起步组成）。与宿主注入侧
 * （subagent-workflow pi-host `GRANDCHILD_EXTENSION_PKG_SEGMENTS`）是同一契约的
 * 两端：宿主决定注入什么，本断言验证引擎确实收到——扩白名单时两处同批扩。
 */
const SCHEMA_ENFORCEMENT_EXTENSION_PKG = "@zhushanwen/pi-structured-output";

/** 武装断言的判定输入（纯函数面，测试直构）。 */
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
 * RPC 命令全集（rpc-types.d.ts 逐一枚举，32 条）无工具清单/扩展加载错误查询面
 * （get_commands = slash 命令、get_state = RpcSessionState，均不暴露工具/扩展面）；
 * 且扩展加载失败时 pi 在非交互模式（含 rpc）启动诊断 gate 直接 `process.exit(1)`
 * （main.js：runtime diagnostics 含 "Failed to load extension" → exit 1），到不了
 * RPC 服务面。③不可作为主动查询断言，按设计预留路径退化为 ①+②；扩展加载破坏的
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
 * 做 `<scope>/<pkg>` 连续段匹配（目录形态 `.../@zhushanwen/pi-structured-output` 与
 * 入口文件形态 `.../index.js` 都命中；段必须精确，前缀相似目录不误判）。与 pi-host
 * 注入侧 isGrandchildExtensionPath 同判据（契约两端）。 */
function hasSchemaEnforcementExtension(spawnArgs: readonly string[]): boolean {
  const wanted = SCHEMA_ENFORCEMENT_EXTENSION_PKG.split("/");
  for (let i = 0; i + 1 < spawnArgs.length; i++) {
    if (spawnArgs[i] !== "--extension") continue;
    const segs = (spawnArgs[i + 1] ?? "").split(/[\\/]/).filter((s) => s.length > 0);
    if (segs.some((_, j) => wanted.every((w, k) => segs[j + k] === w))) return true;
  }
  return false;
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
 * stderr tee（W11）：实例维度路径 + 懒打开 + 尺寸轮转（超 TAIJI_LOG_MAX_BYTES rename
 * 副本重开）+ 三判据过期清理（同前缀 + pid 已死 + mtime 过期）。失败面全部静默
 * 降级（取证面不拖垮任务主通道——调用方对无 tee 形态 resume 排空防背压）。
 *
 * 返回 path（[D5 诊断引用落账] 失败时随终态应答上报宿主的取证文件指针）——路径在
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
      extensionPaths: params.extensionPaths,
    });
    const invocation = getPiInvocation(args);
    const childEnv = buildChildEnv(params);
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
    // [D5 诊断引用落账] tee 路径捕获：失败时随终态应答上报宿主（见 collectOutcome
    // 消费点）。
    const stderrTee = createStderrTee(child);
    if (stderrTee === undefined && child.stderr !== null) {
      child.stderr.resume();
    }

    // 3. 镜像上报（childSpawned 先行——未收上报前宿主 = 无句柄）+ 引擎侧记账
    registerActiveChild(params.recordId, child);
    reportChildSpawned(child, params.recordId, callbacks);

    // [D3 协议版 P6] 武装回执上报：武装断言（本函数上方）通过 + 孙进程 spawn 成功
    //（spawnEngineChild 同步抛错即失败，成功返回 = 「孙进程启动确认」的最强可得
    // 形态——断言③已按 P-C1 核实退化，扩展加载破坏由 pi exit(1) 通路承接）。
    // 协议版上报 = 宿主的独立信号源（监控信号不与施控同源）：宿主等待窗据此判定
    // 武装链路活性，防「断言代码自身失效/被绕过」的自证盲区。仅 schema 任务上报
    // （本包是 native 引擎，capability 分流已由断言前置；无 schema 任务无武装面，
    // 上报零语义）。宿主 reducer 对本事件 no-op（C3 第④步），落账归 run 事件 journal。
    if (params.schema !== undefined) {
      callbacks.onEvent({
        type: "armed",
        schemaEnvVar: SCHEMA_ENV_VAR,
        extensionPkg: SCHEMA_ENFORCEMENT_EXTENSION_PKG,
      });
    }

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
      // [F-1 信号解耦] schemaExpected 判定源 = task.schema 声明形态（schema 本体
      // 存在与否），与 env 派生/注入值不再同源——注入链路变化不影响守卫期待。
      ...(params.schema !== undefined ? { schemaExpected: true } : {}),
    });
    // [D5 诊断引用落账] 失败时随终态应答上报 stderr tee 路径（引擎应答 failed /
    // 进程异常退出路径的共同汇聚点 = outcome.error 非空；成功不报——诊断引用只在
    // 失败语义下有意义）。tee 缺席（无 stderr / dataDir 不可解析 / pid 缺失）= 字段
    // 缺省，宿主按「无取证指针」消费。
    const stderrTeePath = outcome.error !== undefined ? stderrTee?.path : undefined;
    return {
      ...outcome,
      ...(stderrTeePath !== undefined ? { stderrTeePath } : {}),
      sessionId: identity.sessionId,
    };
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
