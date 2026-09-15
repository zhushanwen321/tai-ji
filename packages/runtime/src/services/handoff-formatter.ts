/**
 * handoff 文档 XML 包装器（fast-handoff runtime 层纯函数）。
 *
 * runtime 拿到 agent 产出的自由格式文档字符串后，用 xml tag 包装边界 +
 * 追加 action-oriented 指令，注入新 session 作首条消息。包装是 runtime 加的
 * （非 agent 产出），保证文档可识别 + 驱动新 agent 立即干活——agent 产出的
 * 文档只描述"交接了什么"，runtime 在尾部追加"立即执行下一项"的指令把文档
 * 从被动信息载体变成主动 task driver。
 *
 * 纯函数无副作用、无依赖，便于单测（vitest 直接断言输出字符串）。
 */

/**
 * 转义 xml 属性值：& " < >（含换行的 session label 会破坏 xml 属性引号边界，必须转义）。
 * 单引号不需转义（属性用双引号包裹）。顺序敏感：& 必须先转义（否则后续转义产生的 &quot; 等会被二次转义）。
 *
 * SUGGESTION 2：注释原声称处理换行但实现未转义 \n / \r——补全（\n → &#10;，\r → &#13;）。
 * 换行在 xml 属性值中会破坏属性引号边界（属性值应单行），且 parser 规范化属性时
 * CR/CRLF/LF → LF，导致 round-trip 不可逆。转义后属性值单行无歧义。
 */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
}

/**
 * 包装 handoff 文档为 xml tag + action-oriented 后缀。
 *
 * @param doc agent 产出的自由格式 markdown 文档（非空，由调用方保证）
 * @param source 源 session label（展示用，作为 xml 属性值）
 * @param filePath 文档落盘路径（可选，对话流路径时通常 undefined）
 * @returns 完整的注入字符串
 */
export function wrapWithXmlTag(doc: string, source: string, filePath?: string): string {
  const created = new Date().toISOString()
  // m3：source 经 escapeXmlAttr 转义，防含 " / 换行 / < > 的 session label 破坏 xml 属性边界。
  const fileAttr = filePath ? ` file="${escapeXmlAttr(filePath)}"` : ''
  return `<handoff_document source="${escapeXmlAttr(source)}" created="${created}"${fileAttr}>
${doc}
</handoff_document>

Immediately execute the next incomplete item in the document. If you encounter a blocker or blocked item, stop and ask me. After completing each step, proceed to the next one.`
}
