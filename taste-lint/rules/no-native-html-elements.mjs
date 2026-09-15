/**
 * 品味规则：禁止 Vue 模板中的原生 HTML 表单元素
 *
 * @taiji/ui / 本地 ui 原语提供了统一的组件替代原生元素，保持视觉一致性。
 * 跳过 components/ui/ 目录（本地 ui 原语实现层需要使用原生元素）。
 *
 * 由于 eslint-plugin-vue 的 processor 会将 .vue 拆分为纯 JS blocks，
 * Vue AST 节点（VElement 等）在 lint 阶段不可用。
 * 因此使用 Program:exit + 源码正则扫描。
 */
const BANNED_ELEMENTS = {
  button: 'Button',
  select: 'Select',
  textarea: 'Textarea',
  dialog: 'Dialog',
  table: 'Table',
}

export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow native HTML form elements in Vue templates — use @taiji/ui components' },
    messages: {
      noNativeElement: 'Use @taiji/ui <{{replacement}} /> instead of native <{{element}}>',
    },
    fixable: null,
  },
  create(context) {
    const filename = context.filename || ''
    if (!filename.endsWith('.vue')) return {}
    // 本地 ui 原语实现层允许使用原生元素
    if (filename.includes('components/ui/') || filename.includes('design-system/components/')) return {}

    const sourceCode = context.sourceCode || context.getSourceCode()
    const text = sourceCode.getText()

    // 只扫描 <template> 部分
    const templateMatch = text.match(/<template[^>]*>([\s\S]*?)<\/template>/)
    if (!templateMatch) return {}

    const templateContent = templateMatch[1]
    // 计算 template 内容在源文件中的偏移量
    const templateOffset = templateMatch.index + templateMatch[0].indexOf('>') + 1

    // 收集行号映射（偏移量 -> 行号）
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

    const issues = []

    // 检测原生 HTML 元素（小写标签名），跳过 PascalCase Vue 组件
    for (const [element, replacement] of Object.entries(BANNED_ELEMENTS)) {
      // 不用 i 标志，只匹配小写（原生元素），PascalCase（如 <Button>）不会匹配
      const re = new RegExp(`<(${element})(?![a-z])`, 'g')
      let m
      while ((m = re.exec(templateContent)) !== null) {
        issues.push({ element, replacement, offset: templateOffset + m.index })
      }
    }

    // 检测小写 <input>，跳过 checkbox/radio
    const inputRe = /<input\s[^>]*type\s*=\s*["']([^"']+)["'][^>]*\/?\/?>/g
    let m
    while ((m = inputRe.exec(templateContent)) !== null) {
      if (m[1] === 'checkbox' || m[1] === 'radio') continue
      issues.push({ element: 'input', replacement: 'Input', offset: templateOffset + m.index })
    }
    // 没有 type 属性的裸 <input> 也应标记
    const bareInputRe = /<input(?=\s|\/|>)(?![^>]*type\s*=)/g
    while ((m = bareInputRe.exec(templateContent)) !== null) {
      issues.push({ element: 'input', replacement: 'Input', offset: templateOffset + m.index })
    }

    return {
      // 使用 Program:exit 确保 sourceCode 可用
      'Program:exit'(node) {
        for (const issue of issues) {
          // 找到最接近的 AST 节点用于报告
          const line = offsetToLine(issue.offset)
          const column = issue.offset - lineStarts[line - 1]
          context.report({
            node,
            loc: { line, column },
            messageId: 'noNativeElement',
            data: { element: issue.element, replacement: issue.replacement },
          })
        }
      },
    }
  },
}
