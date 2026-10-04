// mermaid-placeholder —— 移动壳 mermaid 占位降级（remote-use D7 图表行 / D10 分派④）。
//
// mermaid 库不进移动壳 bundle（体积），renderMermaid 桥接返回占位 svg。MarkdownRenderer
// 期望 {svg} 结构（ui MermaidRenderer v-html 受控点注入）——纯 no-op 会破图，占位呈现
// 「图表在桌面查看」。文案经 i18n 注入（壳不养文案副本）。
//
// 产出是纯静态字符串（结构固定 + label 经 XML 转义），无用户输入注入面。

/** XML 文本转义（label 是 i18n 文案，防御性转义保持注入面纯净） */
function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 生成占位 svg：虚线框 + 居中文案，宽度 100% 自适应 */
export function mermaidPlaceholderSvg(label: string): string {
  const safe = escapeXmlText(label)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 96" style="width:100%;height:auto" role="img">` +
    `<rect x="1" y="1" width="318" height="94" rx="8" fill="none" stroke="currentColor" stroke-dasharray="4 4"/>` +
    `<text x="160" y="53" text-anchor="middle" fill="currentColor" font-size="13">${safe}</text>` +
    `</svg>`
  )
}

/** renderMermaid 桥接实现（ChatViewDeps 分派④）：文案取值后包成 {svg} 结构 */
export async function renderMermaidPlaceholder(label: string): Promise<{ svg: string }> {
  return { svg: mermaidPlaceholderSvg(label) }
}
