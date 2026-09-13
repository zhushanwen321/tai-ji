// src/execution/engine/engines/zcode/zcode-engine.ts
//
// ZcodeEngine：zcode 的 EnginePort 实现（2026-09 起单一 app-server 形态）。
// 设计权威源：docs/architecture/subagent-engine-abstraction.md D10 / §3.3.4 /
// §3.3.5；docs/design/zcode-engine-appserver-resident.md §3.3 D1（每引擎实例一条
// 连接）/ D3（abort 链）/ D4（会话自包含）/ D5（capabilities）/ D6（停机面）。
//
// 2026-09 breaking 重构（用户拍板，理由与代价见设计文档修订节）：
//   - **删除 CLI spawn 降级链**（原 XYZ_ZCODE_MODE=spawn 定向 / probe 冒烟门控 /
//     protocol-drift 首败降级）：zcode 无公开契约，协议漂移不再降级保底，直接报
//     可操作错误（提示核对版本 / 重启 / 改用 engine: pi）。
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
//   - journal 分组 key 固定 'shared'（与 pi 引擎 PI_POOL_KEY 同构）：journal 落
//     engineDataDir/engines/zcode/shared/journal-<taskId>.jsonl。
//
// run 错误语义（设计 §3.3.5）：
//   ① prepare 期错误（credential_missing / model_not_available）在进程创建前
//      reject，不产生 handle；
//   ② 运行中失败不 reject——合成 engine_run_failed outcome + 正常 handle 返回
//      （record 必须收尾）；
//   ③ abort：D3 链（session/stop → grace → killChain 连坐共享进程）——终态
//      exitCode=null + 杀链标记。
//   [D3-④] capability 拒绝（fork/conversation/maxTurns/worktree）不再在本引擎：
//      上提到宿主调用前预检（common/capability-gate，两调用点 = chat 域
//      executeViaEngine 同步段 + SAR run 前）——拒绝语义不变
//      （engine_capability_unsupported + 无进程创建）。
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
  ZCODE_APPSERVER_ABORT_GRACE_MS,
  ZCODE_APPSERVER_ERR_BUSY_SESSION,
  ZCODE_APPSERVER_ERR_MODEL_CONFIG_MISSING,
  ZCODE_APPSERVER_HARVEST_GRACE_MS,
  ZCODE_APPSERVER_STOP_TIMEOUT_MS,
  ZCODE_CLI_DEFAULT_PATH,
  ZCODE_ENGINE_ID,
  ZCODE_ERROR_TAIL_CHARS,
  ZCODE_KILL_GRACE_MS,
  ZCODE_RESUME_CHARS_PER_TOKEN,
  ZCODE_RESUME_HISTORY_TOKEN_BUDGET,
  ZCODE_SESSION_SWEEP_DEFER_MS,
  ZCODE_SHARED_POOL_KEY,
  ZCODE_TURN_MAX_TIMEOUT_ENV,
  isFailedTerminalStatus,
  parseZcodeTurnTimeoutEnv,
} from "./constants.ts";
import { zcodeDbPathAllowlist, zcodeSessionDbPath } from "./db-path.ts";

import {
  mapZcodeOutcomeUsage,
  mapZcodeUsage,
  synthesizeCoarseEvents,
  type ZcodeTerminalPayload,
} from "./parser.ts";
import {
  defaultV2ConfigPath,
  listZcodeModels,
  resolveZcodeModelRef,
  splitZcodeModelRef,
  type ZcodeSourcePaths,
} from "./preparer.ts";
import { ensureAppServerLauncher } from "./appserver-launcher.ts";
import { readZcodeSessionView } from "./reader.ts";
import { AppServerConnection, buildAppServerEnv, isAppServerRpcError } from "./connection.ts";
import {
  SessionChannel,
  TurnTimeoutError,
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
      // 首期未接 worktree 隔离（公共层 worktree-manager 接入后升 emulated）
      sandbox: "none",
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
    // [D3-④] fork/conversation/maxTurns 的能力拒绝已上提到宿主调用前预检
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
   * poolKey 固定 'shared'（共享宿主 HOME，无池），onPoolResolved 在 prepare 期、
   * onHandleReady 在 create 应答后（§3.4 不变量 3）。
   */
  private async runViaAppServer(task: AgentCallOpts, ctx: RunContext): Promise<EngineRunResult> {
    const startedAt = Date.now();
    // pre-aborted 短路：取消先于启动——不创建会话、不触发连接惰性启动（防误杀共享
    // 进程殃及在途任务）
    if (ctx.signal?.aborted === true) {
      return this.abortedAppServerRun(task, ctx, startedAt);
    }

    // ① prepare 期：模型解析（provider 体系校验——错误语义为进程创建前 reject）
    const modelRef = resolveZcodeModelRef(task.model, this.deps.sources);
    this.warnIgnoredCtxModel(task, ctx, modelRef);
    // [RX2-F1] 非常见档位出声一行（不拦截透传）；放主编排而非 attemptAppServerTurn——
    // schema 重试轮会二次进 attempt，warn 只应随任务出声一次
    this.warnThoughtLevelUncommon(task, ctx);
    // 对齐点③（不变量 3）：poolKey 在 prepare 期声明，早于连接建立与首个事件
    ctx.onPoolResolved?.(ZCODE_SHARED_POOL_KEY);

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
    // 对齐点③（不变量 3）：onPoolResolved 必须先于首个事件 emit——本分支
    // finalizeOutcome 经 applyAbortedOutcome emit error 事件
    ctx.onPoolResolved?.(ZCODE_SHARED_POOL_KEY);
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
    modelRef: string,
    cwd: string,
    basePrompt: string,
    schema: JsonSchemaObject | undefined,
    usageAcc: { input: number; output: number; cacheRead: number; cacheWrite: number; has: boolean },
  ): Promise<AttemptResult> {
    const attemptStartedAt = Date.now();
    let final = await this.attemptAppServerTurn(task, ctx, modelRef, cwd, basePrompt);
    accumulateUsage(usageAcc, final);
    // [P0-1 U4/D6] 瞬时失败自动重试一次：判据 = run-failed 且 transient 形态标记
    // （类型化，不经字符串反推；RPC 错误/status=error 终态等有应答的精确归类形态
    // 构造处即无 transient——含协议漂移类，漂移不再降级 spawn、直接报错）+ 非用户
    // 已取消 + 非引擎停机（dispose 收割引发的崩溃不重试——停机后惰性重建 = 复活
    // 进程，违背 dispose 防泄漏语义）。
    // 预算继承（P-Z4）：显式总上界预算下重试轮上界 = 剩余（总 − 已耗尽），剩余不足
    // 最小下限不重试直接终态化；重试轮启动即 journal 出声（D6：重试事实记入 journal）。
    if (
      final.kind === "run-failed" &&
      final.transient !== undefined &&
      ctx.signal?.aborted !== true &&
      !this.disposed
    ) {
      const budget = resolveTransientRetryBudget(explicitTurnBudgetMs(), Date.now() - attemptStartedAt);
      if (budget.state === "depleted") {
        logger.warn(
          `[zcode-engine] 末次 attempt 瞬时失败（${final.transient}）——显式总上界预算剩余不足 ${ZCODE_TURN_RETRY_MIN_BUDGET_MS}ms，不重试直接终态化（预算继承：重试不重置总预算）`,
        );
      } else {
        logger.warn(
          `[zcode-engine] 末次 attempt 瞬时失败（${final.transient}）——止损链已终局，新会话自动重试一次` +
            (budget.state === "inherit"
              ? `（预算继承：重试轮总上界=剩余 ${budget.remainingMs}ms，不重置总预算）`
              : "（无显式总上界预算，重试轮走 env/默认上界）"),
        );
        const retry = await this.attemptAppServerTurn(task, ctx, modelRef, cwd, basePrompt, {
          // 预算继承传递点（D2 内部传参面）：显式预算 → 剩余值；无显式预算 → 缺省
          // （channel 侧走同一 env/默认，与首轮行为一致）
          ...(budget.state === "inherit" ? { turnTimeoutMs: budget.remainingMs } : {}),
          // 重试事实进文案：「已自动重试一次」句仅对真实发生的重试生效（未重试形态
          // 不含——与行为一致，§5.2 F-1/F-4）
          retried: true,
        });
        accumulateUsage(usageAcc, retry);
        final = retry;
      }
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
        poolKey: ZCODE_SHARED_POOL_KEY,
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
   * @param opts turnTimeoutMs：显式总上界传参面（D2 内部传参点）——U4/D6 预算继承
   *   向重试轮传剩余值；缺省不传（channel 走 env→默认，首轮行为）。
   *   retried：瞬时重试轮标记——失败文案补「已自动重试一次」句（F-1/F-4）。
   */
  private async attemptAppServerTurn(
    task: AgentCallOpts,
    ctx: RunContext,
    modelRef: string,
    cwd: string,
    prompt: string,
    opts: { turnTimeoutMs?: number; retried?: boolean } = {},
  ): Promise<AttemptResult> {
    const rt = this.ensureAppServerRuntime();
    const { providerId, modelId } = splitZcodeModelRef(modelRef);
    const createParams = buildAppServerCreateParams(task, providerId, modelId, cwd);

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
      // 守护对任何事件类型刷新；reducer no-op、不落 journal）。zcode 引擎
      // conversation:"unsupported"，run 域是唯一发射面（无 chat 域接线）。
      onActivity: () => ctx.onEvent?.({ type: "activity" }),
      onSessionCreated: (sessionId) => {
        currentSessionId = sessionId;
        rt.activeSessions.add(sessionId);
        signalSessionCreated?.();
        // §3.4 不变量 3：create 应答后立即回填（早于 subscribe/send/终态/run resolve）；
        // dbPath 与终态 handle 同源 zcodeSessionDbPath(engineDataDir)（设计 D1）
        ctx.onHandleReady?.({
          sessionRef: { dbPath: zcodeSessionDbPath(this.deps.engineDataDir()), sessionId },
          poolKey: ZCODE_SHARED_POOL_KEY,
        });
      },
      // 显式总上界传参（D2/U4：缺省缺席——channel 侧 resolveTurnTimerMs 走 env→默认）
      ...(opts.turnTimeoutMs !== undefined ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
    });

    // D3 abort 链：signal abort → ① session/stop {sessionId} ② grace 窗口确认终态
    // ③ stop 失败/超时 → killChain 杀共享进程（接受连坐——协议已不可信）→ 在途
    // 其他任务走崩溃路径。capabilities.interrupt 维持 kill-only 不升级（C4）。
    // [P0-1 U2] 用户取消入口 = escalateOn:"turn-settled"（grace 窗口确认 turn 落定，
    // 现状语义零改动）；channel 超时判死（TurnTimeoutError）走 catch 分流的
    // escalateOn:"stop-outcome" 入口（stop 应答三态裁决）。
    const onAbort = (): void => {
      void this.appServerAbortChain(rt, turn, () => currentSessionId, sessionCreated, { escalateOn: "turn-settled" });
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
      if (ctx.signal?.aborted === true) return abortedAppServerAttempt(ctx);
      // [P0-1 U2] 超时入口（D3 v1.1）：turn 已被 channel 判死 reject——升级判据不能
      // 再挂在 turn 落定上（race 恒真，killChain 结构性不可达的 v1 击穿点），改以
      // stop 应答三态裁决。await 链终局（非 fire-and-forget）：outcome 止损文案与
      // 重试时序（D6，u-z4）都依赖链终局信号——止损完成前不合成终态。
      if (err instanceof TurnTimeoutError) {
        const stopPath = await this.appServerAbortChain(
          rt,
          turn,
          () => currentSessionId,
          sessionCreated,
          { escalateOn: "stop-outcome" },
        );
        // [P0-1 U4] timeout 类（idle/ceiling 都算）是 D6 明文的可重试形态——结构化
        // 标记（TurnTimeoutError 类型化判据，不经字符串匹配，D4 同精神）
        return timeoutAppServerAttempt(err, currentSessionId, stopPath, { retried: opts.retried });
      }
      // [P0-1 U4] 连接崩溃收割形态（failAllTurns 的错误，D6 第二可重试形态）判据：
      // 非 RPC error（服务端无明确应答——有应答即精确错误归类，非瞬时崩溃面）且
      // conn 不存活。时序可靠性：catch 时刻紧随 onClose 收割，连接重建仅由
      // conn.request 惰性触发——本链路中 runTurn finally 的 closeSession 对死连接
      // 短路（channel 侧 !alive 守卫）、stop 只属 abort/超时入口（前者已被
      // signal.aborted 短路、后者走上一分支）——此刻无 request 可重建，判据可靠。
      if (!isAppServerRpcError(err) && !rt.conn.alive) {
        return failedAppServerAttempt(err, currentSessionId, { retried: opts.retried, transient: "conn-closed" });
      }
      return failedAppServerAttempt(err, currentSessionId, { retried: opts.retried });
    } finally {
      if (currentSessionId !== undefined) rt.activeSessions.delete(currentSessionId);
      if (ctx.signal !== undefined) ctx.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * killChain 后等待连接 finalize 实际完成（child 置空 + onClose 广播）再宣告链终局：
   * shutdown resolve 于 `exit` 事件，而 finalize 挂 `close`（stdio 排空）——两者之间的
   * 事件窗口内 conn.child 仍非 null，紧接的下一任务 request 会复用垂死进程（写入成功
   * 但必败，走崩溃路径）而非触发重建。与 shutdownRuntimeAndDisposeChannel 的
   * HARVEST_GRACE 同款 race 形态（close 永不到达不挂死）。超时入口的 await 链终局
   * 语义（D6 重试时序依据）因此是「进程收割确认完成」而非「SIGTERM 已发出」。
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
   * D3 abort 链执行体（双入口分岔，P0-1 U2 参数化——设计
   * timeout-zcode-turn-and-settled-watchdog.md §6 D3 v1.1）：
   * - **用户取消入口**（`escalateOn: "turn-settled"`，现状语义零改动；fire-and-forget——
   *   与 turn promise 并行推进）：stop 帧（超时 ZCODE_APPSERVER_STOP_TIMEOUT_MS）→
   *   grace 窗口内 turn 落定即止（不杀共享进程）→ 超窗 killChain（conn.shutdown 全序：
   *   SIGTERM→grace→SIGKILL）。turn 的最终落定由 attempt 主路径 await 收口，本链不
   *   直接产出终态。abort 与 create 竞态（signal 先到、session 未建立）：等会话建立
   *   （带上限）再发 stop——否则 stop 永远发不出，直接连坐杀共享进程。
   * - **超时入口**（`escalateOn: "stop-outcome"`，channel 判死后由 catch await 链终局）：
   *   turn 已 reject，对它 race 恒真不可用（v1 击穿点）——升级判据改挂在 **stop 应答
   *   三态**：①成功应答 → 服务端接受停 turn，止损确认，链终止；②协议性 error 应答
   *   （有 error 帧即控制面活的证据，多因 runTurn finally 的 closeSession 先行关会话，
   *   健康形态竞态）→ 链终止**不升级**（止损由 close 回收 + 服务端自治承担；把
   *   「stop 报错」一律升级会误杀健康共享进程并连坐并发任务）；③超时/写入失败/进程
   *   死等连接级失败（控制面死）→ killChain 升级。判据实现依据：error 应答帧 reject
   *   携带 number code（isAppServerRpcError）；连接级失败是无 code 的新 Error
   *   （connection.request 三态 reject 形态）。返回值即止损路径（超时入口的 outcome
   *   文案素材——D3 强制可观测面）。
   */
  private async appServerAbortChain(
    rt: AppServerRuntime,
    turn: Promise<SessionTurnResult>,
    getSessionId: () => string | undefined,
    sessionCreated: Promise<void>,
    entry: { escalateOn: "turn-settled" | "stop-outcome" },
  ): Promise<AbortChainStopPath> {
    const graceRaceThenKill = async (): Promise<AbortChainStopPath> => {
      const settled = await Promise.race([
        turn.then(
          () => true,
          () => true,
        ),
        delayResolved(ZCODE_APPSERVER_ABORT_GRACE_MS, false),
      ]);
      if (settled) return "settled-in-grace"; // stop 生效：终态在 grace 窗口内到达，共享进程不杀
      logger.warn(
        `[zcode-engine] abort grace 窗口内未见终态——killChain 收割共享进程（接受连坐，在途任务走崩溃路径）`,
      );
      await rt.conn.shutdown({ graceMs: ZCODE_KILL_GRACE_MS });
      await this.awaitConnFinalized(rt);
      return "escalated-kill";
    };

    let sessionId = getSessionId();
    if (sessionId === undefined) {
      await Promise.race([sessionCreated, delayResolved(ZCODE_APPSERVER_STOP_TIMEOUT_MS, undefined)]);
      sessionId = getSessionId();
      if (sessionId === undefined) {
        // 会话始终未建立：超时入口实际不可达（TurnTimeoutError 只能发生在 openTurn
        // 挂 timer 后，彼时 create 已成功），防御分支——无会话即无在途任务可止损；
        // 用户取消入口保持既有语义：跳过 stop，grace race 兜底（create 竞态挂死形态）
        if (entry.escalateOn === "stop-outcome") return "no-session";
        return graceRaceThenKill();
      }
    }
    // [u-z2 修复轮] alive 守卫（与 closeSession 的 `!conn.alive` return 同款防御，
    // 对称补齐）：进程在 turn 判死/abort 与本链发 stop 之间 finalize 完成的微窗口内，
    // request 首行 ensureStarted 会惰性 spawn 新一代进程再写 stop 帧——凭空拉起无人
    // 使用的进程，且 stop-outcome 入口会拿到新进程的「成功应答」误报止损确认。
    // 不 alive = 连接级失败形态（进程已死即已收割）：超时入口直接落杀链终局（等同
    // 三态的连接级失败分支）；用户取消入口跳过 stop 落回 grace race（turn 已被
    // failAllTurns 收割则立即 settled，语义零变化）。
    if (!rt.conn.alive) {
      if (entry.escalateOn === "stop-outcome") return "stop-unreachable-killed";
      return graceRaceThenKill();
    }
    try {
      await rt.conn.request("session/stop", { sessionId }, { timeoutMs: ZCODE_APPSERVER_STOP_TIMEOUT_MS });
    } catch (err) {
      if (entry.escalateOn === "stop-outcome") {
        if (isAppServerRpcError(err)) {
          // ② 协议性 error：控制面活、会话已被回收（健康形态竞态）——不升级
          logger.debug(
            `[zcode-engine] session/stop 报协议性 error（${errMessage(err)}）——会话已回收，控制面存活，不升级杀链`,
          );
          return "stop-rejected";
        }
        // ③ 连接级失败（请求超时/写入失败/进程死）：控制面死，只有杀进程能止损
        logger.warn(
          `[zcode-engine] session/stop 无应答（${errMessage(err)}）——升级 killChain 收割共享进程（超时入口，接受连坐）`,
        );
        await rt.conn.shutdown({ graceMs: ZCODE_KILL_GRACE_MS });
        await this.awaitConnFinalized(rt);
        return "stop-unreachable-killed";
      }
      logger.debug(
        `[zcode-engine] session/stop 失败（${errMessage(err)}）——grace 后走 killChain 兜底`,
      );
    }
    if (entry.escalateOn === "stop-outcome") return "stop-acked"; // ① 成功应答：止损确认，链终止
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
   * turn 会错过收割、挂到 turnTimeoutMs（300s）。退订前等 onClose 触发（本方法先于
   * shutdown 订阅；channel 的订阅在构造期更早——其 failAllTurns 先于本 promise
   * resolve 执行）；ZCODE_APPSERVER_HARVEST_GRACE_MS 兜底防 `close` 永不到达时挂死。
   * [P0-1 U5/D7] grace race 输掉（close 迟到/永不到达——stdio 被孙进程持有排空不
   * 尽等病态形态）时，channel.dispose() 内置的 dispose 收割（failAllTurns 先于退订，
   * SessionChannel.dispose）兜底在途 turn——退化终点从「挂满 turn 自身 idle/总上界
   * 预算」收敛为「grace 窗口内明确失败」（设计 §3.4 退化路径闭合）；race 窗口与
   * awaitConnFinalized 同源同量级（ZCODE_APPSERVER_HARVEST_GRACE_MS）。正常 close
   * 先到时 onClose 收割先行，dispose 收割幂等 no-op（零回归）。
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
    //竞态的修复体，见 shutdownRuntimeAndDisposeChannel——先退订会让在途 turn 挂到
    //turnTimeoutMs）
    await this.shutdownRuntimeAndDisposeChannel(rt);
  }

  /**
   * [u7a D5] 引擎在途只读快照：activeSessions 非空才算在途——poolKey 'shared' 的
   * app-server **空闲常驻进程恒活，禁止按进程存在判定**（进程在 ≠ 在途，否则推迟
   * 判定恒真、30min 上限从兜底变常态路径，设计 §3.3 D5 显式排除）。计数权威 =
   * activeSessions（attempt 入 create 应答后 add / finally settle 后 delete，与
   * dispose 的 close 帧目标集同一状态源，无双记账）。运行时未初始化（从未 run /
   * 已 dispose）→ 恒 0。
   */
  inFlightSnapshot(): { inFlight: number } {
    return { inFlight: this.appserverRuntime?.activeSessions.size ?? 0 };
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
      // D9① fallback 留痕：路由层经 RunContext 投影（zcode 无 record 通路，outcome 是
      // 唯一留痕面；pi 引擎另有 record 投影）
      ...(ctx.engineFallback !== undefined ? { engineFallback: ctx.engineFallback } : {}),
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

  /** [U7] 模型可发现性：v2 桌面登录态聚合（带凭据 provider × models），失败安全返回清单本身可能为空。 */
  listModels(): Array<{ id: string; name?: string }> {
    return listZcodeModels(this.deps.sources);
  }

  /**
   * [u-h2 D2-2] 派发同步期 model 校验：委托 resolveZcodeModelRef（与 run prepare 期
   * 同一函数——canonicalRef 归一化、短名缺省 provider、凭据与清单校验单一权威，无双实现）。
   * modelRef undefined = 返回引擎缺省模型 canonical 全名（ZCODE_FALLBACK_DEFAULT_MODEL，
   * D2-1 ctxModel 不透传的承接面）。校验失败原样抛 ZcodePrepareError，由编排层
   * （engine/model-validation.ts）包装成「引擎与模型不配套」文案。
   */
  validateModel(modelRef: string | undefined): { canonicalRef: string } {
    return { canonicalRef: resolveZcodeModelRef(modelRef, this.deps.sources) };
  }

  /**
   * D6 read 三级降级：①sqlite 原生读取 → ②宿主 event journal 重放（对齐点①接线：
   * replayJournalToSessionView 复用 live reducer，重放等价性见 §3.3.6）→ ③outcome-only。
   * sessionId 缺失（解析失败的 run 无法定位 session）跳过①级；②级依赖
   * handle.journalPath（宿主 run 后回填）。dbPath：新 handle 恒为隔离库绝对路径
   * （zcodeSessionDbPath(engineDataDir)，tier1 白名单集合见方法体——宿主路径仅
   * 「共享 HOME 时代」存量兼容）；旧 records（池时代）的相对路径仍按 poolKey
   * 锚定解析（read 兼容旧数据，池目录不存在时自然落②级 journal 降级）。
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
        dbPath = path.join(
          resolvePoolDir(this.deps.engineDataDir(), ZCODE_ENGINE_ID, handle.data.poolKey),
          dbPathRaw,
        );
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
    // ②级：journal 重放（journalPath 缺省 / 文件不存在 / 无事件 → undefined 落③级）
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
   * 依赖 pi resolveModel 链的引擎才消费它），zcode 自带 provider 体系与缺省模型
   * （resolveZcodeModelRef：requested > ZCODE_FALLBACK_DEFAULT_MODEL），不消费
   * ctxModel。「调用方给了 ctxModel 但 task.model 未显式指定」时出声一行，说明
   * 实际落引擎缺省模型（含实际 model id）——防静默降档无据可查。只在「ctx 有模型
   * 但被忽略」场景输出：显式 task.model 走正常解析链、ctx 本就无模型属预期缺省，
   * 均不出声（避免噪音）。
   */
  private warnIgnoredCtxModel(task: AgentCallOpts, ctx: RunContext, modelRef: string): void {
    if (ctx.ctxModel === undefined) return;
    const requested = task.model?.trim();
    if (requested !== undefined && requested !== "") return;
    logger.warn(
      `[zcode-engine] ctx.ctxModel（${ctx.ctxModel.id}）被忽略——ctxModel 是 pi 链路兜底，zcode 不消费；` +
        `task.model 未显式指定，实际使用引擎缺省模型 ${modelRef}`,
      { taskId: ctx.taskId },
    );
  }

  /**
   * [U6 / §3.2.6 要点 3] resume 锚 → 历史前缀（interact-resume 的读半段）。
   *
   * 无锚 / 非 zcode 锚形态 → undefined（行为不变）。读通道失败（条目被 TTL 清 /
   * 会话失效 / 控制面错误）= 宿主侧锚判据通过后、引擎派发前的窄竞态窗——降级为
   * **无历史前缀的新会话**（warn 留痕；宿主 reopen 摘要承担主降级面），不炸轮：
   * 续聊消息本身仍可送达（模型缺历史上下文，比整轮失败可用性高，与 reopen 降级
   * 的「带摘要重开」语义同族）。
   */
  private async buildResumeHistoryPrefix(ctx: RunContext): Promise<string | undefined> {
    const anchor = zcodeResumeAnchorOf(ctx);
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
        `[zcode-engine] session/resume 读历史失败（锚 ${anchor.sessionId}）——降级为无历史前缀的新会话: ${errMessage(err)}`,
        { taskId: ctx.taskId },
      );
      return undefined;
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
 */
function zcodeResumeAnchorOf(ctx: RunContext): { sessionId: string; dbPath: string } | undefined {
  const ref = ctx.resume?.resume?.sessionRef;
  if (ref === undefined) return undefined;
  const sessionId = ref["sessionId"];
  const dbPath = ref["dbPath"];
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  if (typeof dbPath !== "string" || dbPath === "") return undefined;
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
       * 反推）：timeout = channel 判死（TurnTimeoutError，idle/ceiling 都算——D6
       * 明文两类均可重试）；conn-closed = 连接崩溃收割（failAllTurns 形态，判据 =
       * 非 RPC error 且 conn 不存活——catch 时刻重建仅由 conn.request 惰性触发，
       * 此前无 request，判据可靠）。缺席 = 非瞬时形态（RPC 错误/status=error 终态/
       * send 未送达等），不参与重试（D6 被否③：status='error' 终态 v1 不重试）。
       */
      transient?: "timeout" | "conn-closed";
    }
  | {
      kind: "parsed";
      output: AttemptOutput;
      payload: ZcodeTerminalPayload;
      schemaResult?: { ok: true; parsed: unknown } | { ok: false; error: string; tail: string };
    };

/**
 * [P0-1 U4/D6] 瞬时失败自动重试的最小剩余预算下限（ms）：显式总上界预算下，剩余
 * 低于此值不再重试直接终态化（D6「剩余不足一个最小下限（如 5min）」——重跑一轮
 * 整任务的最小耗时估计，剩余更小的重试注定再被上界回收，白烧一轮 token）。
 * 单消费方（本文件重试编排），故为模块常量不进 constants.ts（跨文件共享才上移）。
 */
export const ZCODE_TURN_RETRY_MIN_BUDGET_MS = 300_000;

/** resolveTransientRetryBudget 的判定结果（可判别联合——inherit 分支剩余值必有）。 */
export type ZcodeTurnRetryBudget =
  | { state: "inherit"; remainingMs: number }
  | { state: "depleted" }
  | { state: "unbounded" };

/**
 * [P0-1 U4/D6 预算继承] 重试轮预算判定（纯函数，P-Z4 探针「显式预算下重试轮不
 * 重置总预算」的数学本体——剩余 = 总预算 − 已耗尽）：显式总上界预算存在时重试轮
 * 上界收窄为剩余（不重置），剩余不足最小下限则不重试；非显式（env 未设/非法/
 * ≤0 显式关闭）为 unbounded——无「总预算」可言，重试轮走 env/默认全新上界（与
 * 首轮同源，行为一致），不受预算门禁。
 */
export function resolveTransientRetryBudget(
  totalBudgetMs: number | undefined,
  consumedMs: number,
): ZcodeTurnRetryBudget {
  if (totalBudgetMs === undefined) return { state: "unbounded" };
  const remainingMs = totalBudgetMs - consumedMs;
  return remainingMs >= ZCODE_TURN_RETRY_MIN_BUDGET_MS
    ? { state: "inherit", remainingMs }
    : { state: "depleted" };
}

/**
 * 显式总上界预算读取（P-Z4 门禁的「显式」判定——D6「显式设置了 turnTimeoutMs
 * （env 或内部传参）」在引擎侧的唯一来源是 env；引擎内部传参点只用于向重试轮传
 * 剩余值）：env 设置为正数 → 显式预算；未设/非法（走默认）与 ≤0（显式关闭上界）
 * 均非显式预算（undefined → unbounded）。读 process.env 直连（与 session-channel
 * 的 resolveTurnTimerMs 同源同通道，vi.stubEnv 可测——D2 env 通道一致性）。
 */
function explicitTurnBudgetMs(): number | undefined {
  const parsed = parseZcodeTurnTimeoutEnv(process.env[ZCODE_TURN_MAX_TIMEOUT_ENV]);
  return parsed.state === "valid" && parsed.ms > 0 ? parsed.ms : undefined;
}

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
      `engine_run_failed: zcode 任务被中止（app-server abort 链：session/stop → ${ZCODE_APPSERVER_ABORT_GRACE_MS}ms grace 确认 → ` +
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

/** create 参数组装（A.2 ① strict 键集：空白 thoughtLevel / 空 deny 清单不设键）。 */
function buildAppServerCreateParams(
  task: AgentCallOpts,
  providerId: string,
  modelId: string,
  cwd: string,
): SessionCreateParams {
  const denyTools = (task.denyTools ?? []).filter((t) => typeof t === "string" && t.trim() !== "");
  // thinkingLevel → thoughtLevel（A.2 ① 键集内）：空白串归一为不设键——strict 对象下
  // 空值键位无语义且防 -32602 变形拒收（与 denyTools 空清单不设键同款纪律）
  const thoughtLevel = task.thinkingLevel?.trim();
  return {
    workspacePath: cwd,
    mode: "yolo",
    // per-session model（G3）：create 参数透传（A.2 ① strict 对象）——同进程任务
    // 各用各的模型，互不干扰
    model: { providerId, modelId },
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
 * 失败终态判据已收编 constants.ts（isFailedTerminalStatus）：session-channel 的
 * 迟到终态分级日志与引擎失败分流共用同一口径，模块私有会迫使对面复制判据双轨。
 */

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
  opts: { retried?: boolean; transient?: "timeout" | "conn-closed" } = {},
): AttemptResult {
  return {
    kind: "run-failed",
    output: syntheticAppServerOutput(null),
    message: buildAppServerRunFailedMessage(err, currentSessionId, opts.retried === true),
    // [P0-1 U4/D6] 瞬时失败形态标记（重试判定判据——timeout 形态走
    // timeoutAppServerAttempt，此处只承载 conn-closed）
    ...(opts.transient !== undefined ? { transient: opts.transient } : {}),
    // 错误规格表 -32004 行「按任务失败上报（含会话 id）」：create 成功后运行中失败
    // （-32004/-32010 等）时留痕会话 id——经 applyRunFailedOutcome 落 outcome.sessionId
    // 与 handle.sessionRef（create 阶段失败无会话，缺省不带）
    ...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
  };
}

/**
 * D3 abort 链的止损路径终局（P0-1 U2）：超时入口的 outcome 文案素材（D3 强制可观测
 * 面——r3 SG-4，A2/A11 验收断言「outcome 止损路径为 stop 已送达 / 升级杀链」的载体）；
 * settled-in-grace / escalated-kill 两值只由用户取消入口产生，超时入口不可达（保留
 * 联合完整供文案兜底）。
 */
type AbortChainStopPath =
  | "stop-acked"
  | "stop-rejected"
  | "stop-unreachable-killed"
  | "no-session"
  | "settled-in-grace"
  | "escalated-kill";

/**
 * [P0-1 U2] channel 判死（TurnTimeoutError）后的收口三态：engine_timeout 前缀
 * （D4——与 engine_run_failed 分流，下游按前缀分流不经字符串反推超时语义），走
 * run-failed kind 承载（exitCode=null 异常终态口径与杀链超时合成终态一致）。sessionId
 * 留痕同 failedAppServerAttempt。
 * [P0-1 U4/D6] timeout 类（idle/ceiling 都算）恒标 transient——D6 明文的可重试形态；
 * retried 时文案补「已自动重试一次」句（F-1）。
 */
function timeoutAppServerAttempt(
  err: TurnTimeoutError,
  currentSessionId: string | undefined,
  stopPath: AbortChainStopPath,
  opts: { retried?: boolean } = {},
): AttemptResult {
  return {
    kind: "run-failed",
    output: syntheticAppServerOutput(null),
    message: buildAppServerTimeoutMessage(err, currentSessionId, stopPath, opts.retried === true),
    transient: "timeout",
    ...(currentSessionId !== undefined ? { sessionId: currentSessionId } : {}),
  };
}

/** 止损路径的可观测文案（§5.2 F-1：stop 已送达 / stop 无应答已升级杀链两分支各具名）。 */
function stopPathText(stopPath: AbortChainStopPath): string {
  switch (stopPath) {
    case "stop-acked":
      return "session/stop 已送达（服务端接受停 turn）";
    case "stop-rejected":
      return "session/stop 报协议性 error（会话已被回收，控制面存活——止损由会话回收承担，不升级杀链）";
    case "stop-unreachable-killed":
      return `session/stop 无应答已升级杀链（SIGTERM→${ZCODE_KILL_GRACE_MS}ms→SIGKILL 收割共享进程）`;
    case "no-session":
      return "会话未建立（任务未开始执行，无在途消耗）";
    default:
      // settled-in-grace / escalated-kill 只属用户取消入口；超时入口不可达，防御兜底
      return "grace 窗口内终态落定或已走杀链";
  }
}

/**
 * 超时族 outcome 文案（D4 + §5.2 F-1/F-2，两形态有别）：idle 主判定静默时长 + 最后
 * 事件时刻（诊断面）；ceiling 总上界判死附 env 自救通道（XYZ_ZCODE_TURN_MAX_TIMEOUT_MS
 * 可调/0 关闭——§2 目标 5 的用户可见出口）。恢复指引共段：重跑 + 连通性排查 + engine: pi。
 * retried（[P0-1 U4] §5.2 F-1 样例句，u-z2 留的补句义务）：仅在瞬时重试真实发生后
 * 为 true——恢复指引补「瞬时故障已自动重试一次仍超时；重试在止损链终局后启动，无
 * 新旧任务双跑窗」句（未重试形态不含，与行为一致）。
 */
function buildAppServerTimeoutMessage(
  err: TurnTimeoutError,
  sessionId: string | undefined,
  stopPath: AbortChainStopPath,
  retried = false,
): string {
  const sid = sessionId !== undefined ? `（会话 ${sessionId}）` : "";
  const lastEventText =
    err.lastEventAt !== undefined
      ? `，最后事件 ${new Date(err.lastEventAt).toISOString()}`
      : "，整轮未观察到任何事件（进程假死/协议静默形态）";
  const head =
    err.kind === "idle"
      ? `engine_timeout: zcode turn 连续静默 ${err.thresholdMs}ms（idle 判定${lastEventText}，总耗时 ${err.elapsed}ms）${sid}。`
      : `engine_timeout: zcode turn 总上界 ${err.thresholdMs}ms 内未观察到终态（chatty-wedge 判定——事件流仍活跃而终态未到达，总耗时 ${err.elapsed}ms）${sid}。`;
  const selfHelp =
    err.kind === "ceiling"
      ? `若本任务属合法超长任务（预期超过 ${err.thresholdMs}ms），重跑前设 ${ZCODE_TURN_MAX_TIMEOUT_ENV} 为更大毫秒值或 0 关闭总上界（关闭后 chatty 形态不再自动回收，静默 wedged 仍由 idle 层兜底——自行权衡）。`
      : "";
  const rerunGuide = retried
    ? `👉 恢复指引：直接重跑本任务（瞬时故障已自动重试一次仍超时；重试在止损链终局后启动，无新旧任务双跑窗）；`
    : `👉 恢复指引：直接重跑本任务；`;
  return (
    `${head}止损路径：${stopPathText(stopPath)}。\n` +
    `${rerunGuide}${selfHelp}若持续出现，检查 ZCode 桌面端模型连通性或改用 engine: pi。`
  );
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
