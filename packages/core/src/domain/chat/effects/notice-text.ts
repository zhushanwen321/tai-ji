/**
 * core 提示行文案的 i18n 键注入槽（chat-flow-consistency 缺陷 3/缺陷 7）。
 *
 * 背景：core 包 i18n 未落地（registry.ts 头部 [TODO @i18n-migration] 登记），停止提示行
 * 与截断提示行的文案不得在 core 硬编码单一语言（design-turn-statemachine 缺陷 8 裁决：
 * 禁止在「英文硬编码」与「i18n 体系」之外引入第三种形态）。落地形态 = 「键注入」：
 * core 持有键名与查表出口，renderer 装配层（useMessageEffects 模块顶层，i18n 就绪后）
 * 经 configureChatNoticeText 注入翻译函数；词条落 @taiji/ui locale（panel.chatNotice.*，
 * zh/en 双侧）。
 *
 * 注入时序：renderer 入口模块加载期注入，恒先于任何 WS 消息到达；未注入（纯 core 单测
 * /移动壳未接线）时回退键名原文——可发现性优先于静默错文案（渲染出键名 = 缺注入的显式
 * 信号，好过回退单一语言掩盖）。userStoppedGate.configure 是 core 模块级 configure 先例。
 */

/** 提示行文案键（locale 词条 = panel.chatNotice.<key>）。 */
export type ChatNoticeKey =
  /** dispatching 窗口点停止、无实体可收尾（缺陷 3） */
  | 'stoppedBeforeStart'
  /** 回复达到长度上限被截断（缺陷 7，stopReason=max_tokens） */
  | 'truncatedMaxTokens'
  /** 回复因内容过滤被终止（缺陷 7，stopReason=content_filter） */

  | 'truncatedContentFilter'

/** 截断提示的 stopReason 白名单（缺陷 7：正常业务终止 end_turn/tool_use 不含，零行为变化）。 */
export const TRUNCATED_STOP_REASONS: ReadonlySet<string> = new Set(['max_tokens', 'content_filter'])

type Translator = (key: ChatNoticeKey) => string

let translator: Translator | undefined

/** renderer 装配层注入翻译函数（模块加载期一次性；重复注入后者覆盖，幂等无害）。 */
export function configureChatNoticeText(next: Translator): void {
  translator = next
}

/** 取提示行文案（未注入时回退键名原文——见文件头「注入时序」）。 */
export function chatNoticeText(key: ChatNoticeKey): string {
  return translator ? translator(key) : `panel.message.chatNotice.${key}`
}

/** 测试复位（vitest 隔离；生产路径不调）。 */
export function resetChatNoticeTextForTest(): void {
  translator = undefined
}
