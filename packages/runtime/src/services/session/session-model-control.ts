/**
 * SessionModelControl — 模型/思考等级控制域（S6 迁出，原 Facade 两方法逐字随迁）：
 * switchModel（set RPC + get_state 回执普查 + 三实例 markDirty 失效 + modelId 直写 +
 * trace 补拉）与 setThinkingLevel（set RPC + 钳制生效值读回 + thinkingLevel 直写）。
 *
 * 全部依赖经既有公有面窄注入（deps）：session 定位经 lifecycle 只读查询（Registry
 * 元素视图可变语义——session.modelId/thinkingLevel 直写是登记的永久双写形态）、
 * 标量失效经 projection 实例组、trace 补拉经 traceSync。销毁无域状态（不持 Map，
 * 无 onSessionDisposed）。Facade 保留两方法一行委托（ISessionService 契约不变）。
 */
import type { ProviderId } from '@taiji/shared'
import { DEFAULT_SESSION_ACTIVATE_TIMEOUT_MS } from '@taiji/shared'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { IManagedSessionView } from './types.js'
import type { SessionReplicatedStates } from './session-state-projection.js'
import {
  toErrorMessage,
  errorWithCode,
  SESSION_ACTIVATE_FAILED,
  SESSION_ACTIVATE_TIMEOUT,
  SESSION_NOT_FOUND,
  MODEL_NOT_CONFIGURED,
  RESTORE_FAILED,
  BUILTIN_EXTENSIONS_MISSING,
  MODEL_NOT_FOUND,
  PROVIDER_CREDENTIAL_MISSING,
  ENGINE_MODEL_MISSING,
  PI_MODEL_NOT_FOUND_PREFIX,
} from '../../utils/errors.js'
import { logger } from '../../infra/logger.js'

/**
 * 激活阶段可原样透传的既有码（U2，设计 §3.4 优先级规则）：这些码的语义与恢复指引已被上层
 * 消费（未配模型 → 去设置选默认模型；产物断链 → 重装应用），重包成 `SESSION_ACTIVATE_FAILED`
 * 会把可操作错误降级成笼统的「会话无法恢复」。
 */
const ACTIVATION_PASSTHROUGH_CODES: ReadonlySet<string | number> = new Set([
  SESSION_NOT_FOUND,
  MODEL_NOT_CONFIGURED,
  RESTORE_FAILED,
  BUILTIN_EXTENSIONS_MISSING,
  SESSION_ACTIVATE_TIMEOUT,
])

/**
 * 激活等待套一层上界（实现范式与 `process-manager.ts` 的 raceReadyTimeout 同款）。
 *
 * 关键语义（设计 §3.6「激活的等待上界」行）：**超时不取消后台恢复** —— 底层 promise 继续跑
 * （join 语义保留，用户重试时 join 同一 in-flight），此处只终止 RPC 等待；定时器 `unref()`
 * 不阻止进程退出；超时后给底层 promise 补挂 no-op 双向挂接，防其后续 settle 触发
 * unhandled rejection。
 */
function raceActivateTimeout<T>(p: Promise<T>, ms: number, sessionId: string): Promise<T> {
  if (ms <= 0) return p
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      p.then(
        () => {},
        () => {},
      )
      reject(errorWithCode(
        `session activation timed out after ${ms}ms (sessionId=${sessionId}; background restore continues, retry later)`,
        SESSION_ACTIVATE_TIMEOUT,
      ))
    }, ms)
    timer.unref()
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * 激活阶段错误分型（U2）：既有码原样透传，其余（含无码错误）包 `SESSION_ACTIVATE_FAILED`
 * 并保留原始 message（排障可读性）。
 */
export function classifyActivationError(e: unknown, sessionId: string): Error & { code: string | number } {
  const code = (e as { code?: string | number } | null | undefined)?.code
  if (code !== undefined && ACTIVATION_PASSTHROUGH_CODES.has(code)) {
    return e as Error & { code: string | number }
  }
  return errorWithCode(
    `session activation failed for ${sessionId}: ${toErrorMessage(e)}`,
    SESSION_ACTIVATE_FAILED,
  )
}

/** pi `set_model` 的「模型未找到」文本判定（前缀匹配；pi 实装文本见 `PI_MODEL_NOT_FOUND_PREFIX`）。 */
export function isPiModelNotFoundError(e: unknown): boolean {
  return toErrorMessage(e).startsWith(PI_MODEL_NOT_FOUND_PREFIX)
}

/**
 * SessionModelControl 装配依赖（窄注入，S5/D2 风格：原 Facade 字段/子模块直读的逐字等价面）。
 */
export interface SessionModelControlDeps {
  /** sessions Map 只读查询（lifecycle 所有者）：session 定位 + modelId/thinkingLevel 直写。 */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** 标量实例组访问器（projection）：modelId/usage/thinkingLevel 三实例的 markDirty 失效。 */
  getReplicatedStates(sessionId: string): SessionReplicatedStates | undefined
  /** trace 增量腿补拉（traceSync）：set_model/set_thinking_level 的 RPC 成功后补拉。 */
  syncTraceEntries(sessionId: string, trigger: string): void
  /**
   * 会话激活（U2/D5）：停止态/回收态 → 拉起或 join 引擎，返回**存活** client。
   * 既有错误码原样抛出（SESSION_NOT_FOUND / MODEL_NOT_CONFIGURED / RESTORE_FAILED /
   * BUILTIN_EXTENSIONS_MISSING），由本类按 ACTIVATION_PASSTHROUGH_CODES 透传。
   */
  ensureActive(sessionId: string): Promise<IPiEngine>
  /**
   * 模型是否在当前 taiji 注册表（`configService.listProviders()` 投影：catalog 合并集 +
   * models.json override）。用于 `Model not found` 三型分型：不在注册表 = 模型真已不存在。
   * 未就绪（configService 尚未注入）时 fail-open 返 true（宁落双因文案，不误报「已不存在」）。
   */
  isModelRegistered(provider: string, modelId: string): boolean
  /**
   * provider 是否有可用凭据（apiKey 落盘 / OAuth / ambient / env_var 引用）。同一 fail-open
   * 语义：无法证明缺凭据时不误报 `PROVIDER_CREDENTIAL_MISSING`。
   */
  hasProviderCredential(provider: string): boolean
  /** 激活等待上界（ms，默认 15s；≤0 = 不限时逃生门）。 */
  activateTimeoutMs?: number
}

export class SessionModelControl {
  constructor(private readonly deps: SessionModelControlDeps) {}

  private get activateTimeoutMs(): number {
    return this.deps.activateTimeoutMs ?? DEFAULT_SESSION_ACTIVATE_TIMEOUT_MS
  }

  /**
   * 激活 + 守卫（U2）：`ensureActive` 前置（回收态不在 Map / client 已死两态都能拉活），
   * 施加 RPC 边界上界并做错误分型；返回的 client 必须**未退出**（`exited` 过滤是
   * 「不把死 client 交给 set RPC」的守卫面）。
   */
  private async activate(sessionId: string): Promise<IPiEngine> {
    let client: IPiEngine
    try {
      client = await raceActivateTimeout(this.deps.ensureActive(sessionId), this.activateTimeoutMs, sessionId)
    } catch (e) {
      const wrapped = classifyActivationError(e, sessionId)
      if (wrapped !== e) {
        console.error(`[session-service] ensureActive failed: sessionId=${sessionId}, ${toErrorMessage(e)}`)
      }
      throw wrapped
    }
    if (client.exited) {
      // 激活返回已死 client（reaper 竞态 / 进程刚退）= 内部不变量破坏，不把死 client 交给 set RPC。
      const err = errorWithCode(
        `activation returned an exited pi client (sessionId=${sessionId})`,
        SESSION_ACTIVATE_FAILED,
      )
      console.error(`[session-service] ${err.message}`)
      throw err
    }
    return client
  }

  /**
   * `Model not found` 三型分型（U2，设计 §3.4）：pi 的错误文本只说明「引擎快照里没这个模型」，
   * 三种成因由 taiji 侧两判分开——① 不在注册表 → `MODEL_NOT_FOUND`；② 在注册表但 provider
   * 无凭据 → `PROVIDER_CREDENTIAL_MISSING`；③ 在注册表且凭据齐备 → `ENGINE_MODEL_MISSING`
   * （快照未同步 or 配置含坏内容，两因不机器可分 → 双因文案，D11）。
   * 非该文本的错误原样返回（不吞、不重包）。
   */
  private classifySetModelError(e: unknown, provider: string, modelId: string): unknown {
    if (!isPiModelNotFoundError(e)) return e
    const target = `${provider}/${modelId}`
    if (!this.deps.isModelRegistered(provider, modelId)) {
      return errorWithCode(
        `model not in taiji registry: ${target} (pi said: ${toErrorMessage(e)})`,
        MODEL_NOT_FOUND,
      )
    }
    if (!this.deps.hasProviderCredential(provider)) {
      return errorWithCode(
        `provider has no credential: ${provider} (pi said: ${toErrorMessage(e)})`,
        PROVIDER_CREDENTIAL_MISSING,
      )
    }
    return errorWithCode(
      `engine has not recognized the model yet: ${target} (pi said: ${toErrorMessage(e)}; `
      + 'snapshot not yet refreshed, or provider config rejected by the engine)',
      ENGINE_MODEL_MISSING,
    )
  }

  /**
   * session 级状态单一 owner：切换模型的 RPC + 缓存更新 + 失效。
   *
   * W12（data-source-governance P1.5）：广播职责归快照挂钩——markDirty modelId / usage /
   * thinkingLevel 三实例后，各自防抖重拉，快照应用后经挂钩发布 session.state_changed
   * （payload 全字段来自实例快照，见 publishStateChangedFromSnapshot）。旧 broadcastSessionState
   * 的「get_state 直读 thinkingLevel + resolver 窗口重算 + session.modelId 直写投影」中间层
   * 已删（plan W12 步骤 3）；UI 更新延迟 = 防抖窗口 + 快照 RPC（W7 行为级验收预算 1s 内）。
   *
   * 为什么除 config.defaults 外还要发 session.state_changed（原 model-service 注释保留）：
   * config.defaults 是全局默认（不带 sessionId），前端无法据它定位「哪个 session 换了模型」。
   * session.state_changed 带 sessionId，前端据它同步 Composer 工具条（模型显示 / 思考强度；
   * 用量刷新走 context.update 帧，D1 协议收敛后 state_changed 不再携带 usage）。
   *
   * W10 owner 结构：inputTokens 唯一数据源 = usage 实例快照（fetch get_session_stats 写入，
   * 事件只 markDirty）。本方法的失效与 context 事件失效任意顺序到达，防抖到点后快照收敛
   * pi 权威值（pi 侧 setModel 后 getContextUsage 天然按新模型窗口），结构自愈。
   */
  async switchModel(sessionId: string, provider: ProviderId, modelId: string): Promise<string> {
    const newModelId = `${provider}/${modelId}`
    // U2/D5：**激活前置**——停止态（不在 Map）/ 回收态 / 死 client 一律先拉活（join 同一
    // in-flight），再谈缓存写与广播。旧实现把 `getSession` 判空放在最前、且 `getClient`
    // 不过滤已死进程，两个状态都到不了激活分支：不在 Map → throw 'session not active'；
    // 无 client → 直接 `return sessionId` 假成功（前端按请求值回显，用户看到切了但引擎没动）。
    const client = await this.activate(sessionId)
    const session = this.deps.getSession(sessionId)
    if (!session) {
      // 激活成功但 Map 仍无条目 = 内部不变量破坏（激活路径负责注册），显式失败不静默。
      throw errorWithCode(
        `session not registered after activation (sessionId=${sessionId})`,
        SESSION_ACTIVATE_FAILED,
      )
    }
    try {
      await client.setModel(provider, modelId)
    } catch (e) {
      console.error(`[session-service] switchModel RPC failed: sessionId=${sessionId}, model=${newModelId}`, e)
      throw this.classifySetModelError(e, provider, modelId)
    }
    // 回执普查（U6，D3④）：pi pattern 引擎可能把请求模型静默换成同族条目（事故 A 形态），
    // 请求值 ≠ 生效值——set 后 get_state 读回实际生效模型，双写缓存与返回值都用生效值
    //（与 setThinkingLevel 的 set→get_state→effective 同款模式，PS-03/PS-01）。
    // get_state 失败 fallback 请求值（旧行为），不反噬切模型主链路。
    const effectiveModelId = await this.readEffectiveModelId(sessionId, client, newModelId)
    // W7：switchModel RPC 成功响应 = modelId 实例的失效源（RPC 响应驱动，「事件只做失效」的
    // 补充合法形态，D7）。markDirty 防抖重拉 get_state，实例快照与 pi 权威值收敛（行为级
    // 验收：模型名 1s 内更新）。失败路径（上方 throw）不失效——pi 侧未生效，实例保持旧快照。
    this.deps.getReplicatedStates(sessionId)?.modelId.markDirty()
    // W10：switchModel 重算失效 = usage 失效源（contextWindow 随模型变化——markDirty 重拉
    // get_session_stats 后快照持有 pi 侧按新模型窗口算出的权威值）。失败路径不失效（同上）。
    this.deps.getReplicatedStates(sessionId)?.usage.markDirty()
    // W12：thinkingLevel 失效——pi 切模型时若新模型 thinkingLevel 与当前相同则不 emit 事件
    //（thinking_level_changed 覆盖不住），markDirty 重拉 get_state 刷新快照（旧实现靠
    // broadcastSessionState 内 get_state 直读，随该方法删除改经实例）。
    this.deps.getReplicatedStates(sessionId)?.thinkingLevel.markDirty()
    // PR #185 S2 裁决的永久双写形态：RPC 已成功（pi 侧生效），直写让 toSummary（session
    // 列表）与 state_changed fallback（防抖 300ms + 重拉窗口内快照未收敛）立即读到新值；
    // 实例快照收敛后主路径照常读快照（与直写同值，无冲突）。U6：直写 get_state 读回的
    // 生效值（pi pattern 换模时 ≠ 请求值），缓存不再携带未生效的请求模型。
    session.modelId = effectiveModelId
    // 持久层唯一写方 = pi（model_change entry 落 JSONL，缓存治理 U8a W1 写点退役）——
    // 会话列表经 scanSessionMeta 反向读 JSONL 在下次刷新可见，本方法只负责内存直写投影。
    // session-trace（A33）：lifecycle RPC 成功后主动补拉——model_change 的 append 无通用事件
    //（design D4：model_change / label 无事件，这些动作由 runtime 自身发起，RPC 成功后补拉覆盖）。
    // fire-and-forget：补拉失败不影响切模型主流程（syncTraceEntries 内部吞错）。
    this.deps.syncTraceEntries(sessionId, 'set_model')
    // U6 回执普查：返回 pi 实际生效模型（get_state 读回，'provider/id' 复合串）——
    // plugin agent.setModel 经此拿生效值回执；WS 侧 settings-message-handler 的
    // model.switch case 拆解该复合串回填 reply（对齐 C-pi-13 改状态 RPC 一律回生效值）。
    return effectiveModelId
  }

  /**
   * switchModel 的 get_state 回执普查读回（U6）：读回实际生效模型。字段缺失/非法/
   * get_state 抛错一律保持请求值 fallback（旧行为），不反噬切模型主链路。
   * thinkingLevel 不在此读回——其持久层由 pi 落 JSONL，内存快照经 thinkingLevel 实例
   * markDirty 重拉 get_state 收敛（U8a 前 sidecar 持久化是该读回的唯一消费者）。
   */
  private async readEffectiveModelId(
    sessionId: string,
    client: IPiEngine,
    fallbackModelId: string,
  ): Promise<string> {
    try {
      const state = await client.getState()
      return SessionModelControl.parseStateModelRef(state) ?? fallbackModelId
    } catch (e) {
      // 读回失败保持请求值（下游 markDirty 防抖重拉 get_state 仍会收敛到权威值）
      console.warn(`[session-service] switchModel get_state read-back failed for ${sessionId}, keeping requested model: ${toErrorMessage(e)}`)
      return fallbackModelId
    }
  }

  /** get_state.model 字段防卫解析：provider/id 均为非空 string 时返回 `${provider}/${id}` 复合串，否则 undefined（调用方 fallback 请求值）。 */
  private static parseStateModelRef(state: Record<string, unknown> | undefined): string | undefined {
    const model = state?.model
    const m = typeof model === 'object' && model !== null ? model as Record<string, unknown> : undefined
    if (!m || typeof m.id !== 'string' || m.id === '' || typeof m.provider !== 'string' || m.provider === '') {
      return undefined
    }
    return `${m.provider}/${m.id}`
  }

  /**
   * 设置思考档并返回 pi 生效值。
   *
   * P3（pi-assumption final gate）：pi 会钳制模型族不支持的档位（如 mimo 族 max →
   * high，clampThinkingLevel 就近回落），reply 与内存缓存若用请求值，会把 UI 的
   * pending 确认与 session 缓存污染成未生效档位。事件侧（PS-04 实证）：钳制致值变
   * （effective ≠ previous）必发 thinking_level_changed，isChanging=false 仅覆盖
   * 「值未变」场景；生效值以 set 后 get_state 快照为准（标量状态唯一权威读路径，
   * ADR-0062）。
   */
  async setThinkingLevel(sessionId: string, level: string): Promise<string> {
    // U2/D7：与 switchModel **同一激活语义**——停止态/回收态先在引擎侧真生效；不再有
    // 「无 client 时请求值兜底 + 内存直写」的第三种语义（它让 UI 显示一个引擎里并不存在的
    // 档位，且与相邻的模型控件行为不一致）。
    const client = await this.activate(sessionId)
    const session = this.deps.getSession(sessionId)
    if (!session) {
      throw errorWithCode(
        `session not registered after activation (sessionId=${sessionId})`,
        SESSION_ACTIVATE_FAILED,
      )
    }
    await client.setThinkingLevel(level)
    // session-trace（A33）：thinking_level_change 的 append 虽有事件但消费点在 pi 侧
    // extension 回调（taiji 不订阅）；与 set_model 同款，RPC 成功后主动补拉。
    // fire-and-forget：补拉失败不影响设档主流程（syncTraceEntries 内部吞错）。
    this.deps.syncTraceEntries(sessionId, 'set_thinking_level')
    const state = await client.getState()
    const effective = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : level
    // U6（P-S2 可观察点）：set→get_state→effective 链路日志——被钳场景（如 mimo 族
    // max → high）在 runtime 日志即可见「请求值 ≠ 生效值」，不再依赖前端体感反推。
    logger.debug('[session-service] setThinkingLevel effective', {
      sessionId,
      requested: level,
      effective,
      clamped: effective !== level,
    })
    // PR #185 S2 裁决的永久双写形态：effective 来自 pi get_state（权威值），直写让
    // toSummary 与 state_changed fallback 在实例防抖重拉窗口内即读准值（modelId 同理，
    // 见 switchModel）。值未变时 pi 不发事件、不写 entry（PS-04），此直写是唯一同步点；
    // 值变场景事件随后到达，直写保证防抖窗口内的即时性。
    session.thinkingLevel = effective
    // 持久层唯一写方 = pi（thinking_level_change entry 落 JSONL，缓存治理 U8a W2 写点退役），
    // 本方法只负责内存直写投影。
    return effective
  }
}
