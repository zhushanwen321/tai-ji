/**
 * createStagingMode —— fork/handoff 两份 staging 模式 composable 的共享行为骨架（D8 泛化）。
 *
 * 背景：fork-mode.ts × handoff-mode.ts 泛化前约 75% 逐字镜像（enter/exit/signal watch 守卫/
 * handleEsc/handleSend 骨架/modeRef getter，设计 §2 例 5），靠注释互证对称、独立漂移。
 * 本模块收编两实现的无差异段为单一骨架；useComposerForkMode / useComposerHandoffMode
 * 改为各持一份配置对象消费它（薄包装，公开 API 契约不变，消费方零改动）。
 *
 * P2 差异清单结论（全部差异可配置表达，无需保留差异段——未触发设计降级预案）：
 * - source 形状（fork 含 fromMessageId，handoff 仅 srcSessionId）→ 泛型参数 S
 * - enter 前置守卫（handoff 的 isSessionActive streaming 拦截 + toast）→ config.enterGuard
 * - enter 互斥副作用（handoff 退出 fork 模式）→ config.beforeEnter
 * - handleSend 前置兑底守卫（handoff 发送时 isSessionActive 竞态窗口兜底）→ config.beforeSend
 * - send 目标 action 与文本归一化（fork 原样 text / handoff trim→undefined reply）→ config.sendAction 闭包
 * - send 失败 toast 文案 key → config.sendFailedKey
 * - B 阶段（fork 无 inflight 可取消；handoff isInProgress=isHandingOff + abort）→ config.isInProgress / config.abort 可选
 * - 视觉与文案（boxClass 首 token / placeholder / chip 标签与图标）→ config.activeBoxClass 等
 * - exit / signal watch 守卫 / handleEsc / modeRef getter：两实现泛化前逐字同构，骨架固定零配置
 *
 * 新增 staging 模式 = 一份配置对象 + 薄包装（StagingType 枚举 + StagingAction 注册，见 ../types）。
 */
import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Component } from 'vue'
import type {
  ComposerInputInstance,
  KeyboardEventLike,
  StagingAction,
  StagingConfig,
  StagingType,
} from '../types'
import { toErrorMessage } from '../../../utils/error-message'

/**
 * staging source 的最小公共形状（泛型 S 的约束）：跨组件 signal 与模式内部 source ref
 * 的元素类型下界。fork 实例化为 {srcSessionId, fromMessageId}，handoff 为 {srcSessionId}。
 * 与 ../types 的 ForkSource/HandoffSource 区别：那两个带 type 判别字段（StagingAction.enter
 * 参数用）；此处 S 是模式内部记录的 source 形状，signal 通道对象不带 type。
 */
export interface StagingModeSource {
  srcSessionId: string
}

/** 骨架公共副作用依赖（ForkDeps/HandoffDeps 的交集，由包装层从各自 deps 透传） */
export interface StagingModeDeps {
  /**
   * ComposerInput 实例 ref：enter 时聚焦输入框用。
   * 最小契约——从域级权威接口（../types）Pick 仅 focus（u3.1 窄契约定性结论，
   * 意图注释见各包装层 ForkDeps/HandoffDeps.inputRef）。
   */
  inputRef: Ref<Pick<ComposerInputInstance, 'focus'> | null>
  /** 发送中标志位 setter（发送期间置 true，结束复位） */
  setSending: (value: boolean) => void
  /** 发送成功后清空输入区（DOM + draft + 持久化草稿） */
  clearInput: () => void
  /** 发送失败时恢复草稿到输入区 */
  restoreInput: (text: string) => void
  /** Staging Mode（ADR-0056）：进入暂存态（快照模型/thinking） */
  enterStagingMode: () => void
  /** Staging Mode：退出暂存态（清空快照，恢复常规态） */
  exitStagingMode: () => void
  /** Staging Mode：获取暂存配置（send 时透传给新 session） */
  getStagingConfig: () => StagingConfig
  /** i18n 翻译（placeholder / send 失败 toast） */
  t: (key: string, params?: Record<string, unknown>) => string
  /** 错误 toast */
  toastError: (msg: string) => void
}

/** staging 模式差异配置（fork/handoff 各持一份；差异字段语义见包装层注释） */
export interface StagingModeConfig<S extends StagingModeSource> {
  /** 当前 session id（null = landing 态，signal watch 守卫用） */
  sessionId: ComputedRef<string | null>
  /** 公共副作用依赖 + 跨域能力（依赖注入） */
  deps: StagingModeDeps
  /** StagingAction.type 标识（注册键 + 日志诊断） */
  type: StagingType
  /** 跨组件触发通道（Sidebar 全局快捷键请求进模式；req 形状 = S） */
  signal: Ref<S | null>
  /**
   * enter 前置守卫：返回 false 则不进入（toast 提示在守卫闭包内自理）。
   * fork 无守卫；handoff 用 isSessionActive 拦截 streaming 中的源 session
   * （handoff turn 需要源 session 空闲，pi 在 turn 进行中会拒绝 prompt）。
   */
  enterGuard?: (source: S) => boolean
  /**
   * enter 前互斥副作用：handoff 进模式前退出 fork（forkSource 残留指向错误 session）。
   * fork 无此段。
   */
  beforeEnter?: (source: S) => void
  /**
   * handleSend 前置兑底守卫：返回 true 表示已消费（不走发送、不清草稿、不退模式——
   * 回复结束后可直接重发）。handoff 用 isSessionActive 兑 enter 拦截后的竞态窗口
   * （进入模式后 session 才变 streaming）。
   */
  beforeSend?: (text: string, source: S) => boolean
  /**
   * 发送目标 action（features 层编排：forkSessionAsk / handoff）。text 为原始 draft
   * （失败 restoreInput 恢复原值）；文本归一化（handoff 的 reply = trim || undefined）
   * 在配置闭包内完成。
   */
  sendAction: (source: S, text: string, staging: StagingConfig) => Promise<void>
  /** send 失败 toast 的 i18n key（params: {error}） */
  sendFailedKey: string
  /** StagingAction.allowsEmptySend（fork 空内容退化为纯 fork；handoff 空 reply 允许） */
  allowsEmptySend: boolean
  /**
   * B 阶段进行中判定（StagingAction.isInProgress 派生；仅 source 有值时读取，
   * 避免未进入态误判）。缺省恒 false（fork：前端编排的 fork+send，无独立 inflight 可取消）。
   */
  isInProgress?: (source: S) => boolean
  /** B 阶段取消（StagingAction.abort 委托；缺省 undefined = 无 B 阶段语义，如 fork） */
  abort?: (sessionId: string) => Promise<void>
  /** 活跃态 composer-box class 串（首 token 为模式标识：fork-mode / handoff-mode） */
  activeBoxClass: string
  /** 活跃态 placeholder 的 i18n key */
  placeholderKey: string
  /** mode-chip 标签的 i18n key */
  chipLabelKey: string
  /** mode-chip 图标组件（GitFork / Upload） */
  chipIcon: Component
}

/** createStagingMode 返回的骨架实例（包装层重命名为各模式的具名 API） */
export interface StagingModeInstance<S extends StagingModeSource> {
  /** 模式开关：true 时 composer 顶部显 mode-chip + 视觉，发送走 sendAction */
  mode: Ref<boolean>
  /** { value: boolean } 包装对象（非 ref，不被 defineExpose 解包；对齐 vm.<mode>.value 访问契约） */
  modeRef: { readonly value: boolean }
  enter: (source: S) => void
  exit: () => void
  /** 模式派生 class；非活跃返回空串 */
  boxClass: ComputedRef<string>
  /** 模式派生 placeholder；非活跃返回 null（调用方回退到普通 placeholder） */
  placeholder: ComputedRef<string | null>
  /** Esc 处理：活跃 + Escape 时清空输入 + 退出，返回 true 已消费；否则 false */
  handleEsc: (e: KeyboardEventLike) => boolean
  /** 模式发送（clearInput → setSending → sendAction → finally 退出），返回 true 已消费；非活跃 false */
  handleSend: (text: string) => Promise<boolean>
  /** 包装成 StagingAction（ADR-0057），供 useComposerStaging 注册消费 */
  asStagingAction: () => StagingAction
}

/**
 * staging 模式骨架（fork/handoff 泛化，D8）。行为与泛化前两实现逐段等价
 * （差异经 config 表达，见本文件头注 P2 清单）。
 *
 * @param config 模式配置（sessionId + 公共 deps 注入 + 差异字段）
 */
export function createStagingMode<S extends StagingModeSource>(
  config: StagingModeConfig<S>,
): StagingModeInstance<S> {
  const { sessionId, deps } = config

  /** 模式开关 */
  const mode = ref(false)
  /** 模式来源（send / isInProgress 消费；enter 时记录） */
  const source = ref<S | null>(null)

  function enter(next: S): void {
    if (config.enterGuard && !config.enterGuard(next)) return
    config.beforeEnter?.(next)
    // Staging Mode（ADR-0056）：快照当前模型/thinking，进入暂存态
    deps.enterStagingMode()
    source.value = next
    mode.value = true
    // 聚焦输入框，让用户立即键入
    deps.inputRef.value?.focus?.()
  }

  function exit(): void {
    mode.value = false
    source.value = null
    // Staging Mode：退出暂存态，chip 恢复读源 session 模型
    deps.exitStagingMode()
  }

  // 跨组件触发通道：Sidebar 全局快捷键经 signal 请求 Composer 进模式
  // （Composer 仍是模式状态真源：发送/Esc/切 session 强耦合）。守卫条件 fork/handoff 同构：
  // req 非空 + srcSessionId 命中本 composer 的 session（双 panel 下快捷键不误触发非焦点 panel）。
  watch(config.signal, (req) => {
    if (!req) return
    if (req.srcSessionId !== sessionId.value) return
    enter({ ...req })
  })

  /** 模式派生 class；非活跃返回空串 */
  const boxClass = computed(() => (mode.value ? config.activeBoxClass : ''))

  /** 模式派生 placeholder；非活跃返回 null（调用方回退到普通 placeholder） */
  const placeholder = computed(() => (mode.value ? deps.t(config.placeholderKey) : null))

  /**
   * Esc 处理：模式活跃 + Escape 时清空输入 + 退出。
   * @returns true 表示已消费（composer 聚焦时优先于全局 Esc handler）
   */
  function handleEsc(e: KeyboardEventLike): boolean {
    if (!mode.value || e.key !== 'Escape') return false
    e.preventDefault?.()
    deps.clearInput()
    exit()
    return true
  }

  /**
   * 模式发送：clearInput → setSending(true) → sendAction（透传 staging 快照配置），
   * 成功或失败后退出模式回普通态；失败 restoreInput 保草稿 + toast。
   * @param text 当前 draft（sendAction 归一化后作 fork 首条 user / handoff reply 备注）
   * @returns true 表示已消费（onSend 开头短路，不走普通 send 流程）；非活跃返回 false
   */
  async function handleSend(text: string): Promise<boolean> {
    if (!mode.value || !source.value) return false
    const current = source.value
    if (config.beforeSend?.(text, current)) return true
    deps.clearInput()
    deps.setSending(true)
    try {
      // Staging Mode（ADR-0056）：透传暂存的模型/thinking 配置给新 session
      const staging = deps.getStagingConfig()
      await config.sendAction(current, text, staging)
    } catch (e) {
      deps.restoreInput(text)
      const msg = toErrorMessage(e)
      deps.toastError(deps.t(config.sendFailedKey, { error: msg }))
    } finally {
      deps.setSending(false)
      // 失败时也退出模式（fork/handoff 泛化前的共同设计选择）：用户丢失 staging context
      // （model override chip 消失），但保持行为一致——避免残留在错误 staging 态，可重新进入。
      exit()
    }
    return true
  }

  /** { value: boolean } 包装对象：getter 代理到响应式 mode ref，对齐 vm.<mode>.value 访问契约 */
  const modeRef = {
    get value(): boolean {
      return mode.value
    },
  }

  /**
   * 包装成 StagingAction（ADR-0057）：mode/enter/exit/handleSend/handleEsc/boxClass/
   * placeholder 收敛为单一策略对象，供 useComposerStaging 聚合路由。
   */
  function asStagingAction(): StagingAction {
    return {
      type: config.type,
      isActive: computed(() => mode.value),
      enter: (stagingSource) => {
        // stagingSource 实际形状由 useComposerStaging.enter(type, source) 调用方保证；
        // StagingAction.enter 默认泛型为 StagingSource（带 type 判别的联合），此处收窄为 S
        // （经 StagingModeSource 中转：泛型 S 无法从联合直接断言，先放宽到公共形状再收窄）。
        enter(stagingSource as StagingModeSource as S)
      },
      exit: () => exit(),
      /**
       * send 直接调 handleSend(text)，忽略传入的 staging 参数。
       * 原因：handleSend 内部已调 deps.getStagingConfig() 取模型/thinking 快照配置，
       * 其数据源与 useComposerModelThinking.getStagingConfig 相同，外部传参与内部自取等价，
       * 故不复用 staging 参数（避免 fork/handoff 在 useComposerStaging.send 处重复透传）。
       */
      send: async (text) => { await handleSend(text) },
      allowsEmptySend: config.allowsEmptySend,
      handleEsc,
      isInProgress: computed(() =>
        source.value ? (config.isInProgress?.(source.value) ?? false) : false,
      ),
      abort: config.abort,
      visual: {
        boxClass,
        placeholder,
        chipLabelKey: config.chipLabelKey,
        chipIcon: config.chipIcon,
      },
    }
  }

  return {
    mode,
    modeRef,
    enter,
    exit,
    boxClass,
    placeholder,
    handleEsc,
    handleSend,
    asStagingAction,
  }
}
