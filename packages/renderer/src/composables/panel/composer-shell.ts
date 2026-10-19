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
 *   useModel / useHandoffActions / useSidebar / useToast / useForkModeChannel /
 *   useHandoffModeChannel / useImageAttachment / useI18n
 *   [u3c 退役] useCompactQueue 已随投递所有权内核退役（队列区数据源 = session.delivery 帧派生视图，
 *   见 composables/panel/useQueueRows.ts）；本文件的残留职责仅剩「撤销/回收文本回输入区」。
 *
 * 视觉派生（D1「视觉派生留壳」）：useComposerBoxClass + useComposerModeVisual 的逻辑并入本文件
 * （boxClass 链：bash > 流式 steer 呼吸 > has-input 微环；placeholder 链：bash > steerHint >
 * inputHint），删除原 2 文件（无独立复用点，仅 Composer.vue 消费）。
 * [HISTORICAL] 两链的 staging 档（整框 accent 染色 / forkHint·handoffHint 换文案）已随 staging
 * banner 形态退役（demo 裁决：banner 图标染 accent 是模式在途的唯一染色点），见派生定义处。
 */
import { computed, onMounted, reactive, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRightLeft, GitBranch } from '@lucide/vue'
import type { ProviderId, Segment } from '@taiji/shared'
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
  takeOrphanedDraft,
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
import { useSubagentComposerLane, wireSubagentLaneTerminals } from '@/composables/panel/subagent-composer-lane'
import {
  useBtwSessionStateStore,
  resolveComposerSessionState,
} from '@/stores/btw-session-state'
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
  /** # query 段清除（session 语义；ComposerInput expose 别名 = dom-core 的 clearHashQueryText） */
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
  /** session 是否活跃（流式/派发）—— canSend/visual 检查 */
  isActive: ComputedRef<boolean>
  /** 命令浮层 open 态（useCommandPopoverTrigger 产物；命令动作表检查——浮层 open 时动作表跳过） */
  cmdOpen: Readonly<Ref<boolean>>
}

/**
 * 历史条目派生（替代 chatStore.getMessages 直读，core history 模块经 deps 注入）。
 * 倒序 + role==='user' + status==='complete' + 去重连续相同文本（原 shim 逻辑平移）。
 * 纯派生函数（无自带缓存）：唯一消费链是 core history 模块内的 Vue computed，
 * 记忆化由 computed 承担（↑/↓ 长按期间 messages 未变 → 直接命中 computed 缓存；
 * messages 变化 → 数组引用必换 → 重算），派生层不再叠第二层缓存。
 * 导出供单测（派生语义基线）。
 */
export function deriveHistoryFromChatStore(chatStore: ReturnType<typeof useChatStore>, sid: string): string[] {
  const msgs = chatStore.getMessages(sid)
  const result: string[] = []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'user' || m.status !== 'complete') continue
    const text = normalizeContent(m.content)
    if (result.length > 0 && result[result.length - 1] === text) continue
    result.push(text)
  }
  return result
}

/**
 * D6 发送路由 + 发送位四态派生工厂（u5b/u6b；useComposerShell 行数治理拆出的纯派生块，
 * 语义与拆出前逐行等价）。deps = 读取面注入：chat store 占用投影 / sessionIdRef /
 * subagent 车道两信号（车道占用覆盖，subagent-composer）/ activeView（本地乐观并集源）。
 */
function createSendPhaseDerived(deps: {
  sessionPhaseOf: (sid: string) => SessionPhase
  sessionIdRef: ComputedRef<string | null>
  isSubagentLane: ComputedRef<boolean>
  laneStreaming: ComputedRef<boolean>
  activeView: ComputedRef<boolean>
}) {
  // ── D6 发送路由（u5b）+ 发送位四态（u6b）：sessionPhase（occupancy 投影）单一派生 ─
  // 数据源 = chat store sessionPhase（session.occupancy 帧驱动 + stateSnapshot 快照恢复）。
  // 发送位四态（D6 表「发送位」列）与 ActivityStrip 从同一真值取数（不双真源）；与 ⏎ 分发器
  // 的关系见下方「故意分立」注——同源 ≠ 同输出。
  //
  // turn 活跃判定取**并集**：occupancy 权威投影 ∨ 本地乐观视图（isActive = streaming 实体
  // ∨ 乐观 pendingSend）。本地 send 的乐观置位先于 runtime occupancy 广播（RPC RTT 窗口），
  // 只看投影会让窗口内 Enter 落 direct 被 canSend 守卫拦死（死键回退）——并集保持现状
  // isActive→steer 语义；settling/compacting/bash 维度无本地乐观源，由权威帧独占。
  // sendRoute（三值浓缩）与发送位（需原始 turn/compacting/bash 维度细分——如 settling 单独
  // vs settling+bash 的 stop/queue 分档）共用同一 effective phase，不双真源。**两者输出故意
  // 分立**（2026-10 用户裁决）：压缩期 sendRoute=queued（⏎ 排队）而发送位=stop（按钮中止
  // 压缩）——按钮与 Enter 回答不同问题，派生处分叉不等于漂移（详见 sendButtonState 注释）。
  const effectivePhase = computed<SessionPhase>(() => {
    const sid = deps.sessionIdRef.value
    if (!sid) return IDLE_SESSION_PHASE // landing（无 session）无 occupancy 记录 → 全 idle
    // subagent 车道：占用只有「轮在飞 = generating」一态（无 bash/compacting/settling
    // 维度；occupancy 帧对虚拟 id 无投影，事实源 = subagent record 流状态）。
    if (deps.isSubagentLane.value) {
      return deps.laneStreaming.value ? { ...IDLE_SESSION_PHASE, turn: 'generating' as const } : IDLE_SESSION_PHASE
    }
    const phase = deps.sessionPhaseOf(sid)
    // 本地乐观 busy 投影化为 dispatching（「已发起未确认」的 occupancy 语义）后过统一派生
    // ——判定逻辑单点在 resolveSendRoute / 发送位派生，消费方复用同源不漂移。
    return deps.activeView.value && phase.turn === 'idle' ? { ...phase, turn: 'dispatching' as const } : phase
  })
  const sendRoute = computed<SendRoute>(() => resolveSendRoute(effectivePhase.value))

  /**
   * [u6b] 发送位四态（D6 表「发送位」列）：send（↑ 直发）/ stop（■ 中止）/ queue（↑ 带时钟
   * 角标排队）。派生自与 sendRoute 同源的 effectivePhase。
   *
   * **按钮形态与 Enter 车道是两个问题**（2026-10 用户裁决，修 a46f6fd7b 的过度收敛）：
   * - 按钮回答「现在能中止什么」——压缩期（任意 turn 组合，含 generating/settling）→ stop，
   *   点击中止**压缩流程**（复用 abort 链路：pi session.abort → abortCompaction）。压缩期
   *   从不渲染 queue 按钮——排队提交走 ⏎（内核 queued 车道 + compaction-end flush，车道
   *   判定见 sendRoute），按钮位是中止入口而非第二提交入口。
   * - Enter 回答「这条消息走哪条车道」——由 resolveSendRoute 独占（compacting → queued）。
   * 两者故意分立：a46f6fd7b 曾把 compacting 归 queue 以「对齐内核 holdReasonOf」修按钮/
   * Enter 漂移，代价是压缩期 composer 失去全部中止能力（阈值自动压缩的 stop 一并消失），
   * 用户裁决恢复「忙 → 终止钮」直觉（与执行中同构）；漂移根源（按钮语义 vs 车道语义混谈）
   * 由本分立消除，而非再次二选一。
   * - turn ∈ {dispatching, generating}（无 compacting）→ stop（turn 活跃，点击 abort）
   * - settling 分档：单独 → stop（收尾期可中止）；settling + bash → queue（turn 不活跃 +
   *   其他维度忙；D6 表未单列 settling+bash，按同构归 queue，登记 impl-plan 偏差表）
   * - bash（turn 不活跃）→ queue
   * - 全 idle → send（行 1）
   */
  const sendButtonState = computed<'send' | 'stop' | 'queue'>(() => {
    const phase = effectivePhase.value
    if (phase.compacting) return 'stop'
    if (phase.turn === 'dispatching' || phase.turn === 'generating') return 'stop'
    if (phase.turn === 'settling') return phase.bash ? 'queue' : 'stop'
    return phase.bash ? 'queue' : 'send'
  })

  /**
   * stop 态的中止目标（按钮 title 分型）。判定序**有意不与 sendButtonState 同形**——
   * 对齐 runtime abort 的 compaction-cancel 门（message-dispatcher.abort：source='user'
   * ∧ isCompacting ∧ ¬isGenerating 才走压缩取消语义；settling → isGenerating=false，
   * 见 event-interpreter 占用→flags 映射），保证「title 说终止压缩 ⇔ runtime 真走压缩取消」：
   * - dispatching/generating → 'turn'：isGenerating=true，abort 是回合中止；即便 compacting
   *   同真（threshold turn 内压缩），title 标「终止压缩」即谎报（2026-10 审查修正）。
   * - 'compacting'：压缩期且 turn 非生成中（idle 手动 /compact、settling+overflow）——
   *   点击中止压缩流程（不写 stopped 终态、不广播 message.complete）。
   * - 'turn'：settling 单独——点击中止当前回合（既有 abort 语义）。
   * 与 sendButtonState 的关系：stop/queue 全集内非空，唯一错位 settling+bash
   * （state='queue' 而 target='turn'）——title 仅 stop 态渲染消费，错位无行为影响。
   */
  const sendButtonStopTarget = computed<'compacting' | 'turn' | null>(() => {
    const phase = effectivePhase.value
    if (phase.turn === 'dispatching' || phase.turn === 'generating') return 'turn'
    if (phase.compacting) return 'compacting'
    if (phase.turn === 'settling') return 'turn'
    return null
  })

  return { effectivePhase, sendRoute, sendButtonState, sendButtonStopTarget }
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
  const btwSessionState = useBtwSessionStateStore()
  const presetStore = usePresetStore()
  const settingsStore = getSettingsStore()
  const flow = useNewTaskFlow()
  const { info: toastInfo, error: toastError } = useToast()
  const { send, followUp, abort, compact, sendBash } = useChat()
  // ── subagent 车道（subagent-composer 2026-10-18）：drawer subagent 详情页复用同一
  //    shell，发送/中止/占用三终端按虚拟 id 形状分流到 subagent-composer-lane（通道 =
  //    session.subagentAction message/cancel 既有链路；包装体在 lane 文件）。主车道
  //    deps 逐成员透传原实现，非 vid 输入零变化。──
  const subagentLane = useSubagentComposerLane(sessionIdRef)
  const isSubagentLane = subagentLane.isLane
  const { activeView, send: laneSend, followUp: laneFollowUp, abort: laneAbort, compact: laneCompact, sendBash: laneSendBash } =
    wireSubagentLaneTerminals(isSubagentLane, subagentLane, { send, followUp, abort, compact, sendBash }, isActive)
  const { handoff: handoffAction, abortHandoff: abortHandoffAction } = useHandoffActions(sessionIdRef)
  const { switchModel, setThinkingLevel } = useModel()
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
    getSessionState: (sid: string) =>
      // btw vid 走线态解析（线回执 → 主会话回退，见 btw-session-state store 头注释）；
      // 非 vid 行为不变（主列表直查）。
      resolveComposerSessionState(
        sid,
        sessionStore.list,
        (vid) => btwSessionState.modelByVid[vid],
        (vid) => btwSessionState.mainSidByVid[vid],
      ),
    defaultModel: computed(() => settingsStore.defaultModel.value),
    currentModel: flow.currentModel,
    // [U4r2] 显式 preset 选择进 chip 侧 resolve 输入（D1 pending 三兄弟补齐）：flow
    // pendingPreset 只读视图（Landing.onPresetSelect 写入）——chip 显示与 submit 透传
    // 同源同输入，显式 preset 捆绑字段不再只在 submit 侧生效（显示 ≠ 生效破口修复）。
    // 仅 landing 态消费（core model-thinking 内部按 sessionId 门控）
    pendingPreset: () => flow.pendingPreset.value,
    setPendingModel: (model: string) => flow.setPendingModel(model),
    switchModel,
    setThinkingLevel,
    getThinkingLevelMap: (modelId: string) => {
      // 旧版检查：无 '/' 的 modelId（如空串/非完整模型 id）直接返回 undefined（all-levels），
      // 不碰 providers。
      if (!modelId.includes('/')) return undefined
      const [providerId, modelName] = modelId.split('/')
      const provider = settingsStore.providers.value.find((p: { id: string }) => p.id === providerId)
      return provider?.models.find((m: { id: string }) => m.id === modelName)?.thinkingLevelMap
    },
    getSupportedLevels: (modelId: string) => {
      // 与 submit 侧 supportedLevelsOf 即同一函数（U6：runtime 注册表 pi 同源计算的
      // view-ready 下发，可用档判定唯一权威，不再本地推算）。曾与本文件各持一份实现，
      // 显示侧漏 enabled 检查 → 禁用 provider 下显示档与生效档发散（F5 统一）。
      return supportedLevelsOf(modelId, settingsStore.providers.value)
    },
    // [U2d] landing 显示链完整解析数据注入（D1 单一解析层）：preset 档可达（preset 档
    // 此前在 core 无镜像，显示恒跳过）+ D4 lastUsedModel 校验获得 providers 能力表。
    // getter 闭包内读响应式 store，createLaunchConfigView 据此建立依赖——preset store
    // 惰性加载完成后 chip 自动重算（P5①）。加载触发不在此（PresetSelectChip onMounted
    // loadPresets 既有通路覆盖 landing 挂载场景）。
    launchData: {
      presets: () => presetStore.presets,
      defaultPresetId: () => presetStore.defaultPresetId || null,
      providers: () => settingsStore.providers.value,
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
  const { handleArrowUp, handleArrowDown, resetBrowsing, isBrowsingFor, getSavedDraft } =
    useComposerHistory(sessionIdRef, {
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

  // [robustness P2/③b] orphan 草稿取回：上次 landing 首发失败且 Composer 已卸载（create 飞行
  // 中切 session 等）时 sendLandingFirstMessage catch 只能把草稿暂存 orphan 槽；下次 landing
  // composer 挂载时取回恢复（text + 全类 chip，image 段含 needsMigrate 标志）。仅 landing
  // （sid null）消费——session composer 草稿走 drafts store（Composer.vue watch(sessionId)）。
  // onMounted 时机 = 子组件 ComposerInput 已挂载、inputRef 就绪（chip 插入需要活实例）。
  onMounted(() => {
    if (sessionIdRef.value) return
    const orphan = takeOrphanedDraft()
    if (orphan && orphan.length > 0) restoreSegments(orphan)
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
    // fork banner 图标（demo 权威 = git-branch，demo ComposerBar.vue:450 / composer-chips spec §4；
    // GitBranch 是本应用分支语义既有图标语言——SessionItem/GitPanel 在用）
    forkChipIcon: GitBranch,
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
    // handoff banner 图标（demo 权威 = arrow-right-left；[HISTORICAL] 前身 Upload 随 mode-chip 形态退役）
    handoffChipIcon: ArrowRightLeft,
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

  // ── D6 发送路由 + 发送位四态（u5b/u6b）：单一派生链抽模块级工厂
  //    createSendPhaseDerived（纯派生无副作用，语义与拆出前逐行等价；行数治理非语义改动）──
  const { sendRoute, sendButtonState, sendButtonStopTarget } = createSendPhaseDerived({
    sessionPhaseOf: (sid) => chatStore.sessionPhase(sid),
    sessionIdRef,
    isSubagentLane,
    laneStreaming: subagentLane.isStreaming,
    activeView,
  })

  // ── bash 命令模式（core dispatch/bash；sendBash 注入）──
  // subagent 车道禁 bash 分流（`!` 是普通消息文本——subagent 无 bash 通道）：sendBash
  // 包装为恒 false（bash.ts 失败信号契约 = 不分流继续普通提交链）。
  const composerBash = useComposerBash({
    draft,
    clearInput,
    isSending,
    sessionId: () => sessionIdRef.value,
    sendBash: laneSendBash,
    restoreInput,
  })
  const isBashMode = computed(() => !isSubagentLane.value && composerBash.isBashMode.value)

  // ── 提交动作（core dispatch/submit）──
  // subagent 车道：followUp = 直发（打断入队由 Continuation D2 统一语义承接）；abort =
  // cancelSubagent（中止对象 = 当前轮，无压缩分型）。
  const { onFollowUp, onAbort } = useComposerSubmit({
    hasInput,
    inputRef,
    sessionIdRef,
    clearInput,
    restoreSegments,
    followUp: laneFollowUp,
    abort: laneAbort,
  })

  /**
   * [u3c / D1 语义收窄] canSend = 「可提交」（hasInput ∧ ¬isSending 双发锁）——**占用不再拦截**：
   * lane 判定收归 runtime 内核（D1），settling/compacting/bash/turn 活跃期发送合法（内核排队/
   * 入槽），禁令只剩空输入与本地双发锁两类（toast 分型见 core dispatch/send 的 routeStaging）。
   * [HISTORICAL] 前身 isBusy = isActive ∨ isSending——isActive 半边是 renderer 侧车道判定的残留
   * （占用即拦截），随 D1「renderer 只提交不判定」退役（u3b 收 core send.ts 的 canSend 语义，
   * 壳层派生同批收窄归 u3c）。
   * 仅约束普通 send；staging 发送不受本检查拦（fork-ask 对源只读，streaming 中合法）。 */
  const canSend = computed(() => hasInput.value && !isSending.value)
  /** 可提交：staging 活跃时只看本地双发锁（isSending）——streaming 中 fork 提交合法，
   *  handoff 的 streaming 拦截在入口（enterHandoffMode）+ 兜底（handleHandoffSend）。
   *  非 staging 态维持 canSend（hasInput ∧ ¬isSending）。 */
  const canSubmit = computed(() => {
    const active = staging.activeStaging.value
    if (active) return (hasInput.value || active.allowsEmptySend) && !isSending.value
    return canSend.value
  })

  // ── 视觉派生（原 useComposerBoxClass + useComposerModeVisual 合并，D1 留壳）──
  /** composer-box class 链：bash（accent 边 + ring）> 流式 steer 呼吸 > has-input 微环；发送中叠半透明。
   *  档位经 2026-10-11 用户裁决降一档（demo 无对应形态、贴合 R3 无缝输入原则收紧）：
   *  steer = accent 边 + 2px accent-ring（原 --shadow-glow 3px/25%）；has-input = 2px
   *  surface-hover/25% 微环（原 40%，不改 border）；bash 特殊模式档保持强提示不动。
   *  rgba(255,255,255,0.04) 硬编码已废弃。
   *  [HISTORICAL] staging 整框染色档（accent 边 + 3px ring + accent-soft 底）已随 staging banner
   *  形态退役（demo 裁决：banner 图标染 accent 是模式在途的唯一染色点，文字/×/box 均中性）——
   *  staging 活跃时 box 回归链上下一档（bash/steer/has-input 判定不变）。 */
  const boxClass = computed<Array<string | false>>(() => [
    isBashMode.value
      ? 'composer-bash-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring)]'
      : activeView.value
        ? 'border-[var(--accent)] shadow-[0_0_0_2px_var(--accent-ring)]'
        : hasInput.value
          ? 'shadow-[0_0_0_2px_color-mix(in_oklch,var(--surface-hover)_25%,transparent)]'
          : '',
    isSending.value && 'opacity-[0.55]',
  ])
  /** placeholder 链：subagent 车道专用文案 > bash > steerHint > inputHint。
   *  [HISTORICAL] staging 换文案档（forkHint/handoffHint）已随 staging banner 退役
   *  （demo placeholder 静态）；core visual.placeholder 派生保留但 renderer 不再消费。 */
  const placeholder = computed(() =>
    isSubagentLane.value
      ? t('panel.composer.subagentInputHint')
      : isBashMode.value
        ? t('panel.composer.bashPlaceholder')
        : activeView.value
          ? t('panel.composer.steerHint')
          : t('panel.composer.inputHint'),
  )
  /** Staging banner 两段文案（fork/handoff 分流，demo 权威形态 = 粗体标题 + 「 · 」+ 描述；
   *  key 为 banner 形态新增，zh/en 双侧见 @taiji/ui locale panel.composer）。 */
  const stagingBannerTitle = computed(() =>
    staging.activeStaging.value?.type === 'fork'
      ? t('panel.composer.forkBannerTitle')
      : t('panel.composer.handoffBannerTitle'),
  )
  const stagingBannerDesc = computed(() =>
    staging.activeStaging.value?.type === 'fork'
      ? t('panel.composer.forkBannerDesc')
      : t('panel.composer.handoffBannerDesc'),
  )

  // ── 发送分流（core dispatch/send；[u3c/D1] 统一分发器：staging > canSend 检查 >
  //    staging.send > landing（含 bash）> bash > /compact > send（统一 submit））──
  const { onSend } = useComposerSend({
    staging: { hasActiveStaging: staging.hasActiveStaging, send: staging.send, activeStaging: staging.activeStaging },
    canSend,
    hasInput,
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
    send: laneSend,
    compact: laneCompact,
    toastError,
    t: t as (key: string, params?: Record<string, unknown>) => string,
  })

  /**
   * [u3c / D7] 队列条目撤销（×）的文本回输入区——delivery.cancel reply 的全文 + segments
   * 快照落回草稿（ADR-0043 Segment[] 模型）。
   *
   * 空输入（无文本且无 chip）→ restoreSegments 整段恢复（text + image/file/skill/session chip，
   * 与发送失败回滚同通路）；已有输入 → 追加不覆盖：走 composerInjectionStore 单值槽位 +
   * '\n\n' 累积语义（与 useSidebarSessionActions 的 forceQuit 回收同款）——用户正在输入的内容
   * 不丢（此前 forceQuit 路径已验证的取舍）。无 segments 快照（纯文本提交 / rebuild / adopt
   * 条目，runtime 不带键）→ 纯文本落草稿。注入通道不携带 segments，追加分支只回文本
   * （已登记 deviations）。
   */
  function restoreToDraft(payload: { text: string; segments?: Segment[] }): void {
    const text = payload.text
    const segments = payload.segments
    const currentText = (inputRef.value?.getText() ?? draft.value).trim()
    const hasChips = (inputRef.value?.getSegments() ?? []).some((s) => s.type !== 'text')
    if (currentText.length === 0 && !hasChips) {
      if (segments && segments.length > 0) restoreSegments(segments)
      else if (text.trim()) restoreInput(text)
      return
    }
    const sid = sessionIdRef.value
    if (!sid || !text.trim()) return
    const pendingText = composerInjectionStore.pendingInjection.value?.text
    composerInjectionStore.requestInjection({
      target: 'current',
      sessionId: sid,
      text: pendingText ? `${pendingText}\n\n${text}` : text,
    })
  }

  // ── Composer 命令动作表（composer-pi-shortcuts U1③组装；分发链「动作表」分支消费）──
  // enabledModels = settingsStore.models 经 enabled 兜底过滤（与 ModelSelectPopover 双保险
  // 同款：runtime aggregateModels 已过滤一遍，同源广播未过滤时兜底；序 = scopedModels 白名单
  // 重排的显示序，即模型循环序）。
  // subagent 车道：模型/档位入口在头部（SubagentTab ModelSelectPopover，subagent.setModel
  // 通道）——composer 键盘循环降级为空集（循环对空表天然 no-op，不再向 vid 会话发 model.switch）。
  const enabledModels = computed(() =>
    isSubagentLane.value ? [] : settingsStore.models.value.filter((m) => m.enabled !== false),
  )
  const shortcutSupportedLevels = computed(() => (isSubagentLane.value ? [] : currentSupportedLevels.value))
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
    currentSupportedLevels: shortcutSupportedLevels,
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
    /**
     * 「切换中」只读真值（U4）：`{ kind, sessionId, target } | null`。
     * 消费侧（Composer.vue）**必须判 sessionId 等值**再显示/禁用（切走 session 后不得残留旧面板态）。
     */
    switching,
    onModelSelect: onModelSelectUi,
    onThinkingSelect: onThinkingSelectUi,
    // history
    handleArrowUp,
    handleArrowDown,
    resetBrowsing,
    isBrowsingFor,
    getSavedDraft,
    // context chips
    attachedItems,
    refreshAttachedItems,
    onRemoveContextChip,
    // dragdrop
    onDragOver,
    onDragLeave,
    onDrop,
    // fork / handoff / staging
    staging,
    // bash
    isBashMode,
    // submit
    onFollowUp,
    onAbort,
    // send
    onSend,
    // [u3c] 队列条目撤销回草稿（useQueueRows 的行撤销 handler 注入本回调）
    restoreToDraft,
    // composer 命令动作表（composer-pi-shortcuts：分发链「动作表」分支消费）
    shortcutActions,
    // D6 发送路由 + 发送位四态（u5b 导出：分发器路由 / P4 发送位与 ActivityStrip 同源消费）。
    // [u3c/D1] sendRoute 保留为**发送位 UI 预测**（不再是投递决策——决策权在内核），
    // Alt+⏎ 的 followUp 保留语义按它分流（composer-keydown）。
    sendRoute,
    sendButtonState,
    // stop 态中止目标（按钮 title 分型：compacting=终止压缩 / turn=停止；null=非 stop 态）
    sendButtonStopTarget,
    // 派生状态
    canSubmit,
    // 视觉
    boxClass,
    placeholder,
    // staging banner 两段文案（Composer.vue 模板消费，fork/handoff 分流见派生处）
    stagingBannerTitle,
    stagingBannerDesc,
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
