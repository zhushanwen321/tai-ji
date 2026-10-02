/**
 * Composer 发送分流（onSend）—— 统一分发器（session-occupancy u5b D6 → 投递所有权内核
 * u3b/D1 收敛）。
 *
 * 职责单一：把 onSend 的发送分流逻辑收口在此处。onSend 是 Composer 的**唯一**发送入口
 * （Enter / Alt+Enter / 发送按钮全部汇入），优先级链：
 * staging > canSend 守卫 > staging.send > landing（含 bash 检测）> bash(!/!!) > /compact >
 * send（统一 submit）。
 *
 * [u3b/D1 收敛] steer 路由与 defer 入队两分支已退役：lane 判定（direct/steer/queued）移交
 * runtime 投递所有权内核，renderer 只提交不判定——终端分支统一为 deps.send（useChat.send：
 * 乐观气泡 + delivery.submit）。占用期（settling/compacting/bash/turn 活跃）发送不再是特殊
 * 路径：普通文本照常提交，内核排队/入槽，气泡经 session.delivery 帧 morph 为队列条目
 * （D7）。据此：
 * - canSend 守卫语义收窄为「可提交」（hasInput ∧ ¬isSending 双发锁——**占用不再拦截**，
 *   壳层 composer-shell 的 canSend 派生随之调整，归 u3c）；路由判定（getSendRoute）与
 *   steer/enqueueCompact deps 摘除。
 * - 旧 defer 分支的 `/`·`!` 命令拒绝退役：占用期命令文本与 idle 态同语义（作为普通消息
 *   提交，pi 侧 skill/bash 处理）；`!`·`!!` 前缀 bash 分流（trySendBash）与 `/compact`
 *   拦截保持原有无条件优先级（bash/slash 守卫不动，设计 §3.1 终态图首行）。
 *
 * 提取到 composable 以满足 Composer.vue <script setup> 行数上限（300 行）。
 *
 * 不含：followUp / abort（见 useComposerSubmit）/ 输入编辑（留 Composer.vue / 其他 composable）。
 *
 * [W3 迁移] 迁自 renderer composables/panel/useComposerSend.ts。
 * [u5b 改造] isCompacting dep 退役（路由判定统一由 getSendRoute 承担）→ [u3b 再退役]
 * getSendRoute/steer/enqueueCompact 三 deps 退役（D1 车道判定收归 runtime）。
 */
import type { ComputedRef, Ref } from 'vue'
import type { Segment } from '@taiji/shared'
import type { BashCommandExtract, StagingAction } from '../types'
import { segmentsToPrompt } from '@taiji/shared'
import { toErrorMessage } from '../../../utils/error-message'
import { stashOrphanedDraft, takeOrphanedDraft } from '../orphan-draft'
import { nextTick } from 'vue'

/**
 * 本模块视角的最小契约：发送前快照只需 getSegments。
 * getSegments 不在域级权威接口 ComposerInputInstance（../types，context 消费面）内，
 * 有意不扩权威接口收编——dispatch 消费面字段留在消费模块局部声明（同 context-chips 立场，
 * 避免强行扩展权威契约边界），壳层 ComposerInput.vue 的 defineExpose 同时满足两者（结构类型）。
 */
interface ComposerInputInstance {
  getSegments: () => Segment[]
  /**
   * 失败恢复后焦点拉回（robustness P1：创建中过渡视图 display:none 丢焦修复）。可选——
   * 低配壳缺省时静默跳过（同 insertSkillChip?.() 可选降级范式）。
   */
  focus?: () => void
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
 * 结构类型精准表达「只消费 submitFirstMessage」（返回三态为字面联合，对齐 new-task-search
 * flow 的 SubmitFirstMessageResult——消费面契约留在消费模块局部声明，不跨域 import）。
 */
interface NewTaskFlowShape {
  /**
   * landing 态首发提交（create session + apply 模型/思考等级 + 载入 panel + 发送）。
   * @param segments 结构化 segments（含 text/image/skill/file/mention 段）
   * @param thinkingLevel 可选思考等级（landing 态 Composer 选定值）
   * @param bashCommand bash 命令参数（仅 extractBashCommand.type === 'command' 时传入）
   * @returns 'handed-over' = 交接完成（视图已切新 session）；'background' = 创建中用户切走，
   *   后台投递（可发现性 info toast 由 flow 后台分支经 ToastPort 发出，F12）；'abandoned' =
   *   用户主动取消（不投递，已建 session 已删）→ 调用方归还草稿。未投递早退（空内容守卫 /
   *   飞行中重复提交）统一报 'abandoned'（草稿归还语义）。
   */
  submitFirstMessage: (
    segments: Segment[],
    thinkingLevel?: string,
    bashCommand?: { command: string; excludeFromContext: boolean },
  ) => Promise<'handed-over' | 'background' | 'abandoned'>
}

export interface ComposerSendDeps {
  // ── staging 路由 ──
  /** staging 聚合层（useComposerStaging 返回），activeStaging 经派生驱动 staging 分流 */
  staging: {
    /** 是否有任意 staging 活跃（A 阶段：发送前 mode 已开） */
    hasActiveStaging: ComputedRef<boolean>
    /** 经 activeStaging 路由发送；true = 已消费（不走普通 send） */
    send: (text: string) => Promise<boolean>
    /** 当前活跃的 staging action（null = 普通态），allowsEmptySend 守卫用 */
    activeStaging: ComputedRef<StagingAction | null>
  }
  // ── 守卫 ──
  /** [u3b 语义收窄] 是否可提交（hasInput ∧ ¬isSending）——统一 submit 下占用期发送合法
   *  （内核排队取代拦截/拒绝，D1/D5），守卫只剩空输入与双发锁两类。
   *  staging 路由同样受本守卫 + isSending 双发锁约束。 */
  canSend: ComputedRef<boolean>
  /** 是否有输入（空输入拦截的反馈分型依据） */
  hasInput: ComputedRef<boolean>
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
   *  拦截在 handleHandoffSend 的 isSessionActive 兜底） */
  isSending: Ref<boolean>
  // ── landing 首发依赖 ──
  /** flow（submitFirstMessage —— landing 态首发提交） */
  flow: NewTaskFlowShape
  /** landing 态选定的思考等级（undefined = 用户未操作，用 runtime 默认） */
  localThinkingLevel: Ref<string | undefined>
  // ── 统一 submit 终端 ──
  /** 统一提交（useChat 提供：乐观气泡 + delivery.submit，lane 由 runtime 内核判定——D1）。
   *  [u3b] 原 steer dep（D6 steer 路由终端）与 enqueueCompact dep（defer 入队）随两分支退役。
   *  [R2-A5 失败信号契约] 返回 false = RPC 失败（useChat 内部已 toast + 回滚乐观气泡），
   *  调用方据此 restoreSegments 恢复草稿（对齐 steer 先例）；true = 已受理。 */
  send: (sessionId: string, segments: Segment[]) => Promise<boolean>
  /** 压缩上下文（useChat 提供）。[R2-A5 失败信号契约] 同 send：false = RPC 失败（内部
   *  双分型反馈：compaction 级进对话流 / transport 级 toast），调用方恢复草稿。 */
  compact: (sessionId: string, customInstructions?: string) => Promise<boolean>
  // ── 反馈 ──
  /** toast 错误（useToast 提供） */
  toastError: (msg: string) => void
  /** i18n 翻译（useI18n 提供） */
  t: (key: string, params?: Record<string, unknown>) => string
}

// ── 分流 helper（按优先级阶段提取，deps 显式传参）──

/**
 * staging 门 + 路由（priority 1-2）。
 * 返回：'blocked' = 守卫拦截（结束发送）；'handled' = staging.send 已消费（结束发送）；
 * 'pass' = 走后续普通链路。
 */
async function routeStaging(deps: ComposerSendDeps): Promise<'blocked' | 'handled' | 'pass'> {
  // staging 活跃时由 StagingAction 自管 allowsEmptySend（handoff 允许空，fork 不允许）；
  // 双发锁只看 isSending（staging 发送自身会置位），不拦 isActive——fork-ask 发给新建
  // session 对源 session 只读，streaming 中合法（handoff 的 streaming 拦截在
  // handleHandoffSend 的 isSessionActive 兜底，非此处）。非 staging 走原 canSend 守卫。
  const activeStaging = deps.staging.activeStaging.value
  const canStagingSend = !!activeStaging && (activeStaging.allowsEmptySend || deps.canSend.value) && !deps.isSending.value
  if (!deps.canSend.value && !canStagingSend) {
    // [GUI 快修④] blocked 不再静默返回：点击/回车被守卫拦下时给用户可见反馈——
    // 有输入 = 双发锁期（isSending），无输入 = 空输入。区分消息避免「点了没反应」。
    deps.toastError(deps.t(deps.hasInput.value ? 'panel.composer.sendBusy' : 'panel.composer.sendEmptyHint'))
    return 'blocked'
  }
  // staging 路由：经 useComposerStaging.send → activeStaging.send → handleSend（内部自取
  // getStagingConfig，本层不透传——审计候选 10 删三层死透传参数）。
  // 守卫 hasActiveStaging：非 staging 态不进入 staging 路由。
  if (deps.staging.hasActiveStaging.value) {
    // [D4-c 迁移] staging 提交载荷从 draft.value 迁 segmentsToPrompt——判定源单一化 +
    // 消除 draft 快照失真窗口（staging 载荷本就是 segments 的序列化，改后判定与载荷同一
    // 表达式）。快照在 staging.send 前（内部消费即可能清 DOM）。
    const segments = deps.inputRef.value?.getSegments() ?? []
    if (await deps.staging.send(segmentsToPrompt(segments))) return 'handled'
  }
  return 'pass'
}

/**
 * landing 首发分支（priority 3）：bash 提取分流（empty=空命令不提交）→ 清输入 →
 * submitFirstMessage，按三态返回收尾（E 拍板）：'abandoned' 归还草稿 + 焦点拉回（无 toast）；
 * 'background' / 'handed-over' 无草稿动作。
 */
async function sendLandingFirstMessage(deps: ComposerSendDeps, segments: Segment[], text: string): Promise<void> {
  // landing bash 分流：提取 !/!! 前缀（empty=空命令不提交；not-bash=走普通首发）
  const bashExtract = deps.composerBash.extractBashCommand(text)
  if (bashExtract.type === 'empty') return
  deps.clearInput()
  deps.isSending.value = true
  try {
    // [幽灵草稿修复] 本次尝试开始即清槽（take 丢弃返回值）：槽内只允许存在「本尝试失败后
    // 写入」的保稿。上一尝试失败 stash 的残留若不清，重发成功后草稿已被消费（视图交接 /
    // 后台投递 / abandoned 归还），槽内旧副本会在下次 landing 挂载时被 take 复活成幽灵草稿
    // → 再点发送产生重复任务。清槽时点必须在 submit 之前而非收到结果之后：background 投递
    // 失败时 flow 侧会在返回 'background' **之前**重新 stashOrphanedDraft 保稿（flow 后台
    // 分支），收到结果后再清会抹掉该次保稿（草稿既已 clearInput、landing 又已卸载 = 永久
    // 丢失）；本尝试自身的失败 stash（下方 catch）与 flow 保稿均发生在本次清槽之后，不受影响。
    takeOrphanedDraft()
    // B6：preset 透传走 flow.pendingPreset，不在此读 store 第二真源
    const bashCommand = bashExtract.type === 'command' ? bashExtract : undefined
    const result = await deps.flow.submitFirstMessage(segments, deps.localThinkingLevel.value, bashCommand)
    if (result === 'abandoned') {
      // [E] 用户主动取消（或未投递早退）：草稿归还 + 焦点拉回（同 catch 的 nextTick 形态），
      // **无 toast**——用户主动放弃，「创建失败」是误导性误报。
      deps.restoreSegments(segments)
      void nextTick(() => deps.inputRef.value?.focus?.())
    }
    // 'handed-over'：现状不变（交接完成即 flow 终态）；'background'：用户已切走、消息已去
    // 新 session——可发现性 info toast 由 flow 后台分支经 ToastPort 发出（F12），此处无草稿
    // 动作（投递失败时 flow 侧已 stashOrphanedDraft 保稿，A 消费侧）。
  } catch (e) {
    // [C] 无条件保底暂存（幂等双写）：堵「catch 后卸载」镜像竞态——restore 写进活实例后
    // Landing 紧接着卸载会消亡且未入槽（原单点二分只堵了「卸载后 catch」半边）。
    // 有活实例照常 restore + focus（槽与实例双写，取回由 landing 单挂载点不变量保证幂等）。
    stashOrphanedDraft(segments)
    if (deps.inputRef.value) {
      deps.restoreSegments(segments)
      // [robustness P1] 创建中过渡视图（display:none）丢焦 → 焦点拉回。必须延到 nextTick：
      // createInFlight 复位虽在本 catch 前（finally），但 v-show 翻回可见是异步渲染 flush，
      // 对 display:none 内元素调 focus() 会静默失败（真机实测 activeElement 停在 BODY）
      void nextTick(() => deps.inputRef.value?.focus?.())
    }
    deps.toastError(deps.t('panel.panel.taskFailed', { error: toErrorMessage(e) }))
  } finally {
    deps.isSending.value = false
  }
}

/**
 * active 态分支（priority 4-6）：bash 分流（!/!! 前缀，必须在 /compact 前）→ /compact →
 * 统一 submit（u3b/D1：direct/steer/queued 全车道收敛）。
 *
 * [R2-A5 失败恢复] send / compact 失败信号（false）→ restoreSegments 恢复完整草稿
 * （slash chip + 文本，W8 通路复活）——useChat 侧已回滚乐观气泡（u3b）并 toast/对话流分型
 * 反馈，调用方只恢复输入不补 toast（防双提示，对齐 submit.ts onSteer 先例）；catch 仅兜
 * 契约外异常（useChat 契约内不 throw），此路径 useChat 未 toast，故补 toast。
 */
async function sendActiveMessage(deps: ComposerSendDeps, segments: Segment[], text: string): Promise<void> {
  // [b08-F2] session 缺失守卫（删除/LRU 驱逐的时序窗口）：本地早退，不发 sessionId:null 的
  // RPC——此前 `sessionIdRef.value!` 非空断言让该失败漂到 runtime 边界才爆，报错指向 runtime
  // 而非「session 不存在」。守卫先于 clearInput：输入原地保留不丢。
  // toast 缺口：composer 域无「session 不存在」i18n 词条（locale 界外不新增 key），以
  // console.warn 留痕 + 输入保留兜底；renderer 侧补 key 后在此接 toastError。
  const sessionId = deps.sessionIdRef.value
  if (!sessionId) {
    console.warn('[useComposerSend] panel 发送早退：当前无活跃 session（输入已保留，可切换 session 后重发）')
    return
  }
  if (await deps.composerBash.trySendBash(text)) return
  // [D4-c 迁移] /compact 拦截输入从 draft.value 迁 segmentsToPrompt——判定源单一化 +
  // 消除 draft 快照失真窗口：`segmentsToPrompt(segments)` 即发送载荷本身，判定与载荷构造
  // 同源，快照滞后面归零。bash 判定（上行）按裁决表不迁（`!` 前缀与 chip 无关）。
  const trimmed = segmentsToPrompt(segments).trim()
  if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
    const customInstructions = trimmed.startsWith('/compact ')
      ? trimmed.slice('/compact '.length).trim() || undefined
      : undefined
    deps.clearInput()
    // [compaction-input-unlock] 不置 isSending：compact RPC 同步等待压缩全程完成（runtime
    // dispatcher.compact await client.compact 全程，可达分钟级），置锁 = 整个压缩期 composer
    // 置灰不可输入。压缩期输入/发送通道已由投递内核承接（compacting hold → queued →
    // compaction-end flush），UI 锁只保留给「受理往返」型提交（send/staging/landing）。
    // 并发互斥交还 runtime：压缩中再提交 /compact 被 compact_busy 预检拒绝（对话流 system
    // 提示呈现 + 本分支 false 信号走下方守卫恢复）。
    // 失败恢复空守卫：本分支不再持 UI 锁，压缩期间用户可能已输入新内容——restoreSegments
    // 是 setText 整体覆盖语义，输入区非空（有文本或有 chip）时禁止恢复（覆盖用户输入 =
    // 数据丢失）；失败呈现已由 useChat 分型路由兜底（分类码 → 对话流 / transport 级 →
    // toast），此处只放弃本次 /compact 草稿回填。
    const restoreIfComposerEmpty = (): void => {
      const composerEmpty =
        !deps.hasInput.value && (deps.inputRef.value?.getSegments().length ?? 0) === 0
      if (composerEmpty) deps.restoreSegments(segments)
    }
    try {
      // 严格比较 false：只认显式失败信号，真值判断会把成功发送误判为失败
      const delivered = await deps.compact(sessionId, customInstructions)
      if (delivered === false) restoreIfComposerEmpty()
    } catch (e) {
      // 契约外异常防御（useChat.compact 契约内不 throw）——同空守卫语义，防覆盖并发输入
      restoreIfComposerEmpty()
      deps.toastError(deps.t('composable.compactFailed', { msg: toErrorMessage(e) }))
    }
    return
  }
  deps.clearInput()
  deps.isSending.value = true
  try {
    // 严格比较 false（同 compact 分支）：只认显式失败信号
    const delivered = await deps.send(sessionId, segments)
    if (delivered === false) deps.restoreSegments(segments)
  } catch (e) {
    // 契约外异常防御（useChat.send 契约内不 throw、不 toast 之外的意外抛出）：W8 回滚 + toast
    deps.restoreSegments(segments)
    deps.toastError(deps.t('panel.panel.sendFailed', { error: toErrorMessage(e) }))
  } finally {
    deps.isSending.value = false
  }
}

/**
 * @param deps staging / canSend / draft / inputRef /
 *   sessionIdRef / variantRef / composerBash / clearInput / restoreSegments /
 *   isSending / flow / localThinkingLevel / send / compact / toastError / t
 *   （Composer.vue 内定义后注入）
 */
export function useComposerSend(deps: ComposerSendDeps): { onSend: () => Promise<void> } {
  /**
   * 发送分流（统一分发器，Enter / Alt+Enter / 发送按钮共用）：
   * staging > canSend 守卫 > staging.send > landing（含 bash 检测）> bash(!/!!) >
   * /compact > send（统一 submit）。
   * 失败恢复（W8）：landing 首发 catch → restoreSegments；active 态 send/compact 消费
   * useChat 失败信号（false）→ restoreSegments（契约失败路径已由 useChat toast/分型，
   * 不双提示）；catch 仅兜契约外异常（补 toast）。bash 分支失败信号见 bash.ts（输入恢复
   * 待 renderer 注入 restoreInput，登记缺口）。
   *
   * 各优先级分支提取为模块级 helper（routeStaging / sendLandingFirstMessage /
   * sendActiveMessage），此处只留编排；text 在门检查前捕获（computed 读纯函数，时序等价）。
   * [u3b/D1] 原 steer 路由（routeSteer）与 defer 路由（enqueueDuringDefer）分支退役——
   * 车道判定收归 runtime 内核，终端统一 deps.send。
   */
  async function onSend(): Promise<void> {
    const text = deps.draft.value
    // staging 门 + canSend 守卫 + staging 路由：'blocked'/'handled' 均结束本次发送
    if ((await routeStaging(deps)) !== 'pass') return
    const segments = deps.inputRef.value?.getSegments() ?? [] // 先快照（clearInput 会清空 DOM）
    if (deps.variantRef.value === 'landing') {
      await sendLandingFirstMessage(deps, segments, text)
      return
    }
    await sendActiveMessage(deps, segments, text)
  }

  return { onSend }
}
