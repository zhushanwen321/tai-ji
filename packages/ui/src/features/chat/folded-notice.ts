/**
 * 收纳完成通知的展示映射单点（specs/chat/system-notices.md §3.3/§3.4/§3.5）：
 * TurnMeta（折叠分段标签 + 解释卡）与 Turn（展开明细行）共用——图标表、i18n 键表、
 * 明细行状态词派生都在此一处，渲染组件零第二份映射。数据行来自 core
 * deriveFoldedNoticeRows（载荷解析聚合轴 SSOT），本模块只做「行 → 文案/图标」。
 */
import { Bot, Layers, SquareTerminal, Workflow } from '@lucide/vue'
import type { Component } from 'vue'
import type { FoldedNoticeRow, FoldedNoticeType } from '@taiji/core/domain/chat'

/** 类型 → 图标（bash 与 SystemNotice 结构化行同款终端图标） */
export const FOLDED_TYPE_ICON: Record<FoldedNoticeType, Component> = {
  bash: SquareTerminal,
  subagent: Bot,
  workflow: Workflow,
  managed: Layers,
}

/** 类型 → 折叠标签词键（整短语键：zh「已处理后台任务」/ en「Handled background tasks」各成段） */
export const FOLDED_TYPE_LABEL_KEY: Record<FoldedNoticeType, string> = {
  bash: 'panel.message.noticeFoldedBash',
  subagent: 'panel.message.noticeFoldedSubagent',
  workflow: 'panel.message.noticeFoldedWorkflow',
  managed: 'panel.message.noticeFoldedManagedSession',
}

/** 类型 → 解释卡词头类型词键 / 词义键（展开明细行类型列同用词头键） */
export const FOLDED_TYPE_WORD_KEY: Record<FoldedNoticeType, string> = {
  bash: 'panel.message.noticeTypeBash',
  subagent: 'panel.message.noticeTypeSubagent',
  workflow: 'panel.message.noticeTypeWorkflow',
  managed: 'panel.message.noticeTypeManagedSession',
}

export const FOLDED_TYPE_DESC_KEY: Record<FoldedNoticeType, string> = {
  bash: 'panel.message.noticeTypeDescBash',
  subagent: 'panel.message.noticeTypeDescSubagent',
  workflow: 'panel.message.noticeTypeDescWorkflow',
  managed: 'panel.message.noticeTypeDescManagedSession',
}

/** vue-i18n t 的结构化最小类型（useI18n().t 满足；named 参数按 i18n 显式命名形参传递） */
type Translate = (key: string, named?: Record<string, unknown>) => string

/**
 * 展开明细行状态词（§3.4：bash 显 exit N 字面量 / 超时词；其余类型三态词；
 * 中性 bash 非 timeout（exitCode 缺失，生产不可达形态）不显状态——不冒充成败）。
 */
export function foldedStatusText(row: FoldedNoticeRow, t: Translate): string {
  if (row.type === 'bash') {
    if (row.endReason === 'timeout') return t('panel.message.noticeStatusTimeout')
    if (row.outcome === 'success') return 'exit 0'
    if (row.outcome === 'failed') return `exit ${row.exitCode}`
    return ''
  }
  if (row.outcome === 'success') return t('panel.message.noticeStatusSuccess')
  if (row.outcome === 'failed') return t('panel.message.noticeStatusFailed')
  return t('panel.message.noticeStatusNeutral')
}
