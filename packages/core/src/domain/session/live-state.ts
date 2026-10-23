/**
 * session 状态层（SessionLiveState）——按会话 id 寄存的运行时状态缓存。
 *
 * 为什么独立成层（会话架构四层分离 W1，设计 §2.4 / §3.3「状态层」）：
 * 现状把「侧栏列表成员资格」当成了状态写入判据——`sessionStore.applySnapshot` 按
 * `list.find(id)` 落位，列表外的会话（btw 线是 runtime `hidden: true` 注册，不进
 * SessionScanner.listAll）状态帧被静默丢弃，只能靠另一套 btw 专用 store + 「回退主会话
 * 当前值」补偿，补偿本身违反 ADR-0122（事实驱动：无事实应显式未知）。
 *
 * 本层把状态从展示容器里剥出来：
 * - 键 = 会话 id（主会话 / btw 线 vid / 任意 id 同一个键空间，**无 sid 类别判据**）；
 * - 唯一写入口 `applyLiveState(id, patch)`，字段级合并（patch 未提供的维度保留现值）；
 * - 读口 `liveStateOf(id)`，缓存缺失返回 `undefined`（显式未知，禁止回退其他会话的值）；
 * - 条目生命周期独立于导航列表：整表刷新 / 项目过滤 / 归档**不得**触碰（I3），
 *   只有会话删除走显式 `removeLiveState(id)`。
 *
 * 响应式：内部用 Vue `reactive(Map)`（core 现有 store 用 ref；Map 形态是为按 id 分区，
 * ADR-0049 分区范式）。`liveStateOf` 在调用方 computed 内读 Map → 依赖自动收集。
 *
 * 数据登记：docs/architecture/data-source-registry.md 主表 #76（C-data-02）；
 * 声明处 `@data-owner #76`。本条替代已退役的 #63（btw 线模型/思考档显示态 store）。
 */
import { reactive } from 'vue'

/**
 * 会话运行时状态（W1 最小面）：模型复合串 + 思考档。
 *
 * W1 刻意不扩 usage / commands / occupancy——那是 W2 决策项（权威拉取与冷读）。
 * 字段缺省 = 该维尚未观测到（显式未知，不是「空值」）。
 */
export interface SessionLiveState { // oe-exempt:20261023:framework:类型契约先行——状态层契约为双壳（renderer/mobile）+ core deps 共同消费面，D1 单元即消费方
  /** 当前模型复合串 "provider/modelId"（与 SessionSummary.modelId 同格式） */
  modelId?: string
  /** 思考等级（PI_THINKING_LEVELS 值域）；缺省 = 尚未观测 */
  thinkingLevel?: string
}

/** 状态层契约（core 内 deps 注入面 / 壳层薄壳同形）。 */
export interface SessionLiveStateStore { // oe-exempt:20261023:framework:类型契约先行——状态层契约（core factory 产物面，pinia 薄壳/mobile 直接实例化同形）
  /** 唯一写入口：字段级合并（patch 未提供的维度保留现值） */
  applyLiveState(id: string, patch: SessionLiveState): void
  /** 读口：缓存缺失返回 undefined（显式未知；禁止回退其他会话的值） */
  liveStateOf(id: string): SessionLiveState | undefined
  /** 唯一清退口：会话删除时调用；列表刷新/过滤/归档不得调用 */
  removeLiveState(id: string): void
}

/**
 * 创建状态层（纯 factory，无 pinia 依赖——与 createSessionStore 同范式）。
 *
 * 声明处 `@data-owner #76`：条目注册 = docs/architecture/data-source-registry.md 主表 #76。
 */
export function createSessionLiveState(): SessionLiveStateStore {
  // @data-owner #76 —— 主表 #76 会话运行时状态层（按会话 id 寄存；写入口唯一 = applyLiveState）
  const states = reactive(new Map<string, SessionLiveState>())

  function applyLiveState(id: string, patch: SessionLiveState): void {
    if (!id) return
    const prev = states.get(id)
    const next: SessionLiveState = prev ? { ...prev } : {}
    if (patch.modelId !== undefined) next.modelId = patch.modelId
    if (patch.thinkingLevel !== undefined) next.thinkingLevel = patch.thinkingLevel
    // 写入新对象（而非原地 mutate）：computed 消费方无需深度追踪，且旧引用快照语义稳定。
    states.set(id, next)
  }

  function liveStateOf(id: string): SessionLiveState | undefined {
    return states.get(id)
  }

  function removeLiveState(id: string): void {
    states.delete(id)
  }

  return { applyLiveState, liveStateOf, removeLiveState }
}

/**
 * 选择器工厂（core 侧纯函数）：把状态层折成 `sessionId → LiveState | undefined` 的读取口。
 *
 * 为什么需要：composer / 面板等消费方的 deps 契约是 `getSessionState(sid)`，直接闭包
 * `liveStateOf` 也可，但把它显式化为工厂有两个好处——① 消费方拿到的读取口只读（不暴露写口）；
 * ② 与壳层 `useSessionLiveState` 共用同一实现，composer 不再自写「列表查找 + btw 回退」。
 *
 * 返回 `undefined` = 该会话状态尚未观测到（显式未知）；**禁止**回退其他会话的值
 * （设计 §2.4 I5 / §6「未知状态」行）。
 */
export function createSessionLiveStateSelector(
  liveState: SessionLiveStateStore,
): (sessionId: string) => SessionLiveState | undefined {
  return (sessionId: string) => liveState.liveStateOf(sessionId)
}
