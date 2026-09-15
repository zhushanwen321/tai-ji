/**
 * 品味规则：禁止消费方用 h-* / w-* / size-* 尺寸类覆盖 <Switch> 轨道几何
 *
 * Switch 的几何是绝对 px 三件套（track h-[20px] w-[36px] / thumb size-[16px] /
 * translate-x-[18px|2px]，v6 spec §6.4），三者互相咬合：thumb 直径 = track 高 - 2×2px
 * 边距，checked 位移 = track 宽 - thumb - 2px。消费方用 h-* / w-* / size-* 覆盖轨道尺寸时
 * track 缩小而 thumb/位移不变 → 圆点垂直溢出 + checked 右沿冲出轨道（真实事故：trace
 * toolbar `class="h-3.5 w-6 scale-90"`，rem 在 html font-size=13.3px 下缩到 ~20×11.6px，
 * 16px thumb 直接刺出）。要小尺寸只能等比 scale-*（transform 连内部几何一起视觉缩放）。
 *
 * 范围：所有 .vue 模板中 PascalCase <Switch> 开标签（含跨行标签）；豁免
 * components/ui/（原语内部实现）与 design-system/components/。
 * 已知盲区（登记不追溯）：:class 绑定的运行时拼接字符串无法静态判定——规则只扫开标签
 * 文本内的静态 class 与字面量；动态拼接覆盖属罕见形态，出现时靠本注释 + Switch.vue
 * [HISTORICAL] 注释人工拦截。
 * false positive 抑制：负向后行 (?<![\w-]) 排除 min-w-* / max-h-* 等（不改变 track 几何，
 * 合法）；scale-* / shrink-0 / 定位类不含 h- / w- / size- token 天然放行。
 * 扩展位：Checkbox 若出现同源事故（内部 rem 图标 vs 消费方覆盖盒尺寸）可在此规则加
 * 标签名；当前无事故不扩。
 *
 * 实现：eslint-plugin-vue processor 把 .vue 拆成 JS blocks，Vue AST 不可用，
 * 与 no-native-html-elements 同款 Program:exit + 正则扫描。
 */
const SWITCH_TAG_RE = /<Switch(?![\w-])[^>]*>/g
// h-3.5 / w-6 / size-4 / h-[20px] / w-full —— 前置负向后行排除 min-w-*/max-h-*
const SIZE_UTILITY_RE = /(?<![\w-])(?:h|w|size)-[^\s"'=/>]+/g

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow h-*/w-*/size-* track size overrides on <Switch> — breaks absolute-px thumb geometry; use scale-* instead',
    },
    messages: {
      sizeOverride:
        '禁止用 {{token}} 覆盖 Switch 轨道尺寸：thumb(16px)/translate(18px) 是绝对 px 不随 track 缩放，圆点会溢出轨道；要小尺寸请用等比 scale-*（如 scale-75）',
    },
    fixable: null,
  },
  create(context) {
    const filename = context.filename || ''
    if (!filename.endsWith('.vue')) return {}
    // 原语内部实现允许自定几何
    if (filename.includes('components/ui/') || filename.includes('design-system/components/')) return {}

    const sourceCode = context.sourceCode || context.getSourceCode()
    const text = sourceCode.getText()

    // 模板提取：首 <template 到末 </template（贪婪）——SFC 恰有一个根模板块，嵌套
    // <template v-if/v-else> 在其内部；曾用非贪婪 match 截在第一个嵌套闭合 → 嵌套点
    // 之后的 Switch 全部漏扫（TraceToolbar 事故验证过这个坑，勿改回）。代价：script 内
    // 字符串若真含 '</template>' 会多扫一段，属罕见且只影响扫描范围不影响判定语义。
    const openMatch = text.match(/<template[^>]*>/)
    const closeIndex = text.lastIndexOf('</template>')
    if (!openMatch || closeIndex < 0) return {}
    const templateContent = text.slice(openMatch.index + openMatch[0].length, closeIndex)

    // 行号映射（offset → 行号）
    const lines = text.split('\n')
    const lineStarts = [0]
    for (const line of lines) {
      lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1)
    }
    function offsetToLine(offset) {
      for (let i = lineStarts.length - 1; i >= 0; i--) {
        if (lineStarts[i] <= offset) return i + 1
      }
      return 1
    }

    return {
      // Program:exit 确保 sourceCode 可用（no-native-html-elements 同款收尾）
      'Program:exit'(node) {
        const seen = new Set()
        for (const tagMatch of templateContent.matchAll(SWITCH_TAG_RE)) {
          for (const tokenMatch of tagMatch[0].matchAll(SIZE_UTILITY_RE)) {
            const token = tokenMatch[0]
            if (seen.has(token)) continue
            seen.add(token)
            const absOffset = openMatch.index + openMatch[0].length + tagMatch.index + tokenMatch.index
            context.report({
              node,
              loc: { line: offsetToLine(absOffset), column: absOffset - lineStarts[offsetToLine(absOffset) - 1] },
              messageId: 'sizeOverride',
              data: { token },
            })
          }
        }
      },
    }
  },
}
