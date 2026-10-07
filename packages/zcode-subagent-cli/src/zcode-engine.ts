// src/execution/engine/engines/zcode/zcode-engine.ts
//
// ZcodeEngine：zcode 的 EnginePort 实现（2026-09 起单一 app-server 形态）。
// 设计权威源：docs/architecture/zcode-engine-appserver-resident.md §3.3 D1（每引擎实例一条
// 连接）/ D3（abort 链）/ D4（会话自包含）/ D5（capabilities）/ D6（停机面）。
//
// 2026-09 breaking 重构（用户拍板，理由与代价见设计文档修订节）：
//   - **删除 CLI spawn 降级链**（probe 冒烟门控 / protocol-drift 首败降级）：zcode 无公开
//     契约，协议漂移不再降级保底，直接报可操作错误（提示核对版本 / 重启 / 改用 engine: pi）。
//   - **删除 HOME 池化，共享宿主 HOME**：spawn env 不覆写 HOME，app-server 共享
//     宿主 ~/.zcode/（凭据经 appserver-launcher fs 拦截注入——cli config 读取重定向
//     为「真实文件 + v2 provider」合并，同 id 时 v2 优先，机制与漂移面见该文件头注；
//     登录态轮换后常驻连接需引擎进程重启才用新凭据）。HOME 依赖副作用（如 pnpm
//     store 路径随 HOME 翻转）随之消失。
//   - **会话库隔离（2026-09，设计 zcode-session-db-isolation.md）**：会话不再与 GUI
//     共写宿主 ~/.zcode/cli/db/db.sqlite——spawn env 覆盖式写入
//     ZCODE_SESSION_DB_PATH=<engineDataDir>/engines/zcode/session-db/db.sqlite（并
//     清空别名键 ZCODE_SESSION_DB，见 ensureAppServerRuntime），handle.dbPath 回填
//     隔离库绝对路径，读侧（本文件 read + session-view-service）按
//     zcodeDbPathAllowlist 封闭白名单放行（宿主路径仅存量兼容）。原「GUI 会话列表
//     可见 headless 会话」已接受代价随之撤销。
//   - journal 分组 key 固定 'shared'（SDK SHARED_POOL_KEY——[池抽象降级 2026-09-13]
//     poolKey 协议面已删，值仅承载 journal 落盘路径与存量 record 兼容）：journal 落
//     engineDataDir/engines/zcode/shared/journal-<taskId>.jsonl。
//
// run 错误语义（设计 §3.3.5）：
//   ① prepare 期错误（credential_missing / model_not_available）在进程创建前
//      reject，不产生 handle；
//   ② 运行中失败不 reject——合成 engine_run_failed outcome + 正常 handle 返回
//      （record 必须收尾）；
//   ③ abort：D3 链（session/stop → grace → killChain 连坐共享进程）——终态
//      exitCode=null + 杀链标记。
//   [D3-④] capability 拒绝（fork/maxTurns/worktree）不再在本引擎：
//      上提到宿主调用前预检（common/capability-gate，两调用点 = chat 域
//      executeViaEngine 同步段 + SAR run 前）；conversation 位按 resume 形态键在
//      SDK server 侧 gate（[modeless 波5 收尾] 显式派发参数分支已删）——拒绝语义
//      不变（engine_capability_unsupported + 无进程创建）。
//
// schema 仿真接线（D4 emulated 侧）：common/schema-emulation.ts——prompt 拼仿真段、
// 终态后三级容错提取 + ajv 校验、失败强化重试一次、仍失败报 schema_emulation_failed。
// read 第②级 journal 降级已接线（common/journal-replay 复用 live reducer）。

import * as fs from "node:fs";
import * as path from "node:path";

import { getLogger } from "@zhushanwen/subagent-engine-sdk";

import {
  buildEngineChildEnv,
  buildSchemaEmulationSegment,
  extractAndValidateStructuredOutput,
  HOST_TIMEOUT_ABORT_REASON,
  synthesizeTimeoutOutcome,
  engineTimeoutDetail,
  resolvePoolDir,
  SHARED_POOL_KEY,
  spawnEngineChild,
} from "@zhushanwen/subagent-engine-sdk";
import { replayJournalToSessionView } from "./journal-io.ts";
import type {
  AgentEvent,
  AgentOutcome,
  EngineCapabilities,
  ProbeReport,
  SessionView,
} from "@zhushanwen/subagent-engine-sdk";
import type { AgentCallOpts, EngineHandle, EnginePort, EngineRunResult, RunContext } from "./port-types.ts";
import {
  ZCODE_ADAPTER_VERSION,
  ZCODE_APPSERVER_ABORT_GRACE_ENV,
  ZCODE_APPSERVER_ABORT_GRACE_MS,
  ZCODE_APPSERVER_ERR_BUSY_SESSION,
  ZCODE_APPSERVER_ERR_MODEL_CONFIG_MISSING,
  ZCODE_APPSERVER_HARVEST_GRACE_MS,
  ZCODE_APPSERVER_STOP_TIMEOUT_ENV,
  ZCODE_APPSERVER_STOP_TIMEOUT_MS,
  ZCODE_CLI_DEFAULT_PATH,
  ZCODE_ENGINE_ID,
  ZCODE_ERROR_TAIL_CHARS,
  ZCODE_KILL_GRACE_MS,
  ZCODE_RESUME_CHARS_PER_TOKEN,
  ZCODE_RESUME_HISTORY_TOKEN_BUDGET,
  ZCODE_SESSION_SWEEP_DEFER_MS,
  isFailedTerminalStatus,
  parseZcodePositiveMsEnv,
} from "./constants.ts";
import { zcodeDbPathAllowlist, zcodeSessionDbPath } from "./db-path.ts";

import {
  mapZcodeOutcomeUsage,
  mapZcodeUsage,
  synthesizeCoarseEvents,
  type ZcodeTerminalPayload,
} from "./parser.ts";
import {
  defaultPersonalProviderConfigPath,
  defaultV2ConfigPath,
  listZcodeModels,
  locateZcodeBuiltinCatalog,
  resolveZcodeMinimalReasoningLevel,
  resolveZcodeModelRef,
  splitZcodeModelRef,
  type ZcodeSourcePaths,
} from "./preparer.ts";
import { ensureAppServerLauncher } from "./appserver-launcher.ts";
import { readZcodeSessionView } from "./reader.ts";
import { AppServerConnection, buildAppServerEnv, isAppServerRpcError } from "./connection.ts";
import {
  SessionChannel,
  extractResumeHistory,
  extractResumeTotalTokens,
  type ResumedHistoryTurn,
  type SessionCreateParams,
  type SessionTurnResult,
} from "./session-channel.ts";
import { maybeSweepExpiredZcodeSessions } from "./session-db-maintenance.ts";
import { toErrorMessage } from "./error-message.ts";
import { stderrLogPathFor } from "./logs/stderr-rotation.ts";

const logger = getLogger("subagents");

/** probe 的版本探测超时（ms）——二进制无响应按探针失败处理，不静默挂死。 */
const PROBE_VERSION_TIMEOUT_MS = 15_000;

/**
 * [RX2-F1] 常见 thoughtLevel 档位（仅作提示基准，非权威值域）：pi 全 7 档
 * （off/minimal/low/medium/high/xhigh/max）恒等透传不拦截——core 引擎层不掌握各模型
 * 真实值域，禁止硬编码枚举做拒收或映射；不在此列的档位只触发一行提示（warnThoughtLevelUncommon）。
 */
const COMMON_THOUGHT_LEVELS: readonly string[] = ["low", "high", "max"];

/** ZcodeEngine 构造依赖（全部可注入——测试不依赖真机 CLI/真凭据）。 */
export interface ZcodeEngineDeps {
  /**
   * 引擎数据目录（journal 分组根 <dir>/engines/zcode/shared/ 与 stderr 日志落点）。
   * 来源通道（宿主 dataDir）见 registration.ts 缺省解析。
   */
  engineDataDir: () => string;
  /** zcode CLI 路径；缺省 ZCODE_CLI_DEFAULT_PATH。 */
  cliPath?: string;
  /** 源 config 路径覆盖（测试注入临时源；缺省读 ~/.zcode）。 */
  sources?: ZcodeSourcePaths;
  /** 版本探测执行器（probe check "version"；测试注入 fake 防真实子进程）。 */
  probeVersion?: (cliPath: string) => Promise<string | undefined>;
  /** env 基底（测试注入；缺省 process.env——app-server env 组装经它）。 */
  processEnv?: NodeJS.ProcessEnv;
}

/** 常驻运行时（每引擎实例一份；dispose 时整件丢弃）。 */
interface AppServerRuntime {
  conn: AppServerConnection;
  channel: SessionChannel;
  /** 在途会话登记（dispose 时 fire session/close 的目标集；settle 后移除）。 */
  activeSessions: Set<string>;
}

/** zcode 引擎适配器。 */
export class ZcodeEngine implements EnginePort {
  readonly id = ZCODE_ENGINE_ID;

  private readonly deps: ZcodeEngineDeps;
  private probeCache: ProbeReport | undefined;
  private appserverRuntime: AppServerRuntime | undefined;
  /**
   * [P0-1 U4] 引擎停机标志（dispose 置位，不重置——dispose 后首个 run 走重建路径
   * 不受影响）：瞬时重试判定据此排除 dispose 收割引发的崩溃形态——停机后的重试轮
   * 会经 ensureAppServerRuntime 惰性重建进程（复活已停机引擎），违背 dispose 防泄漏
   * 语义。
   */
  private disposed = false;

  constructor(deps: ZcodeEngineDeps) {
    this.deps = deps;
  }

  /**
   * zcode 链路实际接通的能力（D3 链路口径。声明升级必须先改链路再改声明（C4 原则）。
   */
  capabilities(): EngineCapabilities {
    return {
      // 无 --json-schema 类通道；公共 schema 仿真层（prompt 约定 + 容错提取 + ajv）
      schemaEnforcement: "emulated",
      // send-while-running 恒 -32010 硬错误（旧实测）——app-server 常驻化不改变此判据
      steer: "unsupported",
      // [U6 / §3.2.6 要点 4] "cold" = 冷恢复会话：session/resume 读通道取结构化
      // 历史 + session/create 新会话注入首轮（无热 steering——interrupt 维持
      // kill-only 如实声明）。P-1 探针：原地 resume 续写被 -32031 卡死，热会话
      // 通道不可用，声明不越级。
      conversation: "cold",
      // 无 --append-system-prompt flag（实测拒收）——persona 只能拼进 prompt
      personaInjection: "prompt",
      // app-server 推送流实时流出（session/event payload.delta → text_delta）
      eventGranularity: "stream",
      // 无 OS sandbox；worktree 隔离由公共层 worktree-manager 承担（引擎侧仅消费
      // task.cwd → session/create 的 workspacePath）= emulated（pi 同款声明语义）
      sandbox: "emulated",
      // sqlite 三级 JOIN 完整重建 turns（reader 实测）
      sessionRead: "full",
      // --resume 冷启动可用（实测）
      resume: "cold",
      // abort 走 D3 链（stop→grace→killChain）但声明维持 kill-only 不升级（改链路
      // 先于改声明；stop 链路经 conformance 真机验证后再评估升 native）
      interrupt: "kill-only",
      // --mode build/edit/plan/yolo 原生权限档位
      permissionMode: "native",
      // [D3-④] 无 turn_end 语义，轮数上限不可兑现（预检 gate 据此同步拒绝）
      maxTurns: false,
      // [subagent-model-switch] zcode 引擎不在模型切换设计范围（协议面引擎中立预留，
      // 后续另立项接入）——setModel 通路未接通，unsupported 如实声明
      setModel: "unsupported",
    };
  }

  /** 探针（D7）：二进制存在 + 版本解析（zcode 无公开契约，版本漂移的入口信号）。 */
  async probe(opts?: { force?: boolean }): Promise<ProbeReport> {
    if (!opts?.force && this.probeCache) return this.probeCache;

    const cliPath = this.deps.cliPath ?? ZCODE_CLI_DEFAULT_PATH;
    // check 1：二进制存在（不在 PATH，固定绝对路径形态——存在性即可用性的第一道判据）
    const binary = this.probeBinaryCheck(cliPath);
    const checks: ProbeReport["checks"] = [binary];

    // check 2：版本解析（存在才尝试——必败进程不再 spawn）
    let engineVersion = "";
    if (binary.ok) {
      const version = await this.probeVersionCheck(cliPath);
      checks.push(version.check);
      engineVersion = version.engineVersion;
    }

    const ok = checks.every((c) => c.ok);
    const report: ProbeReport = {
      ok,
      engineVersion,
      checks,
      ...(ok ? {} : { error: this.probeFailureRecovery(cliPath) }),
    };
    this.probeCache = report;
    return report;
  }

  /** check 1：二进制存在性（isFile 才算——同名目录不是可执行入口）。 */
  private probeBinaryCheck(cliPath: string): ProbeReport["checks"][number] {
    const binaryOk = fs.existsSync(cliPath) && fs.statSync(cliPath).isFile();
    return {
      name: "binary",
      ok: binaryOk,
      detail: binaryOk ? cliPath : `zcode CLI 不存在：${cliPath}`,
    };
  }

  /** check 2：`--version` 解析（probeVersion 可注入——测试 fake 防真实子进程）。 */
  private async probeVersionCheck(
    cliPath: string,
  ): Promise<{ check: ProbeReport["checks"][number]; engineVersion: string }> {
    const runVersion =
      this.deps.probeVersion ?? ((cliPath: string) => defaultProbeVersion(cliPath, this.deps.engineDataDir()));
    const version = await runVersion(cliPath);
    const versionOk = version !== undefined && version.length > 0;
    return {
      check: {
        name: "version",
        ok: versionOk,
        detail: versionOk ? version : "zcode --version 返回空或失败",
      },
      engineVersion: version ?? "",
    };
  }

  /** 探针失败的恢复指引（§3.3.3 终态四：版本确认命令 + 探针重跑 + 调研文档路径）。 */
  private probeFailureRecovery(cliPath: string): NonNullable<ProbeReport["error"]> {
    return {
      code: "engine_probe_failed",
      recovery:
        `Run \`node ${cliPath} --version\` 确认 zcode CLI 可用且版本未漂移，然后重跑探针（重新初始化引擎或 probe({force:true})）。` +
        `若 app-server 协议已漂移（RPC 错误），重启 ZCode 或固定 zcode 版本后重试。` +
        `参照 docs/research/agent-engine-zcode.md。`,
    };
  }

  /** D1 主语义：唯一通道 = app-server 常驻连接（spawn 降级链已删除）。 */
  async run(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> {
    // [D3-④] fork/maxTurns 的能力拒绝已上提到宿主调用前预检
    //（common/capability-gate，capabilities.maxTurns 扩位承载）——引擎内不再做
    // shape 检查（拦截逻辑单点化，重演双轨根因的形态被删除）。
    return this.runViaAppServer(task, ctx);
  }

  // ============================================================
  // app-server 常驻路径（D1/D3/D4）
  // ============================================================

  /**
   * 常驻路径主编排：模型解析（v2 单源校验）→ 惰性连接 + runTurn（事件时序前移：
   * text_delta 流式、终态后 message_end/turn_end）→ schema 仿真重试 → outcome/handle。
   * onHandleReady 在 create 应答后（§3.4 不变量 3；原 onPoolResolved prepare 期
   * 声明已随 [池抽象降级 2026-09-13] poolKey 协议面退役删除）。
   */
  private async runViaAppServer(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> {
    const startedAt = Date.now();
    // pre-aborted 短路：取消先于启动——不创建会话、不触发连接惰性启动（防误杀共享
    // 进程殃及在途任务）
    if (ctx.signal?.aborted === true) {
      return this.abortedAppServerRun(task, ctx, startedAt);
    }

    // ① prepare 期：模型解析（[R4/G3] 条件携带——task.model 显式（trim 非空）才走
    // v2 单源校验解析；缺席时不携带 model 键，create 交由 zcode 自身缺省解析（用户
    // defaultModelSelection 优先——恒传会静默压掉用户配置，R4 根因）。缺席跳过
    // resolveZcodeModelRef 即跳过凭据预校验（D3）：preparer 的凭据空检查与具体模型
    // 无关，缺席时无从预校验——跳过是正确行为而非放松，模型不可用的暴露点后移到
    // 引擎侧 send/首响应（上游错误原文经 buildAppServerRunFailedMessage 透传）。
    const requestedModel = task.model?.trim();
    const modelRef =
      requestedModel !== undefined && requestedModel !== ""
        ? resolveZcodeModelRef(requestedModel, this.deps.sources)
        : undefined;
    this.warnIgnoredCtxModel(task, ctx);
    // [RX2-F1] 非常见档位出声一行（不拦截透传）；放主编排而非 attemptAppServerTurn——
    // schema 重试轮会二次进 attempt，warn 只应随任务出声一次
    this.warnThoughtLevelUncommon(task, ctx);
    const cwd = task.cwd ?? process.cwd();
    const schema = isPlainObject(task.schema) ? task.schema : undefined;
    // [U6 / §3.2.6 要点 3] zcode 续聊（interact-resume）：ctx.resume 携带 zcode 锚
    //（sessionRef {sessionId, dbPath}）→ session/resume 读通道取结构化历史 → token
    // 预算裁剪 → prompt 前缀注入。执行仍走**新 session**（attemptAppServerTurn 每次
    // create 新会话——原地 resume 续写被 -32031 卡死，P-1 探针；与 §3.2.3 reopen
    // 机制同构，round/epoch 不变），新 sessionRef 经 onHandleReady 回传宿主回填
    // transcriptRef。无锚（首轮 / fresh session 轮）prefix 为 undefined，行为不变。
    const resumePrefix = await this.buildResumeHistoryPrefix(ctx);
    const basePrompt =
      resumePrefix === undefined ? this.buildPrompt(task, schema) : resumePrefix + this.buildPrompt(task, schema);

    // ② 首轮执行 + schema 仿真重试（重试语义与不变量注释见 runAppServerAttemptsWithRetry）
    const usageAcc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false };
    const final = await this.runAppServerAttemptsWithRetry(task, ctx, modelRef, cwd, basePrompt, schema, usageAcc);

    const outcome = this.finalizeOutcome(task, ctx, final, usageAcc, startedAt);
    return { handle: this.appServerHandle(outcome), outcome };
  }

  /** pre-aborted 短路收口：合成中止 outcome + 'shared' 锚定 handle。 */
  private abortedAppServerRun(task: AgentCallOpts, ctx: RunContext, startedAt: number): EngineRunResult {
    const outcome = this.finalizeOutcome(
      task,
      ctx,
      abortedAppServerAttempt(ctx),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, has: false },
      startedAt,
    );
    return { handle: this.appServerHandle(outcome), outcome };
  }

  /**
   * 首轮执行 + 双重试编排（常驻路径）：
   * - **schema 仿真重试**（既有语义）：parsed 但校验失败时重试一次（强化 JSON 输出
   *   指令——与 structured-output 的重试语义对齐）。
   * - **瞬时失败自动重试一次**（[P0-1 U4/D6]）：末次 attempt 为 timeout 类（idle/
   *   ceiling）或连接崩溃类失败且非用户 abort → 用新会话重跑一次（attempt 本就每次
   *   新建会话）。重试轮 prompt 用 basePrompt 原样重跑（失败形态非 schema），文案补
   *   「已自动重试一次」句（retried 标记仅对真实发生的重试生效）。
   *
   * 两次重试一次封顶各自独立（D6 被否①：多次重试/指数退避不做——重跑一轮=整任务
   * 重算，一次封顶）。组合序：瞬时重试在前、schema 重试在后——瞬时重试轮 parsed 且
   * 校验失败时仍进 schema 重试（末次 attempt 语义，schema 重试编排保持现状不动）。
   *
   * 重试轮是独立会话的独立 LLM 调用：token 计入 outcome.usage 总量；事件面
   * text_delta 按实际流出（含失败轮——journal 记录真实流水），message_end/turn_end
   * 只在最终轮终态后合成（不变量 2/5）。
   */
  private async runAppServerAttemptsWithRetry(
    task: AgentCallOpts,
    ctx: RunContext,
    modelRef: string | undefined,
    cwd: string,
    basePrompt: string,
    schema: JsonSchemaObject | undefined,
    usageAcc: { input: number; output: number; cacheRead: number; cacheWrite: number; has: boolean },
  ): Promise<AttemptResult> {
    let final = await this.attemptAppServerTurn(task, ctx, modelRef, cwd, basePrompt);
    accumulateUsage(usageAcc, final);
    // [P0-1 U4/D6] 瞬时失败自动重试一次：判据 = run-failed 且 transient 形态标记
    // （类型化，不经字符串反推；RPC 错误/status=error 终态等有应答的精确归类形态
    // 构造处即无 transient——含协议漂移类，漂移不再降级 spawn、直接报错）+ 非用户
    // 已取消 + 非引擎停机（dispose 收割引发的崩溃不重试——停机后惰性重建 = 复活
    // 进程，违背 dispose 防泄漏语义）。
    if (
      final.kind === "run-failed" &&
      final.transient !== undefined &&
      ctx.signal?.aborted !== true &&
      !this.disposed
    ) {
      logger.warn(
        `[zcode-engine] 末次 attempt 瞬时失败（${final.transient}）——止损链已终局，新会话自动重试一次`,
      );
      const retry = await this.attemptAppServerTurn(task, ctx, modelRef, cwd, basePrompt, {
        // 重试事实进文案：「已自动重试一次」句仅对真实发生的重试生效（未重试形态
        // 不含——与行为一致，§5.2 F-1/F-4）
        retried: true,
      });
      accumulateUsage(usageAcc, retry);
      final = retry;
    }
    if (final.kind === "parsed" && final.schemaResult !== undefined && !final.schemaResult.ok && schema !== undefined) {
      const retryPrompt = appendSchemaRetryDirective(basePrompt, final.schemaResult.error);
      const retry = await this.attemptAppServerTurn(task, ctx, modelRef, cwd, retryPrompt);
      accumulateUsage(usageAcc, retry);
      final = retry;
    }
    return final;
  }

  /**
   * 常驻路径的 handle 合成（poolKey 固定 'shared'；dbPath = 隔离会话库绝对路径——
   * 2026-09 会话库隔离，与 spawn env 同源 zcodeSessionDbPath(engineDataDir)，设计 D1）。
   */
  private appServerHandle(outcome: AgentOutcome): EngineHandle {
    return {
      data: {
        v: 1,
        engineId: ZCODE_ENGINE_ID,
        sessionRef: {
          dbPath: zcodeSessionDbPath(this.deps.engineDataDir()),
          ...(outcome.sessionId !== undefined ? { sessionId: outcome.sessionId } : {}),
        },
        ...(this.probeCache?.engineVersion !== undefined && this.probeCache.engineVersion !== ""
          ? { engineVersion: this.probeCache.engineVersion }
          : {}),
        adapterVersion: ZCODE_ADAPTER_VERSION,
      },
    };
  }

  /**
   * 单轮常驻执行：runTurn 组合面 + D3 abort 链 + 事件前移（text_delta 实时流出；
   * 终态数据经 read 兜底收口后才 resolve——不变量 1/2）。
   *
   * @param opts retried：瞬时重试轮标记——失败文案补「已自动重试一次」句（F-1/F-4）。
   */
  private async attemptAppServerTurn(
    task: AgentCallOpts,
    ctx: RunContext,
    modelRef: string | undefined,
    cwd: string,
    prompt: string,
    opts: { retried?: boolean } = {},
  ): Promise<AttemptResult> {
    const rt = this.ensureAppServerRuntime();
    // [R4/G3] modelRef 缺席 → create 帧不携带 model 键（zcode 自身缺省解析）；
    // 显式 → 拆分为 per-session {providerId, modelId}（+ 最小 reasoning 档，目录
    // 值域解析——per-modelRef 记忆化，目录在进程生命周期内视为静态）。
    const reasoningLevel =
      modelRef !== undefined && modelRef !== ""
        ? this.minimalReasoningFor(modelRef)
        : undefined;
    const createParams = buildAppServerCreateParams(task, modelRef, cwd, reasoningLevel);

    let currentSessionId: string | undefined;
    let signalSessionCreated: (() => void) | undefined;
    const sessionCreated = new Promise<void>((resolve) => {
      signalSessionCreated = resolve;
    });
    const turn = rt.channel.runTurn(createParams, prompt, {
      // 事件时序前移：payload.delta → text_delta 实时流出（stream 粒度，D5）；
      // reasoning_delta → thinking_delta 分流（F2 口径：answer 通道仅 text_delta，
      // 不变量 3a 的拼接比对不含 reasoning）
      onTextDelta: (delta) => ctx.onEvent?.({ type: "text_delta", delta }),
      onThinkingDelta: (delta) => ctx.onEvent?.({ type: "thinking_delta", delta }),
      // [PR3] 工具执行期活性：非终态非增量的 session/event 帧（tool.updated progress
      // 等，真机探针实证每 ~1s 一帧）→ activity 事件（零载荷纯活性信号——宿主无进展
      // 守护对任何事件类型刷新；reducer no-op、不落 journal）。zcode 引擎声明
      // conversation:"cold"（续聊 = session-store 冷恢复重建 + 新 run + resume 锚点，
      // 无热 steering/chat 域接线），run 域是唯一发射面。
      onActivity: () => ctx.onEvent?.({ type: "activity" }),
      onSessionCreated: (sessionId) => {
        currentSessionId = sessionId;
        rt.activeSessions.add(sessionId);
        signalSessionCreated?.();
        // §3.4 不变量 3：create 应答后立即回填（早于 subscribe/send/终态/run resolve）；
        // dbPath 与终态 handle 同源 zcodeSessionDbPath(engineDataDir)（设计 D1）
        ctx.onHandleReady?.({
          sessionRef: { dbPath: zcodeSessionDbPath(this.deps.engineDataDir()), sessionId },
        });
      },
    });

    // D3 abort 链：signal abort → ① session/stop {sessionId} ② grace 窗口确认终态
    // ③ stop 失败/超时 → killChain 杀共享进程（接受连坐——协议已不可信）→ 在途
    // 其他任务走崩溃路径。capabilities.interrupt 维持 kill-only 不升级（C4）。
    const onAbort = (): void => {
      void this.appServerAbortChain(rt, turn, () => currentSessionId, sessionCreated);
    };
    if (ctx.signal !== undefined) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const r = await turn;
      // stop 优雅生效（终态在 grace 内到达）：宿主已取消——按中止终态收口（record
      // 终态迁移由编排层 CAS 决定）
      if (ctx.signal?.aborted === true) return abortedAppServerAttempt(ctx);
      return parsedAppServerAttempt(task, r);
    } catch (err) {
      return await this.classifyAppServerTurnFailure(err, ctx, {
        rt,
        turn,
        currentSessionId: () => currentSessionId,
        sessionCreated,
        retried: opts.retried,
      });
    } finally {
      if (currentSessionId !== undefined) rt.activeSessions.delete(currentSessionId);
      if (ctx.signal !== undefined) ctx.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * [attemptAppServerTurn 拆分] 失败分流（catch 半边）：
   * - signal 已 aborted → 中止终态收口；
   * - [P0-1 U4] 连接崩溃收割形态（failAllTurns 的错误，D6 可重试形态）判据：
   *   非 RPC error（服务端无明确应答——有应答即精确错误归类，非瞬时崩溃面）且
   *   conn 不存活。时序可靠性：catch 时刻紧随 onClose 收割，连接重建仅由
   *   conn.request 惰性触发——本链路中 runTurn finally 的 closeSession 对死连接
   *   短路（channel 侧 !alive 守卫）、stop 只属 abort 链（已被 signal.aborted
   *   短路）——此刻无 request 可重建，判据可靠；
   * - 其余 → 精确错误终态。
   */
  private async classifyAppServerTurnFailure(
    err: unknown,
    ctx: RunContext,
    args: {
      rt: AppServerRuntime;
      turn: Promise<unknown>;
      currentSessionId: () => string | undefined;
      sessionCreated: Promise<void>;
      retried: boolean | undefined;
    },
  ): Promise<AttemptResult> {
    if (ctx.signal?.aborted === true) return abortedAppServerAttempt(ctx);
    if (!isAppServerRpcError(err) && !args.rt.conn.alive) {
      return failedAppServerAttempt(err, args.currentSessionId(), { retried: args.retried, transient: "conn-closed" });
    }
    return failedAppServerAttempt(err, args.currentSessionId(), { retried: args.retried });
  }

  /**
   * killChain 后等待连接 finalize 实际完成（child 置空 + onClose 广播）再宣告链终局：
   * shutdown resolve 于 `exit` 事件，而 finalize 挂 `close`（stdio 排空）——两者之间的
   * 事件窗口内 conn.child 仍非 null，紧接的下一任务 request 会复用垂死进程（写入成功
   * 但必败，走崩溃路径）而非触发重建。与 shutdownRuntimeAndDisposeChannel 的
   * HARVEST_GRACE 同款 race 形态（close 永不到达不挂死）。abort 链的 await 终局
   * 语义因此是「进程收割确认完成」而非「SIGTERM 已发出」。
   */
  private async awaitConnFinalized(rt: AppServerRuntime): Promise<void> {
    if (!rt.conn.alive) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => finish(), ZCODE_APPSERVER_HARVEST_GRACE_MS);
      if (typeof timer.unref === "function") timer.unref();
      const off = rt.conn.onClose(() => finish());
      function finish(): void {
        clearTimeout(timer);
        off(); // Set.delete 幂等——并发触发无副作用
        resolve();
      }
    });
  }

  /**
   * D3 abort 链执行体（用户取消入口，fire-and-forget——与 turn promise 并行推进）：
   * stop 帧（超时 ZCODE_APPSERVER_STOP_TIMEOUT_MS）→ grace 窗口内 turn 落定即止
   * （不杀共享进程）→ 超窗 killChain（conn.shutdown 全序：SIGTERM→grace→SIGKILL）。
   * turn 的最终落定由 attempt 主路径 await 收口，本链不直接产出终态。abort 与 create
   * 竞态（signal 先到、session 未建立）：等会话建立（带上限）再发 stop——否则 stop
   * 永远发不出，直接连坐杀共享进程。
   */
  private async appServerAbortChain(
    rt: AppServerRuntime,
    turn: Promise<SessionTurnResult>,
    getSessionId: () => string | undefined,
    sessionCreated: Promise<void>,
  ): Promise<void> {
    const graceRaceThenKill = async (): Promise<void> => {
      const settled = await Promise.race([
        turn.then(
          () => true,
          () => true,
        ),
        delayResolved(abortGraceMs(), false),
      ]);
      if (settled) return; // stop 生效：终态在 grace 窗口内到达，共享进程不杀
      logger.warn(
        `[zcode-engine] abort grace 窗口内未见终态——killChain 收割共享进程（接受连坐，在途任务走崩溃路径）`,
      );
      await rt.conn.shutdown({ graceMs: ZCODE_KILL_GRACE_MS });
      await this.awaitConnFinalized(rt);
    };

    let sessionId = getSessionId();
    if (sessionId === undefined) {
      await Promise.race([sessionCreated, delayResolved(stopTimeoutMs(), undefined)]);
      sessionId = getSessionId();
      if (sessionId === undefined) {
        // 会话始终未建立：无会话即无在途任务可止损，跳过 stop，grace race 兜底
        //（create 竞态挂死形态）
        return graceRaceThenKill();
      }
    }
    // [u-z2 修复轮] alive 守卫（与 closeSession 的 `!conn.alive` return 同款防御，
    // 对称补齐）：进程在 abort 与本链发 stop 之间 finalize 完成的微窗口内，request
    // 首行 ensureStarted 会惰性 spawn 新一代进程再写 stop 帧——凭空拉起无人使用的
    // 进程。不 alive = 连接级失败形态（进程已死即已收割）：跳过 stop 落回 grace race
    //（turn 已被 failAllTurns 收割则立即 settled，语义零变化）。
    if (!rt.conn.alive) {
      return graceRaceThenKill();
    }
    try {
      await rt.conn.request("session/stop", { sessionId }, { timeoutMs: stopTimeoutMs() });
    } catch (err) {
      logger.debug(
        `[zcode-engine] session/stop 失败（${errMessage(err)}）——grace 后走 killChain 兜底`,
      );
    }
    return graceRaceThenKill();
  }

  // ── 常驻运行时管理（D1/D6）──────────────────────

  /**
   * 惰性获取常驻运行时（D1：每引擎实例一条连接，全任务共享；连接自身的崩溃重建在
   * connection 层内部完成——同一条代码路径，§3.4 不变量 4）。常驻进程不进宿主
   * spawnedChildren、不调 onChildSpawned（D6——生命周期归 dispose）。进程级 --cwd
   * 用引擎数据目录（连接跨任务共享的中性位置，工作区由 create 的
   * workspace.workspacePath 按任务传递——D10 基线不预设任务级进程 cwd）。
   * spawn 经 fs 拦截 wrapper（appserver-launcher：cli config 读取重定向为
   * 「真实文件 + v2 provider 注入」——CLI 形态 app-server 在共享宿主 HOME 下的
   * 唯一凭据供数通路，机制与漂移面见该文件头注）。
   */
  private ensureAppServerRuntime(): AppServerRuntime {
    if (this.appserverRuntime !== undefined) return this.appserverRuntime;
    const cliPath = this.deps.cliPath ?? ZCODE_CLI_DEFAULT_PATH;
    const engineDataDir = this.deps.engineDataDir();
    const launcherScript = ensureAppServerLauncher(engineDataDir);
    const env = buildAppServerEnv(this.deps.processEnv ?? process.env);
    env.ZCODE_ENG_CLI_PATH = cliPath;
    env.ZCODE_ENG_V2_CONFIG = this.deps.sources?.v2ConfigPath ?? defaultV2ConfigPath();
    // [D3 顺带发现 6] wrapper 补注入源 = 引擎侧模型校验源同锚（ZcodeSourcePaths
    // personalProviderConfigPath 单源——两处读同一文件，解析源统一在该锚上收口）
    env.ZCODE_ENG_PROVIDER_CONFIG = this.deps.sources?.personalProviderConfigPath ?? defaultPersonalProviderConfigPath();
    // 会话库隔离（设计 zcode-session-db-isolation.md D1/E4）：覆盖式写入隔离库路径，
    // 忽略宿主继承值（用户 shell 的同名 env 不得把我们重定向到别处；配置分层
    // Cli > Env > User 保证 env 压过用户 config 的 storage.sessionDbPath）。同时显式
    // 清空同层别名键 ZCODE_SESSION_DB——实装里两者都映射 storage.sessionDbPath，按
    // env 键序后写胜出，当前写法恰然后写但那是顺序巧合，必须显式化。
    const sessionDbPath = zcodeSessionDbPath(engineDataDir);
    env.ZCODE_SESSION_DB_PATH = sessionDbPath;
    delete env.ZCODE_SESSION_DB;
    // 父目录确保：把权限/磁盘错误提前到可读文案（引擎自身 ensureParentDir 也会建
    // 父目录，此为提前失败面；失败向上 reject——run 错误语义①，不静默回落宿主库）。
    fs.mkdirSync(path.dirname(sessionDbPath), { recursive: true });
    const conn = new AppServerConnection({
      cliPath,
      dataDir: engineDataDir,
      cwd: engineDataDir,
      env,
      launcherScript,
      stderrLogPath: path.join(engineDataDir, "logs", "zcode-appserver-stderr.log"),
      // [W11] 实例维度 tee 路径（设计 §3.9）：文件名带当前代 app-server pid——
      // 双实例（pi 宿主 + runtime 各一个引擎 CLI）并发 append/轮转互不干扰。
      stderrLogPathResolver: (pid) =>
        typeof pid === "number"
          ? stderrLogPathFor(engineDataDir, pid)
          : path.join(engineDataDir, "logs", "zcode-appserver-stderr.log"),
    });
    const rt: AppServerRuntime = {
      conn,
      channel: new SessionChannel(conn),
      activeSessions: new Set<string>(),
    };
    this.appserverRuntime = rt;
    // [U6 / §3.2.6 风险登记②] TTL 清理通道接线（引擎侧 sweep 选型，见
    // session-db-maintenance.ts 头注）：lazy——运行时建立时 defer 触发（50ms 让位
    // 首 run 的 create 请求先出站），进程级 24h 节流。活跃豁免集 = 当前在途会话
    // 快照（sweep 同步执行窗内新建的会话在 30 天 TTL 口径下天然安全——不可能是
    // 超窗条目）。fail-soft：sweep 任何失败不进 run 主链路。
    const sweepDbPath = sessionDbPath;
    const sweepTimer = setTimeout(() => {
      maybeSweepExpiredZcodeSessions(sweepDbPath, { keepSessionIds: this.appserverRuntime?.activeSessions });
    }, ZCODE_SESSION_SWEEP_DEFER_MS);
    if (typeof sweepTimer.unref === "function") sweepTimer.unref();
    return rt;
  }

  /**
   * [R5 修复 R4 既有竞态] shutdown → 等崩溃收割实际发生 → channel 退订。killChain 在
   * `exit` 事件 resolve，而连接 finalize（onClose → channel 的 failAllTurns）挂
   * `close` 事件——两者之间有一个事件循环窗口：shutdown resolve 后立即退订，在途
   * turn 会错过收割而失去终局来源。退订前等 onClose 触发（本方法先于
   * shutdown 订阅；channel 的订阅在构造期更早——其 failAllTurns 先于本 promise
   * resolve 执行）；ZCODE_APPSERVER_HARVEST_GRACE_MS 兜底防 `close` 永不到达时挂死。
   * [P0-1 U5/D7] grace race 输掉（close 迟到/永不到达——stdio 被孙进程持有排空不
   * 尽等病态形态）时，channel.dispose() 内置的 dispose 收割（failAllTurns 先于退订，
   * SessionChannel.dispose）兜底在途 turn——在途 turn 收敛为「grace 窗口内明确失败」
   * （设计 §3.4 退化路径闭合）；race 窗口与 awaitConnFinalized 同源同量级
   * （ZCODE_APPSERVER_HARVEST_GRACE_MS）。正常 close 先到时 onClose 收割先行，
   * dispose 收割幂等 no-op（零回归）。
   */
  private async shutdownRuntimeAndDisposeChannel(rt: AppServerRuntime): Promise<void> {
    const harvested = new Promise<void>((resolve) => {
      const off = rt.conn.onClose(() => {
        off();
        resolve();
      });
    });
    await rt.conn.shutdown({ graceMs: ZCODE_KILL_GRACE_MS });
    // close 未在 grace 内到达 → 输掉 race → channel.dispose() 的内置收割兜底
    await Promise.race([harvested, delayResolved(ZCODE_APPSERVER_HARVEST_GRACE_MS, undefined)]);
    rt.channel.dispose();
  }

  /**
   * [R1 D6 主体] 引擎停机面：①fire 全部在途会话的 session/close 帧（不等待
   * 应答——D6① 顺序规定：close 帧必须先于 SIGTERM，否则对面来不及处理即被杀）→
   * ②同步 SIGTERM（conn.shutdown 调用内 killChain 前缀同步执行——同步面在返回
   * Promise 前完成）→ ③grace → SIGKILL（异步面，Promise resolve 于进程退出）。
   * 幂等：运行时字段取走即置空，二次调用零副作用；dispose 后首个 run 经
   * ensureAppServerRuntime 自动重建（与崩溃重建同一代码路径，不变量 4）。
   */
  async dispose(): Promise<void> {
    // [P0-1 U4] 停机标志先行：在途任务的瞬时重试判定据此短路（dispose 收割引发的
    // 崩溃不再触发重试轮——重试轮会经惰性重建复活已停机引擎）
    this.disposed = true;
    const rt = this.appserverRuntime;
    if (rt === undefined) return;
    this.appserverRuntime = undefined;
    // ①fire 全部在途会话的 session/close 帧（不等待应答——D6① 顺序规定：close 帧
    // 必须先于 SIGTERM，否则对面来不及处理即被杀）。进程已死（child=null，如崩溃
    // 收割与 activeSessions 清理之间的微拍）则整体跳过：post 会经 ensureStarted 惰性
    // 拉起新进程再被同次 dispose 杀掉——无意义的 spawn+kill 循环（D6 dispose=防泄漏
    // 语义不制造新进程）。同步循环内 alive 不会中途翻转（进程退出是异步事件，本轮
    // 循环不可重入）
    if (rt.conn.alive) {
      for (const sessionId of [...rt.activeSessions]) {
        rt.conn.post("session/close", { sessionId });
      }
    }
    // ②③ 同步 SIGTERM（killChain 前缀在 shutdown 调用内同步执行）→ grace → SIGKILL
    //（异步面，resolve 于进程退出）。channel 退订放在崩溃收割之后（exit→close 窗口
    //竞态的修复体，见 shutdownRuntimeAndDisposeChannel——先退订会让在途 turn 失去
    //崩溃收割终局）
    await this.shutdownRuntimeAndDisposeChannel(rt);
  }

  /** 终态合成（extension-conventions 函数 80 行上限，从 run 提取）：aborted / run-failed / parsed 三分支。 */
  private finalizeOutcome(
    task: AgentCallOpts,
    ctx: RunContext,
    final: AttemptResult,
    usageAcc: { input: number; output: number; cacheRead: number; cacheWrite: number; has: boolean },
    startedAt: number,
  ): AgentOutcome {
    const outcome: AgentOutcome = {
      engineId: ZCODE_ENGINE_ID,
      content: "",
      durationMs: Date.now() - startedAt,
      ...(typeof task.worktree === "object" && task.worktree !== null ? { worktreePath: task.worktree.path } : {}),
    };
    const emit = (event: AgentEvent): void => {
      ctx.onEvent?.(event);
    };

    if (final.kind === "aborted") {
      this.applyAbortedOutcome(outcome, task, ctx, final, emit);
    } else if (final.kind === "run-failed") {
      this.applyRunFailedOutcome(outcome, final, emit);
    } else {
      this.applyParsedOutcome(outcome, final, usageAcc, emit);
    }
    return outcome;
  }

  /** abort 合成终态：exitCode=null（record 正常收尾，不留僵尸）。 */
  private applyAbortedOutcome(
    outcome: AgentOutcome,
    task: AgentCallOpts,
    ctx: RunContext,
    final: Extract<AttemptResult, { kind: "aborted" }>,
    emit: (event: AgentEvent) => void,
  ): void {
    outcome.exitCode = null;
    // 对齐点④：宿主超时（mergeTimeoutSignal 的 timeout abort）统一走公共合成终态
    // （common/kill-chain.synthesizeTimeoutOutcome——engine_timeout 文案 SSOT + 「可用
    // engine: pi 重跑」建议）；用户主动 cancel 维持 engine_run_failed 中止标记（非超时
    // 语义，不冒充超时）。?? 兜底是类型收窄（合成器恒写 error）。
    outcome.error = isHostTimeoutAbort(ctx)
      ? synthesizeTimeoutOutcome(task, final.output.stdoutText, ZCODE_ENGINE_ID).error ??
        engineTimeoutDetail(final.output.stdoutText)
      : final.abortMessage ??
        `engine_run_failed: zcode 任务被中止（app-server abort 链收口，宿主合成终态）。` +
          `输出尾部: ${final.output.stdoutText.slice(-ZCODE_ERROR_TAIL_CHARS)}`;
    emit({ type: "error", message: outcome.error });
  }

  /**
   * run-failed 合成终态：错误信息由 buildAppServerRunFailedMessage 产出（已含恢复
   * 指引）直接透传；附带的会话 id 落 outcome.sessionId（错误规格表 -32004 行「含会话
   * id」——appServerHandle 据此写 handle.sessionRef，run-failed 不再恒缺）。
   */
  private applyRunFailedOutcome(
    outcome: AgentOutcome,
    final: Extract<AttemptResult, { kind: "run-failed" }>,
    emit: (event: AgentEvent) => void,
  ): void {
    outcome.exitCode = final.output.exitCode;
    if (final.sessionId !== undefined) outcome.sessionId = final.sessionId;
    outcome.error = final.message;
    emit({ type: "error", message: outcome.error });
  }

  /** parsed 合成终态：content/sessionId/usage 落位 + schema 校验分流 + coarse 事件。 */
  private applyParsedOutcome(
    outcome: AgentOutcome,
    final: Extract<AttemptResult, { kind: "parsed" }>,
    usageAcc: { input: number; output: number; cacheRead: number; cacheWrite: number; has: boolean },
    emit: (event: AgentEvent) => void,
  ): void {
    const payload = final.payload;
    outcome.content = payload.response;
    outcome.exitCode = final.output.exitCode;
    if (payload.sessionId !== undefined) outcome.sessionId = payload.sessionId;
    // usage：token 四项取两轮之和（重试的 LLM 调用真实发生），contextTokens/turns 取末轮
    if (usageAcc.has) {
      const last = payload.outcomeUsage;
      outcome.usage = {
        input: usageAcc.input,
        output: usageAcc.output,
        cacheRead: usageAcc.cacheRead,
        cacheWrite: usageAcc.cacheWrite,
        cost: 0,
        contextTokens: last?.contextTokens ?? usageAcc.input + usageAcc.output + usageAcc.cacheRead + usageAcc.cacheWrite,
        turns: last?.turns ?? 1,
      };
    }
    if (final.schemaResult !== undefined) {
      if (final.schemaResult.ok) {
        // D4 硬分流的 emulated 侧产出：公共仿真层的 ajv 校验结果即 parsedOutput
        outcome.parsedOutput = final.schemaResult.parsed;
      } else {
        // 两轮（原始 + 强化重试）均未通过三级容错提取/ajv 校验
        outcome.error =
          `schema_emulation_failed: zcode 输出经两轮（含强化 prompt 重试）仍未通过 schema 校验。` +
          `末轮失败原因: ${final.schemaResult.error}。原始输出尾部: ${final.schemaResult.tail}。` +
          `恢复指引：简化 schema 或拆小任务后重派；需要强 schema 约束时改用 engine: pi（native schema 注入）。`;
        emit({ type: "error", message: outcome.error });
      }
    }
    // coarse 事件（不变量 5：事件 emit 完成先于 run resolve——journal 完整性）
    for (const ev of synthesizeCoarseEvents(payload.response, payload.usage)) emit(ev);
  }

  /** [U7] 模型可发现性：provider_config 个人 provider 聚合（注册表实况对齐源），失败安全返回清单本身可能为空。 */
  listModels(): Array<{ id: string; name?: string }> {
    return listZcodeModels(this.deps.sources);
  }

  /** 显式模型的最小 reasoning 档（目录 modelRules 值域；per-modelRef 记忆化——
   *  目录文件在引擎进程生命周期内视为静态，重复 run 不重读）。 */
  private readonly reasoningMemo = new Map<string, string | undefined>();

  private minimalReasoningFor(modelRef: string): string | undefined {
    const memoKey = `${locateZcodeBuiltinCatalog(this.deps.sources) ?? "none"}|${modelRef}`;
    const hit = this.reasoningMemo.get(memoKey);
    if (hit !== undefined || this.reasoningMemo.has(memoKey)) return hit;
    const level = resolveZcodeMinimalReasoningLevel(modelRef, this.deps.sources);
    this.reasoningMemo.set(memoKey, level);
    return level;
  }

  /**
   * [u-h2 D2-2] 派发同步期 model 校验：委托 resolveZcodeModelRef（与 run prepare 期
   * 显式路径同一函数——canonicalRef 归一化、短名缺省 provider、凭据与清单校验单一
   * 权威，无双实现）。校验失败原样抛 ZcodePrepareError，由编排层
   * （engine/model-validation.ts）包装成「引擎与模型不配套」文案。
   *
   * [R4/D6-②] 缺席语义：本实现是进程内形态 + 协议诊断面（宿主 cli 形态消费的是
   * RemoteEngine 的 manifest 本地判定，不经本方法——SDK protocol methods.ts 明示
   * validateModel 为诊断面）。缺席 modelRef 时返回空串 canonical（= create 帧省略
   * model 键、CLI 自身缺省解析——2026-09-29 account 体系迁移后 plan 家族兜底 id
   * 已不可用；record 留痕侧按 R4/D6-② 空串归一为「用户未指定」条件留空）。帧应答
   * 形态维持 {canonicalRef: string}（SDK port-contract 契约必填——「帧字段缺席」
   * 的 optional 对齐需放宽 SDK 契约与 server handler 签名，非本包单方面可完成）。
   */
  validateModel(modelRef: string | undefined): { canonicalRef: string } {
    return { canonicalRef: resolveZcodeModelRef(modelRef, this.deps.sources) };
  }

  /**
   * D6 read 三级降级：①sqlite 原生读取 → ②宿主 event journal 重放（对齐点①接线：
   * replayJournalToSessionView 复用 live reducer，重放等价性见 §3.3.6）→ ③outcome-only。
   * sessionId 缺失（解析失败的 run 无法定位 session）跳过①级；②级依赖
   * handle.eventsPath（宿主 run 后回填）。dbPath：新 handle 恒为隔离库绝对路径
   * （zcodeSessionDbPath(engineDataDir)，tier1 白名单集合见方法体——宿主路径仅
   * 「共享 HOME 时代」存量兼容）；旧 records（池时代）的相对路径仍按池目录锚定
   * 解析（read 兼容旧数据，池目录不存在时自然落②级 journal 降级）。[池抽象降级
   * 2026-09-13] 锚定 key 用常量 SHARED_POOL_KEY 承载——协议面 poolKey 已删，池
   * 时代真实池 key 不再随 handle 传输；若旧 record 的池目录恰为 shared 布局则①级
   * 仍可达，其余池 key 的旧 record 直接走②级 journal 降级（30 天 TTL 同尺度衰减，
   * 行为安全）。
   */
  async read(handle: EngineHandle): Promise<SessionView> {
    if (handle.data.engineId !== ZCODE_ENGINE_ID) {
      return { engineId: ZCODE_ENGINE_ID, turns: [], source: "outcome-only" };
    }
    const sessionId = handle.data.sessionRef["sessionId"];
    const dbPathRaw = handle.data.sessionRef["dbPath"];
    if (typeof sessionId === "string" && typeof dbPathRaw === "string") {
      // 绝对路径 tier1 白名单（判定内聚本引擎包——runtime 侧经 registerNativeSessionReader
      // 协议 read 复用本方法同一判定结果，W11 后唯①级放行点）：handle/
      // record 来自 append-only JSONL（不可信面），仅放行 zcodeDbPathAllowlist
      // 集合内精确匹配（隔离库现役 + 宿主库存量兼容；dataDir 与写侧 handle 回填
      // 同源 deps.engineDataDir），其余绝对路径拒绝 ①级 sqlite 读取、降 journal
      // 重放——防任意文件读
      let dbPath: string | undefined;
      if (path.isAbsolute(dbPathRaw)) {
        if (zcodeDbPathAllowlist(this.deps.engineDataDir()).includes(dbPathRaw)) {
          dbPath = dbPathRaw;
        } else {
          logger.warn("[zcode-engine] record dbPath 非白名单 db 绝对路径，拒绝 ①级读取降 journal", {
            dbPath: dbPathRaw,
          });
        }
      } else {
        // 相对路径（池时代旧 record）分支：dbPathRaw 同样来自 append-only JSONL
        // （不可信面），含 `..` 段可经 join 归一化逃逸池目录、绕过绝对路径分支的
        // 封闭白名单——join 后 resolve 归一化并做池目录前缀包含性校验，越界按非
        // 白名单同款 warn + 拒绝 ①级、降 journal（防任意文件读的守卫缺口补齐）。
        const poolDir = path.resolve(
          resolvePoolDir(this.deps.engineDataDir(), ZCODE_ENGINE_ID, SHARED_POOL_KEY),
        );
        const resolved = path.resolve(poolDir, dbPathRaw);
        if (resolved.startsWith(poolDir + path.sep)) {
          dbPath = resolved;
        } else {
          logger.warn("[zcode-engine] record dbPath 相对路径逃逸池目录，拒绝 ①级读取降 journal", {
            dbPath: dbPathRaw,
          });
        }
      }
      if (dbPath !== undefined) {
        try {
          return await readZcodeSessionView(dbPath, sessionId);
        } catch (err) {
          logger.warn("[zcode-engine] native session read failed, degrade to journal replay", {
            dbPath,
            sessionId,
            reason: toErrorMessage(err),
          });
        }
      }
    }
    // ②级：journal 重放（eventsPath 缺省 / 文件不存在 / 无事件 → undefined 落③级）
    const journaled = replayJournalToSessionView(handle, ZCODE_ENGINE_ID);
    if (journaled !== undefined) return journaled;
    return { engineId: ZCODE_ENGINE_ID, turns: [], source: "outcome-only" };
  }

  // ── 内部 ──

  /**
   * [RX2-F1] appserver 路径的非常见档位提示：thinkingLevel → thoughtLevel 恒等透传
   * （F15a），全 7 档放行不拦截——但部分档位（off/minimal/medium/xhigh 等）不在部分
   * 模型的合法值域内（如 GLM-5.3 仅接受 low/high/max），app-server 侧对不支持的档位
   * warn-skip（会话照常但档位静默失效），调用方无从察觉。此处仅对
   * COMMON_THOUGHT_LEVELS 之外的档位出声一行提示（措辞是「若不支持将被忽略/回落」的
   * 或然警告，非无效断言）；是否真不支持由目标模型决定，core 不做权威校验（引擎层
   * 不掌握各模型值域）。
   */
  private warnThoughtLevelUncommon(task: AgentCallOpts, ctx: RunContext): void {
    const thoughtLevel = task.thinkingLevel?.trim();
    if (thoughtLevel === undefined || thoughtLevel === "") return;
    if (COMMON_THOUGHT_LEVELS.includes(thoughtLevel)) return;
    logger.warn(
      `[zcode-engine] thinkingLevel=${thoughtLevel} 已透传为 thoughtLevel（非常见档位）：若目标模型不支持该档位将被忽略/回落到模型缺省推理档位（常见档位：${COMMON_THOUGHT_LEVELS.join("/")}）；档位是否生效以模型实际行为为准`,
      { taskId: ctx.taskId },
    );
  }

  /**
   * [F16b] ctxModel 忽略留痕：ctxModel 是 pi 链路的第三层兜底（port.ts 契约——
   * 依赖 pi resolveModel 链的引擎才消费它），zcode 不消费。「调用方给了 ctxModel 但
   * task.model 未显式指定」时出声一行。只在「ctx 有模型但被忽略」场景输出：显式
   * task.model 走正常解析链、ctx 本就无模型属预期缺省，均不出声（避免噪音）。
   * [R4/G3] 文案更新：缺席 model 时 create 不携带 model 键（缺省模型由 zcode 自身
   * 解析——用户 defaultModelSelection 优先），不再声称「实际使用引擎缺省模型
   * <fallback>」（恒传时代的表述，与缺席不携带的新行为不符）。modelRef 参数已随
   * R4 条件携带移除——warn 可达即缺席态（显式 task.model 在 requested 非空早退处
   * 返回），无第三形态。
   */
  private warnIgnoredCtxModel(task: AgentCallOpts, ctx: RunContext): void {
    if (ctx.ctxModel === undefined) return;
    const requested = task.model?.trim();
    if (requested !== undefined && requested !== "") return;
    logger.warn(
      `[zcode-engine] ctx.ctxModel（${ctx.ctxModel.id}）被忽略——ctxModel 是 pi 链路兜底，zcode 不消费；` +
        `task.model 未显式指定，create 不携带 model 键，缺省模型由 zcode 自身解析（用户 defaultModelSelection 优先）`,
      { taskId: ctx.taskId },
    );
  }

  /**
   * [U6 / §3.2.6 要点 3] resume 锚 → 历史前缀（interact-resume 的读半段）。
   *
   * 无锚 / 非 zcode 锚形态 → undefined（行为不变）。读通道失败（会话失效 / 控制
   * 面错误）= 锚真失效的权威信号——宿主侧库投影预检查已退役（app-server 落库滞后
   * 于 create 应答，分钟级窗 + 部分行永不落库，预检查系统性误判；resume 走
   * app-server resident 内存态才是真实活性判据），因此此处不再静默降级为无前缀
   * 裸跑，而是返回锚失效声明段：让模型知情「延续但无历史」，基于最新消息独立
   * 续推，而非在缺上下文时臆测连续性。用户消息照常执行，不炸轮。
   */
  private async buildResumeHistoryPrefix(ctx: RunContext): Promise<string | undefined> {
    const anchor = zcodeResumeAnchorOf(ctx, this.deps.engineDataDir());
    if (anchor === undefined) return undefined;
    const rt = this.ensureAppServerRuntime();
    let history: ResumedHistoryTurn[];
    let tokens: number | undefined;
    try {
      const result = await rt.channel.resumeSession(anchor.sessionId);
      history = extractResumeHistory(result);
      tokens = extractResumeTotalTokens(result);
    } catch (err) {
      logger.warn(
        `[zcode-engine] session/resume 读历史失败（锚 ${anchor.sessionId}）——判定锚真失效，注入锚失效声明段继续执行: ${errMessage(err)}`,
        { taskId: ctx.taskId },
      );
      return buildResumeUnavailableNoticeSegment();
    }
    if (history.length === 0) return undefined; // 空历史（锚存在但从未成轮）不注入空段
    return buildResumeInjectionSegment(history, anchor.sessionId, tokens);
  }

  /**
   * persona 拼接后的完整 prompt（personaInjection: 'prompt'——zcode 无 flag 通道）：
   * appendSystemPrompt 段在前（人设/约束语境——D6 合流后 persona≡skillPath+
   * appendSystemPrompt 平铺，由上游解析进 appendSystemPrompt），task 正文居中，
   * schema 仿真段尾置（common/schema-emulation 公共层产出）。
   */
  private buildPrompt(task: AgentCallOpts, schema: JsonSchemaObject | undefined): string {
    const segments: string[] = [...(task.appendSystemPrompt ?? [])];
    segments.push(task.prompt);
    if (schema !== undefined) segments.push(buildSchemaEmulationSegment(schema));
    return segments.join("\n\n");
  }
}

// ── 模块级辅助（run 的重试编排件） ──

/**
 * [U6 / §3.2.6 要点 3] run ctx 的 resume 锚 zcode 形态判别（sessionRef 双键
 * {sessionId, dbPath}——宿主 transcriptAnchorOf 派生的 zcode 锚经协议 ResumeAnchor
 * 弱类型 Record 透传，此处形状收窄）。pi 锚（sessionFile）对 zcode 引擎无意义，
 * 返回 undefined 走无前缀路径。
 *
 * dbPath 守卫与 read() ①级同字段同构：锚 sessionRef 与 handle/record 同源
 * append-only JSONL（不可信面），仅放行 zcodeDbPathAllowlist 封闭集合内精确匹配
 * （隔离库现役 + 宿主库「共享 HOME 时代」存量兼容锚点）。非集合内路径（含池时代
 * 相对路径——resume 锚场景读通道本就该走白名单库）→ 非法 zcode 锚，undefined 走
 * 无前缀路径（与读通道失败的降级语义同族，不炸轮）。
 */
function zcodeResumeAnchorOf(
  ctx: RunContext,
  engineDataDir: string,
): { sessionId: string; dbPath: string } | undefined {
  const ref = ctx.resume?.resume?.sessionRef;
  if (ref === undefined) return undefined;
  const sessionId = ref["sessionId"];
  const dbPath = ref["dbPath"];
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  if (typeof dbPath !== "string" || dbPath === "") return undefined;
  if (!zcodeDbPathAllowlist(engineDataDir).includes(dbPath)) return undefined;
  return { sessionId, dbPath };
}

/**
 * [U6 / §3.2.6 要点 3] resume 历史 → 注入前缀（纯函数，单测锁定裁剪契约）。
 *
 * 形态：新会话对 prior session 零记忆——前缀显式框定「这是同一对话的延续」并
 * 给出 prior sessionId（宿主 record 锚已换新，旧 id 仅作溯源提示），历史按
 * user/assistant 双向行铺陈。裁剪：恒按字符 4:1 近似（token 预算 ×
 * ZCODE_RESUME_CHARS_PER_TOKEN）执行，超限时从最旧条目起丢弃并显式标注省略（保尾
 * ——最近上下文对续聊最重要）；resume 应答 tokens 数据（totalTokens 形参）不参与
 * 裁剪判定，仅进保留量注记。
 */
export function buildResumeInjectionSegment(
  history: readonly ResumedHistoryTurn[],
  priorSessionId: string,
  totalTokens?: number,
  tokenBudget: number = ZCODE_RESUME_HISTORY_TOKEN_BUDGET,
): string {
  const budgetTokens = tokenBudget;
  const charBudget = budgetTokens * ZCODE_RESUME_CHARS_PER_TOKEN;
  const lines = history.map((t) => `${t.role}: ${t.text}`);
  let kept = lines;
  let omitted = 0;
  // 裁剪循环：历史行总字符超预算时逐条丢最旧（每轮重算；预算只覆盖历史行——
  // 前缀框架文本与省略注记不占预算，框架文本为固定数百字符，对 96k chars 量级
  // 预算的偏差可忽略）
  while (kept.length > 1 && kept.reduce((n, l) => n + l.length + 1, 0) > charBudget) {
    kept = kept.slice(1);
    omitted++;
  }
  const omissionNote = omitted > 0 ? `[... ${omitted} older turn(s) omitted to fit the ${tokenBudget}-token history budget ...]\n` : "";
  const usageNote =
    totalTokens !== undefined
      ? `\n(prior session retained ~${totalTokens} tokens of history)`
      : "";
  return (
    `[Continued conversation] You are continuing an existing subagent conversation on a NEW session ` +
    `(prior session id: ${priorSessionId}). The new session has no memory of its own — the full prior ` +
    `conversation history recovered from the session store follows. Continue seamlessly from it; the user ` +
    `message after this block is the next turn of the SAME conversation.\n\n` +
    `<conversation_history>\n${omissionNote}${kept.join("\n")}\n</conversation_history>${usageNote}\n\n`
  );
}

/**
 * [U3] resume 读失败 → 锚失效声明段（纯函数，单测锁定文案契约）。
 *
 * resume 走 app-server resident 内存态，读失败即锚真失效的权威信号（宿主侧库投影
 * 预检查已退役——落库滞后使预检查系统性误判，见 buildResumeHistoryPrefix 方法头）。
 * 声明段让模型知情「这是延续会话但历史不可恢复」，避免其在零上下文时臆测任务进展
 * 或假装记得（静默裸跑的缺陷面）；语义与 buildResumeInjectionSegment 的「延续且有
 * 历史」相对，尾部 `\n\n` 形态一致（与后续 prompt 空行分隔）。
 */
export function buildResumeUnavailableNoticeSegment(): string {
  return (
    "[会话延续提示] 本消息是同一任务的延续会话，但上一会话的历史记录不可恢复（原始会话已失效）。\n" +
    "没有更早的对话上下文可引用——请基于下方最新消息独立判断并继续推进任务。\n\n"
  );
}

/** app-server 路径的合成 output 形态（stdoutText 恒空——失败素材在 message 内）。 */
interface AttemptOutput {
  exitCode: number | null;
  stdoutText: string;
  stderrTail: string;
}

/**
 * attempt 的三态产物（run 按序编排重试与终态合成）。
 */
type AttemptResult =
  | { kind: "aborted"; output: AttemptOutput; abortMessage?: string }
  | {
      kind: "run-failed";
      output: AttemptOutput;
      message: string;
      /** appserver 路径失败时已建立的会话 id（错误规格表 -32004 行：按任务失败上报含会话 id）。 */
      sessionId?: string;
      /**
       * [P0-1 U4/D6] 瞬时失败形态标记（重试判定判据——类型化字段，不经字符串
       * 反推）：conn-closed = 连接崩溃收割（failAllTurns 形态，判据 =
       * 非 RPC error 且 conn 不存活——catch 时刻重建仅由 conn.request 惰性触发，
       * 此前无 request，判据可靠）。缺席 = 非瞬时形态（RPC 错误/status=error 终态/
       * send 未送达等），不参与重试（D6 被否③：status='error' 终态 v1 不重试）。
       * （原 "timeout" 形态随 turn 双 timer 删除——channel 不再有时间判死来源。）
       */
      transient?: "conn-closed";
    }
  | {
      kind: "parsed";
      output: AttemptOutput;
      payload: ZcodeTerminalPayload;
      schemaResult?: { ok: true; parsed: unknown } | { ok: false; error: string; tail: string };
    };

/**
 * task.schema 的最小 JSON Schema 形状（S13：替代裸 object——序列化边界上表达
 * 「ajv 可消费的 schema 对象」；具体关键字（type/properties/required…）由
 * schema-emulation 层解释，此处只约束对象形态）。
 */
type JsonSchemaObject = Readonly<Record<string, unknown>>

/** Record 形状 guard（task.schema 的运行时窄化——JsonSchemaObject 不满足 ajv 的 object 入参）。 */
function isPlainObject(v: unknown): v is JsonSchemaObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 错误/日志出声用的 message 提取（非 Error 值不抛二次异常）。 */
function errMessage(err: unknown): string {
  return toErrorMessage(err);
}

/**
 * grace/stop 常量族 env 覆盖读取（测试注入缝）：未设/空 → 默认；正毫秒数 → 覆盖；
 * 非法（非数字/≤0）→ warn 留痕 + 回落默认（生效行为可见）。读 process.env 直连
 *（vi.stubEnv 可测）。
 */
function resolveAppserverTimingMs(envName: string, fallbackMs: number, label: string): number {
  const raw = process.env[envName];
  const parsed = parseZcodePositiveMsEnv(raw);
  if (parsed.state === "valid") return parsed.ms;
  if (parsed.state === "invalid") {
    logger.warn(
      `[zcode-engine] ${envName}="${raw}" 非法（应为正毫秒数字）——回落默认 ${fallbackMs}ms（${label}）`,
    );
  }
  return fallbackMs;
}

/** [测试注入缝] stop 控制面超时实际值（env 覆盖 > 默认 3s；解析见 resolveAppserverTimingMs）。 */
function stopTimeoutMs(): number {
  return resolveAppserverTimingMs(
    ZCODE_APPSERVER_STOP_TIMEOUT_ENV,
    ZCODE_APPSERVER_STOP_TIMEOUT_MS,
    "stop 控制面超时",
  );
}

/** [测试注入缝] abort grace 窗口实际值（env 覆盖 > 默认 3s；同上）。 */
function abortGraceMs(): number {
  return resolveAppserverTimingMs(
    ZCODE_APPSERVER_ABORT_GRACE_ENV,
    ZCODE_APPSERVER_ABORT_GRACE_MS,
    "abort grace 窗口",
  );
}

/** ms 后 resolve 指定值（abort 链 grace 窗口的 race 材料；unref 不阻塞进程退出）。 */
function delayResolved<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(value), ms);
    if (typeof t.unref === "function") t.unref();
  });
}

/** appserver 路径的合成 output（无 stdout 可收集——exitCode 语义：0=正常轮；null=中止/连接级失败）。 */
function syntheticAppServerOutput(exitCode: number | null): AttemptOutput {
  return { exitCode, stdoutText: "", stderrTail: "" };
}

/** appserver 路径的 aborted 三态（abortMessage 描述 D3 链形态）。 */
function abortedAppServerAttempt(ctx: RunContext): AttemptResult {
  void ctx;
  return {
    kind: "aborted",
    output: syntheticAppServerOutput(null),
    abortMessage:
      `engine_run_failed: zcode 任务被中止（app-server abort 链：session/stop → ${abortGraceMs()}ms grace 确认 → ` +
      `超时 killChain SIGTERM→${ZCODE_KILL_GRACE_MS}ms→SIGKILL 收割共享进程，在途任务走崩溃路径）。`,
  };
}

/** runTurn 终态 → 载荷形态（usage 映射：parser.mapZcodeUsage 一族）。 */
function turnResultToPayload(r: SessionTurnResult): ZcodeTerminalPayload {
  return {
    response: r.response,
    sessionId: r.sessionId,
    ...(mapZcodeUsage(r.usage) !== undefined ? { usage: mapZcodeUsage(r.usage) } : {}),
    ...(mapZcodeOutcomeUsage(r.usage, undefined) !== undefined
      ? { outcomeUsage: mapZcodeOutcomeUsage(r.usage, undefined) }
      : {}),
  };
}

/**
 * appserver 路径运行中失败的结构化文案（错误规格表）：-32603 "Model config is
 * missing" → engine_credential_missing（共享宿主 HOME——凭据在 ZCode 桌面端管理）；
 * -32010 → 单会话一任务是结构保证（busy 不排队不打断），文案引导附带 sessionId/state
 * 流水报告；其余（连接崩溃/会话失败/协议漂移）→ engine_run_failed + 恢复指引
 * （漂移不再降级 spawn——直接报错）。sessionId 已建立时随文案透出。
 *
 * retried（[P0-1 U4] §5.2 F-4「已重试 1 次」）：仅在瞬时重试真实发生后为 true——
 * 兜底行恢复指引补「已自动重试一次仍失败」句（未重试形态不含，与行为一致）；专属
 * 归类行（credential/busy）有独立恢复指引，不掺重试事实（错误规格表行的归类语义优先）。
 */
function buildAppServerRunFailedMessage(err: unknown, sessionId?: string, retried = false): string {
  if (
    isAppServerRpcError(err) &&
    err.code === ZCODE_APPSERVER_ERR_MODEL_CONFIG_MISSING &&
    /Model config is missing/.test(err.message)
  ) {
    return (
      `engine_credential_missing: app-server 报 "Model config is missing"（宿主 HOME 的 zcode 配置无可用模型）。` +
      `恢复指引：在 ZCode 桌面端登录并配置 provider 凭据后重跑本任务（常驻连接在引擎进程重启后生效新凭据）。`
    );
  }
  if (isAppServerRpcError(err) && err.code === ZCODE_APPSERVER_ERR_BUSY_SESSION) {
    const sid = sessionId !== undefined ? `（会话 id: ${sessionId}）` : "";
    return (
      `engine_run_failed: app-server 报 -32010${sid}（send 时该会话已有轮在跑，busy 不排队不打断）。` +
      `单会话一任务是结构保证，出现即 bug；请附带 sessionId 与 state 流水（连接/会话事件日志）上报问题。`
    );
  }
  const code = isAppServerRpcError(err) && err.code !== undefined ? `（code ${err.code}）` : "";
  const sid = sessionId !== undefined ? `（会话 ${sessionId}）` : "";
  const retryNote = retried
    ? `恢复指引：直接重跑本任务（瞬时故障已自动重试一次仍失败；重试用的是崩溃后自动重建的新会话）。`
    : `恢复指引：直接重跑本任务（连接崩溃后自动重建进程）；`;
  return (
    `engine_run_failed: app-server 会话执行失败${code}${sid}: ${errMessage(err).slice(-ZCODE_ERROR_TAIL_CHARS)}。` +
    `${retryNote}若持续失败（疑似 zcode 升级后协议漂移——` +
    `-32601/-32602 类错误），重启 ZCode 或固定 zcode 版本后重试，或改用 engine: pi。`
  );
}

/** 跨重试轮累计 token 用量（重试的 LLM 调用真实发生）。 */
function accumulateUsage(acc: { input: number; output: number; cacheRead: number; cacheWrite: number; has: boolean }, r: AttemptResult): void {
  if (r.kind !== "parsed") return;
  const u = r.payload.usage;
  if (u === undefined) return;
  acc.has = true;
  acc.input += u.input;
  acc.output += u.output;
  acc.cacheRead += u.cacheRead;
  acc.cacheWrite += u.cacheWrite;
}

/** 强化重试 prompt：首战校验失败后追加更明确的 JSON 输出指令（structured-output 重试语义）。 */
function appendSchemaRetryDirective(basePrompt: string, validationError: string): string {
  return (
    basePrompt +
    "\n\n## Retry: Structured Output Failed\n" +
    `Your previous answer failed schema validation: ${validationError}\n` +
    "Answer again. Output ONLY the JSON value conforming to the schema above — " +
    "no prose, no markdown fences, no extra text."
  );
}

/** create 参数组装（A.2 ① strict 键集：空白 thoughtLevel / 空 deny 清单不设键）。
 *  [R4/G3] modelRef 条件携带：显式（trim 非空，上游已裁决 canonical）拆分为
 *  per-session model；缺席不设键——zcode 走自身缺省解析（用户 defaultModelSelection
 *  优先），与 strict 键集纪律一致（缺席语义用「键不存在」表达，禁空串哨兵）。
 *  [2026-09-29 account 迁移同步] 显式模型附 model.options.reasoningLevel（目录
 *  modelRules 值域的最小档）：注册表模型普遍要求该选项（缺席 create 即拒收
 *  「Reasoning level is required」），缺省解析路径 CLI 自动补、显式路径须调用方供数。 */
function buildAppServerCreateParams(
  task: AgentCallOpts,
  modelRef: string | undefined,
  cwd: string,
  reasoningLevel?: string,
): SessionCreateParams {
  const denyTools = (task.denyTools ?? []).filter((t) => typeof t === "string" && t.trim() !== "");
  // thinkingLevel → thoughtLevel（A.2 ① 键集内）：空白串归一为不设键——strict 对象下
  // 空值键位无语义且防 -32602 变形拒收（与 denyTools 空清单不设键同款纪律）
  const thoughtLevel = task.thinkingLevel?.trim();
  const model =
    modelRef !== undefined && modelRef !== ""
      ? {
        ...splitZcodeModelRef(modelRef),
        ...(reasoningLevel !== undefined && reasoningLevel !== ""
          ? { options: { reasoningLevel } }
          : {}),
      }
      : undefined;
  return {
    workspacePath: cwd,
    mode: "yolo",
    // per-session model（G3）：显式指定时 create 参数透传（A.2 ① strict 对象）——同进程任务
    // 各用各的模型，互不干扰；缺席不设键（zcode 自身缺省解析）
    ...(model !== undefined ? { model } : {}),
    ...(thoughtLevel !== undefined && thoughtLevel !== "" ? { thoughtLevel } : {}),
    ...(denyTools.length > 0 ? { toolDenylist: denyTools } : {}),
  };
}

/**
 * 权威终态 status 提取（P0-1 U3/D5② + ⛔P-Z2 降级路径约束「只消费
 * source="turn.terminal" 的 status」）：turn.terminal 到达（先到/迟到）时 u-z1 的
 * lastTerminalStatus 必有记录（channel 无条件先记再 settle/不改写落定）；缺席说明
 * 终态仅由 final-frame 宽松判定落定（恒 settle success，不可信）——无权威 status
 * 可消费，不据此判失败。
 */
function authoritativeTerminalStatus(r: SessionTurnResult): string | undefined {
  if (r.lastTerminalStatus !== undefined) return r.lastTerminalStatus;
  return r.terminal.source === "turn.terminal" ? r.terminal.status : undefined;
}

/**
 * [P0-1 U3/D5②] appserver 轮成功收口的 parsed 三态（read 兜底后的 response + schema
 * 校验）。失败终态（isFailedTerminalStatus，"interrupted" 不在其中——不误判失败）
 * 先分流（§3.2 缺陷 B 不再假成功；schema 校验对失败形态无意义——失败终态的
 * response 是错误尾部，非结构化输出候选）。
 */
function parsedAppServerAttempt(task: AgentCallOpts, r: SessionTurnResult): AttemptResult {
  if (isFailedTerminalStatus(authoritativeTerminalStatus(r))) {
    return failedTerminalAppServerAttempt(r);
  }
  const schema = isPlainObject(task.schema) ? task.schema : undefined;
  return {
    kind: "parsed",
    output: syntheticAppServerOutput(0),
    payload: turnResultToPayload(r),
    ...(schema !== undefined
      ? { schemaResult: extractAndValidateStructuredOutput(r.response, schema) }
      : {}),
  };
}

/**
 * [P0-1 U3/D5② + ⛔P-Z2 门修正] failed 终态的 run-failed 合成（§5.2 F-3 文案）：
 * exitCode=null 异常终态、sessionId 留痕同 failedAppServerAttempt。错误详情优先级：
 * terminal 帧 errorCode/errorMessage（⛔P-Z2 实证——真实 failed 终态的错误详情只在
 * terminal 帧，read/delta 携带不了）> read 兜底/delta 聚合尾部（F-3 原文案，降级为
 * 兜底）> 「无返回内容」（P-Z2 降级形态：final-frame 先到且 read 无错误信息——不
 * 伪造错误详情，覆盖面收窄但不假成功）。
 */
function failedTerminalAppServerAttempt(r: SessionTurnResult): AttemptResult {
  const status = authoritativeTerminalStatus(r);
  const detail = r.lastTerminalError;
  const detailParts: string[] = [];
  if (detail?.code !== undefined) detailParts.push(`errorCode: ${detail.code}`);
  if (detail?.message !== undefined) detailParts.push(detail.message);
  // 错误详情优先级（⛔P-Z2）：terminal 帧详情 > read 兜底/delta 聚合尾部 > 无返回内容
  let body: string;
  if (detailParts.length > 0) {
    body = `服务端错误：${detailParts.join("：")}。`;
  } else {
    const tail = r.response.trim();
    body =
      tail !== ""
        ? `服务端返回尾部：${tail.slice(-ZCODE_ERROR_TAIL_CHARS)}。`
        : "服务端无返回内容（read 兜底/delta 聚合均为空）。";
  }
  return {
    kind: "run-failed",
    output: syntheticAppServerOutput(null),
    message:
      `engine_run_failed: app-server 终态 status=${status}（会话 ${r.sessionId}）。${body}\n` +
      `👉 恢复指引：错误内容来自模型/服务端；直接重跑，若持续出现核对 ZCode 桌面端凭据与模型配置（engine_credential_missing 同族排查）。`,
    sessionId: r.sessionId,
  };
}

/** appserver 轮失败收口的 run-failed 三态（结构化文案 + 会话 id 留痕）。 */
function failedAppServerAttempt(
  err: unknown,
  currentSessionId: string | undefined,
  opts: { retried?: boolean; transient?: "conn-closed" } = {},
): AttemptResult {
  return {
    kind: "run-failed",
    output: syntheticAppServerOutput(null),
    message: buildAppServerRunFailedMessage(err, currentSessionId, opts.retried === true),
    // [P0-1 U4/D6] 瞬时失败形态标记（重试判定判据，conn-closed 连接崩溃形态）
    ...(opts.transient !== undefined ? { transient: opts.transient } : {}),
    // 错误规格表 -32004 行「按任务失败上报（含会话 id）」：create 成功后运行中失败
    // （-32004/-32010 等）时留痕会话 id——经 applyRunFailedOutcome 落 outcome.sessionId
    // 与 handle.sessionRef（create 阶段失败无会话，缺省不带）
    ...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
  };
}

/** 宿主超时 abort 判别（对齐点④）：signal.reason 带超时标记 = 超时杀链合成终态路径。 */
function isHostTimeoutAbort(ctx: RunContext): boolean {
  return ctx.signal?.aborted === true && ctx.signal.reason === HOST_TIMEOUT_ABORT_REASON;
}

/**
 * 默认版本探测：`node <cli> --version`（首行 trim；超时按探针失败处理）。
 * [W5 迁移] execFile 改经 SDK spawnEngineChild（引擎包内全部子进程 spawn 单一入口；
 * 超时用 AbortSignal → SIGTERM，与原 execFile timeout 语义等价——探测是短命进程，
 * SIGTERM 即收敛）。stdout 有界收集（版本行 + 余量），防刷屏 OOM。
 */
/** probe 版本探测的 stdout 收集上限（防刷屏 OOM）。 */
const PROBE_STDOUT_CAP_CHARS = 4096;

async function defaultProbeVersion(cliPath: string, dataDir: string): Promise<string | undefined> {
  try {
    return await new Promise<string | undefined>((resolve, reject) => {
      const child = spawnEngineChild({
        command: "node",
        args: [cliPath, "--version"],
        env: buildEngineChildEnv(process.env, { dataDir }),
        stdout: "pipe",
        stderr: "ignore",
        signal: AbortSignal.timeout(PROBE_VERSION_TIMEOUT_MS),
      });
      let out = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (out.length < PROBE_STDOUT_CAP_CHARS) out += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) reject(new Error(`zcode --version exited with code ${code}`));
        else resolve(out.trim().split("\n")[0]?.trim() || undefined);
      });
    });
  } catch (err) {
    logger.debug(
      `[zcode-engine] probe version check failed (best-effort continue): ${
        toErrorMessage(err)
      }`,
    );
    return undefined;
  }
}
