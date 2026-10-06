/**
 * overlay 协同层 —— 模块级公开 API（display-containers §7.1 浮层协调）。
 *
 * 单例换内容（§6.5）：openOverlay 开新内容 = 替换 current（isOpen 保持开）；
 * closeOverlay 关浮层并复位 current（§7.4 发起会话删除级联同语义）。
 *
 * 载荷校验（边界防御，契约用例覆盖）：载荷关键字段为空串/非有限值 = no-op
 * （不改开合态——无效内容不进浮层，调用方（renderer controller）已有同口径守卫）。
 *
 * W2 扩展位（u-w2-browser-mount）：openBrowser(url, sessionId) 协调函数落本文件（URL 注入链）。
 * 入口语义分立（§6.4）：openWorkflow（drawer/coordination，改向开浮层）与
 * openWorkflowInDrawer（显式 drawer 回落语义）不并入本层。
 */
import { overlayControl, getOverlayControlState } from './state'
import type { OverlayContent } from './types'

/** 载荷有效性判据（browser:url+sessionId 非空 / workflow:sessionId+runId 均非空 / scheduler:sessionId 非空） */
function isValidContent(content: OverlayContent): boolean {
  if (content.kind === 'browser') {
    return content.payload.url.trim() !== '' && content.payload.sessionId.trim() !== ''
  }
  if (content.kind === 'scheduler') {
    return content.payload.sessionId.trim() !== ''
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

/**
 * 打开浮层浏览器页（URL 注入链，§7.4/§6.8：markdown 链接 / agent 消息里的 localhost URL
 * → openBrowser → 浮层壳 + BrowserPane）。
 *
 * @param url 要打开的 URL（localhost/127.0.0.1 默认进浮层，判定在 MarkdownRenderer ⑤路，§11-3）
 * @param sessionId 发起会话（点击链接所在会话）：view 键 + 会话删除级联 + 显示谓词事实源
 *
 * 已开态调用 = 单例换内容（换 URL/换会话直接换载荷）；无效载荷 no-op（openOverlay 校验）。
 */
export function openBrowser(url: string, sessionId: string): void {
  openOverlay({ kind: 'browser', payload: { url, sessionId } })
}

/**
 * 打开浮层定时任务面板（scheduler 整合进 workflow 浮层成一级 tab，2026-10-06 用户裁决）：
 * scheduler-manager 插件树经 views.update 按 (sessionId, viewId) 分区持续推送（会话激活
 * 链即推，不依赖旧 plugin modal 开着），浮层内 ViewHost 消费同一分区即得内容（插件零改动）。
 *
 * @param sessionId 面板数据所属会话（per-session 分区键；tab 内容随当前会话）
 *
 * 已开态调用 = 单例换内容（换会话直接换载荷）；无效载荷 no-op（openOverlay 校验）。
 */
export function openSchedulerOverlay(sessionId: string): void {
  openOverlay({ kind: 'scheduler', payload: { sessionId } })
}

/**
 * 会话删除级联（§7.4 发起会话删除的浮层终态）：删除的是浮层当前 browser 内容的发起
 * 会话 → 关浮层（overlay 态复位）；**其它会话被删不动浮层**（条件式语义，对齐 workflow
 * 先例 closeWorkflowVizOverlayForSession；S5 反向断言防过宽清场）。
 * view 销毁归 SessionCleanupHooks.browserDestroy（browserDestroy IPC），本函数只做 UI 关闭编排。
 */
export function closeBrowserOverlayForSession(sessionId: string): void {
  const cur = getOverlayControlState().current
  if (cur?.kind === 'browser' && cur.payload.sessionId === sessionId) closeOverlay()
}

/** 仅测试用：复位开合态（测试隔离）。生产代码禁止调用。 */
export function _resetOverlayForTest(): void {
  overlayControl.close()
}
