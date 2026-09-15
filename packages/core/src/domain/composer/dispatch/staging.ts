/**
 * useComposerStaging —— Composer Staging 策略的聚合 + 路由层（ADR-0057）。
 *
 * 职责：
 * - 注册表：持有所有 StagingAction 实现（fork / handoff），按 type 索引。
 * - 单一真源：activeStagingType ref 驱动 activeStaging 派生，消除散落的 fork/handoff boolean + 互斥 watch。
 * - 统一入口：enter(type, source) / exit() / send(text) / handleEsc(e) / abortIfInProgress()，
 *   经 activeStaging 路由到具体 action，Composer 消费时不关心是 fork 还是 handoff。
 *
 * 互斥编排：enter 时若已有其他 staging 活跃，先 exit 旧的（内化原 Composer.vue 的双向 watch +
 * handoff deps.exitForkMode 两处散落的互斥逻辑）。
 *
 * 与底层 composable 的关系：useComposerForkMode / useComposerHandoffMode 保持原有 ref 状态、
 * channel watch、视觉派生不变，作为 StagingAction 的实现（adapter 层负责包装）。
 * useComposerStaging 只做聚合 + 路由，不重复持有 staging 状态。
 *
 * @param actions 所有 StagingAction 实现（由 Composer 注入，避免本 composable 直接实例化底层 composable）
 *
 * [W3 迁移] 迁自 renderer composables/panel/useComposerStaging.ts。改动：
 * - import 路径 `./staging-types` → `../types`（core domain/composer/types.ts 已定义）
 * - handleEsc 参数 KeyboardEvent → KeyboardEventLike（core 零 DOM 约束，types.ts 已定义结构类型，
 *   真实 KeyboardEvent 兼容 KeyboardEventLike，调用方零改动）
 * 逻辑 byte-level 保持。
 */
import { computed, type ComputedRef } from 'vue'
import type {
  KeyboardEventLike,
  StagingAction,
  StagingConfig,
  StagingSource,
  StagingType,
} from '../types'

/** useComposerStaging 的注入依赖：所有 StagingAction 实现。 */
export interface ComposerStagingDeps {
  /** fork-ask action（来自 useComposerForkMode 包装） */
  fork: StagingAction
  /** handoff action（来自 useComposerHandoffMode 包装） */
  handoff: StagingAction
}

/**
 * @param deps fork + handoff action 实现
 */
export function useComposerStaging(deps: ComposerStagingDeps): {
  /** 当前活跃的 staging action（null = 无 staging，普通态） */
  activeStaging: ComputedRef<StagingAction | null>
  /** 当前活跃的 staging type（null = 普通态），单一真源 */
  activeStagingType: ComputedRef<StagingType | null>
  /** 是否有任意 staging 活跃（A 阶段：发送前 mode 已开） */
  hasActiveStaging: ComputedRef<boolean>
  /** 是否有 staging 操作进行中（B 阶段：发送后，handoff inflight） */
  hasStagingInProgress: ComputedRef<boolean>
  /**
   * 进入指定 staging type。互斥编排：若已有其他 staging 活跃，先 exit 旧的。
   * @param type 要进入的 staging type
   * @param source 来源信息（fork 带 fromMessageId；handoff 只有 srcSessionId）
   */
  enter: (type: StagingType, source: StagingSource) => void
  /** 退出当前活跃的 staging（若无可退出为 no-op） */
  exit: () => void
  /**
   * 发送（经 activeStaging 路由）。非 staging 活跃时返回 false 让调用方走普通 send。
   * @param text draft
   * @param stagingConfig 模型/thinking 暂存配置
   * @returns true 表示已被 staging 消费（不走普通 send）；false 表示非 staging 态
   */
  send: (text: string, stagingConfig: StagingConfig) => Promise<boolean>
  /**
   * Esc 处理：当前 staging 活跃时清空输入 + 退出，返回 true 表示已消费。
   * @returns true 已消费（非 staging 态或非 Escape 返回 false）
   */
  handleEsc: (e: KeyboardEventLike) => boolean
  /**
   * 取消进行中的 staging 操作（B 阶段）。经 activeStaging.isInProgress 路由。
   * 非 staging 进行中时返回 false 让调用方走普通 abort。
   * @param sessionId 源 session id
   * @returns true 表示已被 staging 消费（不走普通 abort）；false 表示非 staging 进行中
   */
  abortIfInProgress: (sessionId: string) => Promise<boolean>
  } {
  // 注册表：type → action。Composer 注入的 fork/handoff action 按类型索引。
  // Map 而非对象：未来扩展 type 时只需 register，不改本 composable。
  const registry = new Map<StagingType, StagingAction>([
    ['fork', deps.fork],
    ['handoff', deps.handoff],
  ])

  /**
   * 当前活跃的 staging type（派生自各 action.isActive）。
   *
   * 派生而非独立 ref：fork/handoff 的 isActive（forkMode/handoffMode）可经多条路径翻转——
   * 除 staging.enter/exit 外，defineExpose 的 enterForkMode/enterHandoffMode、跨组件 channel signal、
   * session 切换 exit 都直接改底层 ref。独立 ref 无法感知这些路径 → activeStaging 与实际态脱节
   * （visual boxClass/chip 不刷新）。派生自 isActive 让 activeStaging 始终对齐实际模式态。
   *
   * 互斥编排仍由 enter() 显式调旧 action.exit()（见下），保证进新 type 时旧 type 的 isActive 翻 false；
   * 派生计算随之刷新。fork 优先于 handoff（对齐原 boxClass 链 fork > handoff 优先级）。
   */
  const activeStagingType = computed<StagingType | null>(() => {
    if (deps.fork.isActive.value) return 'fork'
    if (deps.handoff.isActive.value) return 'handoff'
    return null
  })

  /** 当前活跃的 staging action（null = 普通态） */
  const activeStaging = computed(() => (activeStagingType.value ? registry.get(activeStagingType.value) ?? null : null))

  /** 是否有任意 staging 活跃（A 阶段） */
  const hasActiveStaging = computed(() => activeStagingType.value !== null)

  /**
   * 是否有 staging 操作进行中（B 阶段）。
   *
   * 检查当前 activeStaging 的 isInProgress（handoff 进行中时 activeType 可能已 null——
   * 发送后 exit 已把 activeType 清空）。因此遍历 registry 所有 action 查 isInProgress，
   * 而非只看 activeStaging。fork 的 isInProgress 恒 false 不影响。
   */
  const hasStagingInProgress = computed(() => {
    for (const action of registry.values()) {
      if (action.isInProgress.value) return true
    }
    return false
  })

  /**
   * 进入指定 staging type。
   *
   * 互斥编排：若当前已有其他 staging 活跃（派生自 isActive），先调其 action.exit()（内化原散落的双向 watch）。
   * 再调目标 action.enter(source)——其内部翻转 isActive，activeStagingType 派生随之刷新。
   */
  function enter(type: StagingType, source: StagingSource): void {
    // 互斥：当前已有其他 staging 活跃 → 先退出
    const current = activeStagingType.value
    if (current && current !== type) {
      registry.get(current)?.exit()
    }
    const action = registry.get(type)
    if (!action) {
      console.warn(`[useComposerStaging] no action registered for type: ${type}`)
      return
    }
    // source type 与 enter 的 type 应一致（fork source 带 fromMessageId 等），由调用方保证
    action.enter(source as StagingAction['enter'] extends (s: infer S) => void ? S : StagingSource)
  }

  /** 退出当前活跃的 staging（经派生 activeStagingType 找到当前 action 调其 exit） */
  function exit(): void {
    const current = activeStagingType.value
    if (!current) return
    registry.get(current)?.exit()
  }

  /**
   * 发送：经 activeStaging 路由。非 staging 活跃返回 false 让调用方走普通 send。
   */
  async function send(text: string, stagingConfig: StagingConfig): Promise<boolean> {
    const action = activeStaging.value
    if (!action) return false
    await action.send(text, stagingConfig)
    return true
  }

  /**
   * Esc 处理：当前 staging 活跃时委托其 handleEsc。
   */
  function handleEsc(e: KeyboardEventLike): boolean {
    const action = activeStaging.value
    if (!action) return false
    return action.handleEsc(e)
  }

  /**
   * 取消进行中的 staging 操作（B 阶段）。
   *
   * 遍历 registry 找 isInProgress=true 的 action（发送后 activeType 可能已 null，
   * 不能只看 activeStaging）。找到则调其 abort，返回 true；无进行中则返回 false。
   */
  async function abortIfInProgress(sessionId: string): Promise<boolean> {
    for (const action of registry.values()) {
      if (action.isInProgress.value && action.abort) {
        await action.abort(sessionId)
        return true
      }
    }
    return false
  }

  return {
    activeStaging,
    activeStagingType,
    hasActiveStaging,
    hasStagingInProgress,
    enter,
    exit,
    send,
    handleEsc,
    abortIfInProgress,
  }
}
