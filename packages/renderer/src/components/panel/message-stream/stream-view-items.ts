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
 * streamItems → 视图模型（1:1 投影，见文件头索引一致性约束）。
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
  return items.map((item, index) => {
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
}
