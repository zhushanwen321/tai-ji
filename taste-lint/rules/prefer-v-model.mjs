/**
 * 品味规则：@taiji/ui 组件上优先使用 v-model 而非 :value=
 *
 * PascalCase 组件（@taiji/ui 约定）若使用单向 :value= 绑定，
 * 通常应该用 v-model 实现双向绑定。
 * 由于 eslint-plugin-vue 的 processor 会将 .vue 拆分为纯 JS blocks，
 * 使用 Program:exit + 源码正则扫描。
 */
export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'Prefer v-model over :value on @taiji/ui components' },
    messages: {
      preferVModel: 'Use v-model instead of :value on @taiji/ui components',
    },
    fixable: null,
  },
  create(context) {
    const filename = context.filename || ''
    if (!filename.endsWith('.vue')) return {}

    const sourceCode = context.sourceCode || context.getSourceCode()
    const text = sourceCode.getText()

    // 只扫描 <template> 部分
    const templateMatch = text.match(/<template[^>]*>([\s\S]*?)<\/template>/)
    if (!templateMatch) return {}

    const templateContent = templateMatch[1]
    const templateOffset = templateMatch.index + templateMatch[0].indexOf('>') + 1

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

    // 逐行扫描：PascalCase 标签 + :value= 但无 v-model
    // [HISTORICAL] 排除 Item/Option 后缀子组件：reka-ui 中 SelectItem / ComboboxItem /
    // RadioGroupItem 等的 :value 是「该选项的值」语义（由父级 Root 用 v-model 收集），
    // 不是表单双向绑定。曾因未排除导致 SelectItem :value 误报，无法用 v-model 改写
    // （子组件 API 本就不支持 v-model）。
    const templateLines = templateContent.split('\n')
    const issues = []
    let cumLineOffset = 0

    for (let i = 0; i < templateLines.length; i++) {
      const line = templateLines[i]
      // 检测是否包含 PascalCase 组件标签
      const tagMatches = [...line.matchAll(/<([A-Z][A-Za-z0-9]*)/g)]
      if (tagMatches.length === 0) {
        cumLineOffset += line.length + 1 // +1 for \n
        continue
      }
      // 检测 :value= 绑定
      if (!/:value\s*=/.test(line)) {
        cumLineOffset += line.length + 1
        continue
      }
      // 如果同时有 v-model 则没问题
      if (/v-model/.test(line)) {
        cumLineOffset += line.length + 1
        continue
      }
      // 该行的 PascalCase 标签若全部是 Item/Option 子组件，:value 是选项值语义，跳过
      const allOptionItems = tagMatches.every((m) => /(?:Item|Option)$/.test(m[1]))
      if (allOptionItems) {
        cumLineOffset += line.length + 1
        continue
      }

      issues.push(templateOffset + cumLineOffset)
      cumLineOffset += line.length + 1
    }

    return {
      'Program:exit'(node) {
        for (const offset of issues) {
          const line = offsetToLine(offset)
          context.report({
            node,
            loc: { line, column: 0 },
            messageId: 'preferVModel',
          })
        }
      },
    }
  },
}
