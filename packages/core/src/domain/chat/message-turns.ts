/**
 * MessageStream 回合分组纯逻辑（chat 域 SSOT，w6 从 renderer/composables/logic/messageTurns.ts 迁入）。
 *
 * 数据模型：chat store 的 messages 是扁平 Message[]（user/assistant/system 交替）。
 * 渲染模型（draft-message-stream §4）：一个「turn」= user 气泡 + 其后所有 assistant 块。
 * assistant 的 thinking/toolCalls 折进 trace，content 作收尾 summary。
 *
 * 分组规则 v2 —— 显式边界规则集（conversation-turn-attribution §3.3 D3/D4，W3）。
 * 旧版是 role 扫描（user 开 turn / assistant 归当前 / system 一律打断），根因有二（§2.4）：
 * ① 把「什么开 turn」的产品语义寄托在 role 这个传输属性上——system 族既有 turn 边界语义
 *   （压缩记录）又有 turn 内语义（bash 执行记录 / 健康警告），role 无法区分（机制 C：
 *   mid-turn system 把一个 turn 切成两半，产生无 user 孤立组）；
 * ② display 前置过滤让隐藏完成通知完全退出分组输入——subagent/workflow 完成通知
 *   （display:false）触发的续跑 assistant 并入上一 turn（机制 A：后台任务结果混进上一个提问）。
 * v2 规则表（分组消费全量数组；display 过滤挪到渲染项输出层——D3）：
 * 1. user → 开新 turn（锚）。steer 插话不特判 inline 归组：pi session 文件对 steer 投递的
 *    user entry 无任何可重放区分标记（与普通 prompt 同路径 appendMessage），live 侧若按
 *    taiji 已知 mode 归入当前 turn，replay 侧永远推不出同样归属——开新 turn 是两侧可一致
 *    推导的最大公约数（设计 D1）
 * 2. 隐藏完成通知（display===false 且 customType ∈ COMPLETE_NOTIFY_CUSTOM_TYPES，shared SSOT
 *    常量——与 apply-entry 覆写同一常量源，无第二份判定）→ turn 边界：关闭当前 turn，开启
 *    user:null + trigger:'bg-notify' 的新 turn，后续 assistant 归入（G3 续跑可见起点）。
 *    通知本体压入该组 hiddenNotifies 并同步派生 notifySummary（D5 边界行聚合投影，连续
 *    折叠复用组时累积追加）。空 turn 折叠：边界未被 assistant 填实即遇下一边界/user/数组
 *    结束 → 不产出（连续边界折叠为一个 trigger turn，取最新）
 * 3. assistant → 归当前 turn（无则自启 user:null turn，首条 assistant 边缘保留）
 * 4. inline notice（bashExecution 存在 或 liveOnly===true）→ 归当前 turn 的 notices 列表
 *    （按到达序追加末尾，不切断 turn、不出独立渲染项）；无当前 turn 时退化为独立 static 项
 * 5. background-bash 结构化完成通知（display 非 false 且 details 可解析，解析器即判定 SSOT）→
 *    边界 + 收纳附着（specs/chat/system-notices.md §3）：关闭当前 turn 后挂入 pending 待附
 *    缓冲——后续 assistant 开新 turn（或规则 2 开 trigger turn）时按到达序注入该组
 *    foldedNotices（settle 后收进轮头行，渲染层按轮工作态切换外部行/折叠标签两种形态）；
 *    下一条是 user / 其余可见 system / 数组结束（agent 空闲无宿主轮）→ 以独立 static 项
 *    外部行落位（边界 1：无 settle 时机不收纳，消息不丢）
 * 6. 其余可见 system（compactionSummary/branchSummary/可见 custom/通用 system）→ 边界：
 *    独立 systemNotice 项 + 关闭当前 turn（现状语义）
 * 隐藏非完成通知消息（如 todo-context，display:false）透明：不参与边界、不产出渲染项
 * （现状 = 分组前被过滤；消息仍在 store——渲染过滤不丢消息，AGENTS.md 规则 9）。
 *
 * - streaming 中的 turn（最后一条 assistant status==='streaming'）→ working 态，默认展开 trace
 *
 * 归属：chat 域纯函数（零 Vue/renderer 依赖），对齐 w1-w5 chat 域绞杀模式（core SSOT）。
 * ui 包经 @taiji/core/domain/chat 子路径 import（仅类型/纯函数，非 store/composable 运行时）。
 */
import {
  COMPLETE_NOTIFY_CUSTOM_TYPES,
  parseBackgroundBashDetails,
} from '@taiji/shared'
import type { Message } from '@taiji/shared'
import { deriveNotifySummary } from './notify-summary'
import type { NotifySummary } from './notify-summary'

// D5 边界聚合投影的公开类型（消费方：Turn.vue / 测试）；派生实现与判据在 ./notify-summary
export type { NotifyOutcome, NotifySummary } from './notify-summary'
// 收纳完成通知明细行（specs/chat/system-notices.md §3.4）：类型与派生单点同在 ./notify-summary
export { deriveFoldedNoticeRows } from './notify-summary'
export type { FoldedNoticeRow, FoldedNoticeType } from './notify-summary'

/** 一个渲染回合：起点 user + 其后的 assistant 消息序列 */
export interface MessageTurn {
  index: number
  /** 起始 user 消息（边缘情况：首条是 assistant 时为 null） */
  user: Message | null
  /** 回合内的 assistant 消息（一条或多条） */
  assistants: Message[]
  /** turn 内 notice 列表（D4）：bash 执行记录 / liveOnly 健康警告，按到达序挂在 turn 内部
   *  末尾（bash entry 在文件序即级联末，位置忠实），不切断回合、不出独立渲染项。
   *  W4 渲染消费；undefined = 无 notice（历史 turn 形态不变）。 */
  notices?: Message[]
  /** 无 user 起点的续跑 turn 标记（D3）：'bg-notify' = 隐藏完成通知（subagent/workflow 后台
   *  任务完成）触发的续跑 turn。W4 据此渲染「后台任务完成」起点行（替代 user 气泡）。
   *  undefined = user 锚 turn 或 assistant 自启 turn（现状形态）。 */
  trigger?: 'bg-notify'
  /** bg-notify 边界行聚合投影（D5）：仅 trigger:'bg-notify' 的 turn 有值（分组层规则 2
   *  从 hiddenNotifies 派生，两个构造点同款携带——避免只在快车道构造点派生、全量路缺字段）。
   *  纯派生值（可随时从 hiddenNotifies 重建），渲染层零解析零回扫。
   *  undefined = 非边界 turn 或无可聚合载荷。 */
  notifySummary?: NotifySummary
  /** 被收纳完成通知本体（specs/chat/system-notices.md §3，bg-notice-fold-into-meta）：三通道
   *  完成通知（background-bash 结构化行 / subagent / workflow / managed 隐藏本体）按到达序
   *  原地搬家附着到宿主响应轮（规则 2 与规则 5 收纳分支），settle 后收进轮头行——渲染层
   *  经 deriveFoldedNoticeRows 派生明细行，本体自身不渲染。undefined = 本轮无收纳通知。
   *  纯派生值（成员引用即输入），增量签名随动。 */
  foldedNotices?: Message[]
  /** 文本是否正在流式生成（turn 级信号，最后一条 assistant 处于 streaming 或 subagent 强制态）。
   *  语义仅「文本正在流式生成」——驱动 Loader 转圈、streaming 光标、计时器、滚动跟随。
   *  ask-user 等待期间 message 已 complete → false，但对话仍在进行中（该信号由 session 级
   *  isSessionActive 表达）。CW wave session-active-ssot T4。 */
  isStreaming: boolean
  /** 是否含可折叠块（thinking/toolCall → 有折叠条；纯文字无） */
  hasFoldable: boolean
}

/**
 * 渲染项：kind 全集（renderer-model 归一 M1，conversation-renderer-model-unification §3.3.1）。
 * kind 是 toRenderItems 每渲染从同一堆可选字段现算的派生值，不落 store——单一判定函数。
 *
 * - turn：user+assistant 回合
 * - systemNotice：compaction/branchSummary/stream_warn 等一行通知（system 无 bashExecution）
 * - bashExecution：BashOutputBlock（system + bashExecution 字段）
 *
 * 判定顺序与旧 MessageStream system 分支一致：bashExecution 优先于 systemNotice 兜底
 * （仅无当前 turn 的退化路径会为 bash/liveOnly 产出 static 项——规则 4 inline 归 turn 内）。
 * bgNotify/gui 两类不属全集：隐藏完成通知在分组层被消化为 trigger turn 边界语义（W3·D3），
 * 输出侧 display 过滤兜底；gui 的 producer（workflow-result）同属完成通知一并消化，
 * tool RPC 的 __gui__ 走 Block.vue。
 */
export type RenderItem =
  | { kind: 'turn'; turn: MessageTurn }
  | { kind: 'systemNotice'; message: Message }
  | { kind: 'bashExecution'; message: Message }

/**
 * turn 的稳定标识：首条消息 id（user 优先，assistant 自启 turn 用首条 assistant id；
 * trigger turn 仅含 notice 无 assistant 时回落 notices[0]——折叠规则保证产出 turn 必有
 * user / assistants[0] / notices[0] 之一）。
 * 消息 id 由 runtime 在消息创建时生成（uuid，message-converter / event-adapter），
 * 同一消息两次生成同 id、其他消息插入/删除不影响——key 不随渲染重建/列表增删漂移。
 *
 * [M5 stable-key] 旧实现用 MessageTurn.index（toRenderItems 每次从 0 重算的序号），
 * 消息插入/删除（load-more、streaming 追加）会让全部后续 turn 的 key 平移，
 * virtua 按 key 复用 DOM 时错位（组件状态串台）。改首条消息 id 后 key 恒稳定。
 * 空串兜底理论不可达（产出 turn 必有 user / assistants / notices 之一），仅类型收窄用。
 */
export function turnStableId(turn: MessageTurn): string {
  return turn.user?.id ?? turn.assistants[0]?.id ?? turn.notices?.[0]?.id ?? ''
}

/** 一个渲染回合的稳定 key（turn 用首条消息 id；system 类用 message.id）。
 *  两个 key 空间前缀不同（t-/s-），消息 id 全局唯一，无碰撞。 */
export function renderKey(item: RenderItem): string {
  return item.kind === 'turn' ? `t-${turnStableId(item.turn)}` : `s-${item.message.id}`
}

// ── D-4 turn 派生增量（08-render-layer §3.3.1，perf W21）──────────────────────────

/**
 * turn 派生增量缓存（D-4）。复用键 = turn 成员消息的对象引用序列——直接消费 D-1 的
 * 不可变消息身份（成员引用未变 = 成员内容未变，含 status/thinking/toolCalls/error），
 * 无第二份状态、无脆弱文本 hash（被否方案见 08 §3.2 D-4 对比表）。
 *
 * 缓存归属：纯派生数据、可随时丢弃重建（无 drift 风险）。调用方（MessageStream）经
 * useSessionScopedState 工厂按 session 分区持有（ADR-0049——组件实例不随 session 销毁，
 * 实例级缓存会跨 session 残留上一会话的 Message 引用），session 销毁经工厂 cleanup 释放。
 */
export interface TurnRenderCache {
  /** 快路径键 = 源数组引用（NOT filter 产物——filter 每调用产出新数组，键其上恒 miss）。
   *  D-1 容器范式下源数组（per-sid 分区数组）commit 才替换引用：引用未变 = 本 sid 无新 commit。 */
  lastSourceRef: Message[] | null
  /** 每个 turn 的成员引用签名（[user?, ...assistants, ...notices]；首条 assistant 自启/触发
   *  turn 无 user 位，notice 追加改变签名触发重建），与 turnObjects 一一对应 */
  turnSignatures: Message[][]
  /** 与 turnSignatures 一一对应：上次产出的 MessageTurn（复用载体） */
  turnObjects: MessageTurn[]
  /** 与 turnObjects 一一对应：各 turn 在源数组中的最早成员下标（尾部快车道 D-4 三车道的
   *  重受影响区起点）。该下标具有「分组状态归零」性质：全量分组处理到此处时 current 必为
   *  null（起点消息只可能是 user 锚 / 隐藏完成通知边界 / assistant 自启——三者都以
   *  openTurn 动作起始，见 groupRenderInput），因此子数组从该处重跑与全量路径逐字一致。
   *  [收纳附着] 规则 5 收纳分支经 pending 附着的 bash 通知下标小于 turn 开启下标——
   *  attachPendingBash 把组起始下标回拉至 pending 首条，归零性质对折叠成员同样成立。 */
  turnStartOffsets: number[]
  /** 上次整体产出（快路径直接复用；含非 turn 项——systemNotice/bashExecution 一并缓存） */
  cachedItems: RenderItem[]
}

/** 创建空缓存。toRenderItemsIncremental 原地 mutate 更新（不替换缓存对象），调用方 init 时创建一次。 */
export function createTurnRenderCache(): TurnRenderCache {
  return {
    lastSourceRef: null,
    turnSignatures: [],
    turnObjects: [],
    turnStartOffsets: [],
    cachedItems: [],
  }
}

/** 分组中间结构：一个「turn」的成员组（user 起点锚 / assistant 自启 / 隐藏通知触发） */
interface TurnGroup {
  user: Message | null
  assistants: Message[]
  /** turn 内 notice（D4 规则 4），按到达序追加；undefined = 尚无 notice（输出形态同历史 turn） */
  notices?: Message[]
  /** 被隐藏的完成通知本体（D5 载体）：规则 2 开/复用 trigger turn 时压入，连续边界折叠
   *  复用组时累积追加。**本体不渲染**（隐藏语义保持），只服务 notifySummary 派生与增量
   *  复用键；命名与 notices（字面仅差一词）刻意区分语义：notices = 要渲染的 turn 内
   *  notice，hiddenNotifies = 已消费为边界语义的完成通知（本体不渲染）。 */
  hiddenNotifies?: Message[]
  /** 被收纳完成通知本体（specs/chat/system-notices.md §3）：规则 2 隐藏通知 + 规则 5 收纳
   *  分支的 background-bash 结构化行，按到达序累积。**bash 行是可见消息**——宿主轮工作态
   *  由渲染层以其渲染临时外部行，settle 后切换为折叠标签（数据原地搬家不复制）。 */
  foldedNotices?: Message[]
  /** hiddenNotifies 的聚合派生值（D5）：每次压入后同步重算（组内条数极少，重算成本可忽略），
   *  两个 MessageTurn 构造点直接读取该字段——派生单点收敛在 ./notify-summary，无第二份聚合逻辑。 */
  notifySummary?: NotifySummary
  /** 无 user 起点的续跑 turn 标记（D3 规则 2）；undefined = user 锚 / assistant 自启 turn */
  trigger?: 'bg-notify'
}

/** 渲染槽位：turn 槽位引用 groups 下标；system 类直接产出静态项（不参与 turn 复用） */
type GroupSlot = { slot: 'turn'; group: number } | { slot: 'static'; item: RenderItem }

/** 隐藏完成通知判定（D3 边界触发器）：display===false 且 customType 属完成通知 SSOT 常量集
 *  （与 apply-entry 覆写 / registry 同一常量源——分组侧不引入第二份判定）。 */
function isHiddenCompleteNotify(msg: Message): boolean {
  return (
    msg.display === false &&
    msg.customType !== undefined &&
    COMPLETE_NOTIFY_CUSTOM_TYPES.has(msg.customType)
  )
}

/** background-bash 结构化完成通知判定（specs/chat/system-notices.md 规则 5 收纳分支触发器）：
 *  可见 system 消息且 details 经 shared 单点解析命中（解析器即判定 SSOT——与 SystemNotice
 *  结构化行渲染同一入口，无第二份形状判定；display:false 形态由规则 2/透明分支先行拦截，
 *  本判定只服务可见行）。解析 null（旧 session 无 details / 畸形载荷）→ 落规则 6 兜底原文行
 *  （现状语义，不收纳）。导出供渲染层过滤 foldedNotices 中的 bash 行（工作态临时外部行），
 *  判定单点不复制。 */
export function isBashCompleteNotice(msg: Message): boolean {
  return msg.display !== false && parseBackgroundBashDetails(msg.details) !== null
}

/** inline notice 判定（D4 规则 4）：bash 执行记录（有 bashExecution 字段）或 liveOnly
 *  消息（stream_warn 非终结提示——pi 静默卡死健康警告 / busy 拒绝等，无 entry 无 replay
 *  对应物，W2 创建点打标）→ turn 内部语义，不切断 turn。 */
function isInlineNotice(msg: Message): boolean {
  return msg.bashExecution !== undefined || msg.liveOnly === true
}

// ── bg-notify 边界聚合投影（D5）─────────────────────────────────────────────
// 判据/去重/耗时聚合的实现在 ./notify-summary（载荷解析聚合轴，与分组轴分离）；
// 本文件只负责：规则 2 分支压入通知本体 + 旁挂派生值（分组状态机的一部分）。

/** 隐藏完成通知累积载体（D5 规则 2）：压入通知本体 + 同步重算聚合派生值。本体同时进
 *  foldedNotices（收纳明细行的数据源，specs/chat/system-notices.md §3）——hiddenNotifies
 *  是聚合轴的输入，foldedNotices 是展示轴的输入，同一消息两处引用（原地搬家不复制）。 */
function appendHiddenNotify(msg: Message, group: TurnGroup): void {
  ;(group.hiddenNotifies ??= []).push(msg)
  ;(group.foldedNotices ??= []).push(msg)
  group.notifySummary = deriveNotifySummary(group.hiddenNotifies)
}

/** background-bash 完成通知收纳附着（规则 5 收纳分支）：本体压入 foldedNotices（到达序）。
 *  bash 行是可见消息、不进 hiddenNotifies——聚合轴（notify-summary 解析族）不消费 bash 载荷，
 *  混入会把 bash details 误判为解析失败推高 neutralCount。 */
function appendBashNotice(msg: Message, group: TurnGroup): void {
  ;(group.foldedNotices ??= []).push(msg)
}

/** turn 未被填实（无 user、无 assistant、无 notice）→ 折叠候选。实际只可能是未被后续
 *  assistant 填实的 trigger turn（user 锚 turn 必有 user；assistant 自启 turn 必有 assistant）。
 *  [D5 钉死] hiddenNotifies 刻意不纳入本判定：纳入会破坏「连续边界折叠复用同组」承诺
 *  （第二条通知另开新组、两行各显 1），且 hidden-only 组的 turnStableId 回落空串致
 *  renderKey 重复。后果显式登记：无 assistant 填充的 hidden-only 组随空 turn 折叠、边界行
 *  不渲染——与现状零劣化（通知本体本就不渲染），正常路径由 triggerTurn 唤醒 assistant 填实。 */
function isEmptyTurn(g: TurnGroup): boolean {
  return g.user === null && g.assistants.length === 0 && (g.notices?.length ?? 0) === 0
}

/** 关闭 turn：若其未被填实（空 trigger turn）从产出中移除（空 turn 折叠，D3）。
 *  current 开启期间无其他槽位压栈（notice 挂 current 不出槽位），末位槽位即 current 的
 *  turn 槽位——groups/slots 成对弹出安全，groups 末位守卫为防御性断言。
 *  starts 与 groups 同步弹出（保持与 turnObjects 对齐的起始下标不变量）。
 *  [收纳折叠边界] 被折叠空组携带的 background-bash 通知是可见消息（规则 5 收纳分支附着，
 *  宿主轮未及填实即遇下一边界）——弹出前以其落位独立 static 项（渲染过滤不丢消息，规则 9；
 *  隐藏通知本体保持不渲染，D5 契约不变）。
 *  返回 null（关闭后无当前 turn）——返回值形式让调用点直接 `current = closeTurn(...)`，
 *  赋值对 TS CFA 可见（跨函数的外部 let 窄化不追踪）。 */
function closeTurn(
  turn: TurnGroup | null,
  groups: TurnGroup[],
  slots: GroupSlot[],
  starts: number[],
): null {
  if (turn !== null && isEmptyTurn(turn) && groups[groups.length - 1] === turn) {
    groups.pop()
    starts.pop()
    slots.pop()
    // 折叠组携带的 bash 行在其原槽位落位 static（pop 之后再 push——槽位序即流序）
    for (const msg of turn.foldedNotices ?? []) {
      if (isBashCompleteNotice(msg)) {
        slots.push({ slot: 'static', item: { kind: 'systemNotice', message: msg } })
      }
    }
  }
  return null
}

/** 开启 turn 并压入 turn 槽位，返回新组（调用点赋回 current）；startIndex = 该组最早成员
 *  在源数组中的下标，与 groups 同步压入 starts（尾部快车道的重受影响区起点）。 */
function openTurn(
  user: Message | null,
  trigger: 'bg-notify' | undefined,
  groups: TurnGroup[],
  slots: GroupSlot[],
  starts: number[],
  startIndex: number,
): TurnGroup {
  const turn: TurnGroup = { user, assistants: [], trigger }
  groups.push(turn)
  starts.push(startIndex)
  slots.push({ slot: 'turn', group: groups.length - 1 })
  return turn
}

/** 规则 4 分支体：inline notice 归当前 turn 内部（挂 notices，按到达序追加末尾——bash entry
 *  在文件序即级联末，位置忠实）；无当前 turn 退化为独立 static 项（现状兜底保留）。
 *  current 透传返回（本分支不改变边界）。 */
function appendInlineNotice(
  msg: Message,
  current: TurnGroup | null,
  slots: GroupSlot[],
): TurnGroup | null {
  if (current) {
    ;(current.notices ??= []).push(msg)
  } else {
    slots.push({
      slot: 'static',
      item: msg.bashExecution
        ? { kind: 'bashExecution', message: msg }
        : { kind: 'systemNotice', message: msg },
    })
  }
  return current
}

/** 规则 5 收纳分支的待附缓冲成员：bash 完成通知 + 其源数组下标（附着回拉组起始下标用） */
interface PendingBashNotice {
  msg: Message
  index: number
}

/** pending bash 行落位独立 static 外部行（边界 1：agent 空闲无宿主轮不收纳；不丢消息）。
 *  清空由调用方传入的缓冲数组原地完成（groupRenderInput 持有该数组引用）。 */
function flushPendingBashAsStatic(
  pendingBashNotices: PendingBashNotice[],
  slots: GroupSlot[],
): void {
  for (const p of pendingBashNotices) {
    slots.push({ slot: 'static', item: { kind: 'systemNotice', message: p.msg } })
  }
  pendingBashNotices.length = 0
}

/** pending bash 行按到达序注入宿主轮（数据原地搬家，settle 后收进轮头行）；
 *  组起始下标回拉至 pending 首条下标（重跑等价性，见 groupRenderInput 的 pendingBashNotices 注）。 */
function attachPendingBashToGroup(
  group: TurnGroup,
  pendingBashNotices: PendingBashNotice[],
  groupsRef: TurnGroup[],
  startsRef: number[],
): void {
  if (pendingBashNotices.length === 0) return
  for (const p of pendingBashNotices) appendBashNotice(p.msg, group)
  const gi = groupsRef.indexOf(group)
  const firstIndex = pendingBashNotices[0].index
  if (gi >= 0 && firstIndex < (startsRef[gi] ?? Number.POSITIVE_INFINITY)) {
    startsRef[gi] = firstIndex
  }
  pendingBashNotices.length = 0
}

/** 规则 3 分支体：assistant 归 current（无则自启 user:null turn——首条 assistant 边缘保留）。
 *  pending bash 行的宿主轮就此确定：先注入再归成员（foldedNotices 保持到达序）。 */
function appendAssistantEntry(
  msg: Message,
  current: TurnGroup | null,
  groups: TurnGroup[],
  slots: GroupSlot[],
  starts: number[],
  index: number,
  pendingBashNotices: PendingBashNotice[],
): TurnGroup {
  if (pendingBashNotices.length > 0) {
    current ??= openTurn(null, undefined, groups, slots, starts, index)
    attachPendingBashToGroup(current, pendingBashNotices, groups, starts)
  }
  current ??= openTurn(null, undefined, groups, slots, starts, index)
  current.assistants.push(msg)
  return current
}

/** 规则 2 分支体：隐藏完成通知 → turn 边界（D3）。连续边界折叠：current 已是未填实 trigger
 *  turn 时复用该组（trigger 单值常量，取最新语义天然成立），不再压新组；此分支 current
 *  为 null 或已填实（非空），closeTurn 无可折叠，直接开新 trigger turn。先注入 pending
 *  bash 行（到达序在前），再压入本隐藏通知（D5 聚合载体 + 收纳明细行）。 */
function appendHiddenNotifyBoundary(
  msg: Message,
  current: TurnGroup | null,
  groups: TurnGroup[],
  slots: GroupSlot[],
  starts: number[],
  index: number,
  pendingBashNotices: PendingBashNotice[],
): TurnGroup {
  if (current === null || !isEmptyTurn(current)) {
    current = openTurn(null, 'bg-notify', groups, slots, starts, index)
  }
  attachPendingBashToGroup(current, pendingBashNotices, groups, starts)
  appendHiddenNotify(msg, current)
  return current
}

/** 规则 5 收纳分支体（specs/chat/system-notices.md §3）：background-bash 结构化完成通知。
 *  current 为未填实 trigger turn（同批完成通知收敛同一宿主轮）→ 直接附着该组；否则
 *  关闭当前 turn 挂入 pending——宿主轮出现（assistant / 规则 2）即注入，user / 其余
 *  可见 system / 数组结束（agent 空闲无 settle 时机）→ 落位独立 static 外部行。 */
function collectBashCompleteNotice(
  msg: Message,
  current: TurnGroup | null,
  groups: TurnGroup[],
  slots: GroupSlot[],
  starts: number[],
  index: number,
  pendingBashNotices: PendingBashNotice[],
): TurnGroup | null {
  if (current !== null && isEmptyTurn(current)) {
    appendBashNotice(msg, current)
    return current
  }
  current = closeTurn(current, groups, slots, starts)
  pendingBashNotices.push({ msg, index })
  return current
}

/**
 * 扁平消息（全量数组，含 display:false）→ 渲染槽位序列 + turn 成员组。
 * 分组规则 v2 见文件头「分组规则」节（conversation-turn-attribution §3.3 D3/D4）。
 * toRenderItems（全量版）与 toRenderItemsIncremental（增量版）共享的分组 SSOT——
 * 两处分组逻辑漂移会导致增量输出与全量输出不等价。
 *
 * 分组不变量（设计文档 D-A5）：static 槽位结构性不含 display:false 消息，依赖分支顺序
 * （透明分支先于 isInlineNotice 与规则 5 拦截）——新增 static 产出分支须保持该分支顺序前提。
 *
 * from = 起始下标（尾部快车道 D-4 用：从末位 turn 的起始下标重跑子数组分组——该下标处
 * 分组状态归零，子重跑与全量路径在该区间逐字一致）。starts = 各 turn 组的最早成员下标
 * （与 groups 等长对齐，供下次尾部快车道定位重受影响区）。分组规则分支本体不感知 from/
 * starts（纯 bookkeeping），全量调用（from 缺省 0）行为与历史版本逐字一致。
 */
function groupRenderInput(
  messages: Message[],
  from = 0,
): { slots: GroupSlot[]; groups: TurnGroup[]; starts: number[] } {
  const slots: GroupSlot[] = []
  const groups: TurnGroup[] = []
  const starts: number[] = []
  let current: TurnGroup | null = null
  // 规则 5 收纳分支的待附缓冲（specs/chat/system-notices.md §3）：bash 完成通知到达时宿主轮
  // 未出现 → 持有；宿主轮开启（assistant 自启 / 规则 2 trigger turn）→ 按到达序注入该组。
  // 不变量：pending 非空 ⇒ current === null（入队前必经 closeTurn 归零，出队口全数清空）。
  // 携带源数组下标：附着发生在宿主轮开启之后，而开启下标 > pending 下标——turnStartOffsets
  // 的「分组状态归零」不变量（尾部快车道从该下标重跑与全量逐字一致）要求组起始下标覆盖
  // 全部成员，附着时回拉至 pending 首条下标。
  const pendingBashNotices: PendingBashNotice[] = []

  for (let i = from; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'user') {
      // 规则 1：user 锚 → 开新 turn（挂起的空 trigger turn 折叠不产出；pending bash 无宿主
      // 轮 → 落位外部行，随后到达的用户消息不被误认为宿主）
      current = closeTurn(current, groups, slots, starts)
      flushPendingBashAsStatic(pendingBashNotices, slots)
      current = openTurn(msg, undefined, groups, slots, starts, i)
    } else if (msg.role === 'assistant') {
      // 规则 3（分支体见 appendAssistantEntry）
      current = appendAssistantEntry(msg, current, groups, slots, starts, i, pendingBashNotices)
    } else if (isHiddenCompleteNotify(msg)) {
      // 规则 2（分支体见 appendHiddenNotifyBoundary）
      current = appendHiddenNotifyBoundary(msg, current, groups, slots, starts, i, pendingBashNotices)
    } else if (msg.display === false) {
      // 隐藏非完成通知消息（todo-context 等）透明：不参与边界、不产出渲染项——现状语义
      // 原样保留。消息仍在 store，不丢。
      continue
    } else if (isBashCompleteNotice(msg)) {
      // 规则 5 收纳分支（分支体见 collectBashCompleteNotice）
      current = collectBashCompleteNotice(msg, current, groups, slots, starts, i, pendingBashNotices)
    } else if (isInlineNotice(msg)) {
      // 规则 4：inline notice → 归当前 turn 内部（分支体见 appendInlineNotice）；
      // 无当前 turn 退化为独立 static 项——pending bash 行先落位（保持流序）
      if (current === null) flushPendingBashAsStatic(pendingBashNotices, slots)
      current = appendInlineNotice(msg, current, slots)
    } else {
      // 规则 6：其余可见 system → boundary：独立 systemNotice 项 + 关闭当前 turn（现状语义）。
      // else 即「非 user/assistant 且非上述属性」兜底分支：现状唯一合法值是 role === 'system'
      // （compactionSummary/branchSummary/可见 custom/通用 system）。刻意不做显式 system 判定后
      // 丢弃——类型外 role（未来扩展）兜底渲染为 systemNotice 可见可发现，静默丢弃会违背
      // 「渲染过滤不丢消息」语义（AGENTS.md 规则 9）。bashExecution 此分支不可达（规则 4 已收）。
      // pending bash 行先落位（到达序在先）。
      current = closeTurn(current, groups, slots, starts)
      flushPendingBashAsStatic(pendingBashNotices, slots)
      slots.push({ slot: 'static', item: { kind: 'systemNotice', message: msg } })
    }
  }
  // 数组结束时仍挂起的空 trigger turn 不产出（空 turn 折叠——其附着的 bash 行经 closeTurn
  // 落位外部行）；pending 余量 = agent 空闲到达的通知，落位外部行（边界 1）
  closeTurn(current, groups, slots, starts)
  flushPendingBashAsStatic(pendingBashNotices, slots)
  return { slots, groups, starts }
}

/** turn 派生字段：isStreaming（turn 级「文本正在流式生成」，仅末位 turn 可为 true） */
function computeIsStreaming(
  assistants: Message[],
  isLastTurn: boolean,
  forceWorking: boolean,
): boolean {
  if (!isLastTurn) return false
  const last = assistants[assistants.length - 1]
  return forceWorking || last?.status === 'streaming'
}

/** turn 派生字段：是否含可折叠块（thinking/toolCalls）——被收纳完成通知同样构成展开入口
 *  （specs/chat/system-notices.md §3.4：展开区首行起为收纳明细行），计入口径与块同权。 */
function computeHasFoldable(assistants: Message[], foldedNotices?: Message[]): boolean {
  return (
    assistants.some(
      (m) => (m.thinking?.length ?? 0) > 0 || (m.toolCalls?.length ?? 0) > 0,
    ) || (foldedNotices?.length ?? 0) > 0
  )
}

/** 签名相等 = 长度相同且逐成员引用相等（自启 turn 无 user 位，序列天然对齐） */
function signatureEquals(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** turn 组成员引用签名（[user?, ...assistants, ...notices, ...foldedNotices]；首条 assistant
 *  自启/触发 turn 无 user 位，notice / 完成通知附着改变签名触发重建）。尾部快车道与
 *  全量重扫共用同一构造。
 *  foldedNotices 纳入签名（D5 等价性义务 + 收纳附着）：其为 hiddenNotifies 的超集（同一
 *  消息引用两处同步追加），签名未变则 notifySummary 与收纳明细行必然不变（成员引用相等 =
 *  内容相等，ADR-0039）。 */
function turnSignature(g: TurnGroup): Message[] {
  return [
    ...(g.user ? [g.user] : []),
    ...g.assistants,
    ...(g.notices ?? []),
    ...(g.foldedNotices ?? []),
  ]
}

/** turn 对象解析（尾部快车道与全量重扫共用的复用判定）：abs = 该组在 turnObjects 全序
 *  中的绝对下标。同位置签名逐引用对齐 → 复用上次 turn 对象。成员（含 notices/foldedNotices）
 *  未变 → hasFoldable/user/assistants/notices/trigger/notifySummary/foldedNotices 必然不变，
 *  只需校正 isStreaming（末位地位变化 / forceWorking 翻转会让上次值过期，不可变替换）。
 *  否则整组重建。 */
function reuseOrRebuildTurn(
  cache: TurnRenderCache,
  sig: Message[],
  g: TurnGroup,
  abs: number,
  isLastTurn: boolean,
  forceWorking: boolean,
): MessageTurn {
  const prevSig = abs < cache.turnSignatures.length ? cache.turnSignatures[abs] : undefined
  const prevTurn = abs < cache.turnObjects.length ? cache.turnObjects[abs] : undefined
  if (prevTurn && prevSig && signatureEquals(sig, prevSig)) {
    const expected = computeIsStreaming(g.assistants, isLastTurn, forceWorking)
    return prevTurn.isStreaming === expected ? prevTurn : { ...prevTurn, isStreaming: expected }
  }
  return {
    index: abs + 1,
    user: g.user,
    assistants: g.assistants,
    notices: g.notices,
    trigger: g.trigger,
    notifySummary: g.notifySummary,
    foldedNotices: g.foldedNotices,
    isStreaming: computeIsStreaming(g.assistants, isLastTurn, forceWorking),
    hasFoldable: computeHasFoldable(g.assistants, g.foldedNotices),
  }
}

/**
 * 快路径（源数组引用未变 = 本 sid 无新 commit）：按当前 forceWorking 重驱动末位 turn 的
 * isStreaming——消费方的 forceWorking 翻转（虚拟 session 的 subagent streaming 判定）在
 * 源数组不变时触发本函数。
 * 期望值未变 → cachedItems 引用恒等返回（零重算）；变化 → 不可变替换末位 turn 对象
 * （不原地改，历史 turn 与其余项全部复用）并同步缓存自洽。
 */
function redriveLastTurnStreaming(cache: TurnRenderCache, forceWorking: boolean): RenderItem[] {
  const items = cache.cachedItems
  const lastTurnItemIdx = lastTurnItemIndexOf(items)
  const lastTurnItem = lastTurnItemIdx >= 0 ? items[lastTurnItemIdx] : null
  // 无 turn（cachedItems 空或全 static 项）：static 项不依赖 forceWorking，恒等复用
  if (!lastTurnItem || lastTurnItem.kind !== 'turn') return items
  const expected = computeIsStreaming(lastTurnItem.turn.assistants, true, forceWorking)
  if (lastTurnItem.turn.isStreaming === expected) return items
  const replacement: MessageTurn = { ...lastTurnItem.turn, isStreaming: expected }
  const nextItems = items.slice()
  nextItems[lastTurnItemIdx] = { kind: 'turn', turn: replacement }
  cache.cachedItems = nextItems
  // items 中最后一个 turn 槽位恒对应 turnObjects 末位（分组顺序一致）；签名未变只换对象
  if (cache.turnObjects.length > 0) {
    const nextObjects = cache.turnObjects.slice()
    nextObjects[nextObjects.length - 1] = replacement
    cache.turnObjects = nextObjects
  }
  return nextItems
}

/** 逐项引用比较 [0, k)（纯指针比较，零分配）。ADR-0039 消息 shallowRef 不可变替换下
 *  「引用相等 = 内容相等」——前缀逐项同引用 = 前缀分组输入逐字节一致，确定性分组状态机
 *  到该处为止的产出必然一致，这是尾部快车道正确性的唯一前提。 */
function refsEqualUpTo(a: Message[], b: Message[], k: number): boolean {
  for (let i = 0; i < k; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** cachedItems 中末位 turn 项的下标（尾部倒扫——末位 turn 之后的 static 项数量少） */
function lastTurnItemIndexOf(items: RenderItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'turn') return i
  }
  return -1
}

/** static 项的 message 引用（turn 项返回 null）——尾部恒等判定用（避免 union 窄化散落） */
function staticMessageOf(item: RenderItem): Message | null {
  return item.kind === 'turn' ? null : item.message
}

/** 尾部 turn 槽位与上次产出恒等判定：新旧项同为 turn 且复用后的 turn 对象引用相等 */
function turnSlotUnchanged(oldItem: RenderItem | undefined, turn: MessageTurn): boolean {
  return oldItem !== undefined && oldItem.kind === 'turn' && oldItem.turn === turn
}

/** 尾部 static 槽位与上次产出恒等判定：kind 相同且 message 引用相等（引用相等 = 内容
 *  相等，ADR-0039）。防御 staticMessageOf 为 null（静态项必带 message，正常不可达）。 */
function staticSlotUnchanged(oldItem: RenderItem | undefined, newItem: RenderItem): boolean {
  if (oldItem === undefined) return false
  const newMsg = staticMessageOf(newItem)
  return (
    newMsg !== null && staticMessageOf(oldItem) === newMsg && oldItem.kind === newItem.kind
  )
}

/** 尾部快车道重跑起点定位：末位 turn 组的缓存下标（baseTurnIdx，即缓存三数组的截断点）、
 *  源数组起始下标（from，分组状态归零点）与旧产出中首个尾部项下标（tailStart）。无缓存
 *  turn 时全部取 0（= 从头重跑，expectedGroupCount 0 → 恒等判定期望零个 turn 组）。 */
function tailRebuildOrigin(cache: TurnRenderCache): {
  baseTurnIdx: number
  from: number
  tailStart: number
  expectedGroupCount: number
} {
  if (cache.turnObjects.length === 0) {
    return { baseTurnIdx: 0, from: 0, tailStart: 0, expectedGroupCount: 0 }
  }
  const lastTurnIdx = cache.turnObjects.length - 1
  return {
    baseTurnIdx: lastTurnIdx,
    from: cache.turnStartOffsets[lastTurnIdx],
    tailStart: lastTurnItemIndexOf(cache.cachedItems),
    expectedGroupCount: 1,
  }
}

/**
 * 尾部快车道（D-4 三车道形态①/②共用，08-render-layer §3.3.1 perf W21 演进；登记文档在
 * cw harness 侧，落地说明以此注释为准）：miss 形态判定通过后，从 cache 末位 turn 的源数组
 * 起始下标起重跑子数组分组（复用 groupRenderInput，不另写分组逻辑），产出尾部与 cache
 * 尾部对齐复用。覆盖两类高频 miss：
 * - 形态① 同长度仅末条替换（delta-coalescer 合帧 commit：末条 assistant 不可变替换）；
 * - 形态② 尾部 append（新消息追加：归既有末位 turn 或开新 turn 均正确）。
 *
 * 正确性依据（产出 ≡ 全量路径 deepEqual）：
 * - ADR-0039（消息 shallowRef 不可变替换）⇒ 引用相等 = 内容相等；前缀逐项引用相等
 *   （车道判定已验证）⇒ 前缀产出与 cache 前缀一致，差异只可能始于末位 turn 起始下标；
 * - turnStartOffsets 末位的「分组状态归零」性质（见字段注释）⇒ 子数组从 current=null
 *   重跑与全量路径在该区间逐字一致（连续边界 notify 同组、收尾 closeTurn 折叠由同一
 *   函数保证，无第二份分组语义）；
 * - 尾部对齐复用：turn 组按绝对组号与 cache 对应位签名比对（复用条件含 isStreaming
 *   期望一致——末位地位变化 / forceWorking 翻转在此校正，与全量重扫路径同款判定）；
 *   static 项按 kind + message 引用比对。全部可恒等复用（项数相同、turn 对象 toBe、
 *   static message 引用相同）→ 引用恒等返回 cachedItems（零分配零重算）；否则不可变
 *   替换尾部（cachedItems slice 产新数组，历史项引用不动）。
 */
function rebuildTailFromLastTurn(
  cache: TurnRenderCache,
  sourceMessages: Message[],
  forceWorking: boolean,
): RenderItem[] {
  const oldItems = cache.cachedItems
  const { baseTurnIdx, from, tailStart, expectedGroupCount } = tailRebuildOrigin(cache)
  const { slots: tailSlots, groups: tailGroups, starts: tailStarts } = groupRenderInput(
    sourceMessages,
    from,
  )
  const absLastTurn = baseTurnIdx + tailGroups.length - 1
  // 有缓存 turn 时旧尾部恰含 1 个 turn 组（起始下标性质：末位 turn 起点之后不再开新组）；
  // 子重跑组数不同 = 结构变化（新开 turn / 消息换型），不可能恒等
  let unchanged = tailGroups.length === expectedGroupCount

  const newTail: RenderItem[] = []
  const newSigs: Message[][] = []
  const newTurns: MessageTurn[] = []
  const newStarts: number[] = []
  let tailIdx = 0
  for (const s of tailSlots) {
    const oldItem = oldItems[tailStart + tailIdx]
    if (s.slot === 'turn') {
      const g = tailGroups[s.group]
      const abs = baseTurnIdx + s.group
      const sig = turnSignature(g)
      const turn = reuseOrRebuildTurn(cache, sig, g, abs, abs === absLastTurn, forceWorking)
      newSigs.push(sig)
      newTurns.push(turn)
      newStarts.push(tailStarts[s.group])
      unchanged = unchanged && turnSlotUnchanged(oldItem, turn)
      newTail.push({ kind: 'turn', turn })
    } else {
      unchanged = unchanged && staticSlotUnchanged(oldItem, s.item)
      newTail.push(s.item)
    }
    tailIdx += 1
  }
  // 旧尾部剩余项（新尾部没有对应项）→ 结构变化
  if (unchanged && tailIdx !== oldItems.length - tailStart) unchanged = false

  // 恒等复用：尾部产出与上次完全一致（如 append 透明消息 / 边界折叠形态）——零重算承诺
  if (unchanged) {
    cache.lastSourceRef = sourceMessages
    return oldItems
  }

  const items = oldItems.slice(0, tailStart)
  for (const it of newTail) items.push(it)
  cache.lastSourceRef = sourceMessages
  // 缓存三数组（signatures/objects/offsets）仅 cache 内部持有，截断 + 追加尾部即可
  cache.turnSignatures.length = baseTurnIdx
  cache.turnObjects.length = baseTurnIdx
  cache.turnStartOffsets.length = baseTurnIdx
  for (const sg of newSigs) cache.turnSignatures.push(sg)
  for (const t of newTurns) cache.turnObjects.push(t)
  for (const st of newStarts) cache.turnStartOffsets.push(st)
  cache.cachedItems = items
  return items
}

/** miss 形态判定（尾部快车道资格，O(n) 指针比较零分配——ADR-0039 不可变替换下
 *  引用相等 = 内容相等）：
 *  ① 同长度仅末条替换（streaming 合帧 commit）——比前 n-1 项（n=0 退化全量）；
 *  ② 尾部 append（新消息追加）——比前 oldLen 项（含首次 oldLen=0）。 */
function isTailAppendOrReplace(old: Message[] | null, sourceMessages: Message[]): boolean {
  const oldLen = old !== null ? old.length : 0
  const n = sourceMessages.length
  const sameLen = n === oldLen
  const prefixLen = sameLen ? n - 1 : oldLen
  return (
    old !== null &&
    (sameLen ? n > 0 : n > oldLen) &&
    (prefixLen <= 0 || refsEqualUpTo(old, sourceMessages, prefixLen))
  )
}

/** ③ 全量重扫（低频形态兜底，行为与历史版本逐字一致）：分组规则 v2 消费全量数组，
 *  同位置签名对齐的 turn 复用上次对象（reuseOrRebuildTurn），只重建成员变化的 turn。
 *  首版只做同位置匹配（位置平移的 turn 重算，成本 O(turn 数)，可接受——08 §3.3.1
 *  失效条件 2）。非 turn 项在重扫路径重建（构造便宜、数量少），经 cachedItems 随快路径
 *  整体复用。 */
function fullRescan(
  cache: TurnRenderCache,
  sourceMessages: Message[],
  forceWorking: boolean,
): RenderItem[] {
  const { slots, groups, starts } = groupRenderInput(sourceMessages)
  const lastGroupIdx = groups.length - 1
  const turnObjects: MessageTurn[] = new Array<MessageTurn>(groups.length)
  const signatures: Message[][] = new Array<Message[]>(groups.length)

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]
    const sig = turnSignature(g)
    signatures[i] = sig
    turnObjects[i] = reuseOrRebuildTurn(cache, sig, g, i, i === lastGroupIdx, forceWorking)
  }

  const items: RenderItem[] = slots.map((s) =>
    s.slot === 'turn' ? { kind: 'turn', turn: turnObjects[s.group] } : s.item,
  )

  cache.lastSourceRef = sourceMessages
  cache.turnSignatures = signatures
  cache.turnObjects = turnObjects
  cache.turnStartOffsets = starts
  cache.cachedItems = items
  return items
}

/**
 * toRenderItemsIncremental（增量版，D-4，08 §3.3.1 perf W21；三车道演进见 rebuildTailFromLastTurn）：
 * - 快路径：源数组引用未变 → 零重算（仅按 forceWorking 重驱动末位 isStreaming）
 * - miss 形态判定（isTailAppendOrReplace，逐项引用比较 O(n) 零分配）：
 *   ① 同长度仅末条替换（streaming 合帧 commit）/ ② 尾部 append → 尾部快车道
 *   （rebuildTailFromLastTurn：从末位 turn 起始下标重跑子数组，其余部分引用恒等复用）
 * - ③ 其余形态（前插/中删/引用全变等低频）→ 全量重扫（fullRescan，分组规则 v2 消费
 *   全量数组）。
 * - 上次末位 turn 的 streaming 态在末位地位变化时过期（如追加新 turn），复用分支
 *   按「期望 isStreaming」校正——不一致时不可变替换。
 *
 * @param sourceMessages 源消息数组（per-sid 分区数组，全量含 display:false）
 * @param forceWorking subagent 虚拟 session 强制 streaming
 * @param cache 增量缓存；undefined 时退化为全量版（等价现状 toRenderItems）
 */
export function toRenderItemsIncremental(
  sourceMessages: Message[],
  forceWorking: boolean,
  cache: TurnRenderCache | undefined,
): RenderItem[] {
  if (!cache) {
    return toRenderItems(sourceMessages, forceWorking)
  }
  if (cache.lastSourceRef === sourceMessages) {
    return redriveLastTurnStreaming(cache, forceWorking)
  }
  if (isTailAppendOrReplace(cache.lastSourceRef, sourceMessages)) {
    return rebuildTailFromLastTurn(cache, sourceMessages, forceWorking)
  }
  return fullRescan(cache, sourceMessages, forceWorking)
}

export function toRenderItems(
  messages: Message[],
  forceWorking = false,
): RenderItem[] {
  const { slots, groups } = groupRenderInput(messages)
  const turns: MessageTurn[] = groups.map((g, i) => ({
    index: i + 1,
    user: g.user,
    assistants: g.assistants,
    notices: g.notices,
    trigger: g.trigger,
    notifySummary: g.notifySummary,
    foldedNotices: g.foldedNotices,
    isStreaming: computeIsStreaming(g.assistants, i === groups.length - 1, forceWorking),
    hasFoldable: computeHasFoldable(g.assistants, g.foldedNotices),
  }))
  return slots.map((s): RenderItem =>
    s.slot === 'turn' ? { kind: 'turn', turn: turns[s.group] } : s.item,
  )
}

/** 统计 turn 内 thinking 块数（折叠条 badge） */
export function countThinking(turn: MessageTurn): number {
  return turn.assistants.reduce((sum, m) => sum + (m.thinking?.length ?? 0), 0)
}

/** 统计 turn 内 toolCall 块数（折叠条 badge） */
export function countToolCalls(turn: MessageTurn): number {
  return turn.assistants.reduce((sum, m) => sum + (m.toolCalls?.length ?? 0), 0)
}

/** turn 是否含失败的 tool（影响 trace 渲染：失败 tool 整块红框） */
export function hasFailedTool(turn: MessageTurn): boolean {
  return turn.assistants.some((m) =>
    m.toolCalls?.some((t) => t.status === 'error'),
  )
}

// 有序渲染块展开（OrderedBlock / expandAssistantBlocks）：实装在 ./assistant-blocks
// （此处 re-export 保持原 import 路径不变——包内 trace-window 深路径与桶出口消费方零改动），
// 独立职责：单条 assistant 消息内部块的时序解出，与 turn 分组无耦合。
export { expandAssistantBlocks } from './assistant-blocks'
export type { OrderedBlock } from './assistant-blocks'
