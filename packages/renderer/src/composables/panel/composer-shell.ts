/**
 * composer-shell.ts —— renderer 壳层 deps 组装 + 视觉派生（W4 composer-shell-integration）。
 *
 * 定位：p3-strangler-domains::composer W4 产物。替代 14 个 useComposer* shim（W2/W3 双轨期
 * 过渡产物），把 core dispatch/context/model-thinking/input 模块的跨域 deps 组装集中在此，
 * Composer.vue 只做解构 + 模板绑定（<script setup> ≤300 行约束）。
 *
 * 命名刻意避开 useComposer* 前缀（TC4 lint 残留检查不误伤；W3 教训：core exports 只暴露
 * barrel 子路径，此处 import 全走 @taiji/core/domain/composer/{dispatch,context,input}）。
 *
 * deps 来源分层（AC10 零 renderer import 的反向约束——本文件是 renderer，可以 import 一切）：
 * - core 模块：useComposerModelThinking / useComposerInjection / useComposerHistory /
 *   useComposerContextChips / useComposerDragDrop / useComposerRestore / useComposerForkMode /
 *   useComposerHandoffMode / useComposerStaging / useComposerBash / useComposerSubmit / useComposerSend
 * - renderer store/composable：useChatStore / useSessionStore / useSettingsStore / useNewTaskFlow /
 *   useModel / useHandoffActions / useCompactQueue / useSidebar / useToast / useForkModeChannel /
 *   useHandoffModeChannel / useImageAttachment / useI18n
 *
 * 视觉派生（D1「视觉派生留壳」）：useComposerBoxClass + useComposerModeVisual 的逻辑并入本文件
 * （boxClass 三级链：staging > bash > 流式 steer 呼吸 > 聚焦 ring；placeholder 四级链：
 * staging > bash > steerHint > deferHint > inputHint），删除原 2 文件（无独立复用点，仅 Composer.vue 消费）。
 */
import { computed, reactive, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitFork, Upload } from '@lucide/vue'
import type { ProviderId, Segment, Message } from '@taiji/shared'
import { normalizeContent } from '@taiji/shared'
import {
  useComposerModelThinking,
  useComposerInjection,
  useComposerContextChips,
  useComposerForkMode,
  useComposerHandoffMode,
  useComposerStaging,
  useComposerBash,
  useComposerSubmit,
  useComposerSend,
  resolveSendRoute,
  IDLE_SESSION_PHASE,
  type SendRoute,
  type SessionPhase,
} from '@taiji/core/domain/composer'
// input 域 3 个 composable 已迁 @taiji/dom-core（ADR-0058）：history/dragdrop/restore
import {
  useComposerHistory,
  useComposerDragDrop,
  useComposerRestore,
  type DraftStore,
} from '@taiji/dom-core/composer/input'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { usePresetStore } from '@/stores/preset'
import { getSettingsStore } from '@taiji/core'
import { useChat } from '@/composables/features/chat/useChat'
import { useNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
// 显示侧与 submit 侧 getSupportedLevels 的主路径唯一实现（F5；例外 = core flow.ts
// buildFallbackLaunchInput 的壳未接线 fallback 逐字镜像，过渡语义，改动双侧同步）；
// 独立模块——composer 系列测试
// vi.mock 整个 useNewTaskFlow 模块时，本文件 import 链不被 mock 波及
import { supportedLevelsOf } from '@/composables/features/new-task/supported-levels'
import { useModel } from '@/composables/features/model/useModel'
import { useHandoffActions } from '@/composables/features/fork-handoff/useHandoffActions'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useCompactQueue } from './useCompactQueue'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { useToast } from '@/composables/useToast'
import { useComposerShortcutActions } from './composer-shortcut-actions'
import { modelSwitchErrorMessage, modelSwitchToastKey } from './model-switch-toast'
import { useForkModeChannel } from './useForkModeChannel'
import { useHandoffModeChannel } from './useHandoffModeChannel'
import { handleImagePaste } from './useImageAttachment'
import { composerInjectionStore } from './composer-injection-store'

/**
 * ComposerInput 壳层实例契约（composer-shell 视角的完整 expose 面）。
 *
 * core 各模块（history/context-chips/send/submit/restore/fork/handoff）各自定义最小结构契约
 * （getSegments/removeImageChip 等分散在模块内），此处合并为壳层组装用的完整面——
 * ui ComposerInput.vue 的 defineExpose 同时满足所有模块契约（结构类型），
 * Composer.vue 传入的模板 ref 实例可赋值给本接口。
 *
 * [tsc 前置修复] useCommandPopoverTrigger 原以 `InstanceType<typeof ComposerInput>` 消费
 * 该面——vue-tsc 可解析 .vue defineExpose，但 renderer 的 plain tsc 经 env.d.ts 的
 * `*.vue` shim 落到 `DefineComponent<object, object, unknown>`（无 expose 成员，19 处
 * TS2349 never）。改为结构契约后 plain tsc 也能全量解析（签名为 dom-core composable
 * 真源的同构镜像，U8b 前置清零）。扩 expose 面时本接口须同步（漏键 = 消费方 tsc 红）。
 */
export interface ShellInputInstance {
  clear: () => void
  focus: () => void
  getText: () => string
  getSegments: () => Segment[]
  setText: (text: string, caretPosition?: 'end' | 'start') => void
  insertTextAtCursor: (text: string) => void
  insertSlashChip: (command: string, icon?: string) => void
  insertSkillChip: (name: string, location?: string, icon?: string) => void
  insertMentionChip: (type: '@' | '#', name: string) => void
  insertFileChip: (path: string, lineRange?: [number, number]) => void
  insertSessionChip: (sessionId: string, label: string) => void
  insertSubagentChip: (subagentId: string, slug: string) => void
  insertImageBadge: (path: string, fileName: string, displayName: string, needsMigrate?: boolean) => void
  removeImageChip: (chipId: string) => void
  clearSlashQueryText: () => void
  clearHashQueryText: () => void
  /** # query 段清除（session 语义，expose 别名 = clearHashQueryText） */
  clearSessionQueryText: () => void
  clearDollarFileQueryText: () => void
  clearSubagentQueryText: () => void
  clearSkillQueryText: () => void
  saveSelection: () => void
  restoreSelection: () => void
  moveCaretVertical: (dir: 'up' | 'down') => 'moved' | 'at-edge'
  /**
   * contenteditable 输入根元素读取口（command-popover-keyboard activeElement 门识别源）。
   * 可选成员 = 运行时可能缺失（版本错配/简化实现），缺失时消费方 fail-closed false——
   * 禁止回退实例 $el（W1 F-1：dev 构建保留模板注释 → $el 为注释节点，门恒 false）。
   */
  getInputElement?: () => HTMLElement | null
}

/** useComposerShell 入参：Composer.vue 组件局部状态（ref/Map 真源留在壳层） */
export interface ComposerShellParams {
  /** 当前 session id（null = landing 态） */
  sessionIdRef: ComputedRef<string | null>
  /** variant（'panel' | 'landing'，landing 分流依据） */
  variantRef: ComputedRef<'panel' | 'landing'>
  /** ComposerInput 实例 ref（expose 面消费） */
  inputRef: Ref<ShellInputInstance | null>
  /** composer-box 容器 ref（拖拽落位 + boxClass 视觉） */
  composerBoxRef: Ref<HTMLElement | null>
  /** draft ref（纯文本，发送判断 + 失败恢复） */
  draft: Ref<string>
  /** 发送中标志位（普通 send / landing 首发 / staging 发送共用） */
  isSending: Ref<boolean>
  /** per-session 草稿存储窄接口（ADR-0049：经 useSessionScopedState 分区，不暴露 Map 引用） */
  drafts: DraftStore
  /** session 是否活跃（流式/派发）—— canSend/visual 守卫 */
  isActive: ComputedRef<boolean>
  /** 命令浮层 open 态（useCommandPopoverTrigger 产物；命令动作表守卫——浮层 open 时动作表跳过） */
  cmdOpen: Readonly<Ref<boolean>>
}

/**
 * 历史派生的引用键缓存（ADR-0039 兑现）：chat store 消息不可变替换（commitMessages 整体
 * 替换分区内层 ref，无原地写入）⇒ 源数组引用同则内容同。↑/↓ 长按导航（~30Hz keydown）下
 * 跳过全量 messages 重遍历 + 每条 normalizeContent 重建。键为源数组本身（WeakMap 弱引用）：
 * 分区数组被替换后旧键随 GC 回收，无 per-session 生命周期管理；getMessages 空分区每次
 * 新建 []，天然 miss（重算 O(1) 无害）。
 */
// @data-owner #7 —— #7 消息列表的 composer 历史派生缓存（引用键纯派生，非第二写方）
const historyDeriveCache = new WeakMap<Message[], string[]>()

/**
 * 历史条目派生（替代 chatStore.getMessages 直读，core history 模块经 deps 注入）。
 * 倒序 + role==='user' + status==='complete' + 去重连续相同文本（原 shim 逻辑平移）。
 * 结果按源数组引用缓存（见 historyDeriveCache）并返回缓存实例——消费方
 * （core input/history computed）只读遍历（.length / 索引读取），实例复用安全。
 * 导出供单测（缓存刷新语义）。
 */
export function deriveHistoryFromChatStore(chatStore: ReturnType<typeof useChatStore>, sid: string): string[] {
  const msgs = chatStore.getMessages(sid)
  const cached = historyDeriveCache.get(msgs)
  if (cached) return cached
  const result: string[] = []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'user' || m.status !== 'complete') continue
    const text = normalizeContent(m.content)
    if (result.length > 0 && result[result.length - 1] === text) continue
    result.push(text)
  }
  historyDeriveCache.set(msgs, result)
  return result
}

/**
 * @param params Composer.vue 组件局部状态（ref/Map 真源）
 * @returns core 模块组装结果 + 派生状态（Composer.vue 解构消费）
 */
export function useComposerShell(params: ComposerShellParams) {
  const { sessionIdRef, variantRef, inputRef, composerBoxRef, draft, isSending, drafts, isActive, cmdOpen } = params
  const { t } = useI18n()
  const chatStore = useChatStore()
  const sessionStore = useSessionStore()
  const presetStore = usePresetStore()
  const settingsStore = getSettingsStore()
  const flow = useNewTaskFlow()
  const { info: toastInfo, error: toastError } = useToast()
  const { send, steer, followUp, abort, compact, sendBash } = useChat()
  const { handoff: handoffAction, abortHandoff: abortHandoffAction } = useHandoffActions(sessionIdRef)
  const { switchModel, setThinkingLevel } = useModel()
  const compactQueue = useCompactQueue()
  const sidebar = useSidebar()
  const { signal: forkEnterSignal } = useForkModeChannel()
  const { signal: handoffEnterSignal } = useHandoffModeChannel()

  // ── 模型 + 思考等级（core model-thinking；landing resolve 显示 + staging 快照）──
  const {
    currentModelId,
    currentThinkingLevel,
    currentThinkingLevelMap,
    currentSupportedLevels,
    localThinkingLevel,
    switching,
    onModelSelect,
    onThinkingSelect,
    enterStagingMode,
    exitStagingMode,
    getStagingConfig,
  } = useComposerModelThinking(sessionIdRef, {
    getSessionState: (sid: string) => {
      const s = sessionStore.list.find((x) => x.id === sid)
      if (!s) return null
      return { modelId: s.modelId, thinkingLevel: s.thinkingLevel }
    },
    defaultModel: computed(() => settingsStore.defaultModel.value),
    currentModel: flow.currentModel,
    // [U4r2] 显式 preset 选择进 chip 侧 resolve 输入（D1 pending 三兄弟补齐）：flow
    // pendingPreset 只读视图（Landing.onPresetSelect 写入）——chip 显示与 submit 透传
    // 同源同输入，显式 preset 捆绑字段不再只在 submit 侧生效（显示 ≠ 生效破口修复）。
    // 视图缺失（部分测试 mock 的 flow 简化形态）= 无显式选择 → null，不阻断 chip 解析
    pendingPreset: () => flow.pendingPreset?.value ?? null,
    setPendingModel: (model: string) => flow.setPendingModel(model),
    switchModel,
    setThinkingLevel,
    getThinkingLevelMap: (modelId: string) => {
      // 旧版守卫：无 '/' 的 modelId（如空串/非完整模型 id）直接返回 undefined（all-levels），
      // 不碰 providers（测试 mock 的 settingsStore 可能无 providers）。
      if (!modelId.includes('/')) return undefined
      const [providerId, modelName] = modelId.split('/')
      const provider = settingsStore.providers?.value?.find((p: { id: string }) => p.id === providerId)
      return provider?.models.find((m: { id: string }) => m.id === modelName)?.thinkingLevelMap
    },
    getSupportedLevels: (modelId: string) => {
      // 与 submit 侧 supportedLevelsOf 即同一函数（U6：runtime 注册表 pi 同源计算的
      // view-ready 下发，可用档判定唯一权威，不再本地推算）。曾与本文件各持一份实现，
      // 显示侧漏 enabled 检查 → 禁用 provider 下显示档与生效档发散（F5 统一）。
      return supportedLevelsOf(modelId, settingsStore.providers?.value ?? [])
    },
    // [U2d] landing 显示链完整解析数据注入（D1 单一解析层）：preset 档可达（preset 档
    // 此前在 core 无镜像，显示恒跳过）+ D4 lastUsedModel 校验获得 providers 能力表。
    // getter 闭包内读响应式 store，createLaunchConfigView 据此建立依赖——preset store
    // 惰性加载完成后 chip 自动重算（P5①）。加载触发不在此（PresetSelectChip onMounted
    // loadPresets 既有通路覆盖 landing 挂载场景）。
    launchData: {
      presets: () => presetStore.presets,
      defaultPresetId: () => presetStore.defaultPresetId || null,
      providers: () => settingsStore.providers?.value,
    },
  })

  // ── 上下文注入消费（side-effect：watch pendingInjection 路由；target=new 触发 startFlow）──
  useComposerInjection(inputRef, sessionIdRef, variantRef, {
    injectionStore: composerInjectionStore,
    startFlow: (cwd?: string) => flow.startFlow(cwd),
    getSessionCwd: (sid: string) => sessionStore.list.find((s) => s.id === sid)?.cwd ?? undefined,
    getActiveSessionId: () => sessionStore.active?.id ?? null,
  })

  // ── 输入历史导航（↑/↓ shell 风格，core input/history）──
  const { handleArrowUp, handleArrowDown, resetBrowsing, isBrowsing } = useComposerHistory(sessionIdRef, {
    getText: () => inputRef.value?.getText() ?? '',
    setText: (text, caretPosition) => inputRef.value?.setText(text, caretPosition),
    clear: () => inputRef.value?.clear(),
    getHistoryEntries: (sid: string) => deriveHistoryFromChatStore(chatStore, sid),
  })

  // ── 已附上下文 chip 行（core context/context-chips）──
  const { attachedItems, refreshAttachedItems, onRemoveContextChip } = useComposerContextChips(inputRef)

  // ── composer-box 拖拽落位（core input/dragdrop；pasteImage 注入 handleImagePaste）──
  const { onDragOver, onDragLeave, onDrop } = useComposerDragDrop(inputRef, composerBoxRef, refreshAttachedItems, sessionIdRef, {
    pasteImage: handleImagePaste,
  })

  // ── 发送后清空 / 失败恢复（core input/restore）──
  const { clearInput, restoreInput, restoreSegments } = useComposerRestore({
    draft,
    inputRef,
    drafts,
    sessionId: sessionIdRef,
  })

  // ── Fork 提问模式（core dispatch/fork-mode）──
  const fork = useComposerForkMode(sessionIdRef, {
    inputRef,
    setSending: (value: boolean) => { isSending.value = value },
    clearInput,
    restoreInput,
    enterStagingMode,
    exitStagingMode,
    getStagingConfig,
    t: t as (key: string, params?: Record<string, unknown>) => string,
    forkChipIcon: GitFork,
    forkSessionAsk: sidebar.forkSessionAsk,
    toastError,
    forkEnterSignal,
  })

  // ── Handoff 模式（core dispatch/handoff-mode；互斥：进 handoff 前退出 fork）──
  const handoff = useComposerHandoffMode(sessionIdRef, {
    inputRef,
    setSending: (value: boolean) => { isSending.value = value },
    clearInput,
    restoreInput,
    exitForkMode: fork.exitForkMode,
    handoff: (srcSessionId, reply, staging) => handoffAction(srcSessionId, reply, staging),
    abortHandoff: (sessionId) => abortHandoffAction(sessionId),
    enterStagingMode,
    exitStagingMode,
    getStagingConfig,
    t: t as (key: string, params?: Record<string, unknown>) => string,
    handoffChipIcon: Upload,
    toastError,
    isHandingOff: (sid: string) => chatStore.isHandingOff(sid),
    isSessionActive: (sid: string) => !!sid && chatStore.isActive(sid),
    handoffEnterSignal,
  })

  // ── Staging 聚合路由（core dispatch/staging，ADR-0057）──
  const staging = useComposerStaging({
    fork: fork.asStagingAction(),
    handoff: handoff.asStagingAction(),
  })

  const hasInput = computed(() => draft.value.trim().length > 0)

  // ── D6 发送路由（u5b）+ 发送位四态（u6b）：sessionPhase（occupancy 投影）单一派生 ──
  // 数据源 = chat store sessionPhase（session.occupancy 帧驱动 + stateSnapshot 快照恢复）。
  // 发送位四态（D6 表「发送位」列）与 ActivityStrip 从同一真值取数，与分发器行为同源不漂移。
  //
  // turn 活跃判定取**并集**：occupancy 权威投影 ∨ 本地乐观视图（isActive = streaming 实体
  // ∨ 乐观 pendingSend）。本地 send 的乐观置位先于 runtime occupancy 广播（RPC RTT 窗口），
  // 只看投影会让窗口内 Enter 落 direct 被 canSend 守卫拦死（死键回退）——并集保持现状
  // isActive→steer 语义；settling/compacting/bash 维度无本地乐观源，由权威帧独占。
  // sendRoute（三值浓缩）与发送位（需原始 turn/compacting/bash 维度细分——如 settling 单独
  // vs settling+compacting 的 stop/queue 分档）共用同一 effective phase，不双真源。
  const effectivePhase = computed<SessionPhase>(() => {
    const sid = sessionIdRef.value
    if (!sid) return IDLE_SESSION_PHASE // landing（无 session）无 occupancy 记录 → 全 idle
    const phase = chatStore.sessionPhase(sid)
    // 本地乐观 busy 投影化为 dispatching（「已发起未确认」的 occupancy 语义）后过统一派生
    // ——判定逻辑单点在 resolveSendRoute / 发送位派生，消费方复用同源不漂移。
    return isActive.value && phase.turn === 'idle' ? { ...phase, turn: 'dispatching' as const } : phase
  })
  const sendRoute = computed<SendRoute>(() => resolveSendRoute(effectivePhase.value))

  /**
   * [u6b] 发送位四态（D6 表「发送位」列）：send（↑ 直发）/ stop（■ 中止）/ queue（↑ 带时钟
   * 角标排队）。派生自与 sendRoute 同源的 effectivePhase：
   * - turn ∈ {dispatching, generating}（含 threshold 行 3）→ stop（turn 活跃，点击 abort）
   * - settling 分档：单独 → stop（收尾期可中止）；settling + compacting/bash → queue
   *   （turn 不活跃 + 其他维度忙——行 5/6 同构；D6 表未单列 settling+bash，按同构归 queue，
   *   登记 impl-plan 偏差表）
   * - compacting / bash（turn=idle）→ queue（行 5/6）
   * - 全 idle → send（行 1）
   */
  const sendButtonState = computed<'send' | 'stop' | 'queue'>(() => {
    const phase = effectivePhase.value
    if (phase.turn === 'dispatching' || phase.turn === 'generating') return 'stop'
    if (phase.turn === 'settling') return (phase.compacting || phase.bash) ? 'queue' : 'stop'
    if (phase.compacting || phase.bash) return 'queue'
    return 'send'
  })

  // ── bash 命令模式（core dispatch/bash；sendBash 注入）──
  const composerBash = useComposerBash({
    draft,
    clearInput,
    isSending,
    sessionId: () => sessionIdRef.value,
    sendBash,
  })
  const isBashMode = composerBash.isBashMode

  // ── 提交动作（core dispatch/submit）──
  const { onSteer, onFollowUp, onAbort } = useComposerSubmit({
    hasInput,
    isActive,
    draft,
    inputRef,
    sessionIdRef,
    clearInput,
    restoreInput,
    // [D2] onSteer 失败恢复完整草稿（text + chips，与 send.ts routeSteer 同款）
    restoreSegments,
    steer,
    followUp,
    abort,
  })

  /** 忙时（流式/派发/发送中）—— canSend 共用守卫（不含 isCompacting：压缩期允许排队）。
   *  仅约束普通 send；staging 发送不受 isActive 拦（fork-ask 对源只读，streaming 中合法） */
  const isBusy = computed(() => isActive.value || isSending.value)
  const canSend = computed(() => hasInput.value && !isBusy.value)
  /** 可提交：staging 活跃时只看本地双发锁（isSending）——streaming 中 fork 提交合法，
   *  handoff 的 streaming 拦截在入口（enterHandoffMode）+ 兑底（handleHandoffSend）。
   *  非 staging 态维持原 canSend（hasInput ∧ ¬isBusy）。 */
  const canSubmit = computed(() => {
    const active = staging.activeStaging.value
    if (active) return (hasInput.value || active.allowsEmptySend) && !isSending.value
    return canSend.value
  })

  // ── 视觉派生（原 useComposerBoxClass + useComposerModeVisual 合并，D1 留壳）──
  const stagingBoxClass = computed(() => staging.activeStaging.value?.visual.boxClass.value ?? '')
  const stagingPlaceholder = computed(() => staging.activeStaging.value?.visual.placeholder.value ?? null)
  /** composer-box class 三级链：staging > bash（accent 边 + ring）> 流式 steer 呼吸 > has-input 微环；发送中叠半透明。
   *  分支 token 同口径（has-input = 2px surface-hover/40 微环，不改 border；
   *  rgba(255,255,255,0.04) 硬编码已废弃） */
  const boxClass = computed<Array<string | false>>(() => [
    stagingBoxClass.value
      || (isBashMode.value
        ? 'composer-bash-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring)]'
        : isActive.value
          ? 'border-[var(--accent)] shadow-[var(--shadow-glow)]'
          : hasInput.value
            ? 'shadow-[0_0_0_2px_color-mix(in_oklch,var(--surface-hover)_40%,transparent)]'
            : ''),
    isSending.value && 'opacity-[0.55]',
  ])
  /** placeholder 四级链：staging > bash > 流式 steerHint > defer 占用 deferHint > 普通 inputHint。
   *  defer 行（settling/compacting/bash 占用、turn 不活跃）此前误显 idle inputHint，
   *  与发送位 queue 态不同源——补第四级与 D6 路由同源取数。 */
  const placeholder = computed(
    () =>
      stagingPlaceholder.value
      ?? (isBashMode.value
        ? t('panel.composer.bashPlaceholder')
        : isActive.value
          ? t('panel.composer.steerHint')
          : sendRoute.value === 'defer'
            ? t('panel.composer.deferHint')
            : t('panel.composer.inputHint')),
  )

  // ── 发送分流（core dispatch/send；D6 统一分发器：staging > steer 路由 > canSend > staging.send >
  //    defer 路由 > landing > bash > /compact > send）──
  const { onSend } = useComposerSend({
    staging: { hasActiveStaging: staging.hasActiveStaging, send: staging.send, activeStaging: staging.activeStaging },
    getStagingConfig,
    canSend,
    hasInput,
    getSendRoute: () => sendRoute.value,
    draft,
    inputRef,
    sessionIdRef,
    variantRef,
    composerBash: { extractBashCommand: composerBash.extractBashCommand, trySendBash: composerBash.trySendBash },
    clearInput,
    restoreSegments,
    isSending,
    flow,
    localThinkingLevel,
    send,
    steer,
    compact,
    enqueueCompact: (sessionId: string, text: string, segments: Segment[]) =>
      compactQueue.enqueue(sessionId, text, segments),
    toastError,
    t: t as (key: string, params?: Record<string, unknown>) => string,
  })

  // ── Composer 命令动作表（composer-pi-shortcuts U1③组装；分发链「动作表」分支消费）──
  // enabledModels = settingsStore.models 经 enabled 兜底过滤（与 ModelSelectPopover 双保险
  // 同款：runtime aggregateModels 已过滤一遍，同源广播未过滤时兜底；序 = scopedModels 白名单
  // 重排的显示序，即模型循环序）。models?. 同款防御：测试 mock 的 settingsStore 可能缺字段。
  const enabledModels = computed(() => (settingsStore.models?.value ?? []).filter((m) => m.enabled !== false))
  /** staging 活跃只读信号（R2：从既有 staging.activeStaging 派生，零 core 改动） */
  const isStaging = computed(() => staging.activeStaging.value !== null)
  /**
   * UI 路径的统一通知包装（U4，model-switch-live-provider-sync §3.4 / D7）：
   * 点 composer 的模型 chip / popover 或档位 chip / popover → 失败按 `error.code` 映射 toast。
   *
   * 三条纪律：
   * - **不外抛**：壳层只给 `Composer.vue` 的模板绑定这件包装（不传给键盘循环），不 rethrow
   *   既避免 Vue 事件处理器把 rejection 记成「Unhandled error」，也避免与 shortcut 路径叠加成双 toast
   *   （键盘循环收**原始** core 函数，其内联 catch 需要 rejection 来做意图清理并自行 toast）。
   * - **不通向 landing/staging**：core 的 landing/staging 分支不发 RPC、不 reject，包装天然 no-op。
   * - **文案单点**：code→i18n key 映射在 `model-switch-toast.ts`，与 shortcut 路径共用。
   */
  async function onModelSelectUi(payload: { modelId: string; provider: ProviderId }): Promise<void> {
    try {
      await onModelSelect(payload)
    } catch (err) {
      toastError(t(modelSwitchToastKey(err), { error: modelSwitchErrorMessage(err) }))
    }
  }

  /** 档位 UI 路径包装（与 onModelSelectUi 同款；自动对齐走 core 内部，不经此处、只记日志）。 */
  async function onThinkingSelectUi(level: string): Promise<void> {
    try {
      await onThinkingSelect(level)
    } catch (err) {
      toastError(t(modelSwitchToastKey(err), { error: modelSwitchErrorMessage(err) }))
    }
  }

  const shortcutActions = useComposerShortcutActions({
    cmdOpen,
    sessionId: sessionIdRef,
    isStaging,
    currentModelId,
    currentThinkingLevel,
    currentSupportedLevels,
    enabledModels,
    // 刻意传**原始** core 函数（非 onModelSelectUi 包装）：键盘循环的内联 catch 需要
    // rejection 到达才能清 `modelIntent`/`thinkingIntent`（意图清理是功能必需），
    // 并由它自己 toast（每条路径恰一个通知点，U4）。
    onModelSelect,
    onThinkingSelect,
    getMessages: (sid: string) => chatStore.getMessages(sid),
    // toast 窄接口适配（U3）：入参 i18n key，此处完成翻译——翻译时刻 = 触发时刻
    toast: {
      info: (key: string) => toastInfo(t(key)),
      error: (key: string) => toastError(t(key)),
    },
  })

  return {
    // model-thinking（onModelSelect/onThinkingSelect 对外 = **UI 包装版**：模板绑定用；
    // 键盘循环在 shortcutActions 内部拿原始函数，见上方组装处注释）
    currentModelId,
    currentThinkingLevel,
    currentThinkingLevelMap,
    currentSupportedLevels,
    localThinkingLevel,
    /**
     * 「切换中」只读真值（U4）：`{ kind, sessionId, target } | null`。
     * 消费侧（Composer.vue）**必须判 sessionId 等值**再显示/禁用（切走 session 后不得残留旧面板态）。
     */
    switching,
    onModelSelect: onModelSelectUi,
    onThinkingSelect: onThinkingSelectUi,
    enterStagingMode,
    exitStagingMode,
    getStagingConfig,
    // history
    handleArrowUp,
    handleArrowDown,
    resetBrowsing,
    isBrowsing,
    // context chips
    attachedItems,
    refreshAttachedItems,
    onRemoveContextChip,
    // dragdrop
    onDragOver,
    onDragLeave,
    onDrop,
    // restore
    clearInput,
    restoreInput,
    restoreSegments,
    // fork / handoff / staging
    fork,
    handoff,
    staging,
    // bash
    composerBash,
    isBashMode,
    // submit
    onSteer,
    onFollowUp,
    onAbort,
    // send
    onSend,
    // composer 命令动作表（composer-pi-shortcuts：分发链「动作表」分支消费）
    shortcutActions,
    // D6 发送路由 + 发送位四态（u5b 导出：分发器路由 / P4 发送位与 ActivityStrip 同源消费）
    sendRoute,
    sendButtonState,
    // 派生状态
    hasInput,
    isBusy,
    canSend,
    canSubmit,
    // 视觉
    boxClass,
    placeholder,
  }
}

export type ComposerShellReturn = ReturnType<typeof useComposerShell>
// Segment 类型 re-export（Composer.vue 发送/恢复链路消费）
export type { Segment }

/**
 * FR4: per-session 草稿存储（内存不持久化）；session 切换时保存旧/恢复新草稿。
 * ADR-0049：裸 Map 迁到 useSessionScopedState 分区——结构化消除 session 泄漏。
 * DraftStore 窄接口：消费方（restore.ts）只关心 get/save/delete，不持有 Map 引用。
 */
export function createComposerDrafts(sessionIdRef: ComputedRef<string | null>): DraftStore {
  const draftsState = useSessionScopedState(sessionIdRef, () => reactive({ text: '' }))
  return {
    getDraft: (sid: string) => {
      let text = ''
      draftsState.updateFor(sid, (s) => { text = s.text })
      return text
    },
    saveDraft: (sid: string, text: string) => {
      draftsState.updateFor(sid, (s) => { s.text = text })
    },
    deleteDraft: (sid: string) => {
      // cleanup 移除分区（triggerSessionCleanups 也会调，此处是发送成功后即时清理）
      draftsState.cleanup(sid)
    },
  }
}
