/**
 * stream-view-items —— Virtualizer slot 表达式前置求值视图模型（RD-2#1 / code-harden RD-2）。
 *
 * 问题：MessageStream 的 Virtualizer slot 内表达式（item.turn.user、renderKey(item)、
 * item.turn === lastRenderTurn 等）在 Virtualizer 的 render 帧执行（slot 函数属父组件
 * 编译产物），任一数据形态异常抛错会炸掉整个列表渲染——全屏消息流退化旧帧/空白，
 * 全仓无 onErrorCaptured 时用户零感知（全局 errorHandler 只落盘不上屏）。
 *
 * 修法（两道防线中的第一道）：把 slot 所需的全部派生表达式前置到本构建器逐项求值，
 * MessageStream 模板只消费算好的 plain object 字段（属性读取结构性无抛点）。单项求值
 * 抛错降级为 broken 项（渲染「本条渲染失败」占位行），不影响其余项。
 * 第二道防线 = StreamItemBoundary.vue（子组件 render 抛错的运行时边界，本构建器无法
 * 前置拦截 shiki/markdown 等组件内部异常）。
 *
 * [索引一致性硬约束] 返回数组与入参 streamItems 严格 1:1（同长度同顺序，broken 项占位
 * 不删位）——MessageStream 以本数组作 Virtualizer :data，lastUserTurnIdx / useStreamingPin /
 * rail 仍以 streamItems 为基准，两基准下标空间恒等，既有「混用基准错钉/错跳」禁令不破。
 */
import type { DeepReadonly } from 'vue'
import type { Message } from '@taiji/shared'
import type { MessageTurn } from '@taiji/core/domain/chat'
import { renderKey } from '@taiji/core/domain/chat'
import type { SkillNoticeEntry, SkillNoticeStreamItem } from '@/composables/panel/useSkillNoticeStream'

/** 占位行的预览文本上限：占位行是诊断信息不是内容回放，超长截断。 */
const PREVIEW_MAX_CHARS = 120

/**
 * 渲染视图项：kind 全集与 SkillNoticeStreamItem 一一对应，另加 broken（前置求值抛错的
 * 降级位）。turn 项携带 slot 原本现算的 canEdit / isLastTurn；每项必带 key / preview
 * （占位行数据源）。
 */
export type StreamViewItem =
  | { kind: 'turn'; key: string; preview: string; turn: MessageTurn; canEdit: boolean; isLastTurn: boolean }
  | { kind: 'bashExecution'; key: string; preview: string; message: Message }
  | { kind: 'systemNotice'; key: string; preview: string; message: Message }
  | { kind: 'skillNotice'; key: string; preview: string; entry: DeepReadonly<SkillNoticeEntry> }
  | { kind: 'broken'; key: string; preview: string }

/** 摘一段文本作占位预览：压平空白 + 截断；字段形态异常返回空串（不抛）。 */
function previewText(text: unknown): string {
  try {
    if (typeof text !== 'string') return ''
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > PREVIEW_MAX_CHARS ? `${flat.slice(0, PREVIEW_MAX_CHARS)}…` : flat
  } catch {
    return ''
  }
}

/** turn 预览：user 正文优先，自启 turn（无 user）回落首条 assistant 正文。 */
function turnPreview(turn: MessageTurn): string {
  return previewText(turn.user?.content) || previewText(turn.assistants[0]?.content)
}

/**
 * 上次构建缓存（模块级单槽，streaming perf）：纯派生 memo，比较对象 = 输入引用本身，
 * 同输入必同输出（无 session/props 维度，跨 MessageStream 实例换输入即 miss 重建，
 * 与 TurnRail railMemo 同款模块级形态）。切 session 后首帧逐项 miss 全量重建覆盖，
 * 旧 session 引用随覆盖释放，无跨会话残留面。
 */
// @data-owner #58 —— chat 对话流渲染派生 memo ②（streamViewItems 逐项恒等缓存单槽，
// 纯派生可丢弃重建，下次构建整体覆盖）
let cacheItems: SkillNoticeStreamItem[] | null = null
let cacheLastUserTurnIdx = -1
let cacheLastRenderTurn: MessageTurn | null = null
let cacheResult: StreamViewItem[] = []

/**
 * 单项复用判定：上次同位置 view item 是否可原样复用（preview 不重算）。
 *
 * 复用依据两层，全部显式 O(1) 比对、不依赖跨帧推理：
 * 1. 核心载体引用恒等（turn/message/entry ===）：ADR-0039/0041 不可变更新保证
 *    引用同 ⇒ 内容同 ⇒ preview（全文正则派生）与 key（首条消息 id 派生）同——
 *    与 TurnRail railMemo 消费同一不变量（core toRenderItemsIncremental 对签名未变
 *    的 turn 逐引用复用，历史项在本层引用恒稳定）。
 * 2. 标量派生字段逐个显式比对（canEdit/isLastTurn）：入参 lastUserTurnIdx /
 *    lastRenderTurn 变化不阻断其余项复用——变化只影响受影响项（重建），其余项
 *    比对通过即逐字节同值。streaming 帧的 lastRenderTurn 每帧新引用，靠这层
 *    显式比对而非入参快判，历史项才能跨帧存活。
 *
 * broken 项不复用（返回 false）：占位行是瞬时降级态，每帧重试正常构建（数据
 * 修复后自然恢复），复用会把瞬时故障固化。
 */
function canReuseView(prev: StreamViewItem, item: SkillNoticeStreamItem, index: number, lastUserTurnIdx: number, lastRenderTurn: MessageTurn | null): boolean {
  if (prev.kind === 'turn' && item.kind === 'turn') {
    return (
      prev.turn === item.turn &&
      prev.key === renderKey(item) &&
      prev.canEdit === (!!item.turn.user && index === lastUserTurnIdx) &&
      prev.isLastTurn === (item.turn === lastRenderTurn)
    )
  }
  if (prev.kind === 'bashExecution' && item.kind === 'bashExecution') {
    return prev.message === item.message && prev.key === renderKey(item)
  }
  if (prev.kind === 'systemNotice' && item.kind === 'systemNotice') {
    return prev.message === item.message && prev.key === renderKey(item)
  }
  if (prev.kind === 'skillNotice' && item.kind === 'skillNotice') {
    return prev.entry === item.entry
  }
  return false
}

/**
 * streamItems → 视图模型（1:1 投影，见文件头索引一致性约束）。
 *
 * streaming perf（逐项恒等缓存）：core commit 每 delta 帧替换 streamItems 引用，
 * 全量 map 重建会让历史 turn（引用恒稳定，几百项）每帧重付 previewText 全文正则
 * （preview 唯一消费点是 broken/failed 占位行，正常渲染零消费）。本层逐位复用：
 * 载体引用与标量派生字段全同 → 原样复用旧 view item（见 canReuseView）；全部项
 * 复用时连数组引用一并复用（下游 Virtualizer :data 引用不变，virtua 内部 diff 整体跳过）。
 * 1:1 约束不受影响：复用/重建逐位对应，长度与顺序由 items 本身决定。
 *
 * @param items streamItems 基准数组（core RenderItem 三态 + skillNotice）
 * @param lastUserTurnIdx 最后一个含 user 的 turn 的下标（canEdit 判定，与 slot index 同基准）
 * @param lastRenderTurn 渲染项里最后一个 turn（isStreaming 滚动判定用引用比对）
 */
export function buildStreamViewItems(
  items: SkillNoticeStreamItem[],
  lastUserTurnIdx: number,
  lastRenderTurn: MessageTurn | null,
): StreamViewItem[] {
  // 入参零变化快判：引用级直接返回上次结果（computed 意外重算 / 同帧多消费者零开销）
  if (cacheItems === items && cacheLastUserTurnIdx === lastUserTurnIdx && cacheLastRenderTurn === lastRenderTurn) {
    return cacheResult
  }
  // 逐位复用：上次数组存在即可逐位尝试（长度变化只影响超界位——尾部 append 前缀仍复用，
  // load-more 前插时前缀 miss 重算、后缀复用；全量重扫退化为全重建，均为正确降级）
  const canReusePerItem = cacheItems !== null
  const prevResult = cacheResult
  let reusedCount = 0
  const out: StreamViewItem[] = items.map((item, index) => {
    if (canReusePerItem) {
      const prev = prevResult[index]
      if (prev !== undefined && canReuseView(prev, item, index, lastUserTurnIdx, lastRenderTurn)) {
        reusedCount += 1
        return prev
      }
    }
    try {
      if (item.kind === 'skillNotice') {
        // skillNotice 用 notice 稳定 id 作 key（原 slot :key="item.entry.id" 同源）
        return { kind: 'skillNotice', key: item.entry.id, preview: previewText(item.entry.skills.join(', ')), entry: item.entry }
      }
      const key = renderKey(item)
      if (item.kind === 'turn') {
        return {
          kind: 'turn',
          key,
          preview: turnPreview(item.turn),
          turn: item.turn,
          canEdit: !!item.turn.user && index === lastUserTurnIdx,
          isLastTurn: item.turn === lastRenderTurn,
        }
      }
      if (item.kind === 'bashExecution') {
        return { kind: 'bashExecution', key, preview: previewText(item.message.content), message: item.message }
      }
      return { kind: 'systemNotice', key, preview: previewText(item.message.content), message: item.message }
    } catch (e) {
      // 单项求值抛错降级 broken（key 退化为 index 基——异常路径的身份保证，正常项不受影响）
      console.warn(`[stream-view-items] item view build failed at index ${index}:`, e)
      return { kind: 'broken', key: `broken-${index}`, preview: '' }
    }
  })
  // 全项复用 → 返回旧数组引用（内容与新建逐字节一致，复用引用只是切断下游 diff）
  const result = reusedCount === items.length ? prevResult : out
  cacheItems = items
  cacheLastUserTurnIdx = lastUserTurnIdx
  cacheLastRenderTurn = lastRenderTurn
  cacheResult = result
  return result
}
