/**
 * composer 域类型骨架 —— core 平台无关内核（headless）的 composer 域类型归位起点。
 *
 * 定位：p3-strangler-domains::composer 的 W1 骨架，承接架构文档 §10.2
 * （旧层 → core/domain/* 映射：renderer composables/panel/staging-types.ts 的
 * StagingAction 策略类型契约 + useComposerBash.ts 的 BashCommandExtract + shared 的 Segment）。
 *
 * 迁移过渡期（旧 Composer 未删）：renderer 侧 staging-types.ts / useComposerBash.ts
 * 保持原定义不动（旧调用方 useComposerStaging/useComposerForkMode 等仍消费 renderer 版本）。
 * 本文件为 core 独立骨架，待旧 Composer 删除时 renderer 定义收敛到此处（SSOT 归位）。
 *
 * 零 DOM 约束：core tsconfig 未配置 DOM lib。原 renderer StagingAction.handleEsc 参数为
 * DOM KeyboardEvent，此处用结构兼容的 KeyboardEventLike（{code,key}）替代——真实
 * KeyboardEvent 结构包含 code/key，可赋值给 KeyboardEventLike 参数，调用方零改动。
 */
import type { Component, ComputedRef } from 'vue'

// Segment：re-export @taiji/shared 的 SSOT（ADR-0043），不重复定义。
// shared 的 Segment 判别联合（text/skill/file/mention/image/handoff）+ segmentsToText
// 全链路消费（composer DOM → store → 渲染），runtime 的 segmentsToPrompt/convertPiHistory
// 也在消费，core 只引用不迁移。
export type { Segment } from '@taiji/shared'

/**
 * Staging 类型枚举（ADR-0057 契约）。
 *
 * 当前成员：'fork'（fork-ask 提问模式）/ 'handoff'（fast-handoff 交接模式）。
 * 未来扩展点：新增 type 只需加枚举值 + 实现 StagingAction 接口 + 注册到 useComposerStaging。
 */
export type StagingType = 'fork' | 'handoff'

/**
 * 暂存的模型/thinking 配置（ADR-0056 模型暂存层产出）。
 *
 * 由 useComposerModelThinking.getStagingConfig() 返回，send 时透传给 features 层
 * （useForkActions.forkSessionAsk / useHandoffActions.handoff），最终到 runtime 创建新 session。
 * 两个字段都是可选的——用户进 staging 后没切模型/thinking 时，快照值与源 session 相同，
 * 不传 override 让 runtime 走默认继承。
 */
export interface StagingConfig {
  modelOverride?: string
  thinkingOverride?: string
}

/**
 * Staging 来源信息（进入模式时记录，send 时消费）。
 *
 * fork 需要 fromMessageId（fork 点 assistant id，runtime 据此截断历史）；
 * handoff 不需要（始终从末条 assistant 打包文档，runtime 从 agent_end 提取）。
 * 用交叉类型区分，让 fork action 的 enter 签名强制要求 fromMessageId。
 */
export interface ForkSource {
  type: 'fork'
  srcSessionId: string
  fromMessageId: string
}

export interface HandoffSource {
  type: 'handoff'
  srcSessionId: string
}

export type StagingSource = ForkSource | HandoffSource

/**
 * KeyboardEventLike —— 结构兼容的键盘事件类型（core 零 DOM 约束替代品）。
 *
 * 原 renderer StagingAction.handleEsc 参数为 DOM KeyboardEvent。core 无 DOM lib，
 * 此处保留接口消费方实际读取的最小字段：code/key（路由判定）+ preventDefault
 * （handleEsc 实现消费——Esc 命中时阻止默认行为）。真实 KeyboardEvent 结构
 * 包含这些属性，可直接传入（调用方零改动）。preventDefault 设为可选：路由层
 * （useComposerStaging.handleEsc）不调用它，仅具体 action 实现读取。
 */
export interface KeyboardEventLike {
  code: string
  key: string
  /** 阻止默认行为（Esc 命中时 handleEsc 实现调用；真实 KeyboardEvent 必有） */
  preventDefault?: () => void
}

/**
 * StagingAction —— 某种 staging type 的完整行为契约。
 *
 * 分两阶段（与 Composer 生命周期对齐）：
 *
 * A 阶段「暂存态」（用户已进模式，发送前）：
 *   - isActive：此 staging 是否活跃（Composer 的 mode 单一真源派生自此）
 *   - enter / exit：进入（记来源 + enterStagingMode 快照模型 + 聚焦输入）/ 退出（清来源 + exitStagingMode）
 *   - send：发送（经 Composer.onSend 路由到此），text = draft，staging = 模型/thinking 快照配置
 *   - allowsEmptySend：是否允许空输入发送（handoff 允许 reply 为空；fork 必须有 content）
 *   - handleEsc：Esc 处理（清输入 + exit），返回是否已消费
 *
 * B 阶段「进行中态」（用户已发送，操作在跑）：
 *   - isInProgress：此操作是否进行中（handoff → chatStore.isHandingOff；fork → 始终 false）
 *   - abort：取消进行中的操作（handoff → abortHandoff；fork 无此阶段，实现可省略）
 *
 * 视觉（boxClass / placeholder / mode-chip）：
 *   - visual：派生的 class 串、placeholder 文案、chip 标签与图标
 */
export interface StagingAction<S extends StagingSource = StagingSource> {
  /** 类型标识（注册键 + 日志诊断） */
  readonly type: StagingType

  // ── A 阶段：暂存态（发送前）──

  /** 是否处于此 staging（活跃判定，Composer mode 单一真源派生自此） */
  readonly isActive: ComputedRef<boolean>
  /**
   * 进入此 staging。
   * 实现职责：记 source + enterStagingMode（快照模型/thinking）+ 聚焦输入框。
   * 互斥由 useComposerStaging.enter 统一编排（进入新 type 前退出其他 type），
   * 实现内部不需关心互斥。
   */
  readonly enter: (source: S) => void
  /** 退出此 staging（清 source + exitStagingMode 恢复常规态模型 chip） */
  readonly exit: () => void
  /**
   * 发送（经 Composer.onSend 路由到此）。
   * 实现职责：trim text（allowsEmptySend=false 时空文本拦截）+ clearInput + setSending(true)
   * + 取 getStagingConfig 透传 + 调 features 层 action（forkSessionAsk / handoff）
   * + 失败 restoreInput + toastError + finally setSending(false) + exit。
   * @param text 当前 draft
   * @param staging 模型/thinking 暂存配置（来自 useComposerModelThinking.getStagingConfig）
   */
  readonly send: (text: string, staging: StagingConfig) => Promise<void>
  /** 是否允许空输入发送（handoff 允许 reply 为空；fork 必须有 content） */
  readonly allowsEmptySend: boolean
  /**
   * Esc 处理：此 staging 活跃时清空输入 + 退出，返回 true 表示已消费。
   * 非此 staging 活跃或非 Escape 键返回 false（让上游继续派发）。
   * @param e 键盘事件（KeyboardEventLike 结构类型，core 零 DOM 约束；真实 KeyboardEvent 兼容）
   */
  readonly handleEsc: (e: KeyboardEventLike) => boolean

  // ── B 阶段：进行中态（发送后）──

  /**
   * 此操作是否进行中（Composer stop 按钮的 abort 路由依据）。
   * handoff → chatStore.isHandingOff(srcSessionId)（handoff turn 在源 session 跑）；
   * fork → 始终 false（fork-ask 是前端编排的 fork+send，无独立 inflight 可取消）。
   */
  readonly isInProgress: ComputedRef<boolean>
  /**
   * 取消进行中的操作（可选——无 B 阶段语义的 staging 如 fork 可不实现）。
   * handoff → useHandoffActions.abortHandoff（session.abortHandoff RPC + 乐观清 handingOff）。
   * @param sessionId 源 session id
   */
  readonly abort?: (sessionId: string) => Promise<void>

  // ── 视觉（boxClass / placeholder / mode-chip）──

  readonly visual: {
    /** composer-box class（accent 边框 + glow ring + accent-soft 底）；非活跃返回空串 */
    readonly boxClass: ComputedRef<string>
    /** placeholder 文案；非活跃返回 null（调用方回退到普通 placeholder） */
    readonly placeholder: ComputedRef<string | null>
    /** mode-chip 标签的 i18n key（如 panel.composer.forkChip） */
    readonly chipLabelKey: string
    /** mode-chip 图标组件（GitFork / Upload） */
    readonly chipIcon: Component
  }
}

/**
 * ComposerInput 实例最小契约（clear/setText/insertImageBadge/insertSlashChip/insertFileChip
 * 经 defineExpose 暴露）。用结构类型避免 import .vue 文件（循环依赖 + 类型推断复杂）。
 *
 * [ADR-0058 归位] 权威定义原在 input/types.ts（随 composer/input 迁 @taiji/dom-core），
 * 但 context 子域（注入系统）也消费此类型——类型归属依消费方修正：跨子域共享类型上移
 * 域级 types.ts，dom-core 经 '@taiji/core/domain/composer' import 并 re-export
 * （保持 dom-core barrel 对外契约不变）。
 */
export interface ComposerInputInstance {
  clear: () => void
  setText: (text: string, caretPosition?: 'end' | 'start') => void
  insertImageBadge: (path: string, fileName: string, displayName: string, needsMigrate?: boolean) => void
  insertSlashChip: (command: string, icon?: string) => void
  insertFileChip: (path: string, lineRange?: [number, number]) => void
  /** context 注入消费（focus / insertTextAtCursor），W3 合并 context 版同名接口 */
  focus: () => void
  insertTextAtCursor: (text: string) => void
  /**
   * session chip 插入（四符号体系 §3.3.4 sidebar 直引：insertSessionChip(sessionId, label)）。
   * 可选：ui ComposerInput 已 expose（U1），低配实现（旧 mock/测试桩）可缺省——
   * 消费端（injection.ts）经 ?. 调用，缺省时不注入但不崩溃。
   */
  insertSessionChip?: (sessionId: string, label: string) => void
  /**
   * subagent 定向 chip 插入（四符号 @，restore 恢复草稿用：insertSubagentChip(subagentId, slug)）。
   * 可选同上：ui ComposerInput 已 expose（U1），消费端（dom-core restore）经 ?. 调用。
   */
  insertSubagentChip?: (subagentId: string, slug: string) => void
  /**
   * skill chip 插入（skill 段回滚用：insertSkillChip(name, location, icon)，设计 D3）。
   * 可选同上：ui ComposerInput 已 expose，低配实现（旧 mock/测试桩）可缺省——
   * 消费端（dom-core restore）经 ?. 调用，缺省时静默跳过，不崩溃。
   * icon：skill chip 图标 key（renderIcon 渲染）；回滚不还原——skill 段无 icon 字段。
   */
  insertSkillChip?: (name: string, location?: string, icon?: string) => void
}

/**
 * BashCommandExtract —— 从 composer draft 提取 bash 命令的判别联合（迁移自 useComposerBash.ts）。
 *
 * - not-bash：非 bash 前缀（调用方走普通发送）
 * - empty：空命令（! 或 !! 后无内容，调用方不提交，保持 bash 模式）
 * - command：有效 bash 命令
 */
export type BashCommandExtract =
  | { type: 'not-bash' }
  | { type: 'empty' }
  | { type: 'command'; command: string; excludeFromContext: boolean }
