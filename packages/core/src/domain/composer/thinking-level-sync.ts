/**
 * 思考等级与模型同步 composable（Q3）。
 *
 * 从 Composer 拆出，保持 script setup 行数合规。职责：
 * - 按 currentModelId 解析当前模型的 thinkingLevelMap
 * - 模型切换后按体系判定对齐思考等级：同体系直接映射，跨体系重置到最高可用档
 *
 * thinkingLevelMap 语义：
 * key = UI 可选档位（ThinkingLevel 枚举值，含 max），value = 发给 runtime/pi 的实际 level。
 * onReset 传给 Composer 的是 map 映射后的 value（发给 runtime 的字符串）。
 *
 * [W3 迁移] 迁自 renderer composables/panel/useThinkingLevelSync.ts。改动：
 * - 去掉 renderer 跨域依赖 `import { useSettingsStore } from '@/stores/settings'`，以及
 *   currentThinkingLevelMap computed 内联的 providers/models 解析逻辑。改为经
 *   deps.getThinkingLevelMap 回调注入（壳层 Composer 从 settingsStore.providers 派生后传入），
 *   core 零 store 依赖。
 * - [U6] 可用档判定切 deps.getSupportedLevels（ProviderInfo.models[].supportedLevels，
 *   runtime 注册表 pi 同源计算下发），本地推算已删除。
 * - import 路径 `@/components/panel/thinking-levels` → core 本域 `./thinking-levels`（batch1 已迁入）。
 * 函数签名 / 逻辑 byte-level 保持。
 *
 * [u2 记忆恢复] watch 回调顶部新增 armed 消费（设计 model-thinking-level-memory.md
 * D3 规则 1/2/3 / D4 消费点 / D5 可用性回落）：显式切模型（u3 model-thinking 设立 armed）时
 * 优先恢复记忆档位，未命中 / 不可用 / 幂等 / 过期回落既有对齐分支。armed 相关 deps
 * 均为可选注入——未注入时消费块零副作用；[U5/D5] 对齐分支门禁与注入无关
 * （armedSnapshot 恒 null 即恒拦截分支 2/4/5，见下方门禁段）。
 *
 * [U5/D5 门禁] 本设计 composer-model-session-isolation D5：档位对齐只挂「用户显式切模型」。
 * 门禁判据 = 回调入口的 armed 快照（consumeArmedRestore 执行前捕获）——分支 2（无档位
 * 设最高档）/4（同体系映射）/5（跨体系重置）无快照一律跳过；分支 3（可用性校验，oldMap
 * undefined 挂载首触发可达）保持不门禁。armed 快照是「本触发 = 显式切换」的一次性抑制
 * 判据（启发式）而非精确归因。
 */
import { computed, watch, type ComputedRef, type Ref } from 'vue'
import {
  normalizeSupportedLevels,
  resolveThinkingValue,
  resolveThinkingKey,
  highestAvailableLevel,
  isSameThinkingScheme,
  type ThinkingLevel,
} from './thinking-levels'

/** useThinkingLevelSync 的注入依赖：按 modelId 派生 thinkingLevelMap（壳层从 settingsStore.providers 解析注入）。 */
export interface ThinkingLevelSyncDeps {
  /**
   * 取指定 modelId 的 thinkingLevelMap。
   * @param modelId 完整 model id（provider/model 形式）
   * @returns 该模型的思考档位映射；undefined 表示无 map
   */
  getThinkingLevelMap: (modelId: string) => Record<string, string | null> | undefined
  /**
   * 取指定 modelId 的档位可用集（ProviderInfo.models[].supportedLevels，U6 切源——
   * runtime 能力注册表 pi 同源计算的 view-ready 下发）。undefined = 下发链路未接通
   * （归一为默认五档）。non-reasoning 模型该集为 ['off']——切模型重置逻辑据此正确落到 off。
   */
  getSupportedLevels: (modelId: string) => string[] | undefined

  // ── [u2 记忆恢复] 以下可选注入：armed 切模型意图的记忆恢复消费（设计 D3 规则 1-3 / D4 / D5）。
  // 可选的原因：现有调用方（u4 接线前）与无记忆场景不注入，消费块零副作用、零回归；
  // u4 壳层组装时由 u3 持有的状态透传接入。
  /**
   * 记忆查询：透传 u1 model-thinking-memory 的 lookup。返回值即 UI key（D1：记忆表存
   * UI key），无需反查。缺省 = 恒未命中（含记忆未加载 E7①，自然回落既有规则）。
   */
  getRememberedLevel?: (modelId: string) => ThinkingLevel | undefined
  /**
   * 读 armed 切模型意图（消费侧只读切片）。armed 由 u3 model-thinking 持有完整结构
   * {modelId, at, callId} 并负责设立 / 失败清 / 成功清 / 换绑清；本模块只做消费
   * （规则 1 过期清 / 规则 2 匹配消费）。缺省 = 无 armed。
   */
  getArmed?: () => ArmedModelSwitchIntent | null
  /** 清 armed（规则 1 过期清 / 规则 2 消费或回落清）。与 getArmed 成对注入。 */
  clearArmed?: () => void
  /**
   * in-flight switchModel 调用计数（u3 按 callId 引用计数持有）。规则 1 过期判定的
   * 豁免依据（E10：慢 RPC 回包触发的消费发生在豁免窗内，不得按过期误杀）。缺省按 0。
   */
  getInFlightCount?: () => number
}

/** armed 过期保险丝（D3 规则 1）：正常链路由 u3 的失败清/成功清/换绑清先行，5s 只兜底陈旧 token。 */
export const ARMED_EXPIRY_MS = 5000

/**
 * armed 切模型意图（消费侧只读切片，设计 D3）。
 * u3 model-thinking 持有完整结构 {modelId, at, callId}——本接口只声明消费侧
 * 需要的两个字段，u3 的完整结构结构化兼容本切片（无需显式实现）。
 */
export interface ArmedModelSwitchIntent {
  /** 目标模型复合串（provider/modelId） */
  modelId: string
  /** 设立时刻（Date.now() 毫秒）——规则 1 过期判定输入，消费侧只读不写 */
  at: number
}

/**
 * armed 记忆恢复消费（设计 D3 规则 1/2/3，D4 消费点 = watch 回调顶部，先于所有既有分支）。
 *
 * 规则顺序即判定顺序（D3 恢复数据流 ①→②→③）：
 * 1. 过期清——`now - at > ARMED_EXPIRY_MS` 且 in-flight 计数为零才清（E10 豁免窗：
 *    慢 RPC 回包触发的本回调先于 finally 撤销计数，in-flight > 0 时不得按过期误杀）；
 *    清后走既有分支，不再进入规则 2（陈旧 token 不消费恢复）。
 * 2. 匹配即消费——currentModelId === armed.modelId 时查记忆：
 *    命中且可用（D5：key ∈ 新模型 normalizeSupportedLevels，不发新模型不支持的档）
 *    且换算后 value ≠ 当前档位 → 清 armed + onReset(记忆 key 经新 map 换算的 value)
 *    并返回 true（调用方直接 return，跳过既有分支防双重 onReset，D4）；
 *    幂等（value 已等于当前）/ 未命中（含记忆未加载 E7①）/ 不可用 → 清 armed 回落既有分支。
 * 3. 不匹配——RPC 在途 / providers 刷新等无关触发 → 不动 armed，等待匹配触发（规则 3）。
 *
 * armed 传 null（无 armed 快照）时直通 false 走既有分支——规则判定前的空值门卫
 * 内迁于此（替代调用侧 `snapshot && …` 短路，判定顺序与副作用零变化）。
 *
 * @returns true = 已消费并 onReset（调用方 return 跳过既有分支）；false = 走既有分支
 */
function consumeArmedRestore(args: {
  armed: ArmedModelSwitchIntent | null
  deps: ThinkingLevelSyncDeps
  currentModelId: string
  currentValue: string | undefined
  map: Record<string, string | null> | undefined
  supported: string[] | undefined
  onReset: (level: string) => void
}): boolean {
  const { armed, deps, currentModelId, currentValue, map, supported, onReset } = args
  if (!armed) return false
  const inFlight = deps.getInFlightCount?.() ?? 0
  if (Date.now() - armed.at > ARMED_EXPIRY_MS && inFlight === 0) {
    // 规则 1：过期 token 只清不消费——陈旧 token 若被消费即「chip 突跳伪恢复」（D3 被否②a）
    deps.clearArmed?.()
    return false
  }
  if (currentModelId !== armed.modelId) {
    // 规则 3：模型尚未到达目标 → 保留 armed 等待匹配触发
    return false
  }
  // 规则 2：匹配即消费（含幂等跳过）。记忆值即 UI key（D1），可用性按新模型 supported 归一判定
  const remembered = deps.getRememberedLevel?.(armed.modelId)
  if (remembered && normalizeSupportedLevels(supported).includes(remembered)) {
    const newValue = resolveThinkingValue(remembered, map)
    if (newValue !== currentValue) {
      // 消费即清（一次性标志）；先清再 onReset——即使 onReset 抛错也不留陈旧 token
      deps.clearArmed?.()
      onReset(newValue)
      return true
    }
  }
  // 幂等 / 未命中 / 不可用 → 清 armed 回落既有分支（D5）
  deps.clearArmed?.()
  return false
}

/**
 * 分支 3：首次触发（oldMap===undefined）的可用性安全网——当前档位在新模型可用则
 * 保留，不可用才重置到最高可用档一次（不门禁：挂载首触发可达，数据不一致时的兜底，
 * 避免无 oldMap 无法判定体系时误触发冗余 RPC）。
 */
function applyFirstTriggerAvailability(args: {
  current: string
  map: Record<string, string | null> | undefined
  supported: string[] | undefined
  onReset: (level: string) => void
}): void {
  const { current, map, supported, onReset } = args
  const currentKey = resolveThinkingKey(current, map, highestAvailableLevel(supported))
  const available = normalizeSupportedLevels(supported)
  if (available.includes(currentKey)) return
  const highest = highestAvailableLevel(supported)
  onReset(resolveThinkingValue(highest, map))
}

/**
 * 分支 4：同体系切换（isSameThinkingScheme 成立）——旧 map 反查当前 value 的 UI key，
 * 直接映射到新模型 value；key 在新模型不可用时按跨体系语义重置，value 未变不发冗余 RPC。
 */
function applySameSchemeMapping(args: {
  current: string
  oldMap: Record<string, string | null> | undefined
  map: Record<string, string | null> | undefined
  supported: string[] | undefined
  onReset: (level: string) => void
}): void {
  const { current, oldMap, map, supported, onReset } = args
  const currentKey = resolveThinkingKey(current, oldMap)
  // 防御：current 既不在 oldMap 的 value 里又非合法 ThinkingLevel 时，
  // resolveThinkingKey 缺省 fallback 到默认五档最高档；该 key 若在新模型的
  // 可用档中不可用，resolveThinkingValue 会走 v ?? key 回退把不可用档原样发给
  // runtime。此时走跨体系重置（重置到最高可用档）。
  const available = normalizeSupportedLevels(supported)
  if (!available.includes(currentKey)) {
    const highest = highestAvailableLevel(supported)
    const resetValue = resolveThinkingValue(highest, map)
    if (resetValue !== current) onReset(resetValue)
    return
  }
  const newValue = resolveThinkingValue(currentKey, map)
  // value 变了才重置（同体系同 value 时不触发冗余 RPC）
  if (newValue !== current) onReset(newValue)
}

export function useThinkingLevelSync(
  currentModelId: ComputedRef<string> | Ref<string>,
  currentThinkingLevel: ComputedRef<string | undefined>,
  onReset: (level: string) => void,
  deps: ThinkingLevelSyncDeps,
): ComputedRef<Record<string, string | null> | undefined> {
  /** 当前模型的思考档位映射（按 currentModelId 经 deps 派生） */
  const currentThinkingLevelMap = computed(() => deps.getThinkingLevelMap(currentModelId.value))

  /** 当前模型档位可用集（supportedLevels，U6 切源——可用档判定唯一权威） */
  const supportedOf = () => deps.getSupportedLevels(currentModelId.value)

  /**
   * 模型切换后对齐思考等级（session 已建 + landing 态均触发）。
   *
   * 映射规则（用户确认的语义；编号 = 设计 D5 分支编号，与行内门禁注释单轨）：
   * 1. [u2] armed 记忆恢复消费（D4：先于下列所有分支）——显式切模型的记忆恢复，
   *    命中且可用且 value≠当前 → onReset(记忆值) 后直接 return 跳过下列分支；
   *    过期 / 幂等 / 未命中 / 不可用 / 不匹配 → armed 按规则处理后照走下列分支
   *    [U5/D5] 入口 armed 快照同时是对齐门禁：下列分支 2/4/5 无快照一律跳过
   *    （分支 3 可用性安全网不门禁）——对齐只挂「用户显式切模型」
   * 2. currentThinkingLevel 无值（landing 态初始）→ 设为新模型最高可用档
   * 3. 首次触发（oldMap===undefined，Composer 挂载/session 载入）→ 可用性检查：
   *    当前档位在新模型可用则保留，不可用则重置到最高档（与原逻辑一致，避免无 oldMap
   *    无法判定体系时误触发冗余 RPC）
   * 4. 真正的模型切换（oldMap 有值）且同体系（可用 key 集合相同）→
   *    直接映射当前档位到新模型 value
   * 5. 跨体系切换 → 重置到新模型最高可用档
   *
   * 「体系」定义见 isSameThinkingScheme。同体系时用旧 map 反查当前 value 的 UI key，
   * 再用新 map 转成新 value；value 未变则不触发冗余 RPC。
   *
   * onReset 传的是 map 映射后的 value（发给 runtime/pi 的字符串）。
   */
  watch(
    // 组合观察源：map（key→value 映射）+ supportedLevels（可用档集，U6 切源）。
    // 一起观察让回调同时拿到新旧 supported——体系判定（isSameThinkingScheme）需要
    // 切换前后两个模型的档位集，单观察 map 拿不到旧模型的 supported。
    () => [currentThinkingLevelMap.value, supportedOf()] as const,
    ([map, supported], oldPair) => {
    // [u2/D4] armed 消费置于回调最顶部，先于「无档位」「首触发」「体系判定」所有分支。
    // [U5/D5] 入口快照语义：armedSnapshot 在 consumeArmedRestore 执行前捕获——消费块内的
    // clearArmed 不影响该局部变量，故「记忆未命中的显式切换」（回落路径先清 armed）仍能放行
    // 对齐分支。禁止读消费块之后的 armed 值（D5 被否③）。
      const armedSnapshot = deps.getArmed?.() ?? null
      if (
        consumeArmedRestore({
          armed: armedSnapshot,
          deps,
          currentModelId: currentModelId.value,
          currentValue: currentThinkingLevel.value,
          map,
          supported,
          onReset,
        })
      ) {
        return // 命中恢复已 onReset，跳过既有分支防双重 onReset（D4）
      }
      const oldMap = oldPair?.[0]
      const oldSupported = oldPair?.[1]
      const current = currentThinkingLevel.value
      if (!current) {
        // [U5/D5] 分支 2 门禁：landing 态无 armed 快照时不自动设最高档（landing 初值由
        // resolveLaunchConfig 解析链给出——authored-only，U2a 后无 follow watch），避免换绑触发发多余 setThinkingLevel
        if (!armedSnapshot) return
        // landing 态初始无思考等级 → 设为新模型最高可用档
        const highest = highestAvailableLevel(supported)
        onReset(resolveThinkingValue(highest, map))
        return
      }
      // 首次触发（无 oldMap 可比）→ 可用性检查，与原逻辑一致
      // [U5/D5] 分支 3 保持不门禁：数据不一致时的可用性安全网（不可用才重置一次）
      if (oldMap === undefined) {
        applyFirstTriggerAvailability({ current, map, supported, onReset })
        return
      }
      // [U5/D5] 分支 4/5 门禁：无入口快照时同体系映射与跨体系重置一并跳过
      //（置于 isSameThinkingScheme 判定之前，一处守卫覆盖两分支；分支 3 已在上面 return）
      if (!armedSnapshot) return
      // 模型切换：同体系 → 直接映射当前档位 key 到新模型 value
      if (isSameThinkingScheme(oldSupported, supported)) {
        applySameSchemeMapping({ current, oldMap, map, supported, onReset })
        return
      }
      // 跨体系 → 重置到新模型最高可用档（value 未变则不触发冗余 RPC）
      const highest = highestAvailableLevel(supported)
      const newValue = resolveThinkingValue(highest, map)
      if (newValue !== current) onReset(newValue)
    }, { immediate: true })

  return currentThinkingLevelMap
}
