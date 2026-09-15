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
import type { IProcessManager, IPiEngine } from '../ports/pi-engine.js'
import type { IManagedSessionView } from './types.js'
import type { SessionReplicatedStates } from './session-state-projection.js'
import { toErrorMessage } from '../../utils/errors.js'
// persistModelBinding 实现已迁至 infra/pi/session-model-sidecar（max-lines 行数合规）；
// 本文件保持经 session-file-utils 的 re-export 导入——services 层 infra 直引白名单以
// session-file-utils 锚定（三层守卫 check_services_infra_import），且 restore 播种测试的
// mock factory 锚定同一导入面。
import { persistModelBinding } from '../../infra/pi/session-file-utils.js'
import { logger } from '../../infra/logger.js'

/**
 * SessionModelControl 装配依赖（窄注入，S5/D2 风格：原 Facade 字段/子模块直读的逐字等价面）。
 */
export interface SessionModelControlDeps {
  /** pi 进程管理（getClient：set RPC + get_state 回执读回）。 */
  pm: IProcessManager
  /** sessions Map 只读查询（lifecycle 所有者）：session 定位 + modelId/thinkingLevel 直写。 */
  getSession(sessionId: string): IManagedSessionView | undefined
  /** 标量实例组访问器（projection）：modelId/usage/thinkingLevel 三实例的 markDirty 失效。 */
  getReplicatedStates(sessionId: string): SessionReplicatedStates | undefined
  /** trace 增量腿补拉（traceSync）：set_model/set_thinking_level 的 RPC 成功后补拉。 */
  syncTraceEntries(sessionId: string, trigger: string): void
}

export class SessionModelControl {
  constructor(private readonly deps: SessionModelControlDeps) {}

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
    const session = this.deps.getSession(sessionId)
    if (!session) throw new Error('session not active')
    const newModelId = `${provider}/${modelId}`
    const client = this.deps.pm.getClient(sessionId)
    if (!client) return sessionId // 无活跃 pi 进程：跳过缓存写和广播，不假装成功
    try {
      await client.setModel(provider, modelId)
    } catch (e) {
      console.error(`[session-service] switchModel RPC failed: sessionId=${sessionId}, model=${newModelId}`, e)
      throw e
    }
    // 回执普查（U6，D3④）：pi pattern 引擎可能把请求模型静默换成同族条目（事故 A 形态），
    // 请求值 ≠ 生效值——set 后 get_state 读回实际生效模型，双写缓存与返回值都用生效值
    //（与 setThinkingLevel 的 set→get_state→effective 同款模式，PS-03/PS-01）。
    // get_state 失败 fallback 请求值（旧行为），不反噬切模型主链路。
    const effective = await this.readEffectiveModelState(sessionId, client, newModelId, session.thinkingLevel ?? '')
    const effectiveModelId = effective.modelId
    const effectiveThinkingLevel = effective.thinkingLevel
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
    // 持久化 model binding sidecar（switchModel 生效后写入 .model.json）。
    if (session.sessionFilePath) {
      try {
        persistModelBinding(session.sessionFilePath, effectiveModelId, effectiveThinkingLevel)
      } catch (e) {
        // best-effort：sidecar 写失败不阻塞 switchModel 主链路——重启后 get_state 读回自愈
        console.warn(`[session-service] persistModelBinding failed after switchModel: ${toErrorMessage(e)}`)
      }
    }
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
   * switchModel 的 get_state 回执普查读回（U6）：一次 get_state 同时读回生效模型与
   * thinkingLevel。字段缺失/非法/get_state 抛错一律保持请求值 fallback（旧行为），
   * 不反噬切模型主链路（thinkingLevel 供 sidecar 持久化使用）。
   */
  private async readEffectiveModelState(
    sessionId: string,
    client: IPiEngine,
    fallbackModelId: string,
    fallbackThinkingLevel: string,
  ): Promise<{ modelId: string; thinkingLevel: string }> {
    try {
      const state = await client.getState()
      const modelId = SessionModelControl.parseStateModelRef(state) ?? fallbackModelId
      // 同次 get_state 读回 thinkingLevel（pi 生效思考等级），用于 sidecar 持久化
      const thinkingLevel = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : fallbackThinkingLevel
      return { modelId, thinkingLevel }
    } catch (e) {
      // 读回失败保持请求值（下游 markDirty 防抖重拉 get_state 仍会收敛到权威值）
      console.warn(`[session-service] switchModel get_state read-back failed for ${sessionId}, keeping requested model: ${toErrorMessage(e)}`)
      return { modelId: fallbackModelId, thinkingLevel: fallbackThinkingLevel }
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
    const client = this.deps.pm.getClient(sessionId)
    if (!client) {
      // 无活跃进程（理论不可达：调用方都在活跃 session 语境）——请求值兜底，行为同旧版
      const session = this.deps.getSession(sessionId)
      if (session) session.thinkingLevel = level
      return level
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
    const session = this.deps.getSession(sessionId)
    // PR #185 S2 裁决的永久双写形态：effective 来自 pi get_state（权威值），直写让
    // toSummary 与 state_changed fallback 在实例防抖重拉窗口内即读准值（modelId 同理，
    // 见 switchModel）。值未变时 pi 不发事件、不写 entry（PS-04），此直写是唯一同步点；
    // 值变场景事件随后到达，直写保证防抖窗口内的即时性。
    if (session) session.thinkingLevel = effective
    // 持久化 model binding sidecar（setThinkingLevel 生效后写入 .model.json）。
    if (session?.sessionFilePath) {
      try {
        persistModelBinding(session.sessionFilePath, session.modelId, effective)
      } catch (e) {
        // best-effort：sidecar 写失败不阻塞 setThinkingLevel 主链路——重启后 get_state 读回自愈
        console.warn(`[session-service] persistModelBinding failed after setThinkingLevel: ${toErrorMessage(e)}`)
      }
    }
    return effective
  }
}
