/**
 * Composer 工具条的模型 + 思考等级状态管理。
 *
 * 从 Composer.vue 拆出（script setup 行数合规）。职责：
 * - currentModelId：当前选中模型（[D3] session 已建读自身真值，空值→占位；landing 态读
 *   resolveLaunchConfig 全序解析 currentModel(explicit) → preset.modelOverride →
 *   lastUsedModel（D4 校验）→ 全局默认）
 * - currentThinkingLevel：当前思考等级（[D3] session 已建读自身真值，空值→占位；landing 态用 localThinkingLevel）
 * - currentThinkingLevelMap：当前模型的思考档位映射 + 切模型自动重置（委托 useThinkingLevelSync）
 * - onModelSelect / onThinkingSelect：切换处理，session 已建走 RPC，landing 态记 pending /
 *   authored 值，首发提交时经 resolve 终值随 create 快照透传（D5，无 post-create apply）
 * - Staging Mode（ADR-0056）：enter/exit 快照隔离 + getStagingConfig 导出暂存配置
 *
 * per-session 隔离：session 已建态按 sessionId 查真值（经 deps.getSessionState，非读全局 active），
 * split panel 下两个 Composer 各读各的 session 状态，不串读。底层数据已 per-session
 * （SessionSummary.modelId/thinkingLevel + applySnapshot(id,...)），此处只接对数据源。
 *
 * landing 态（sessionId=null）session 尚未 create，无法调 model.switch / setThinkingLevel RPC。
 * 选定值记入 pendingModel + localThinkingLevel，首发提交时经 resolveLaunchConfig 终值随
 * create payload 快照透传（D5，无 post-create apply 通道）。
 *
 * Staging Mode（ADR-0056）：composer 进入 fork-ask/handoff-ask 暂存态时，模型/thinking chip
 * 切换只写暂存快照（不影响当前源 session）。退出暂存态时清空快照，chip 恢复读常规态真值。
 * 发送时 getStagingConfig() 导出暂存配置，透传给 fork/handoff RPC 供新 session 使用。
 *
 * [W3 迁移] 迁自 renderer composables/panel/useComposerModelThinking.ts。改动：
 * - 去掉 renderer 跨域依赖（useSessionStore/useSettingsStore/useNewTaskFlow/useModel 4 个），
 *   改为经 deps 回调注入（getSessionState/defaultModel/currentModel/setPendingModel/switchModel/
 *   setThinkingLevel），core 零 store 依赖。
 * - thinking-level-sync 委托：原内部读 settingsStore.providers，现 core 已有 useThinkingLevelSync(...,deps)
 *   接收 getThinkingLevelMap。deps 加第 7 字段 getThinkingLevelMap 透传给 sync。
 * - import 路径 `@/composables/panel/useThinkingLevelSync` → core 本域 `./thinking-level-sync`（batch2 已迁入）。
 * 函数签名 / 逻辑 byte-level 保持。
 *
 * [u3 记忆恢复 → U2a authored-only 收窄]（记忆表 = ./model-thinking-memory）：
 * - armed 意图持有与设立：onModelSelect staging/已建分支设 {modelId, at, callId}（landing 分支
 *   不设——U2a 删除，landing 记忆档经 resolveLaunchConfig 解析链生效，armed 恢复通道在 landing
 *   结构性不存在，设计 state-truth-sync-architecture D5）；已建态走 try/catch——失败清/成功清
 *   均按 callId 归属校验（规则 4/5）；换绑 watch 清（规则 6，注册先于 sync watch）
 * - in-flight 按 callId 引用计数：规则 1 过期判定的豁免数据源（E10），finally 撤销晚于 flush
 * - [U2a/D2 authored-only] 记录点收窄为 onThinkingSelect（唯一）：显式选档时刻入表（三分支统一，
 *   记录不问生效）；「生效即记录」watch 及纪元/第三形态守卫整体废除（设计 D2/D9——非 authored
 *   值结构性不到达记录路径，防污染 by construction）
 * - [U2a/D1] landing 显示改线：chip 读 resolveLaunchConfig 输出（单一解析层，显示 ≡ 生效 by
 *   construction）；landing auto 值机制（follow watch + localAuthored）删除，localThinkingLevel
 *   只存 authored 值（唯一写点 = routeThinkingLevel landing 支；例外 = sync 分支 3 安全网，
 *   D10-E10 声明保留）
 * - [U4r2] chip 侧 resolve 输入补 pendingPreset 通道（deps 新增可选 getter，壳层从 flow
 *   pendingPreset 只读视图接线）——D1「pending 三兄弟」在显示侧补齐，显式 preset 选择的
 *   捆绑字段进入 chip 显示（等价破口修复，守卫见 launch-config-equivalence.test.ts 全矩阵）
 * - 对外 API 不变（u4 壳层解构面零变化）；记忆模块为 core 域内单例，直接 import（非 deps 注入）
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { PiLaunchPreset, ProviderId, ProviderInfo } from '@taiji/shared'
import { useThinkingLevelSync } from './thinking-level-sync'
import {
  normalizeSupportedLevels,
  resolveThinkingKey,
} from './thinking-levels'
import { createLaunchConfigView } from '../new-task-search/launch-config'
import { loadOnce, lookup, record } from './model-thinking-memory'
import {
  loadOnce as loadLastUsedOnce,
  lookup as lookupLastUsed,
  record as recordLastUsed,
} from './last-used-model'

/** useComposerModelThinking 的注入依赖（壳层 Composer 从各 store/composable 派生后注入）。 */
export interface ModelThinkingDeps {
  /** 按 sessionId 查 session 真值（per-session 隔离核心：壳层从 sessionStore.list.find 派生） */
  getSessionState: (sessionId: string) => { modelId: string; thinkingLevel?: string } | null
  /** 全局默认模型（壳层从 settingsStore.defaultModel 派生，响应式：landing 按钮需在 store 异步填充后更新） */
  defaultModel: ComputedRef<string>
  /** landing 态 flow 选定模型（壳层从 useNewTaskFlow().currentModel 取） */
  currentModel: ComputedRef<string | null>
  /**
   * [U4r2] landing 态 flow 显式选定 preset id（壳层从 useNewTaskFlow().pendingPreset
   * 只读视图取——与 currentModel 同族的 flow pending 状态读通道，非 launchData store 数据）。
   * launchConfigView 仅 landing 态消费（已建态/staging 显示不感知）；未注入时 chip 侧
   * resolve 输入缺 pendingPreset——显式 preset 选择不进显示链，chip 按「默认 preset」
   * 解析而 submit 按显式 preset 解析（显示 ≠ 生效，U4 round 1 发现的等价破口形态）。
   * getter 闭包内读响应式源（computed 视图），数据变化显示自动重算。
   */
  pendingPreset?: () => string | null | undefined
  /** landing 态记 pendingModel（壳层从 useNewTaskFlow().setPendingModel 取） */
  setPendingModel: (model: string) => void
  /** 已建态切模型 RPC 回执写编排（壳层从 useModel().switchModel 取） */
  switchModel: (sessionId: string, provider: ProviderId, modelId: string) => Promise<void>
  /** 已建态设思考等级 RPC 回执写（壳层从 useModel().setThinkingLevel 取） */
  setThinkingLevel: (sessionId: string, level: string) => Promise<void>
  /** 按 modelId 派生 thinkingLevelMap（透传给 useThinkingLevelSync，壳层从 settingsStore.providers 解析） */
  getThinkingLevelMap: (modelId: string) => Record<string, string | null> | undefined
  /**
   * 按 modelId 派生档位可用集（ProviderInfo.models[].supportedLevels，U6 切源——runtime
   * 能力注册表 pi 同源计算的 view-ready 下发，renderer 零推导）。non-reasoning 模型该集
   * 为 ['off']；undefined = 下发链路未接通（归一为默认五档）。
   */
  getSupportedLevels: (modelId: string) => string[] | undefined
  /**
   * [U2a] landing 态生效配置解析数据注入（消费 resolveLaunchConfig，设计
   * state-truth-sync-architecture §3.3 D1 单一解析层）：landing chip 显示与 submit
   * 侧（U2b 改线）消费同一 resolve 输出，「显示 ≡ 生效」由构造成立。getter 闭包内
   * 读壳层响应式 store（preset store / settings store），createLaunchConfigView 据此
   * 建立依赖——数据晚到显示自动重算（P5①）。core 零 store 依赖（同本接口其余字段先例）。
   * 可选：未注入时解析退化为 explicit > defaultModel（preset 档不可达；lastUsedModel 档
   * 因 D4 校验无能力表而跳过）——完整解析行为需壳层接线 launchData。
   */
  launchData?: {
    /** preset 列表（renderer preset store） */
    presets?: () => readonly PiLaunchPreset[] | undefined
    /** 全局默认 preset id（PiPresetsFile.defaultPresetId，空 = 未设 → builtin:full） */
    defaultPresetId?: () => string | null | undefined
    /** providers 能力表（settings store；D4 lastUsedModel 校验 + 记忆档 map 派生） */
    providers?: () => readonly ProviderInfo[] | undefined
  }
}

export function useComposerModelThinking(
  sessionId: ComputedRef<string | null> | Ref<string | null>,
  deps: ModelThinkingDeps,
): {
  currentModelId: ComputedRef<string>
  currentThinkingLevel: ComputedRef<string | undefined>
  currentThinkingLevelMap: ComputedRef<Record<string, string | null> | undefined>
  /** 当前模型档位可用集（supportedLevels，U6 切源；下发未接通时 undefined → 归一默认五档） */
  currentSupportedLevels: ComputedRef<string[] | undefined>
  localThinkingLevel: Ref<string | undefined>
  onModelSelect: (payload: { modelId: string; provider: ProviderId }) => Promise<void>
  onThinkingSelect: (level: string) => Promise<void>
  /** Staging Mode：进入暂存态（快照当前模型/thinking） */
  enterStagingMode: () => void
  /** Staging Mode：退出暂存态（清空快照，恢复常规态） */
  exitStagingMode: () => void
  /** Staging Mode：获取暂存配置（供 fork/handoff 发送时透传给新 session） */
  getStagingConfig: () => { modelOverride?: string; thinkingOverride?: string }
} {
  const {
    getSessionState,
    defaultModel,
    currentModel,
    pendingPreset: getPendingPreset,
    setPendingModel,
    switchModel,
    setThinkingLevel: applyThinkingLevel,
    getThinkingLevelMap,
    getSupportedLevels,
    launchData,
  } = deps

  /**
   * landing 态本地 authored 思考等级（session 尚未 create，无 session 真值）。
   * authored-only：唯一写点 = routeThinkingLevel landing 支（用户显式选档；唯一例外 =
   * sync 分支 3 可用性安全网，D10-E10 声明保留）——切模型不自动写最高可用档，landing
   * 显示初值由 resolveLaunchConfig 解析链给出（U2a）。首发提交时作 explicit 输入进
   * resolve，终值随 create payload 快照透传（D5，无 post-create setThinkingLevel）。
   */
  const localThinkingLevel = ref<string | undefined>(undefined)

  // ── Staging Mode（ADR-0056）────────────────────────────────────
  /**
   * 暂存快照：进入 fork-ask/handoff-ask 时快照当前模型/thinking。
   * null = 常规态（读 session/landing 真值）；非 null = 暂存态（读快照值）。
   * 退出暂存态时清空（null），chip 自动恢复读常规态真值。
   */
  const stagingModel = ref<string | null>(null)
  const stagingThinking = ref<string | undefined>(undefined)

  // ── [u3 记忆恢复] armed 切模型意图 + in-flight 计数（设计 D3）────────────
  /**
   * armed 完整结构（D3）：消费侧只读切片 {modelId, at} 已由 u2 的 ArmedModelSwitchIntent
   * 定义，本结构多一个 callId 供规则 4/5 的归属校验（结构化兼容该切片，无需显式实现）。
   * 每次显式选模型自增唯一 callId——并发连切时后一次调用覆盖 armed（所有权转移），
   * 先回包的调用只允许操作自己设立的 token。
   */
  interface ArmedIntent {
    modelId: string
    at: number
    callId: number
  }

  const armed = ref<ArmedIntent | null>(null)
  let armedCallIdSeq = 0

  /**
   * in-flight switchModel 按 callId 引用计数（Set，非 reactive——消费侧经闭包同步读，
   * 无 watch 依赖）。规则 1 过期判定的豁免数据源：finally 撤销自己份额必然晚于
   * watch flush（D3 证据②），慢 RPC 回包触发的消费落在计数仍 >0 的豁免窗内（E10）。
   */
  const inFlightCallIds = new Set<number>()

  /**
   * [u3·D3 规则 6「换绑清」] panel 换绑 session 瞬间清 armed——无论 callId 归属：
   * 切模型意图绑定发起时的 session，换绑即作废全部未消费意图。
   * 必须注册在 useThinkingLevelSync 的 sync watch 之前：同一 flush 内 watch job 按
   * 注册序执行，若消费检查先跑，换绑到恰为 armed 目标模型的 session 会在作废前被
   * 消费（伪恢复，D3 被否①的换绑变体）。
   */
  watch(sessionId, () => {
    armed.value = null
  })

  /**
   * 规则 4/5 专用清（callId 归属校验）：只清自己设立的 token——arm 后被后续调用
   * 覆盖时所有权已转移，先回包调用禁清后来者的（D3 callId 归属校验）。
   */
  function clearArmedIfOwner(callId: number): void {
    if (armed.value?.callId === callId) armed.value = null
  }

  /**
   * 按 sessionId 查 session 真值（per-session 隔离的核心）。
   * session 已建态经 deps.getSessionState 按 id 查（非读全局 active——active 是单焦点，
   * split 下非聚焦 panel 会串读）；landing 态（sessionId=null）返回 null，走 landing 分支。
   */
  const sessionState = computed(() =>
    sessionId.value ? getSessionState(sessionId.value) ?? null : null,
  )

  // ── [U2a/D1] landing 态生效配置解析视图（单一解析层）───────────────────
  /**
   * landing chip 显示消费 resolveLaunchConfig 输出（设计 state-truth-sync §3.3 D1）：
   * 旧显示链（currentModel > lastUsedModel > defaultModel）与生效链独立解析必然发散
   * （§2.3-①③），改线后显示与 submit（U2b 透传）消费同一输出，「显示 ≡ 生效」由构造
   * 成立。已建态/staging 显示不消费本视图（读 session 真值 / 暂存快照）。
   *
   * 输入经 getter 闭包读响应式源：launchData getters 内读壳层 store；lookupLastUsed /
   * lookup 是模块级 reactive 源——KV 冷启动晚到时视图自动重算（P5①），无需补写回调。
   * pendingThinkingLevel = localThinkingLevel（U2a 后唯一写点 = routeThinkingLevel
   * landing 支，只含 authored 值——D1 authored 守卫的结构前提；例外 = sync 分支 3
   * 安全网经同一通路写入，D10-E10 声明保留）。
   * pendingPreset = deps 显式选定 preset（U4r2 通道，D1 pending 三兄弟至此齐备）——
   * 仅 landing 态消费（已建态/staging 分支显示不感知，与 pendingThinkingLevel 同款门控）。
   */
  const launchConfigView = createLaunchConfigView(() => ({
    pendingModel: currentModel.value,
    pendingThinkingLevel: sessionId.value === null ? localThinkingLevel.value : null,
    pendingPreset: sessionId.value === null ? getPendingPreset?.() ?? null : null,
    lastUsedModel: lookupLastUsed(),
    getRememberedThinkingLevel: lookup,
    presets: launchData?.presets?.(),
    defaultPresetId: launchData?.defaultPresetId?.(),
    providers: launchData?.providers?.(),
    defaultModel: defaultModel.value,
    getSupportedLevels,
  }))

  /**
   * 常规态思考等级（不受 staging 影响，供 enterStagingMode 快照读取）。
   * [D3 显示分流] 已建 session 空值 → 返回 undefined 作为占位信号（不回落 landing 残留）；
   * landing 态 → resolve 输出（explicit authored > preset > memory > 最高可用档，
   * 解析链终点恒有值——authored 缺位时 localThinkingLevel 为 undefined 不参与）。
   */
  const regularThinkingLevel = computed(() => {
    if (sessionId.value !== null) {
      // 已建态：读 session 真值；空值 → undefined 占位，不回落 landing 残留
      return sessionState.value?.thinkingLevel
    }
    // landing 态：resolve 输出（|| undefined 防御空串归一为占位信号）
    return launchConfigView.value.thinkingLevel || undefined
  })

  /**
   * 常规态模型 id（不受 staging 影响，供 enterStagingMode 快照读取）。
   * [D3 显示分流] 已建 session 空值 → 返回 '' 占位（不回落 landing 残留 / 全局默认）；
   * landing 态 → resolve 输出（explicit > preset.modelOverride > lastUsedModel(D4 校验)
   * > defaultModel——与 submit 侧同一解析，不再单独兜底）。
   */
  const regularModelId = computed(() => {
    if (sessionId.value !== null) {
      // 已建态：读 session 真值；空串 → '' 占位，不兜底到其他模型
      return sessionState.value?.modelId ?? ''
    }
    // landing 态：resolve 输出（单一解析层——任何一侢单独兜底都是发散源，设计 D1）
    return launchConfigView.value.model
  })

  /** 当前思考等级：staging 活跃时读快照，否则读常规态真值 */
  const currentThinkingLevel = computed(
    () => stagingModel.value !== null
      ? stagingThinking.value
      : regularThinkingLevel.value,
  )

  /**
   * 当前选中模型 id（"provider/modelId" 复合串）。
   * staging 活跃时读暂存快照，否则读常规态真值（session 真值 > landing resolve 全序解析：
   * currentModel(explicit) → preset.modelOverride → lastUsedModel（D4 校验）→ 全局默认）。
   */
  const currentModelId = computed(
    () => stagingModel.value !== null
      ? stagingModel.value
      : regularModelId.value,
  )

  /** 当前模型的思考档位映射 + 切换模型后重置不可用等级（逻辑见 useThinkingLevelSync） */
  const currentThinkingLevelMap = useThinkingLevelSync(
    currentModelId,
    currentThinkingLevel,
    // [U2a/D2 authored-only] 自动对齐走内部路由（routeThinkingLevel）而非用户入口
    // onThinkingSelect——用户入口带记忆记录（唯一记录点），自动对齐值非用户 authored、
    // 不得入表（「生效即记录」watch 已删除，非 authored 值必须结构性绕开记录路径）
    (level) => { void routeThinkingLevel(level) },
    {
      getThinkingLevelMap,
      getSupportedLevels,
      // [u3·D3] armed 意图 + in-flight 计数 + 记忆查询接入消费侧（u2 契约，配对闭环）
      getRememberedLevel: lookup,
      getArmed: () => armed.value,
      clearArmed: () => { armed.value = null },
      getInFlightCount: () => inFlightCallIds.size,
    },
  )

  /** 当前模型档位可用集（供 popover 判定可用档，U6 切 supportedLevels） */
  const currentSupportedLevels = computed(() => getSupportedLevels(currentModelId.value))

  // ── [U2a] KV 惰性预载（resolve 输入源）────────────────────────────────
  /**
   * 记忆表与 lastUsedModel 是 launchConfigView 的输入源（memory / lastUsed 档）。
   * fire-and-forget 触发（幂等）；加载完成后 lookup / lookupLastUsed 的 reactive 源
   * 更新驱动视图自动重算（P5①）——旧「加载完成回调补一次跟随重设」已随 follow watch
   * 整体删除（landing auto 值机制废除，未 authored 的显示值由 resolve 解析而非写入
   * localThinkingLevel，无补写需求）。
   */
  loadOnce()
  loadLastUsedOnce()

  /**
   * 模型切换：staging 活跃时只写快照（不调 RPC，不改源 session）。
   * session 已建走 deps 注入的编排（RPC 回执写）；
   * landing 态（sid=null）session 尚未 create，记 pendingModel 供首发提交时经 resolve
   * 终值随 create 透传（D5）。
   *
   * [u3·D3] staging / 已建两分支各设 armed 意图（{modelId, at, callId}）：恢复只挂在显式
   * 切模型上，消费点在 sync watch 回调顶部（u2 规则 1/2/3）；本函数只负责设立与生命周期
   * 防线（规则 4 失败清 / 规则 5 成功清 / 规则 6 换绑清见上方 watch）。
   * [U2a] landing 分支不设 armed（旧 landing armed 设立已删）：landing 的记忆档经
   * resolveLaunchConfig 解析链在显示与创建两侧生效（D5），armed 恢复通道在 landing
   * 结构性不存在——显式选模型后显示即 resolve 的 explicit 档，无需暂挂恢复意图。
   */
  async function onModelSelect(payload: { modelId: string; provider: ProviderId }): Promise<void> {
    const callId = ++armedCallIdSeq
    const targetModelId = `${payload.provider}/${payload.modelId}`
    // Staging Mode：只写暂存快照，不影响当前源 session
    if (stagingModel.value !== null) {
      // [U-fix-1] re-select 判定必须在写快照之前（写后 currentModelId 即为 target，恒「匹配」）
      const reselect = targetModelId === currentModelId.value
      stagingModel.value = targetModelId
      // armed 同步设立（staging 分支）：恢复经同一 onReset 通路写入暂存快照（B5——暂存态
      // 恢复不另设通路）；无 RPC。re-select 同模型不设——无反应性变化 watch 必不触发，
      // 设了必然悬留，5s 内一次 providers 刷新的无关触发会经规则 2 匹配分支把记忆值写回
      // 快照（D3 规则 5 要消灭的「chip 突跳伪恢复」形态，staging 无 RPC 无成功清兜底，源头跳过）
      if (!reselect) {
        armed.value = { modelId: targetModelId, at: Date.now(), callId }
      }
      return
    }
    // landing 态延迟 create：记 pendingModel，首发提交时经 resolve 终值随 create 透传（D5）
    if (!sessionId.value) {
      setPendingModel(targetModelId)
      // [D4] lastUsedModel 写入（仅显式选模型，staging 试选不写——入口已在上方 staging return）
      recordLastUsed(targetModelId)
      return
    }
    // 已建态：RPC 回执写（编排逻辑归壳层 useModel，ADR-0028）
    armed.value = { modelId: targetModelId, at: Date.now(), callId }
    inFlightCallIds.add(callId)
    try {
      await switchModel(sessionId.value, payload.provider, payload.modelId)
      // [D4] lastUsedModel 写入（仅显式选模型，staging 试选不写——入口已在上方 staging return）。
      // 置于 RPC 成功后、clearArmedIfOwner 之前：RPC 失败 = 本次切换未生效，landing 粘滞
      // 默认不指向切换失败的模型（与 armed「失败清」防线同向）
      recordLastUsed(targetModelId)
      // [u3·D3 规则 5「成功清」] 时序依据（D3 证据②）：applySnapshot 在 switchModel 内同步
      // 执行，watch flush 微任务于 applySnapshot 时刻入队，本 await 续段晚于 flush——
      // watch 回调总是先跑。故此处只对「回调未能消费」的残留 token 生效（pi 静默换模 /
      // re-select 同模型），清除后陈旧 token 不再被后续无关触发延迟消费（chip 突跳伪恢复）。
      clearArmedIfOwner(callId)
    } catch (err) {
      // [u3·D3 规则 4「失败清」/ E4] RPC 失败 store 不写（U6 现状语义），armed 立即清除
      // 自己 callId 的——失败 token 残留会被后续换绑到同模型 session 误消费（D3 被否②(a)）。
      // 重抛维持调用方既有失败路径不变。
      clearArmedIfOwner(callId)
      throw err
    } finally {
      // [u3·E10] in-flight 撤销必须留在 finally（晚于 flush）：回包触发的 watch 消费发生在
      // 计数仍 >0 的豁免窗内，规则 1 不误杀慢 RPC（>5s 回包仍正常匹配消费）
      inFlightCallIds.delete(callId)
    }
  }

  /**
   * [U2a/D2 authored-only] 记忆记录点（唯一）：用户显式选档时刻入表，不问生效。
   * 归属模型 = 选档动作的上下文模型 currentModelId（三分支自然投影：staging = 暂存
   * 快照模型 / landing = resolve 当时选中模型 / 已建 = session 真值模型——选档动作
   * 的上下文模型即归属模型，三分支均是用户显式选择）。
   * 带 UI key 转换（u3 D1：跨模型恢复的语义是档位名）+ 可用性校验（E5 防线，平移自
   * 被删「生效即记录」watch 的既有校验——体系外脏值不入表）。
   *
   * 刻意反转声明（设计 state-truth-sync D2 + R4 审查确认）：staging 试选后取消（未
   * commit）/ landing 选后未发送同样留痕——记录发生在选择时刻，「用户显式选过的档」
   * 语义一致，双向可用性校验兜底（恢复时仍校验目标模型可用性），良性自愈。这是对旧
   * 代码注释「暂存取消时不该入表」排除语义的刻意反转。
   *
   * 「生效即记录」watch 已随本机制整体废除：非 authored 值（preset 档 / pi 归一档 /
   * 钳制值 / session 加载值 / 切模型自动对齐值）结构性不到达记录路径，防污染 by
   * construction——纪元守卫 / 第三形态守卫失去存在理由一并删除（设计 D9 净减法）。
   */
  function recordAuthoredThinking(level: string): void {
    const modelId = currentModelId.value
    // 模型未就绪（landing 全链空防御形态 / 已建态空串占位）无法归属，跳过
    if (!modelId) return
    // 记录 UI key（D1）——value 经当前模型 map 反查
    const uiKey = resolveThinkingKey(level, getThinkingLevelMap(modelId))
    // 可用性校验（E5 防线）：体系外脏值不入表
    if (!normalizeSupportedLevels(getSupportedLevels(modelId)).includes(uiKey)) return
    record(modelId, uiKey)
  }

  /**
   * 思考等级切换（用户显式入口 = authored 唯一记录点）。
   * [U2a/D2] 三分支统一在此记录（记录不问生效——staging 取消 / landing 未发送同样
   * 留痕，见 recordAuthoredThinking 注释）；随后与自动对齐同构路由。
   */
  async function onThinkingSelect(level: string): Promise<void> {
    recordAuthoredThinking(level)
    await routeThinkingLevel(level)
  }

  /**
   * 思考等级路由（三分支，原 onThinkingSelect 主体）。
   * [U2a/D2] sync onReset 的自动对齐走本函数而非用户入口：用户入口带记忆记录
   * （authored-only 唯一记录点），自动对齐值非用户 authored、不得入表——「生效即
   * 记录」watch 删除后记录路径只此一处，入口拆分即防污染的结构保证。
   * landing 支写 localThinkingLevel 亦在本函数——localThinkingLevel 的唯一写点
   * （用户 authored 与 sync 分支 3 安全网共用此通路，后者为 D10-E10 声明的唯一例外）。
   */
  async function routeThinkingLevel(level: string): Promise<void> {
    // Staging Mode：只写暂存快照
    if (stagingModel.value !== null) {
      stagingThinking.value = level
      return
    }
    // landing 态延迟 create：记 authored 档，首发提交时作 explicit 输入进 resolve、终值随 create 透传（D5）
    if (!sessionId.value) {
      localThinkingLevel.value = level
      return
    }
    // 已建态：RPC 回执写（编排逻辑归壳层 useModel，ADR-0028）
    await applyThinkingLevel(sessionId.value, level)
  }

  /**
   * Staging Mode：进入暂存态。
   * 快照当前 currentModelId + currentThinkingLevel 到 staging refs。
   * 之后 chip 切换只改 staging 值，不影响源 session。
   */
  function enterStagingMode(): void {
    // 先快照再切 stagingModel：stagingModel 置位后 currentModelId/currentThinkingLevel
    // 即切读 staging 分支，反序快照会把 undefined 写进 stagingThinking（UF1b）
    stagingThinking.value = currentThinkingLevel.value
    stagingModel.value = currentModelId.value
  }

  /**
   * Staging Mode：退出暂存态。
   * 清空 staging refs，chip 自动恢复读常规态真值（源 session 的模型）。
   */
  function exitStagingMode(): void {
    stagingModel.value = null
    stagingThinking.value = undefined
  }

  /**
   * Staging Mode：获取暂存配置（供 fork/handoff 发送时透传给新 session）。
   * 返回 undefined 字段不传（runtime 走默认/preset 兜底）。
   */
  function getStagingConfig(): { modelOverride?: string; thinkingOverride?: string } {
    if (stagingModel.value === null) return {}
    return {
      ...(stagingModel.value ? { modelOverride: stagingModel.value } : {}),
      ...(stagingThinking.value ? { thinkingOverride: stagingThinking.value } : {}),
    }
  }

  return {
    currentModelId,
    currentThinkingLevel,
    currentThinkingLevelMap,
    currentSupportedLevels,
    localThinkingLevel,
    onModelSelect,
    onThinkingSelect,
    enterStagingMode,
    exitStagingMode,
    getStagingConfig,
  }
}
