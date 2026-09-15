/**
 * useComposerHandoffMode —— Composer 的 handoff（交接）模式（fast-handoff，参照 useComposerForkMode）。
 *
 * 职责：
 * - handoffMode 状态真源：是否处于「从末条 assistant 交接」的备注模式
 * - handoffSource：记录 handoff 来源（srcSessionId = handoff 出发的 session）
 * - enterHandoffMode / exitHandoffMode：进入（记来源 + 聚焦输入框 + 互斥退出 fork 模式）/ 退出（复位状态）
 * - 跨组件触发通道：watch handoffEnterSignal（Sidebar ⌘J 请求），命中本 session 时 enterHandoffMode
 * - handoffBoxClass / handoffPlaceholder：handoff 模式派生的 class 与 placeholder 文案
 * - handleHandoffEsc：Esc 退出（清空输入 + exitHandoffMode），返回是否已消费
 * - handleHandoffSend：handoff 模式发送（调 handoff(srcId, text) + 退出），返回是否已消费
 * - handoffModeRef：{ value: boolean } 包装对象，给 defineExpose 用（避免 Vue 解包顶层 ref）
 *
 * 与 fork 模式互斥：进 handoff 前退出 fork（deps.exitForkMode）；fork 模式自身进 handoff 时也对称退出。
 *
 * [D8 泛化] fork 与 handoff 曾约 75% 逐字镜像（设计 §2 例 5）。行为骨架已收敛到
 * createStagingMode（./staging-mode），本模块 = handoff 配置对象 + 薄包装：公开 API
 * （返回面 9 项）与 HandoffDeps 注入契约保持不变，消费方零改动。handoff 差异全部经
 * 配置表达（P2 清单见 staging-mode.ts 头注）：
 * - enterGuard：isSessionActive 入口拦截（源 session streaming 中 handoff 必然失败，toast 而非英文 RPC 错）
 * - beforeEnter：互斥退出 fork 模式（forkSource 残留指向错误 session）
 * - beforeSend：发送兑底守卫（兑入口拦截后 session 才变 streaming 的竞态窗口；返回 true 已消费，
 *   不清草稿不退模式——回复结束后可直接重发）
 * - sendAction：reply = text.trim() || undefined（空备注允许，runtime 只发 template）
 * - isInProgress / abort：B 阶段（handoff turn 在源 session 跑，可取消）
 *
 * 发送/清空输入等副作用通过 deps 注入（Composer 持有 draft/isSending/clearInput/restoreInput 真源），
 * 保持 handoff 状态真源单一且不侵入 Composer 已稳定的发送/草稿流程。
 *
 * [W3 迁移] 迁自 renderer composables/panel/useComposerHandoffMode.ts。跨域能力（vue-i18n t /
 * Upload icon / toastError / isHandingOff / handoffEnterSignal channel）去掉 renderer import，
 * 改为 HandoffDeps 字段注入（core 零 renderer 依赖）；isInProgress 派生原 chatStore.isHandingOff(...)
 * → deps.isHandingOff(...)（dep 注入）。
 */
import type { ComputedRef, Ref } from 'vue'
import type { Component } from 'vue'
import type { ComposerInputInstance, KeyboardEventLike, StagingAction, StagingConfig } from '../types'
import { createStagingMode } from './staging-mode'

/** handoff source 形状（createStagingMode 泛型 S 的 handoff 实例化：无 fromMessageId，始终从末条 assistant 打包） */
interface HandoffSourceShape {
  srcSessionId: string
}

/** useComposerHandoffMode 返回类型（从函数内联类型提取为命名 interface，便于复用 + 阅读） */
export interface ComposerHandoffModeReturn {
  handoffMode: Ref<boolean>
  /** { value: boolean } 包装对象，给 defineExpose 用（不被 Vue 解包） */
  handoffModeRef: { readonly value: boolean }
  enterHandoffMode: (srcSessionId: string) => void
  exitHandoffMode: () => void
  /** handoff 模式 composer-box class（accent 边 + glow + accent-soft 底）；非 handoff 模式返回空串 */
  handoffBoxClass: ComputedRef<string>
  /** handoff 模式 placeholder 文案；非 handoff 模式返回 null */
  handoffPlaceholder: ComputedRef<string | null>
  /** Esc 处理：handoff 模式下清空输入 + 退出，返回 true 表示已消费；否则返回 false */
  handleHandoffEsc: (e: KeyboardEventLike) => boolean
  /** handoff 模式发送：调 handoff(srcId, text) + exitHandoffMode，返回 true 表示已消费；否则返回 false */
  handleHandoffSend: (text: string) => Promise<boolean>
  /**
   * 包装成 StagingAction（handoff 实现），供 useComposerStaging 注册消费。
   * 不改变现有 handoffMode/enterHandoffMode 等 expose 契约（仅追加 adapter，对齐 ADR-0057）。
   */
  asStagingAction: () => StagingAction
}

/** handoff 发送副作用依赖（由 Composer 注入，避免重复持有 draft/isSending 真源） */
export interface HandoffDeps {
  /**
   * ComposerInput 实例 ref：enterHandoffMode 聚焦输入框用。
   * 本模块视角的最小契约——从域级权威接口（../types）Pick 仅 focus，耦合面显式
   * 受控于权威定义（权威 focus 必选，真实实例 defineExpose 必有；调用点 focus 的
   * 二级可选链按零行为变化原则原样保留，运行时骗类型的低配桩仍不炸）。
   */
  inputRef: Ref<Pick<ComposerInputInstance, 'focus'> | null>
  /** 发送中标志位 setter（handoff 发送期间置 true，结束复位） */
  setSending: (value: boolean) => void
  /** 发送成功后清空输入区（DOM + draft + 持久化草稿） */
  clearInput: () => void
  /** 发送失败时恢复草稿到输入区 */
  restoreInput: (text: string) => void
  /** 互斥：进入 handoff 模式时退出 fork 模式（forkSource 残留指向错误 session） */
  exitForkMode: () => void
  /** handoff 编排（features 层跨 api + stores）：handleHandoffSend 调用触发 handoff（runtime agent-driven） */
  handoff: (srcSessionId: string, reply?: string, staging?: StagingConfig) => Promise<void>
  /** 取消进行中的 handoff（与 handoff 对称注入，来自 useHandoffActions）：StagingAction.abort 委托 */
  abortHandoff: (sessionId: string) => Promise<void>
  /** Staging Mode（ADR-0056）：进入暂存态（快照模型/thinking） */
  enterStagingMode: () => void
  /** Staging Mode：退出暂存态（清空快照，恢复常规态） */
  exitStagingMode: () => void
  /** Staging Mode：获取暂存配置（供 handoff 发送时透传给新 session） */
  getStagingConfig: () => StagingConfig
  // ── 跨域能力（W3 迁移：去掉 renderer import，改为 deps 注入）──
  /** i18n 翻译（原 vue-i18n useI18n → t） */
  t: (key: string, params?: Record<string, unknown>) => string
  /** handoff mode-chip 图标（原 @lucide/vue Upload） */
  handoffChipIcon: Component
  /** 错误 toast（原 useToast error） */
  toastError: (msg: string) => void
  /** 源 session 是否正在 handoff（原 useChatStore().isHandingOff；StagingAction.isInProgress 派生用） */
  isHandingOff: (sessionId: string) => boolean
  /** 源 session 是否活跃（streaming/派发中）。handoff 入口/发送双重守卫：runtime handoff
   *  需要源 session 空闲跑一个 handoff turn，pi 的 prompt 在 turn 进行中会拒绝
   *  （"Agent is already processing"，pi 源码锚点 agent-session.ts:1181，已核对实装
   *  0.84.1 dist/core/agent-session.js:833 同语义），streaming 中 handoff 必然失败——入口直接拦截 +
   *  发送时兑底（兑入口后 session 才变 active 的竞态窗口），toast 友好提示而非英文 RPC 错 */
  isSessionActive: (sessionId: string) => boolean
  /** 跨组件触发通道 signal（原 useHandoffModeChannel signal；Sidebar ⌘J 请求） */
  handoffEnterSignal: Ref<{ srcSessionId: string } | null>
}

/**
 * @param sessionId 当前 session id（null = landing 态，signal 守卫用）
 * @param deps 发送副作用依赖（含 exitForkMode 做互斥）+ 跨域能力
 */
export function useComposerHandoffMode(
  sessionId: ComputedRef<string | null>,
  deps: HandoffDeps,
): ComposerHandoffModeReturn {
  // handoff 编排经 deps 注入（Composer 从 useSidebar 取，避免本 composable 重复实例化 useSidebar）。
  const handoffAction = deps.handoff
  // 取消进行中的 handoff 同样经 deps 注入（与 handoff 对称，来自 useHandoffActions）。
  const abortHandoffAction = deps.abortHandoff

  const staging = createStagingMode<HandoffSourceShape>({
    sessionId,
    deps: {
      inputRef: deps.inputRef,
      setSending: deps.setSending,
      clearInput: deps.clearInput,
      restoreInput: deps.restoreInput,
      enterStagingMode: deps.enterStagingMode,
      exitStagingMode: deps.exitStagingMode,
      getStagingConfig: deps.getStagingConfig,
      t: deps.t,
      toastError: deps.toastError,
    },
    type: 'handoff',
    signal: deps.handoffEnterSignal,
    // 源 session streaming 中拦截：handoff turn 需要源 session 空闲，此时进入模式必然
    // 发送失败（pi 拒绝 prompt），不如入口就拦 + toast（含直接调 enterHandoffMode 的所有路径）。
    enterGuard: (source) => {
      if (deps.isSessionActive(source.srcSessionId)) {
        deps.toastError(deps.t('panel.composer.handoffBusy'))
        return false
      }
      return true
    },
    // 互斥：进 handoff 前退出 fork 模式（避免 forkSource 残留 + 两个模式同时活跃）
    beforeEnter: () => {
      deps.exitForkMode()
    },
    // 兑底守卫（入口拦截后的竞态窗口：进入模式后 session 才变 streaming）。返回 true 已消费
    // （不走普通 send），不清草稿不退模式——回复结束后可直接重发。
    beforeSend: (_text, source) => {
      if (deps.isSessionActive(source.srcSessionId)) {
        deps.toastError(deps.t('panel.composer.handoffBusy'))
        return true
      }
      return false
    },
    // reply 备注可选：空文本也允许（runtime handoff turn 无 reply 时只发 template）。空则 undefined 不传 reply。
    sendAction: (source, text, staging) => {
      const reply = text.trim() || undefined
      return handoffAction(source.srcSessionId, reply, staging)
    },
    sendFailedKey: 'panel.message.handoffFailed',
    // handoff 允许空 reply（空文本发送时 runtime 只发 handoff template）
    allowsEmptySend: true,
    // handoff turn 在源 session 跑：isInProgress 读 deps.isHandingOff(srcSessionId)
    isInProgress: (source) => deps.isHandingOff(source.srcSessionId),
    abort: abortHandoffAction,
    activeBoxClass:
      'handoff-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring,rgba(79,142,247,0.45))] bg-[var(--accent-soft)]',
    placeholderKey: 'panel.composer.handoffHint',
    chipLabelKey: 'panel.composer.handoffChip',
    chipIcon: deps.handoffChipIcon,
  })

  return {
    handoffMode: staging.mode,
    handoffModeRef: staging.modeRef,
    enterHandoffMode: (srcSessionId) => staging.enter({ srcSessionId }),
    exitHandoffMode: staging.exit,
    handoffBoxClass: staging.boxClass,
    handoffPlaceholder: staging.placeholder,
    handleHandoffEsc: staging.handleEsc,
    handleHandoffSend: staging.handleSend,
    asStagingAction: staging.asStagingAction,
  }
}
