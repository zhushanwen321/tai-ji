// [H3/R3] RecordAccess 聚合（域 #3/#8/#10/#13：孤儿/manifest 恢复 + 查询面 + action
// 网关 + 身份解析/record 创建）——自 SubagentService 上帝类 strangler 抽取的第三个
// 聚合的**读建面**（设计 docs/design/subagent-service-decomposition.md §2.1 / §3.3 D5；
// 成员归属以 r0-inventory.md 清单① + 域分区为准）。
//
// [计划变更 D-R3-1] G1「每聚合 ≤700 行」与 R0 八域体量（分区实测 833 物理行）冲突，
// 拆两文件（dev agent 停线报告、主 agent 核验追认）：本文件（读建面 #3/#8/#10/#13）
// + record-lifecycle.ts（终态迁移
// 写面 #4/#11/#17/#18，D5/H4 落点）。两文件组间零互调（已验证），各自独立 deps，
// 壳分别装配——聚合间零 import（G2 / R1 打样模式 3）。
//
// 单一职责：record 的**获得与可见性**——boot 孤儿自愈（manifest 重物化 / entry-born
// 恢复）、身份解析与 record 创建注册、内存∪磁盘查询投影、message/close action 的
// 归属校验网关（冷查/冷复活经 cold-lookup.ts）。终态迁移写面（close/cancel/finalize/
// dispose 批量回收）在 record-lifecycle.ts——D5「store 与终态迁移入口的唯一宿主」。
//
// [R1 打样模式——R3 落地]（模式权威定义见 session-baselines.ts 文件头）
// 1. 依赖注入形态：deps 全晚绑定闭包（构造期零求值）。基线字段（pi/sessionRootId/
//    sessionId/mainSessionFile/execNesting）运行时可变（initSession 注入 / 复活翻转），
//    断言/调用时经壳 getter 现读；叶子模块实例（store/manifestStore/modelService）为
//    #1 留壳共享依赖，getter 现读同一实例（晚绑定形态统一）——深绑测试的 store 读
//    路径（ServiceInternals）保持生效，断言零改写。
// 2. 转发壳写法：壳保留同名方法（含原可见性）单行转发；本聚合公共面 = 壳转发面，
//    聚合内部互调（recoverOrphanRecords / rematerializeReconnectableEntryManifests /
//    coldLookupDeps 消费）保持 private。原 private 方法因壳转发需要可见性放宽为
//    public（strangler 必然，非行为变化）。
// 3. 只搬不改：方法体除依赖注入通道替换（this.X → this.deps.getX()）外逐字节保留
//    ——本聚合侧的写点通道（r0-inventory 清单②）：#13 创建期 createRecord + store.register
//   （C+B 通道）、#3 manifest 重物化投影（D 通道）原样随迁，不经任何中转。

import { getLogger } from "../../core/logger.ts";
import { toErrorMessage } from "../../core/error-message.ts";

import { bestEffort } from "../best-effort.ts";
import { COLD_LOOKUP_SCAN_LIMIT, coldLookupForAction, type ColdLookupDeps } from "../cold-lookup.ts";
import { createRecord, project, snapshot } from "../execution-record.ts";
import type { ExecutionNestingContext } from "../engine/common/nesting-guard.ts";
import {
  joinEngineModelRef,
  splitEngineModelRef,
  validateModelForEngine,
  withCrossEngineHint,
} from "../engine/model-validation.ts";
import type { EnginePort } from "../engine/port.ts";
import { getEngine, listEngines } from "../engine/registry.ts";
import type { ManifestStore } from "../manifest-store.ts";
import type { ModelConfigService } from "../model-config-service.ts";
import type { AgentConfig, ResolvedModel } from "../model-resolver.ts";
import type { RecordStore, StatusFilter } from "../record-store.ts";
// [R6/D-R3-2] 跨进程身份 env 名 ENV_SELF_RECORD_ID 归位常量叶子文件
// service-constants.ts（原 SSOT 在 session-baselines.ts，R3 时的聚合间单向 import
// 合法边随之消除）——聚合→支撑文件方向（import 常量），守卫允许。
import { ENV_SELF_RECORD_ID } from "./service-constants.ts";
import {
  DEFAULT_AGENT_NAME,
  isReconnectableFinalReason,
  type ExecuteOptions,
  type ExecutionHandle,
  type ExecutionMode,
  type ExecutionRecord,
  type RecordSnapshot,
  type SubagentRecord,
} from "../types.ts";

const logger = getLogger("subagents");

/** resolveIdentity 的产物——一次确定、写入 record 后不再变。
 *  [R3] 接口本体自壳文件迁入（唯一生产者 resolveIdentity/resolveIdentityForEngine）；
 *  壳经 type import 消费（execute/executeAndAwait/workflow 派发链的局部类型标注），
 *  对外无导出面（原模块内私有接口）。 */
export interface ResolvedIdentity {
  agent: string;
  agentConfig: AgentConfig | undefined;
  resolved: ResolvedModel;
}

/**
 * [R1 打样模式 1] 聚合协作 deps——**全部晚绑定闭包，构造期零求值**。
 *
 * 窄结构类型只声明聚合真实消费的通道（不整实例注入）。本聚合无跨域编排回调：
 * 读建面自足（查询/创建/恢复只依赖 #1 留壳叶子 + #2 基线字段现读）；跨域边只有
 * baselines deps.recoverOrphans 回调（R1 打样时预留）经壳转发指向本聚合的
 * recoverOrphansIfRootProcess（壳装配零改动）。
 */
export interface RecordAccessDeps {
  /** [D4 下沉] assertReady 断言（本体在 SessionBaselines，壳转发）。查询/action
   *  入口的就绪门（findRecord/lookupRecordAnyState/getRecordForAction）。 */
  readonly assertReady: () => void;
  /** RecordStore（#1 留壳共享依赖；本聚合消费面：恢复扫描/查询投影/注册/冷查）。 */
  readonly getStore: () => RecordStore;
  /** ManifestStore（#1 留壳；tmp 恢复 + 重物化投影写）。 */
  readonly getManifestStore: () => ManifestStore;
  /** ModelConfigService（resolveIdentity 三层解析 + agentConfig 加载）。 */
  readonly getModelService: () => ModelConfigService;
  /** 所属根 session ID（恢复过滤 / record 归属盖章 / 查询 root 过滤；#2 基线现读）。 */
  readonly getSessionRootId: () => string | null;
  /** 本进程 pi session ID（查询 root 过滤兜底；#2 基线现读）。 */
  readonly getSessionId: () => string | null;
  /** 主 session 文件（孤儿恢复扫描数据源；initSession 先赋值后恢复——时序就绪）。 */
  readonly getMainSessionFile: () => string | undefined;
  /** 嵌套身份基线 ALS（record 父链挂接 + action 网关直接父校验；#2 基线现读）。 */
  readonly getExecNesting: () => ExecutionNestingContext;
}

/**
 * 域 #3/#8/#10/#13 聚合：record 读建面（R3 自 SubagentService 抽取）。
 *
 * 字段所有权（r0-inventory 清单①）：#30 coldLookupDeps（唯一消费方 getRecordForAction
 * 冷查分支）。壳零感知其余内部态。
 */
export class RecordAccess {
  private readonly deps: RecordAccessDeps;

  constructor(deps: RecordAccessDeps) {
    this.deps = deps;
  }

  // ── 域 #3 孤儿/manifest 恢复 ──

  /**
   * 孤儿终态恢复（residual-fixes）：session_start 主动触发一次——父扩展死后再无人写
   * 终态 entry 的 record 在此判定落盘（否则侧栏永久 running）。幂等不 throw，失败不
   * 阻断 session_start。
   *
   * [T5① / PS-8] 只有根进程做扫描者：恢复机制假设「单扫描者」，但子进程 sessionRootId
   * 经 env 与父同值（过滤域 = 整树共享的 sessions/records 目录），env 贯穿让每个子进程
   * 都成了扫描者——递归编排中任一子进程启动时，恰有兄弟记录 marker 缺失或超软超时
   *（hours-long wave 必然命中）→ 活记录被无关进程盖 .finalized sidecar，closed entry
   * 写进别的进程的 session 文件（跨进程互写，无任何锁）。子进程身份判据 = env
   * PI_SUBAGENT_SELF_RECORD_ID（父 spawn 时注入的「子进程自己的 record id」，仅子进程
   * 非空）——与 execNesting 基线同源。根进程恢复语义不变。
   */
  recoverOrphansIfRootProcess(): void {
    const isChildProcess = (process.env[ENV_SELF_RECORD_ID] ?? "") !== "";
    if (!isChildProcess) {
      this.recoverOrphanRecords();
    } else if (process.env.XYZ_AGENT_DEBUG) {
      logger.debug("[subagents] child process detected (PI_SUBAGENT_SELF_RECORD_ID set), skipping orphan recovery scan");
    }
  }

  /** 孤儿终态恢复委托（RecordStore.recoverOrphanRecords 的唯一调用入口，维持 store
   *  private 封装——与 recoverManifestTmpFiles 同模式；[D4] public 面收窄：唯一调用方
   *  是 initSession，转 private）。判定语义见 store 侧注释。
   *  mainSessionFile 随调用透传（v2 D3 覆写 merge 数据源：主文件末条 entry 的批域
   *  标记与轮终 result/model；initSession 先赋值后恢复，时序就绪）。
   *  随后跑 entry-born 孤儿恢复（无子文件锚的 register-only record，spawn 窗口期死亡，
   *  E2E 实测缺口）——主 session 文件经 getMainSessionFile 注入（构造期可空）。
   *  [M1 Gate B] 末段跑可重连 entry 的 manifest 重物化（闭含 dispose 时 manifest
   *  fire-and-forget 写被 SIGKILL 竞态吞掉的窗口）。 */
  private recoverOrphanRecords(): void {
    try {
      this.deps.getStore().recoverOrphanRecords(this.deps.getSessionRootId() ?? undefined, this.deps.getMainSessionFile());
    } catch (err) {
      logger.warn("[subagents] orphan recovery failed", {
        reason: toErrorMessage(err),
      });
    }
    try {
      this.deps.getStore().recoverEntryOnlyOrphans(this.deps.getMainSessionFile(), this.deps.getSessionRootId() ?? undefined);
    } catch (err) {
      logger.warn("[subagents] entry-only orphan recovery failed", {
        reason: toErrorMessage(err),
      });
    }
    try {
      this.rematerializeReconnectableEntryManifests();
    } catch (err) {
      logger.warn("[subagents] reconnectable entry manifest re-materialization failed", {
        reason: toErrorMessage(err),
      });
    }
  }

  /**
   * [M1 Gate B] 可重连终态 entry 的 manifest 重物化（boot 自愈段）。
   *
   * 缺口：编排性关闭（disposeAllRecords）的 manifest 写是 fire-and-forget——SIGKILL /
   * 崩溃打进 shutdown 窗口时 entry（pi flush）与 manifest 写可能只活下来前者。末条
   * subagent-record entry 为 closed + closedReason ∈ 可重连集（RECONNECTABLE_FINAL_
   * REASONS = parent-shutdown/disconnected，types.ts SSOT）的 record，若查询面
   * （collectRecords：内存∪磁盘∪manifest）已不可见，则从 entry 自描述快照重物化
   * manifest——恢复 list 可见性 + message 的可重连分流（D4 revive 准入仍由
   * cold-lookup 四守卫把门，重物化只补反查索引，不复活任何执行态）。
   *
   * 刻意收窄的语义边界：
   *  - 只认可重连集。user-close/cancelled（主动告别，close 语义不可旁路）与
   *    gc/parent-fork/parent-new（自洽终态，无续聊歧义）不重物化——条目自洽，
   *    「不可恢复」即其对外语义，补可见性收益不抵语义面扩大（M1 负向断言锁定）。
   *  - 只补本 rootSessionId 的 entry（每 session boot 治自己的树；跨 session 记录
   *    归属其自身 boot 段，防本进程替异树批量落盘）。
   *  - 已可见（磁盘锚或 manifest 幸存）的 id 跳过——重物化是幂等补缺，不是覆写源。
   */
  private rematerializeReconnectableEntryManifests(): void {
    if (this.deps.getMainSessionFile() === undefined) return;
    const visibleIds = new Set(
      this.deps.getStore().collectRecords(COLD_LOOKUP_SCAN_LIMIT, "all", undefined).map((r) => r.id),
    );
    for (const rec of this.deps.getStore().scanLastRecordEntries(this.deps.getMainSessionFile())) {
      if (visibleIds.has(rec.id)) continue; // 查询面已可见：磁盘锚或 manifest 幸存
      if (rec.rootSessionId !== this.deps.getSessionRootId()) continue; // 只治本 session 树
      if (rec.status !== "closed" || !isReconnectableFinalReason(rec.closedReason)) continue;
      // manifest 投影补写走 store 公开原语（[H4 收口 / G1] store 外零 manifest 直写；
      // status 恒 closed——entry 的 closed 即终态自描述，无 running 形态可达此处）。
      this.deps.getStore().rematerializeManifest({
        id: rec.id,
        rootSessionId: rec.rootSessionId ?? "",
        parentRecordId: rec.parentRecordId,
        agentName: rec.agent,
        status: "closed",
        closedReason: rec.closedReason,
        createdAt: rec.startedAt,
        completedAt: rec.endedAt ?? Date.now(),
        sessionFile: rec.sessionFile,
        task: rec.task,
        slug: rec.slug,
        model: rec.model,
      });
    }
  }

  /** 启动清扫：manifest tmp 残留（崩溃打断的原子写留下的 *.json.tmp.<pid>）静默删除
   *  ——[U4c / D6] tmp 恢复已退役（manifest 是可丢可重建缓存，promote 语义失效）。
   *  幂等，不 throw。ADR-035 启动清扫接线——session_start 每次都调（与
   *  maybeCleanupExpiredSessionFiles 一致）。manifestStore 保持 private 封装，本方法
   *  是公开入口。 */
  async recoverManifestTmpFiles(): Promise<{ deleted: number; recovered: number }> {
    try {
      const deleted = await this.deps.getManifestStore().sweepTmpFiles();
      // recovered 恒 0：promote 已随 U4c 退役——公开签名保留 {deleted, recovered}
      // 形态（subagent-service 壳转发 + subagent-workflow session-lifecycle 消费
      // swept.deleted，改签名波及 extension 消费面）。
      return { deleted, recovered: 0 };
    } catch (err) {
      bestEffort(err, "recoverManifestTmpFiles", "error");
      return { deleted: 0, recovered: 0 };
    }
  }

  // ── 域 #13 身份解析/record 创建 ──

  /** 步骤 1：身份解析。agentConfig → resolveModel（三层：override → agentConfig → 主 agent model）。
   *
   * [u-h2] pi 未命中跨引擎候选（D2-4）：resolveModel 抛 notFoundError（pi registry
   * 全等裁决未命中）时反查其他已注册引擎清单，唯一命中则追加「该 id 属于引擎 X」
   * 候选段（场景 3）；其余裁决失败（孪生歧义/auth）与命中路径原样返回（零回归）。
   * execute() 与 executeAndAwait() 两个派发路径共享本方法，故 chat 与 workflow 域的
   * pi 校验同享场景 3 文案。
   */
  async resolveIdentity(
    opts: ExecuteOptions,
    pre?: { agent: string; agentConfig: AgentConfig | undefined },
  ): Promise<ResolvedIdentity> {
    // agentRef 语义（S2）：agent 参数 = .md 绝对路径；不传 = 不加载 agentConfig，
    // 直接用 override → 主 agent model。DEFAULT_AGENT_NAME 仅作 record 显示名
    // （TUI 层 extractAgentName 共用，保证显示一致）。
    const agent = pre?.agent ?? opts.agent ?? DEFAULT_AGENT_NAME;
    // 显式 agent ref（用户点名）失败必须报错，不静默降级：无 require 的 loadByPath
    // 对相对路径/裸名/文件缺失都返回 undefined → agentConfig undefined → resolveModel
    // 静默回落 override→主 agent model，用户拿到的 subagent 无 systemPrompt/工具白名单
    // 且零反馈。require:true 让失败抛出带 <available_subagents> 指引的错误（对齐
    // workflow name not found 反馈风格）；不传 agent = 默认 general-purpose 语义，
    // agentConfig 保持 undefined（合法缺省，走 override → ctxModel 兑底）。
    // [u-h2 D2-1] execute() 已在路由前解析 agentConfig（pre 通道），此处复用不二次加载。
    const agentConfig = pre
      ? pre.agentConfig
      : opts.agent
        ? this.deps.getModelService().getRequiredAgentConfig(opts.agent)
        : undefined;

    let resolved: ResolvedModel;
    try {
      resolved = this.deps.getModelService().resolveModel(
        opts.agent ?? "",
        { model: opts.model, thinkingLevel: opts.thinkingLevel },
        opts.ctxModel,
        agentConfig,
      );
    } catch (err) {
      throw withCrossEngineHint(err, listEngines(), (id) => {
        try {
          return getEngine(id);
        } catch {
          return undefined; // 清单快照与注册表并发变化的防御：取不到引擎按未注册处理
        }
      });
    }

    return { agent, agentConfig, resolved };
  }

  /**
   * [u-h2 D2-1③] 非 pi 引擎的 identity 解析：跳过 pi registry 三层解析（ctxModel 主
   * agent model 不透传——主 agent 的 pi id 对目标引擎大概率无效，缺省语义归引擎）。
   *
   * 逐层语义（设计 D2-1 归趋表）：
   *   - model 源 = engineModel（调用参数 opts.model > agentConfig.model frontmatter，
   *     agent 作者声明不忽略——配错在 validateModel 同步报错，不落引擎缺省静默续跑）；
   *   - 无显式 model → 校验/留痕走引擎缺省（validateModel(undefined) 的 canonicalRef）；
   *   - thinkingLevel 直接透传（引擎中立参数，不涉 registry）。
   *
   * 引擎未实现 validateModel 时 modelRef 原样透传（其 prepare 期校验兜底，现状语义）。
   */
  resolveIdentityForEngine(
    engine: EnginePort,
    engineModel: string | undefined,
    agent: string,
    agentConfig: AgentConfig | undefined,
    opts: ExecuteOptions,
  ): ResolvedIdentity {
    const canonical = validateModelForEngine(engine, engineModel);
    // record.model 留痕：canonical（引擎裁决 ref，允许无斜杠形态——契约变更④，协议化
    // 后引擎可原样返回 ref）；引擎未实现校验面且无显式 model 时为空串（记录形态退化，
    // 生产不可达——注册表内非 pi 引擎均实现 validateModel；防御性空串避免 throw 打断
    // 兜底语义）。拆分单一权威 = splitEngineModelRef（无斜杠 → provider=""/id=ref/
    // 整串进 name，不再落 "<ref>/" 畸形）。
    const modelStr = canonical ?? engineModel ?? "";
    const model = splitEngineModelRef(modelStr);
    return {
      agent,
      agentConfig,
      resolved: {
        model: {
          id: model.id,
          name: model.name,
          provider: model.provider,
          reasoning: false,
        },
        thinkingLevel: opts.thinkingLevel ?? agentConfig?.thinkingLevel,
      },
    };
  }

  /** 步骤 2：按 mode 生成 id + controller，创建 record 并注册。
   *  [L-1] ExecutionMode 类型固定 "background"（sync 已删除），id/controller 分支简化。
   *  [H2 W2] originFields：workflow 域派发（executeWorkflowAgent）的来源身份——
   *  origin:"workflow" + parentRunId 进 record（D1）；缺省不传 = tool 来源（存量零迁移）。 */
  createRecordForMode(
    identity: ResolvedIdentity,
    opts: ExecuteOptions,
    mode: ExecutionMode,
    originFields?: { origin: "workflow"; parentRunId: string },
  ): ExecutionRecord {
    // FR-1: record id 用全局 UUID，不依赖 transcript/PID
    const id = `sa-${crypto.randomUUID()}`;
    const controller = new AbortController();

    // 从 async 调用链读父执行上下文：主 session 链上无 store → 顶层 record；
    // B run() 期间包了嵌套上下文，B 内创建 C 时读到 B → C.parentRecordId=B.id, C.depth=B.depth+1。
    // depth 语义：顶层（无父）=0；有父=父 depth+1。靠 recordId 是否存在区分，不用负数魔数。
    // [ALS 断裂修复] current() 内含基线兜底——本进程的身份在 initSession 已确定（env 注入），
    // 任何上下文下都能正确挂父链。
    const parentCtx = this.deps.getExecNesting().current();
    const parentRecordId = parentCtx?.recordId;
    const depth = parentCtx ? parentCtx.depth + 1 : 0;

    const base = createRecord(id, {
      agent: identity.agent,
      // model 留痕词形与拆分同源（joinEngineModelRef）：provider 为空串只写 id——
      // 契约变更④的无斜杠 ref（provider=""/id=ref）不得落成 "/ref" 或 "ref/" 畸形；
      // 续聊回读侧 splitEngineModelRef 对无斜杠串还原 provider=""/id=ref，往返自洽。
      model: joinEngineModelRef(identity.resolved.model),
      thinkingLevel: identity.resolved.thinkingLevel,
      mode,
      task: opts.task,
      slug: opts.slug,
      startedAt: Date.now(),
      rootSessionId: this.deps.getSessionRootId() ?? undefined,
      parentRecordId,
      depth,
      chatMode: opts.conversation === true,
      idleTimeoutMs: opts.idleTimeoutMs,
      // P4 引擎留痕（D9①）：opts.engine/engineFallback 由引擎适配层写入（PiEngine.run
      // 从 RunContext 回填；缺省 = pi 投影，存量调用方零感知）
      engine: opts.engine,
      engineFallback: opts.engineFallback,
      // subagent-sync-collect U2（偏差#4 接线）：sync record 落 collectMode——
      // 协调器路由判据 + startHandler pendingSyncCount 枚举含本条的数据源。
      // undefined = async（缺省语义，旧记录零迁移）。
      collectMode: opts.collect === "sync" ? "sync" : undefined,
      controller,
    });
    // [H2 W2] 来源身份在对象构造点落位（origin/parentRunId 为 readonly，创建期一次性
    // 写入——与 createRecord 的 identity 语义同款「创建时确定，不可变」）。
    const record: ExecutionRecord =
      originFields !== undefined
        ? { ...base, origin: originFields.origin, parentRunId: originFields.parentRunId }
        : base;

    this.deps.getStore().register(record);
    return record;
  }

  /** [MF#R4] worktree 前置失败的 early-return handle。
   *  record 已被 finalizeFailed 收尾为 failed、detached promise 从未启动。 */
  buildEarlyFailedHandle(record: ExecutionRecord): ExecutionHandle {
    const details = project(record);
    return { mode: "background", subagentId: record.id, sessionFile: record.sessionFile, details };
  }

  // ── 域 #8 查询面 ──

  /**
   * 按 id 查内存 running record 的只读快照（G3-002 修复）。
   * 不从 session.jsonl 重建（cancel/list 单点查询只关心内存 running record）。
   * 供 tool 层 cancelHandler 翻译 throw 用（id 不存在 / mode / 终态三种错误）。
   * 不存在返回 undefined。
   */
  findRecord(id: string): RecordSnapshot | undefined {
    this.deps.assertReady();
    const record = this.deps.getStore().getMutable(id);
    return record ? snapshot(record) : undefined;
  }

  /**
   * [v8.5 A1/B] 全态查找：任意状态（running/closed）× 任意归属（含异 root session）的
   * record 快照。供 message 拒绝文案分流（A1）与 fork-from 源解析（B）共用。
   *
   * 与 getRecordForAction 的差异：不做归属/直接父校验、不重建可变 record 入内存，
   * 只读快照（light 形态可能缺详情重数据，身份/sidecar 状态字段齐全）。查询顺序与
   * getRecordForAction 冷路径同款（idToFile 索引直查 → collectRecords 全扫兑底），
   * 不限 status——终态（sidecar closed）记录也能查到。
   *
   * 返回 undefined：id 在内存与磁盘均不存在。
   */
  lookupRecordAnyState(id: string): SubagentRecord | undefined {
    try {
      this.deps.assertReady();
    } catch {
      return undefined; // 未初始化/disposed 时按「不存在」处理（文案分流无需区分）
    }
    const direct = this.deps.getStore().findLightById(id);
    if (direct) return direct;
    return this.deps.getStore().collectRecords(COLD_LOOKUP_SCAN_LIMIT, "all", undefined).find((r) => r.id === id);
  }

  /** 订阅 store 变更（widget/list requestRender）。返回取消订阅。 */
  onChange(listener: () => void): () => void {
    return this.deps.getStore().onChange(listener);
  }

  // [D4] listRunning 已删除：零生产调用方（TUI 计数经 collectRecords / notify-host 的
  // piAdapter 直调 store.listRunning 覆盖），唯一消费是初始空态单测——保留 store 层方法。

  /** 合并内存(running) + 磁盘(session.jsonl 重建) record（/subagents list + tool list 消费）。
   *  按 rootSessionId 过滤：根进程=本 session（sessionRootId===sessionId）；
   *  子进程=env 贯穿的真 ROOT（sessionRootId≠sessionId）→ 看到整棵 ROOT 树（决策 3）。
   *  [perf] 磁盘源为 light（头部 identity + 状态，无 eventLog/result/turns 等重数据）
   *  ——列表/补全/hasRunning 够用；详情场景调 getFullRecord(id) 懒加载补齐。 */
  collectRecords(
    limit: number,
    statusFilter: StatusFilter = "all",
    includeWorkflow: boolean = false,
  ): SubagentRecord[] {
    return this.deps.getStore().collectRecords(limit, statusFilter, this.deps.getSessionRootId() ?? this.deps.getSessionId() ?? undefined, includeWorkflow);
  }

  /** [perf] 单 record 详情懒加载（全量：eventLog/displayItems/result/turns/tokens）。
   *  内存 running record 直接投影；磁盘 record 全量重建（per-file 缓存，stat 戳校验）。
   *  返回 undefined：id 不存在于内存与磁盘。 */
  getFullRecord(id: string): SubagentRecord | undefined {
    return this.deps.getStore().getFullRecord(id);
  }

  // ── 域 #10 action 网关 ──

  /** [D4-③] 冷路径查询依赖（cold-lookup.ts；deps 闭包惰性求值：sessionRootId /
   *  execNesting 基线运行时可变）。[R3] 初始化器内的箭头函数体运行时才解引用
   *  this.deps（构造器体先于任何调用完成），晚绑定语义与原壳字段一致。 */
  private readonly coldLookupDeps: ColdLookupDeps = {
    findLightById: (id) => this.deps.getStore().findLightById(id),
    collectRecords: (limit, statusFilter, rootFilter) =>
      this.deps.getStore().collectRecords(limit, statusFilter, rootFilter),
    register: (record) => this.deps.getStore().register(record),
    reportRecordTransition: (record) => this.deps.getStore().reportRecordTransition(record),
    // [U2a/B4] 透明重生回边原语（store.markResurrected）——ColdLookupDeps 新增字段的
    // 机械装配行（接口装配点不在 U2a 领地清单内的连带接线）。
    markResurrected: (record, wasClosed) => this.deps.getStore().markResurrected(record, wasClosed),
    getSessionRootId: () => this.deps.getSessionRootId(),
    getBaselineRecordId: () => this.deps.getExecNesting().baseline()?.recordId ?? undefined,
  };

  /**
   * 按 id 查 record 并做归属校验（message/close action 的统一入口）。
   *
   * 设计决策 3（归属守卫）：校验 record.rootSessionId 必须等于当前 session 的根 id
   *（this.sessionRootId）。不匹配 / 不存在统一抛「not found or not owned」——不区分
   * 两种失败，防信息泄露（无法通过错误消息探测其他 session 的 subagent id）。
   *
   * 同进程内 running + idle record 都在内存（getMutable）；终态 record 已 archive。
   * 跨重启（SP-2）内存空时，从磁盘 collectRecords 重建 idle record 并 register 进内存。
   * reconstructAll 已将跨重启 record（无 sidecar marker + pid 死）标记为 running（v4 B-1 跨重启可续聊语义，record-store buildRecord 分支 4），
   * collectRecords 返回的 SubagentRecord 可直接转为可变 ExecutionRecord 供续操作。
   *
   * @param id subagent record id
   * @param opts.allowReconnect [v8.5 D] message 专属：冷查额外接受「可重连」的 closed 记录
   *   （死因∈ RECONNECTABLE_FINAL_REASONS，A 档真实死因 sidecar 是唯一准入门），经四重守卫后
   *   resurrectClosed 回边为 running 并续写原 session 文件。仅 message 开启；close/cancel 维持单向终态语义。
   * @returns 可变 ExecutionRecord（message/close handler 直接操作）
   * @throws Error record 不存在 / 非本 session 所有（含恢复指引）
   * @throws ResurrectDeniedError 命中可重连集但被 worktree/异进程活实例守卫拦截（自带完整行动语言）
   */
  getRecordForAction(id: string, opts?: { allowReconnect?: boolean }): ExecutionRecord {
    this.deps.assertReady();
    let record = this.deps.getStore().getMutable(id);
    // SP-2 跨重启恢复：内存未命中时，从磁盘 collectRecords 重建 idle record。
    // reconstructAll 已将跨重启 record（无 sidecar + pid 死）标记为 running（v4 B-1 可续聊语义，非 crashed），
    // 直接转为可变 ExecutionRecord register 进内存，供 message/close action 续操作。
    if (!record) {
      // [D4-③] 冷查/复活链在 cold-lookup.ts（[H1 U6] 原 cold-resurrect.ts 改名落位）。
      record = coldLookupForAction(this.coldLookupDeps, id, opts?.allowReconnect === true);
    }
    if (!record || record.rootSessionId !== this.deps.getSessionRootId()) {
      throw new Error(
        `subagent not found or not owned: ${id}. Recovery: use action:'list' to confirm the id; ` +
        `ended subagents cannot be messaged — start a new one; only subagents owned by the current session can be operated on.`,
      );
    }
    // [v4 A-5 / P7] 直接父校验：rootSessionId 已确认 record 属于本 session 树，但递归场景下
    // 孙级 record（parentRecordId = 某子进程的 self recordId）的子进程句柄只存在于其直接父
    // 进程内存。主进程（基线 null）若仅凭 rootSessionId 通过就 message 孙级，会走
    // 冷路径重新 spawn → 双写同一 session 文件（P7 双写者窗口）。统一用 baseline recordId 校验：
    //   - 主进程 baseline=undefined → 只能操作 parentRecordId=undefined 的根层 record
    //   - 子进程 baseline="sa-X"    → 只能操作 parentRecordId="sa-X" 的直接孩子
    // record.parentRecordId===undefined 视作根层，仅主进程可操作（身份缺省的旧/异常 record 归此）。
    const baselineRecordId = this.deps.getExecNesting().baseline()?.recordId ?? undefined;
    if (record.parentRecordId !== baselineRecordId) {
      throw new Error(
        `subagent ${id} is owned by its direct parent; message it through that parent ` +
        `(see /subagents list, parent=${record.parentRecordId ?? "(root layer)"}). [v4 A-5] cross-layer ` +
        `ownership guard: this process's baseline=${baselineRecordId ?? "(root)"} is not the direct parent of ${id}; ` +
        `operating here would race the owning child process's handle and double-write the session file.`,
      );
    }
    return record;
  }

  // [D4-③] 冷路径查询链（findColdLookupCandidate / assertReconnectAllowed /
  // resurrectColdRecord / coldLookupForAction + isReconnectableClosed 判定）落位
  // cold-lookup.ts（本聚合经 coldLookupDeps 注入）。
  // SP-2 冷路径 [perf] 语义不变：idToFile 索引直查 → collectRecords 全扫兜底。
}
