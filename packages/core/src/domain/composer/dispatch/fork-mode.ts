/**
 * useComposerForkMode —— Composer 的 fork 提问模式（FR-13/14/15）。
 *
 * 职责：
 * - forkMode 状态真源：是否处于「从某条 assistant fork 出新分支」的提问模式
 * - forkSource：记录 fork 来源（srcSessionId = fork 点所在 session，fromMessageId = fork 点 assistant id）
 * - enterForkMode / exitForkMode：进入（记来源 + 聚焦输入框）/ 退出（复位状态）
 * - 跨组件触发通道：watch forkEnterSignal（Sidebar ⌘⇧G 请求），命中本 session 时 enterForkMode
 * - forkBoxClass / forkPlaceholder：fork 模式派生的 class 与 placeholder 文案
 * - handleForkEsc：Esc 退出（清空输入 + exitForkMode），返回是否已消费
 * - handleForkSend：fork 模式发送（调 forkSessionAsk + 退出），返回是否已消费
 * - forkModeRef：{ value: boolean } 包装对象，给 defineExpose 用（避免 Vue 解包顶层 ref 导致 vm.forkMode 变 boolean）
 *
 * [D8 泛化] fork 与 handoff 曾约 75% 逐字镜像（enter/exit/signal watch 守卫/handleEsc/
 * handleSend 骨架/modeRef getter，设计 §2 例 5）。行为骨架已收敛到 createStagingMode
 * （./staging-mode），本模块 = fork 配置对象 + 薄包装：公开 API（返回面 9 项）与
 * ForkDeps 注入契约保持不变，消费方零改动。fork 差异全部经配置表达（P2 清单见
 * staging-mode.ts 头注）：send 目标 = forkSessionAsk（空 content 守卫在 features 层
 * 退化为纯 fork → allowsEmptySend=true）；无 enter 守卫 / 互斥退出 / 发送兑底守卫 /
 * B 阶段（isInProgress 恒 false、abort 无）。
 *
 * 发送/清空输入等副作用通过 deps 注入（Composer 持有 draft/isSending/clearInput/restoreInput 真源），
 * 保持 fork 状态真源单一且不侵入 Composer 已稳定的发送/草稿流程。
 *
 * [W3 迁移] 迁自 renderer composables/panel/useComposerForkMode.ts。跨域能力（vue-i18n t /
 * GitFork icon / forkSessionAsk / toastError / forkEnterSignal channel）去掉 renderer import，
 * 改为 ForkDeps 字段注入（core 零 renderer 依赖）。
 */
import type { ComputedRef, Ref } from 'vue'
import type { Component } from 'vue'
import type { ComposerInputInstance, KeyboardEventLike, StagingAction, StagingConfig } from '../types'
import { createStagingMode } from './staging-mode'

/**
 * fork source 形状（createStagingMode 泛型 S 的 fork 实例化）：
 * srcSessionId + fromMessageId（fork 点 assistant id，runtime 据此截断历史）。
 */
interface ForkSourceShape {
  srcSessionId: string
  fromMessageId: string
}

/** fork 发送副作用依赖（由 Composer 注入，避免重复持有 draft/isSending 真源） */
export interface ForkDeps {
  /**
   * ComposerInput 实例 ref：enterForkMode 聚焦输入框用。
   * 本模块视角的最小契约——从域级权威接口（../types）Pick 仅 focus，耦合面显式
   * 受控于权威定义（权威 focus 必选，真实实例 defineExpose 必有；调用点 focus 的
   * 二级可选链按零行为变化原则原样保留，运行时骗类型的低配桩仍不炸）。
   */
  inputRef: Ref<Pick<ComposerInputInstance, 'focus'> | null>
  /** 发送中标志位 setter（fork 发送期间置 true，结束复位） */
  setSending: (value: boolean) => void
  /** 发送成功后清空输入区（DOM + draft + 持久化草稿） */
  clearInput: () => void
  /** 发送失败时恢复草稿到输入区 */
  restoreInput: (text: string) => void
  /** Staging Mode（ADR-0056）：进入暂存态（快照模型/thinking） */
  enterStagingMode: () => void
  /** Staging Mode：退出暂存态（清空快照，恢复常规态） */
  exitStagingMode: () => void
  /** Staging Mode：获取暂存配置（供 fork 发送时透传给新 session） */
  getStagingConfig: () => StagingConfig
  // ── 跨域能力（W3 迁移：去掉 renderer import，改为 deps 注入）──
  /** i18n 翻译（原 vue-i18n useI18n → t） */
  t: (key: string, params?: Record<string, unknown>) => string
  /** fork mode-chip 图标（原 @lucide/vue GitFork） */
  forkChipIcon: Component
  /** fork+send 编排（原 useSidebar forkSessionAsk；features 层跨 api + stores） */
  forkSessionAsk: (
    srcSessionId: string,
    fromMessageId: string,
    text: string,
    staging?: StagingConfig,
  ) => Promise<void>
  /** 错误 toast（原 useToast error） */
  toastError: (msg: string) => void
  /** 跨组件触发通道 signal（原 useForkModeChannel signal；Sidebar ⌘⇧G 请求） */
  forkEnterSignal: Ref<{ srcSessionId: string; fromMessageId: string } | null>
}

/**
 * @param sessionId 当前 session id（null = landing 态，signal 守卫用）
 * @param deps 发送副作用依赖 + 跨域能力
 */
export function useComposerForkMode(
  sessionId: ComputedRef<string | null>,
  deps: ForkDeps,
): {
  forkMode: Ref<boolean>
  /** { value: boolean } 包装对象，给 defineExpose 用（不被 Vue 解包，对齐 vm.forkMode.value 访问契约） */
  forkModeRef: { readonly value: boolean }
  enterForkMode: (srcSessionId: string, fromMessageId: string) => void
  exitForkMode: () => void
  /** fork 模式 composer-box class（accent 边 + 3px ring glow + accent 底）；非 fork 模式返回空串 */
  forkBoxClass: ComputedRef<string>
  /** fork 模式 placeholder 文案；非 fork 模式返回 null（调用方回退到普通 placeholder） */
  forkPlaceholder: ComputedRef<string | null>
  /** Esc 处理：fork 模式下清空输入 + 退出，返回 true 表示已消费；否则返回 false */
  handleForkEsc: (e: KeyboardEventLike) => boolean
  /** fork 模式发送：调 forkSessionAsk + exitForkMode，返回 true 表示已消费；否则返回 false */
  handleForkSend: (text: string) => Promise<boolean>
  /**
   * 包装成 StagingAction（fork 实现），供 useComposerStaging 注册消费。
   * 不改变现有 forkMode/enterForkMode 等 expose 契约（仅追加 adapter，对齐 ADR-0057）。
   */
  asStagingAction: () => StagingAction
} {
  const staging = createStagingMode<ForkSourceShape>({
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
    type: 'fork',
    signal: deps.forkEnterSignal,
    // send：fork 新分支 + text 作首条 user（staging 快照透传给新 session）
    sendAction: (source, text, staging) =>
      deps.forkSessionAsk(source.srcSessionId, source.fromMessageId, text, staging),
    sendFailedKey: 'panel.panel.sendFailed',
    // fork 允许空提交：点 fork 按钮进 composer 模式后可不输入直接提交（≈ 原后台 fork）。
    // forkSessionAsk 的空 content 守卫会退化为纯 fork（不发送首条 user）。
    allowsEmptySend: true,
    // fork-ask 是前端编排的 fork+send，无独立 inflight 可取消 → isInProgress/abort 缺省
    activeBoxClass:
      'fork-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring,rgba(79,142,247,0.45))] bg-[var(--accent-soft)]',
    placeholderKey: 'panel.composer.forkHint',
    chipLabelKey: 'panel.composer.forkChip',
    chipIcon: deps.forkChipIcon,
  })

  return {
    forkMode: staging.mode,
    forkModeRef: staging.modeRef,
    enterForkMode: (srcSessionId, fromMessageId) => staging.enter({ srcSessionId, fromMessageId }),
    exitForkMode: staging.exit,
    forkBoxClass: staging.boxClass,
    forkPlaceholder: staging.placeholder,
    handleForkEsc: staging.handleEsc,
    handleForkSend: staging.handleSend,
    asStagingAction: staging.asStagingAction,
  }
}
