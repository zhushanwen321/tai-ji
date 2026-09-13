/**
 * Composer 发送分流（onSend）—— D6 统一发送分发器（session-occupancy-send-closure u5b）。
 *
 * 职责单一：把 onSend 的发送分流逻辑收口在此处。onSend 是 Composer 的**唯一**发送入口
 * （Enter / Alt+Enter / 发送按钮全部汇入），优先级链：
 * staging > [D6 steer 路由] > canSend 守卫 > staging.send > [D6 defer 路由] >
 * landing（含 bash 检测）> bash(!/!!) > /compact > send。
 *
 * [u5b / D6] 路由判定（resolveSendRoute，sessionPhase → sendRoute）先于 canSend 守卫：
 * steer 路由（turn 活跃）恰在 canSend 的 isBusy 集内，守卫在前会把它拦死。steer 分支的
 * 终端是 deps.steer（useChat.steer：isActive 时并入 steering 队列；投影滞后窗口 isActive=false
 * 时内部静默 return——该窗口调用方回退走 direct 直发路径，本函数在 onSteer 式编排前以
 * sessionPhase 判定路由，迟到投影由 useChat.send 的 B 策略兜底，双通道自愈不丢输入）。
 * defer 分支（settling / compacting / bash）泛化原 isCompacting 分支：`/`、`!` 前缀命令
 * 拒绝 toast 保留（命令无法延迟重放），普通文本入 defer 队列（occupancy 全 idle 时
 * useChat occupancy handler 触发 flush 投递）。
 *
 * 提取到 composable 以满足 Composer.vue <script setup> 行数上限（300 行）。
 *
 * 不含：followUp / abort（见 useComposerSubmit）/ 输入编辑（留 Composer.vue / 其他 composable）。
 *
 * [W3 迁移] 迁自 renderer composables/panel/useComposerSend.ts。改动：
 * - 去掉 renderer 跨域依赖 `import { useCompactQueue } from './useCompactQueue'`，以及
 *   onSend 内联的 `useCompactQueue().enqueue(...)` 直调。改为经 ComposerSendDeps.enqueueCompact
 *   回调注入（壳层从 useCompactQueue 派生后传入），core 零 composable 依赖。
 * - import 路径：`./staging-types` → `../types`（StagingAction / StagingConfig）；
 *   `./useComposerBash` → `./bash`（BashCommandExtract，本域 dispatch 同目录）。
 * [u5b 改造] isCompacting dep 退役（路由判定统一由 getSendRoute 承担）；新增 getSendRoute
 * 与 steer dep（composer-shell 组装）。
 */
import type { ComputedRef, Ref } from 'vue'
import type { Segment } from '@xyz-agent/shared'
import type { BashCommandExtract, StagingAction, StagingConfig } from '../types'
import type { SendRoute } from './send-route'
import { segmentsToPrompt } from '@xyz-agent/shared'
import { toErrorMessage } from '../../../utils/error-message'

/**
 * 本模块视角的最小契约：发送前快照只需 getSegments。
 * getSegments 不在域级权威接口 ComposerInputInstance（../types，context 消费面）内，
 * 有意不扩权威接口收编——dispatch 消费面字段留在消费模块局部声明（同 context-chips 立场，
 * 避免强行扩展权威契约边界），壳层 ComposerInput.vue 的 defineExpose 同时满足两者（结构类型）。
 */
interface ComposerInputInstance {
  getSegments: () => Segment[]
}

/**
 * composerBash 最小契约（extractBashCommand / trySendBash）。
 * 用结构类型而非 ReturnType<typeof useComposerBash>——后者会引入 isBashMode 等本 composable
 * 不需要的成员，结构类型更精准表达「只消费这两个方法」。
 */
interface ComposerBashShape {
  /** [W5] 从文本提取 bashCommand（discriminated union），landing 态首发分流用 */
  extractBashCommand: (text: string) => BashCommandExtract
  /** 尝试 bash 分流（active 态 !/!! 前缀）。返回 true 表示已处理（调用方 return） */
  trySendBash: (rawText: string) => Promise<boolean>
}

/**
 * flow 最小契约（submitFirstMessage）。landing 态首发提交用。
 * 结构类型精准表达「只消费 submitFirstMessage」。
 */
interface NewTaskFlowShape {
  /**
   * landing 态首发提交（create session + apply 模型/思考等级 + 载入 panel + 发送）。
   * @param segments 结构化 segments（含 text/image/skill/file/mention 段）
   * @param thinkingLevel 可选思考等级（landing 态 Composer 选定值）
   * @param bashCommand bash 命令参数（仅 extractBashCommand.type === 'command' 时传入）
   */
  submitFirstMessage: (
    segments: Segment[],
    thinkingLevel?: string,
    bashCommand?: { command: string; excludeFromContext: boolean },
  ) => Promise<void>
}

export interface ComposerSendDeps {
  // ── staging 路由 ──
  /** staging 聚合层（useComposerStaging 返回），activeStaging 经派生驱动 staging 分流 */
  staging: {
    /** 是否有任意 staging 活跃（A 阶段：发送前 mode 已开） */
    hasActiveStaging: ComputedRef<boolean>
    /** 经 activeStaging 路由发送；true = 已消费（不走普通 send） */
    send: (text: string, stagingConfig: StagingConfig) => Promise<boolean>
    /** 当前活跃的 staging action（null = 普通态），allowsEmptySend 守卫用 */
    activeStaging: ComputedRef<StagingAction | null>
  }
  /** 取 staging 模型/thinking 暂存配置（ADR-0056，仅 staging 活跃时调） */
  getStagingConfig: () => StagingConfig
  // ── 守卫 ──
  /** 是否可发送（hasInput && !isBusy）—— 非 staging 态 direct 路由的发送守卫（isBusy 语义由调用方烘进 canSend）。
   *  [u5b] steer 路由不受本守卫拦（判定在其之前）；defer 路由仍受拦（isSending 期防双发）。 */
  canSend: ComputedRef<boolean>
  /** 是否有输入（D6 steer 路由分支的前置守卫——steer 判定在 canSend 之前，空输入单独拦） */
  hasInput: ComputedRef<boolean>
  // ── D6 发送路由（u5b）──
  /** 当前 session 的发送路由（D6 表：direct/steer/defer）。composer-shell 从 chat store
   *  sessionPhase 派生后注入；landing（无 session）恒 direct。 */
  getSendRoute: () => SendRoute
  // ── 输入 ──
  /** draft ref（纯文本，用于发送判断 + 文本提取） */
  draft: Ref<string>
  /** inputRef（ComposerInput 实例 ref，getSegments 快照用） */
  inputRef: Ref<ComposerInputInstance | null>
  // ── session / variant ──
  /** sessionId ref（send / compact 调用参数） */
  sessionIdRef: ComputedRef<string | null>
  /** variant ref（'panel' | 'landing'，landing 分流依据） */
  variantRef: ComputedRef<'panel' | 'landing'>
  // ── bash ──
  /** composerBash（extractBashCommand / trySendBash）—— landing + active 两态 bash 分流 */
  composerBash: ComposerBashShape
  // ── 输入恢复 ──
  /** 清空输入（useComposerRestore 提供） */
  clearInput: () => void
  /** 失败恢复 text + 各类 chip（useComposerRestore 提供） */
  restoreSegments: (segments: Segment[]) => void
  // ── 状态 ──
  /** 发送中状态（普通 send / landing 首发 / staging 发送期间置 true）——兼作 staging 双发锁
   *  （不拦 isActive：fork-ask 对源 session 只读，streaming 中合法；handoff 的 streaming
   *  拦截在 handleHandoffSend 的 isSessionActive 兑底） */
  isSending: Ref<boolean>
  // ── landing 首发依赖 ──
  /** flow（submitFirstMessage —— landing 态首发提交） */
  flow: NewTaskFlowShape
  /** landing 态选定的思考等级（undefined = 用户未操作，用 runtime 默认） */
  localThinkingLevel: Ref<string | undefined>
  // ── 普通 send / compact / steer ──
  /** 普通发送（useChat 提供；isActive 时内部 B 策略转 steer——steer 路由投影滞后的自愈兜底） */
  send: (sessionId: string, segments: Segment[]) => Promise<void>
  /** 压缩上下文（useChat 提供） */
  compact: (sessionId: string, customInstructions?: string) => Promise<void>
  /** 追加 steer（useChat 提供；isActive 时并入 steering 队列）。D6 steer 路由终端。
   *  [D2] 返回 false = RPC 失败（内部已 toast）——routeSteer 据此 restoreSegments 恢复草稿。 */
  steer: (sessionId: string, segments: Segment[]) => Promise<boolean>
  /** compact 期间入队待重放消息（useCompactQueue.enqueue 注入，替代直调 useCompactQueue）。
   *  [defer segments 化 / D-A1-1] text = 展示文本（draft），segments = 入队快照的完整
   *  段（image/skill/file chip 等）——占用期发富内容不再丢段。 */
  enqueueCompact: (sessionId: string, text: string, segments: Segment[]) => void
  // ── 反馈 ──
  /** toast 错误（useToast 提供） */
  toastError: (msg: string) => void
  /** i18n 翻译（useI18n 提供） */
  t: (key: string, params?: Record<string, unknown>) => string
}

// ── 分流 helper（按优先级阶段提取，deps 显式传参，分支体与原内联实现逐字节一致）──

/**
 * staging 门 + 路由（priority 1-2）。
 * 返回：'blocked' = 守卫拦截（结束发送）；'handled' = staging.send 已消费（结束发送）；
 * 'pass' = 走后续普通链路。
 */
async function routeStaging(deps: ComposerSendDeps): Promise<'blocked' | 'handled' | 'pass'> {
  // staging 活跃时由 StagingAction 自管 allowsEmptySend（handoff 允许空，fork 不允许）；
  // 双发锁只看 isSending（staging 发送自身会置位），不拦 isActive——fork-ask 发给新建
  // session 对源 session 只读，streaming 中合法（handoff 的 streaming 拦截在
  // handleHandoffSend 的 isSessionActive 兑底，非此处）。非 staging 走原 canSend 守卫。
  const activeStaging = deps.staging.activeStaging.value
  const canStagingSend = !!activeStaging && (activeStaging.allowsEmptySend || deps.canSend.value) && !deps.isSending.value
  if (!deps.canSend.value && !canStagingSend) {
    // [GUI 快修④] blocked 不再静默返回：点击/回车被守卫拦下时给用户可见反馈——
    // 有输入 = 占用中（双发/流式期），无输入 = 空输入。区分消息避免「点了没反应」。
    deps.toastError(deps.t(deps.hasInput.value ? 'panel.composer.sendBusy' : 'panel.composer.sendEmptyHint'))
    return 'blocked'
  }
  // staging 路由：经 useComposerStaging.send → activeStaging.send。仅在有活跃 staging 时取 staging config
  // 透传（fork/handoff 内部 handleXxxSend 也自取 deps.getStagingConfig，传参与自取等价故实际被忽略）。
  // 守卫 hasActiveStaging：非 staging 态不调 getStagingConfig（避免测试 mock 未提供该方法时炸 + 语义清晰）。
  if (deps.staging.hasActiveStaging.value) {
    // [D4-c 迁移] staging 提交载荷从 draft.value 迁 segmentsToPrompt——判定源单一化 +
    // 消除 draft 快照失真窗口（staging 载荷本就是 segments 的序列化，改后判定与载荷同一
    // 表达式）。轮 3 修正理由：draft 与 prompt 同源同归位，「命令 chip 就地化后 DOM 序文本
    // `/cmd` 不在行首 ⇒ staged prompt 静默变字面文本」的原由不成立。快照在 staging.send
    // 前（内部消费即可能清 DOM）。
    const segments = deps.inputRef.value?.getSegments() ?? []
    if (await deps.staging.send(segmentsToPrompt(segments), deps.getStagingConfig())) return 'handled'
  }
  return 'pass'
}

/**
 * [D6] steer 路由（priority 2，行 2/3）：追加当前回合，不打断。
 * 判定条件 = route==='steer' ∧ 非 staging ∧ 本地 busy（canSend=false）——真实时序下 turn 活跃必然
 * 伴随本地视图 busy（streaming 实体 / 乐观 pendingSend），steer 内部 isActive 守卫必过；
 * 仅毫秒级投影失配窗口（retry/followUp 续跑的 turn-start 先于 message_start 到达，本地
 * 已收口而投影已 flip generating）会出现 route==='steer' ∧ 本地 idle——此时不进本分支，
 * 落入下方 direct 流程：useChat.send 的 B 策略内部再裁决（busy→steer）/ idle 直发被拒时
 * send.rejected 兜底静默入队自愈——不丢输入不丢消息。isSending 期拦（防双发锁失效）。
 * 命令分流（bash/ /compact）不适用——turn 活跃时命令文本按 steer 消息投递（现状 Enter
 * isActive→onSteer 同语义，pi 侧 skill 展开处理）。
 * 返回 true = 已消费（结束发送）。判定先于 canSend 守卫——steer 恰在 canSend 的 isBusy 集内，
 * 守卫在前会把它拦死。
 */
async function routeSteer(deps: ComposerSendDeps, route: SendRoute): Promise<boolean> {
  if (deps.staging.activeStaging.value || route !== 'steer' || deps.canSend.value) return false
  if (!deps.hasInput.value || deps.isSending.value) {
    // [GUI 快修④] steer 行的空输入/双发拦截不再静默吞掉（占用期点击发送无任何反馈）
    deps.toastError(deps.t(deps.hasInput.value ? 'panel.composer.sendBusy' : 'panel.composer.sendEmptyHint'))
    return true
  }
  const sid = deps.sessionIdRef.value
  if (!sid) return true
  // clearInput 会清空 DOM，必须先快照 segments（onSend/submit 同范式）
  const segments = deps.inputRef.value?.getSegments() ?? []
  deps.clearInput()
  // [D2] steer 内部 catch 不抛（toast + return false）——失败时输入已被 clearInput 清空，
  // 据 false 恢复完整草稿（text + chips），否则用户输入静默丢失。
  if (!(await deps.steer(sid, segments))) deps.restoreSegments(segments)
  return true
}

/**
 * defer 分支（priority 4，行 4/5/6）：占用期（settling / compacting / bash）发送动作改为
 * 入队待重放（flush 在 occupancy 全 idle 时由 useChat occupancy handler 统一触发——触发源
 * 不再绑定 session.compacted）。`/` 前缀是命令——占用结束后才能执行，此处拒绝 + toast，
 * draft 保留不清空。[defer segments 化 / MF-A 根修] 入队语义从「重放纯文本（draft）」
 * 改为「重放完整消息（segments）」：defer 面扩大到小时级 bash 后「占用中发富内容」成为
 * 常态可达路径，原「重放时无 chip 上下文」的近似失效——text 仍是 draft（气泡/快照展示），
 * segments 是提交载荷（flush 经 submitQueuedEntry 序列化 + 注入展开，与直发同款）。
 */
function enqueueDuringDefer(deps: ComposerSendDeps, text: string): void {
  // sessionIdRef 非空性与 defer 路由同源（无 session 的 landing 无 occupancy 记录恒 direct，
  // 不会进本分支；守卫是防御层）。把不变量局部化，消除 enqueue 处的 `!` 断言。
  if (!deps.sessionIdRef.value) return
  // 先快照 segments 再 enqueue/clearInput：clearInput 会清空 DOM（chips 随之消失），
  // 顺序颠倒会入队纯文本条目（丢段）。与 routeSteer/onSend 的快照范式一致。
  const segments = deps.inputRef.value?.getSegments() ?? []
  // `/` 与 `!`/`!!` 前缀都是命令（slash 命令 / bash 命令）——占用结束后才能执行，
  // 此处拒绝 + toast，draft 保留不清空。`!` 对称于 `/`：避免 bash 命令被静默降级
  // 为纯文本入队（重放走普通 send 不会按 bash 执行，用户语义被悄悄改变）。
  // [D4-c 迁移] 双源拆开判定：`/` 半边读 segmentsToPrompt——判定源单一化 + 消除 draft
  // 快照失真窗口（draft 是 getText() 的调用快照，回滚/程序化 setText/时序窗口下可滞后于
  // DOM）。轮 3 修正理由：`getTextFromEl` 在基线与 HEAD 相同（恒为 segmentsToText(段)），
  // draft 与 prompt 同源同归位，「DOM 序文本不以 / 开头 ⇒ 漏拒」的原由不成立；
  // `!` 半边保持 draft.value——`!` 不产 chip，手打必在 DOM 文本行首，两源恒一致。
  if (segmentsToPrompt(segments).trim().startsWith('/') || text.trim().startsWith('!')) {
    deps.toastError(deps.t('panel.composer.commandQueuedRejected'))
    return
  }
  deps.enqueueCompact(deps.sessionIdRef.value, text, segments)
  deps.clearInput()
}

/**
 * landing 首发分支（priority 4）：bash 提取分流（empty=空命令不提交）→ 清输入 →
 * submitFirstMessage，失败 restoreSegments 回滚。
 */
async function sendLandingFirstMessage(deps: ComposerSendDeps, segments: Segment[], text: string): Promise<void> {
  // landing bash 分流：提取 !/!! 前缀（empty=空命令不提交；not-bash=走普通首发）
  const bashExtract = deps.composerBash.extractBashCommand(text)
  if (bashExtract.type === 'empty') return
  deps.clearInput()
  deps.isSending.value = true
  try {
    // B6：preset 透传走 flow.pendingPreset，不在此读 store 第二真源
    const bashCommand = bashExtract.type === 'command' ? bashExtract : undefined
    await deps.flow.submitFirstMessage(segments, deps.localThinkingLevel.value, bashCommand)
  } catch (e) {
    deps.restoreSegments(segments)
    deps.toastError(deps.t('panel.panel.taskFailed', { error: toErrorMessage(e) }))
  } finally {
    deps.isSending.value = false
  }
}

/**
 * active 态分支（priority 5-7）：bash 分流（!/!! 前缀，必须在 /compact 前）→ /compact →
 * 普通发送，失败 restoreSegments 回滚。
 */
async function sendActiveMessage(deps: ComposerSendDeps, segments: Segment[], text: string): Promise<void> {
  if (await deps.composerBash.trySendBash(text)) return
  // [D4-c 迁移] /compact 拦截输入从 draft.value 迁 segmentsToPrompt——判定源单一化 +
  // 消除 draft 快照失真窗口：`segmentsToPrompt(segments)` 即发送载荷本身，判定与载荷构造
  // 同源，快照滞后面归零。轮 3 修正理由：draft 与 prompt 同源同归位，「命令 chip 在中部时
  // DOM 序文本不以 /compact 起头 ⇒ 漏拦截」的原由不成立。bash 判定（上行）按裁决表不迁
  // （`!` 前缀与 chip 无关）。
  const trimmed = segmentsToPrompt(segments).trim()
  if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
    const customInstructions = trimmed.startsWith('/compact ')
      ? trimmed.slice('/compact '.length).trim() || undefined
      : undefined
    deps.clearInput()
    await deps.compact(deps.sessionIdRef.value!, customInstructions)
    return
  }
  deps.clearInput()
  deps.isSending.value = true
  try {
    await deps.send(deps.sessionIdRef.value!, segments)
  } catch (e) {
    deps.restoreSegments(segments)
    deps.toastError(deps.t('panel.panel.sendFailed', { error: toErrorMessage(e) }))
  } finally {
    deps.isSending.value = false
  }
}

/**
 * @param deps staging / getStagingConfig / canSend / getSendRoute / draft / inputRef /
 *   sessionIdRef / variantRef / composerBash / clearInput / restoreSegments /
 *   isSending / flow / localThinkingLevel / send / compact / steer / enqueueCompact / toastError / t
 *   （Composer.vue 内定义后注入）
 */
export function useComposerSend(deps: ComposerSendDeps): { onSend: () => Promise<void> } {
  /**
   * 发送分流（D6 统一分发器，Enter / Alt+Enter / 发送按钮共用）：
   * staging > [steer 路由] > canSend 守卫 > staging.send > [defer 路由] > landing（含 bash
   * 检测）> bash(!/!!) > /compact > send。
   * 失败均 restoreSegments 回滚草稿（W8）。
   *
   * 各优先级分支提取为模块级 helper（routeSteer / routeStaging / enqueueDuringDefer /
   * sendLandingFirstMessage / sendActiveMessage），此处只留编排；text 在门检查前捕获
   * （computed 读纯函数，时序等价）。
   */
  async function onSend(): Promise<void> {
    // [D6] 路由判定先于一切分流（staging 除外——staging 是模式提交，与 occupancy 路由正交，
    // 用户决策 streaming 中 fork 提交合法）。
    const route = deps.getSendRoute()
    // [D6] steer 路由（turn 活跃）：追加当前回合——判定先于 canSend 守卫（守卫会拦死 steer）。
    if (await routeSteer(deps, route)) return
    const text = deps.draft.value
    // staging 门 + canSend 守卫 + staging 路由：'blocked'/'handled' 均结束本次发送
    if ((await routeStaging(deps)) !== 'pass') return
    // [D6] defer 路由（settling / compacting / bash，行 4/5/6）：占用期发送动作改为入队待重放
    // （flush 在 occupancy 全 idle 时由 useChat occupancy handler 统一触发——触发源不再绑定
    // session.compacted）。
    if (route === 'defer') {
      enqueueDuringDefer(deps, text)
      return
    }
    const segments = deps.inputRef.value?.getSegments() ?? [] // 先快照（clearInput 会清空 DOM）
    if (deps.variantRef.value === 'landing') {
      await sendLandingFirstMessage(deps, segments, text)
      return
    }
    await sendActiveMessage(deps, segments, text)
  }

  return { onSend }
}
