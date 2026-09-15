/**
 * 品味规则：禁止 Vue 文件中的 emoji 字符
 *
 * 使用 SVG 图标或 lucide-vue-next 替代，保持跨平台渲染一致性。
 * 由于 eslint-plugin-vue 的 processor 会将 .vue 拆分为纯 JS blocks，
 * 使用 Program:exit + 源码字符扫描。
 */
const EMOJI_RANGES = [
  [0x1F600, 0x1F64F], [0x1F300, 0x1F5FF], [0x1F680, 0x1F6FF],
  [0x1F1E0, 0x1F1FF], [0x2600, 0x26FF], [0x2700, 0x27BF],
  [0x1F900, 0x1F9FF], [0x1FA00, 0x1FA6F], [0x1FA70, 0x1FAFF],
  [0x2705, 0x2705], [0x2714, 0x2714], [0x274C, 0x274C],
  [0x2B50, 0x2B50], [0x2764, 0x2764],
]

function isEmoji(cp) {
  return EMOJI_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)
}

export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow emoji characters in Vue files — use SVG icons or lucide-vue-next' },
    messages: {
      noEmoji: 'Use SVG icons or lucide-vue-next instead of emoji',
    },
    fixable: null,
  },
  create(context) {
    const filename = context.filename || ''
    if (!filename.endsWith('.vue')) return {}
    // design-system 和本地 ui 原语实现层豁免
    if (filename.includes('components/ui/') || filename.includes('design-system/components/')) return {}

    const sourceCode = context.sourceCode || context.getSourceCode()
    const text = sourceCode.getText()

    // 预扫描：无 emoji 则跳过
    let hasEmoji = false
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i)
      if (isEmoji(cp)) { hasEmoji = true; break }
      i += cp > 0xFFFF ? 2 : 1
    }
    if (!hasEmoji) return {}

    const lines = text.split('\n')
    const emojiLines = []
    for (let li = 0; li < lines.length; li++) {
      for (let ci = 0; ci < lines[li].length;) {
        const cp = lines[li].codePointAt(ci)
        if (isEmoji(cp)) {
          emojiLines.push(li + 1)
          break
        }
        ci += cp > 0xFFFF ? 2 : 1
      }
    }

    return {
      'Program:exit'(node) {
        for (const line of emojiLines) {
          context.report({
            node,
            loc: { line, column: 0 },
            messageId: 'noEmoji',
          })
        }
      },
    }
  },
}
