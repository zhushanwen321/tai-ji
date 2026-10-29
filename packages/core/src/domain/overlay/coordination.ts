/**
 * overlay 协同层 —— 模块级公开 API（display-containers §7.1 浮层协调）。
 *
 * 单例换内容（§6.5）：openOverlay 开新内容 = 替换 current（isOpen 保持开）；
 * closeOverlay 关浮层并复位 current（§7.4 发起会话删除级联同语义）。
 *
 * 载荷校验（边界防御，契约用例覆盖）：载荷关键字段为空串/非有限值 = no-op
 * （不改开合态——无效内容不进浮层，调用方（renderer controller）已有同口径检查）。
 *
 * W2 扩展位（u-w2-browser-mount）：openBrowser(url, sessionId) 协调函数落本文件（URL 注入链）。
 * 入口语义分立（§6.4）：openWorkflow（drawer/coordination，改向开浮层）不并入本层。
 * （openWorkflowInDrawer 显式 drawer 回落语义 2026-10-19 随 drawer workflow tab 删除移除。）
 * 容器扩展点统一（§6.4/§6.8）：openOverlayContent(contentId, sessionId) 通用寻址入口
 * （内置走既有组装、插件走 plugin 载体）+ closeOverlayForSession 级联统一判据落本文件。
 */
import { overlayControl, getOverlayControlState } from './state'
import type { OverlayContent, OverlayKind } from './types'

/**
 * 内置内容类型词表（与 @taiji/shared OverlayContentKind / domain/drawer OVERLAY_REGISTRY
 * 对账——registry 单测锚定成员序一致；satisfies 保证词表漂移编译期报错）。
 * openOverlayContent 的寻址分派依据：命中 = 内置（scheduler 可组装、其余走专属入口），
 * 未命中 = 插件声明 id（§6.8 载体）。
 */
const BUILTIN_OVERLAY_KINDS = ['browser', 'workflow', 'scheduler', 'canvas'] as const satisfies readonly OverlayKind[]

/** 内置词表中 openOverlayContent 不可寻址的成员（载荷需专属参数，走专属入口）。 */
const BUILTIN_ADDRESSABLE_EXCLUDED = BUILTIN_OVERLAY_KINDS.filter((k) => k !== 'scheduler')

/** 载荷有效性判据（browser:url+sessionId 非空 / workflow:sessionId+runId 均非空 / scheduler:sessionId 非空 / canvas:canvasId+sessionId 均非空 / plugin:contentId+sessionId 均非空——§6.8 插件载体，sessionId 由宿主注入） */
function isValidContent(content: OverlayContent): boolean {
  if (content.kind === 'browser') {
    return content.payload.url.trim() !== '' && content.payload.sessionId.trim() !== ''
  }
  if (content.kind === 'scheduler') {
    return content.payload.sessionId.trim() !== ''
  }
  if (content.kind === 'canvas') {
    return content.payload.canvasId.trim() !== '' && content.payload.sessionId.trim() !== ''
  }
  if (content.kind === 'plugin') {
    return content.payload.contentId.trim() !== '' && content.payload.sessionId.trim() !== ''
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
 * 打开浮层问题解决画布 tab（problem-solve-canvas §3.1(3)：对齐 scheduler 双入口先例
 * ——同壳 tab 切换 + 独立 content kind 直达打开）。画布按归属会话隔离
 * （session-store-layout-inversion D4）：载荷带归属 sessionId（对齐 workflow/scheduler
 * 先例），消费侧 per-session 数据分区与删除级联判定的键。
 *
 * @param canvasId  画布 id（托盘列表 / 程序化直达打开的唯一寻址键）
 * @param sessionId 画布归属会话 id（创建会话）
 *
 * 已开态调用 = 单例换内容（换画布直接换载荷）；无效载荷 no-op（openOverlay 校验）。
 */
export function openCanvasOverlay(canvasId: string, sessionId: string): void {
  openOverlay({ kind: 'canvas', payload: { canvasId, sessionId } })
}

/**
 * 会话删除级联（canvas 分支，D4 隔离配套）：删除的是浮层当前 canvas 内容的归属会话
 * → 关浮层；其它会话被删不动浮层（条件式语义，对齐 browser/workflow 先例）。
 * 落点在 core coordination（与 closeBrowserOverlayForSession 同层）——renderer 侧
 * workflow-viz-overlay 的 session 删除编排直接消费本函数。
 */
export function closeCanvasOverlayForSession(sessionId: string): void {
  const cur = getOverlayControlState().current
  if (cur?.kind === 'canvas' && cur.payload.sessionId === sessionId) closeOverlay()
}

/**
 * 打开浮层内容（§6.4「请求宿主打开容器」原语的浮层落点协调函数）：contentId 全局寻址。
 *
 * - 内置内容类型词表成员：走既有 payload 组装。能凭 (contentId, sessionId) 组装完整
 *   载荷的仅 scheduler（载荷只持归属会话）；browser/workflow/canvas 的载荷需专属参数
 *   （url / runId / canvasId），各有专属入口（openBrowser / openWorkflowVizOverlay /
 *   openCanvasOverlay），不经本通道——命中时 warn + no-op（不静默）。
 * - 其余 contentId = 插件声明 id（§6.12 命名空间形态）：走 §6.8 插件载体
 *   {kind:'plugin', payload:{contentId, sessionId}}。sessionId 由宿主在执行打开时注入
 *   当前会话（插件不传，避免自报不一致），同时是会话删除级联的唯一判据；scope:'global'
 *   的内容不参与级联（豁免由导航执行器的声明校验层裁决——domain 不查注册表）。
 *
 * 已开态调用 = 单例换内容；无效载荷 no-op（openOverlay 校验）。声明存在性与可打开性
 * 校验归导航执行器（§6.4 先校验后动作）——本函数是校验通过后的写入端，不查注册表
 * （core domain 不依赖 extension-host）。
 */
export function openOverlayContent(contentId: string, sessionId: string): void {
  if (contentId === 'scheduler') {
    openSchedulerOverlay(sessionId)
    return
  }
  if ((BUILTIN_ADDRESSABLE_EXCLUDED as readonly string[]).includes(contentId)) {
    console.warn(
      `[overlay] openOverlayContent: 内置内容 '${contentId}' 的载荷需专属参数（browser:url / workflow:runId / canvas:canvasId），不经本通道打开（no-op）——改走专属入口 openBrowser / openWorkflowVizOverlay / openCanvasOverlay`,
    )
    return
  }
  openOverlay({ kind: 'plugin', payload: { contentId, sessionId } })
}

/**
 * 会话删除级联（§6.8/§11.1-2 统一判据）：删除的是浮层当前内容的归属会话 → 关浮层；
 * 其它会话被删不动浮层。判据唯一 = payload.sessionId（kind 不参与——五类内容的载荷
 * 都持归属 sessionId，插件载体 §6.8 同构），取代按 kind 分派的级联编排。per-kind
 * 级联函数（closeBrowserOverlayForSession / closeCanvasOverlayForSession）保留为专属
 * hook 的既有入口，行为收敛为本判据的 kind 收窄子集。
 */
export function closeOverlayForSession(sessionId: string): void {
  const cur = getOverlayControlState().current
  if (cur !== null && cur.payload.sessionId === sessionId) closeOverlay()
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
