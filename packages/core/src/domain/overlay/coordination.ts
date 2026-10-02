/**
 * overlay 协同层 —— 模块级公开 API（display-containers §7.1 浮层协调）。
 *
 * 单例换内容（§6.5）：openOverlay 开新内容 = 替换 current（isOpen 保持开）；
 * closeOverlay 关浮层并复位 current（§7.4 发起会话删除级联同语义）。
 *
 * 载荷校验（边界防御，契约用例覆盖）：载荷关键字段为空串/非有限值 = no-op
 * （不改开合态——无效内容不进浮层，调用方（renderer controller）已有同口径守卫）。
 *
 * W2 扩展位（u-w2-browser-mount）：openBrowser(url) 协调函数落本文件（URL 注入链）。
 * 入口语义分立（§6.4）：openWorkflow（drawer/coordination，改向开浮层）与
 * openWorkflowInDrawer（显式 drawer 回落语义）不并入本层。
 */
import { overlayControl } from './state'
import type { OverlayContent } from './types'

/** 载荷有效性判据（browser:url 非空 / workflow:sessionId+runId 均非空） */
function isValidContent(content: OverlayContent): boolean {
  if (content.kind === 'browser') {
    return content.payload.url.trim() !== ''
  }
  return content.payload.sessionId.trim() !== '' && content.payload.runId.trim() !== ''
}

/**
 * 打开浮层（或换内容）：校验通过 → current=content + isOpen=true。
 * 已开态调用 = 单例换内容（不先关后开，视口不闪断）。无效载荷 no-op（保持原态）。
 */
export function openOverlay(content: OverlayContent): void {
  if (!isValidContent(content)) return
  overlayControl.open(content)
}

/** 关闭浮层：isOpen=false 且 current 复位 null（关浮层复位不变量） */
export function closeOverlay(): void {
  overlayControl.close()
}

/** 仅测试用：复位开合态（测试隔离）。生产代码禁止调用。 */
export function _resetOverlayForTest(): void {
  overlayControl.close()
}
