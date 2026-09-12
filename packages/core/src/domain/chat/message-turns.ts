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
 *    xyz 已知 mode 归入当前 turn，replay 侧永远推不出同样归属——开新 turn 是两侧可一致
 *    推导的最大公约数（设计 D1）
 * 2. 隐藏完成通知（display===false 且 customType ∈ COMPLETE_NOTIFY_CUSTOM_TYPES，shared SSOT
 *    常量——与 apply-entry 覆写同一常量源，无第二份判定）→ turn 边界：关闭当前 turn，开启
 *    user:null + trigger:'bg-notify' 的新 turn，后续 assistant 归入（G3 续跑可见起点）。
 *    空 turn 折叠：边界未被 assistant 填实即遇下一边界/user/数组结束 → 不产出（连续边界
 *    折叠为一个 trigger turn，取最新）
 * 3. assistant → 归当前 turn（无则自启 user:null turn，首条 assistant 边缘保留）
 * 4. inline notice（bashExecution 存在 或 liveOnly===true）→ 归当前 turn 的 notices 列表
 *    （按到达序追加末尾，不切断 turn、不出独立渲染项）；无当前 turn 时退化为独立 static 项
 * 5. 其余可见 system（compactionSummary/branchSummary/可见 custom/通用 system）→ 边界：
 *    独立 systemNotice 项 + 关闭当前 turn（现状语义）
 * 隐藏非完成通知消息（如 todo-context，display:false）透明：不参与边界、不产出渲染项
 * （现状 = 分组前被过滤；消息仍在 store——渲染过滤不丢消息，AGENTS.md 规则 9）。
 *
 * - streaming 中的 turn（最后一条 assistant status==='streaming'）→ working 态，默认展开 trace
 *
 * 归属：chat 域纯函数（零 Vue/renderer 依赖），对齐 w1-w5 chat 域绞杀模式（core SSOT）。
 * ui 包经 @xyz-agent/core/domain/chat 子路径 import（仅类型/纯函数，非 store/composable 运行时）。
 */
import {
  COMPLETE_NOTIFY_CUSTOM_TYPES,
  normalizeContent,
  SUBAGENT_TOOL_NAMES,
  WORKFLOW_TOOL_NAMES,
} from '@xyz-agent/shared'
import type { Message, ThinkingBlock, ToolCall } from '@xyz-agent/shared'

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

/** 不在对话流渲染的 customType 判定已删除 [M2 display 前置]：完成通知由生产端（registry
 *  customStart / runtime mapper）统一写 display:false，不再维护 customType 黑名单
 *  （conversation-renderer-model-unification §3.3.2，supersede ADR-0048）。
 *  消息仍进 chat store 供 fork/compact/replay，agent 仍能读到；此处仅过滤渲染，不丢消息。
 *  [W3·D3 演进] display 过滤从「分组前置」挪到渲染项输出层（toRenderItems 内建）——
 *  隐藏完成通知须参与分组边界语义，不能再在分组前滤除。分组路径不再消费本函数
 *  （toRenderItemsIncremental 的 filter 参数占位已于 W4 移除）；保留供调用方独立
 *  过滤场景使用。 */

/** 过滤掉不在对话流展示的消息（display===false：完成通知由生产端写死，
 *  goal/todo context 由 pi 扩展声明——纯字段过滤，无 customType 黑名单）。
 *  [W3·D3] 注意：分组（groupTurns/toRenderItems/toRenderItemsIncremental）已改为消费
 *  全量数组并在输出侧内建同等过滤，调用方不再需要先 filter 再分组。 */
export function filterDisplayableMessages(messages: Message[]): Message[] {
  return messages.filter((m) => m.display !== false)
}

/** 全量数组 → turn 列表（分组规则 v2 消费全量数组——隐藏完成通知参与边界语义，
 *  隐藏项经输出侧过滤不产出渲染项，见文件头）。 */
export function groupTurns(messages: Message[]): MessageTurn[] {
  return toRenderItems(messages)
    .filter((item): item is { kind: 'turn'; turn: MessageTurn } => item.kind === 'turn')
    .map((item) => item.turn)
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
   *  openTurn 动作起始，见 groupRenderInput），因此子数组从该处重跑与全量路径逐字一致。 */
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

/** inline notice 判定（D4 规则 4）：bash 执行记录（有 bashExecution 字段）或 liveOnly
 *  消息（stream_warn 健康警告，无 entry 无 replay 对应物，W2 创建点打标）→ turn 内部语义，
 *  不切断 turn。 */
function isInlineNotice(msg: Message): boolean {
  return msg.bashExecution !== undefined || msg.liveOnly === true
}

/** turn 未被填实（无 user、无 assistant、无 notice）→ 折叠候选。实际只可能是未被后续
 *  assistant 填实的 trigger turn（user 锚 turn 必有 user；assistant 自启 turn 必有 assistant）。 */
function isEmptyTurn(g: TurnGroup): boolean {
  return g.user === null && g.assistants.length === 0 && (g.notices?.length ?? 0) === 0
}

/** 关闭 turn：若其未被填实（空 trigger turn）从产出中移除（空 turn 折叠，D3）。
 *  current 开启期间无其他槽位压栈（notice 挂 current 不出槽位），末位槽位即 current 的
 *  turn 槽位——groups/slots 成对弹出安全，groups 末位守卫为防御性断言。
 *  starts 与 groups 同步弹出（保持与 turnObjects 对齐的起始下标不变量）。
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

/**
 * 扁平消息（全量数组，含 display:false）→ 渲染槽位序列 + turn 成员组。
 * 分组规则 v2 见文件头「分组规则」节（conversation-turn-attribution §3.3 D3/D4）。
 * toRenderItems（全量版）与 toRenderItemsIncremental（增量版）共享的分组 SSOT——
 * 两处分组逻辑漂移会导致增量输出与全量输出不等价。
 *
 * 分组不变量（设计文档 D-A5）：static 槽位结构性不含 display:false 消息，依赖分支顺序
 * （透明分支先于 isInlineNotice 与规则 5 拦截）——新增 static 产出分支须同步尾部快车道过滤义务。
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

  for (let i = from; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'user') {
      // 规则 1：user 锚 → 开新 turn（挂起的空 trigger turn 折叠不产出）
      current = closeTurn(current, groups, slots, starts)
      current = openTurn(msg, undefined, groups, slots, starts, i)
    } else if (msg.role === 'assistant') {
      // 规则 3：assistant 归 current（无则自启 user:null turn——首条 assistant 边缘保留）
      current ??= openTurn(null, undefined, groups, slots, starts, i)
      current.assistants.push(msg)
    } else if (isHiddenCompleteNotify(msg)) {
      // 规则 2：隐藏完成通知 → turn 边界（D3）。连续边界折叠：current 已是未填实 trigger
      // turn 时复用该组（trigger 单值常量，取最新语义天然成立），不再压新组；此分支 current
      // 为 null 或已填实（非空），closeTurn 无可折叠，直接开新 trigger turn。
      if (current === null || !isEmptyTurn(current)) {
        current = openTurn(null, 'bg-notify', groups, slots, starts, i)
      }
    } else if (msg.display === false) {
      // 隐藏非完成通知消息（todo-context 等）透明：不参与边界、不产出渲染项——现状语义
      // （分组前被 filterDisplayableMessages 滤除）原样保留。消息仍在 store，不丢。
      continue
    } else if (isInlineNotice(msg)) {
      // 规则 4：inline notice → 归当前 turn 内部（分支体见 appendInlineNotice）。
      current = appendInlineNotice(msg, current, slots)
    } else {
      // 规则 5：其余可见 system → boundary：独立 systemNotice 项 + 关闭当前 turn（现状语义）。
      // else 即「非 user/assistant 且非上述属性」兜底分支：现状唯一合法值是 role === 'system'
      // （compactionSummary/branchSummary/可见 custom/通用 system）。刻意不做显式 system 判定后
      // 丢弃——类型外 role（未来扩展）兜底渲染为 systemNotice 可见可发现，静默丢弃会违背
      // 「渲染过滤不丢消息」语义（AGENTS.md 规则 9）。bashExecution 此分支不可达（规则 4 已收）。
      current = closeTurn(current, groups, slots, starts)
      slots.push({ slot: 'static', item: { kind: 'systemNotice', message: msg } })
    }
  }
  // 数组结束时仍挂起的空 trigger turn 不产出（空 turn 折叠）
  closeTurn(current, groups, slots, starts)
  return { slots, groups, starts }
}

/** D3 输出侧 display 过滤：隐藏消息（display===false）不产出渲染项。分组层已把隐藏完成
 *  通知消化为 trigger turn 边界语义、隐藏非通知消息透明跳过——此处是不变量守卫（正常路径
 *  零命中），防御未来新增消息类型绕过分组规则直接产出 static 项。turn 项不过滤：
 *  user/assistant 无 display:false 写入点，隐藏成员属 turn 内部不可整组丢弃。 */
function filterInvisibleItems(items: RenderItem[]): RenderItem[] {
  return items.filter((item) => item.kind === 'turn' || item.message.display !== false)
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

/** turn 派生字段：是否含可折叠块（thinking/toolCalls） */
function computeHasFoldable(assistants: Message[]): boolean {
  return assistants.some(
    (m) => (m.thinking?.length ?? 0) > 0 || (m.toolCalls?.length ?? 0) > 0,
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

/** turn 组成员引用签名（[user?, ...assistants, ...notices]；首条 assistant 自启/触发
 *  turn 无 user 位，notice 追加改变签名触发重建）。尾部快车道与全量重扫共用同一构造。 */
function turnSignature(g: TurnGroup): Message[] {
  return [...(g.user ? [g.user] : []), ...g.assistants, ...(g.notices ?? [])]
}

/** turn 对象解析（尾部快车道与全量重扫共用的复用判定）：abs = 该组在 turnObjects 全序
 *  中的绝对下标。同位置签名逐引用对齐 → 复用上次 turn 对象。成员（含 notices）未变 →
 *  hasFoldable/user/assistants/notices/trigger 必然不变，只需校正 isStreaming
 *  （末位地位变化 / forceWorking 翻转会让上次值过期，不可变替换）。否则整组重建。 */
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
    isStreaming: computeIsStreaming(g.assistants, isLastTurn, forceWorking),
    hasFoldable: computeHasFoldable(g.assistants),
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

  const items = filterInvisibleItems(
    slots.map((s) => (s.slot === 'turn' ? { kind: 'turn', turn: turnObjects[s.group] } : s.item)),
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
    isStreaming: computeIsStreaming(g.assistants, i === groups.length - 1, forceWorking),
    hasFoldable: computeHasFoldable(g.assistants),
  }))
  return filterInvisibleItems(
    slots.map((s) => (s.slot === 'turn' ? { kind: 'turn', turn: turns[s.group] } : s.item)),
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

/**
 * 有序渲染块 —— 单条 assistant Message 内部块按真实时序解出后的渲染单元。
 * Turn.vue trace 区按此数组顺序 v-for 渲染 Block.vue。
 */
export interface OrderedBlock {
  kind: 'thinking' | 'tool' | 'text' | 'agentgraph'
  ref: ThinkingBlock | ToolCall | string
}

/** 判断 toolName 是否属于 agentgraph（subagent/workflow）。 */
function isAgentgraphToolName(toolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolName) || WORKFLOW_TOOL_NAMES.has(toolName)
}

/** toolCall 块构造：agentgraph 工具名归 agentgraph kind（主路径/降级路径共用）。 */
function toolBlockOf(tc: ToolCall): OrderedBlock {
  return { kind: isAgentgraphToolName(tc.toolName) ? 'agentgraph' : 'tool', ref: tc }
}

/** 主路径：contentBlocks 非空时按其真实时序解出（text/thinking/toolCall 的 refId 回查）。 */
function expandFromContentBlocks(blocks: NonNullable<Message['contentBlocks']>, msg: Message): OrderedBlock[] {
  const result: OrderedBlock[] = []
  for (const b of blocks) {
    if (b.type === 'text') {
      if (msg.content) result.push({ kind: 'text', ref: normalizeContent(msg.content) })
    } else if (b.type === 'thinking') {
      const th = msg.thinking?.find((t) => t.id === b.refId)
      if (th) result.push({ kind: 'thinking', ref: th })
    } else if (b.type === 'toolCall') {
      const tc = msg.toolCalls?.find((t) => t.id === b.refId)
      if (tc) result.push(toolBlockOf(tc))
    }
  }
  return result
}

/** 降级路径：contentBlocks 缺失/为空时按 content 文本 + thinking + toolCalls 顺序解出。 */
function expandFallback(msg: Message): OrderedBlock[] {
  const fallback: OrderedBlock[] = []
  const text = normalizeContent(msg.content)
  if (text.trim()) fallback.push({ kind: 'text', ref: text })
  for (const th of msg.thinking ?? []) fallback.push({ kind: 'thinking', ref: th })
  for (const tc of msg.toolCalls ?? []) fallback.push(toolBlockOf(tc))
  return fallback
}

/**
 * 把单条 assistant Message 的内部块按 contentBlocks 真实时序解成有序列表。
 * 纯函数：相同输入相同输出，无副作用。
 */
export function expandAssistantBlocks(msg: Message): OrderedBlock[] {
  const blocks = msg.contentBlocks
  if (blocks && blocks.length > 0) {
    return expandFromContentBlocks(blocks, msg)
  }
  return expandFallback(msg)
}
