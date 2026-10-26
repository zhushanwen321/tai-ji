import { baseCompile } from '@intlify/message-compiler'
import type { CompileError } from '@intlify/message-compiler'
import { describe, expect, it } from 'vitest'
import enUS from '@/i18n/locales/en-US'
import zhCN from '@/i18n/locales/zh-CN'

/**
 * renderer 组合 locale 的消息编译检查测试。
 *
 * 背景（2026-10-15 事故）：vue-i18n 懒编译——t(key) 首次渲染时才编译文案。文案里的
 * 裸 `{` 被当占位符起始，token 非法即抛 INVALID_TOKEN_IN_PLACEHOLDER（code 2）；裸 `@`
 * 抛 INVALID_LINKED_FORMAT（code 10）。编译发生在渲染函数内，同步 throw → 渲染树崩溃
 * （MCP 添加弹窗切「代码」tab 白屏：codeHint / codePlaceholder 含字面 JSON 花括号）。
 *
 * 本测试遍历 renderer 装配后的全量 messages（ui 域经 @taiji/ui/locale/* 传入 +
 * renderer 自有域），对每条叶子文案跑真实编译器——SSOT 聚合层另有同型检查
 * （packages/ui/src/locale/__tests__/locale.test.ts）。
 *
 * onError 必须挂「收集不抛」形态：裸调 baseCompile 不挂 onError 时解析器静默吞错，
 * 任何不挂 onError 的体检都是假绿。
 */

/** 深度遍历 messages 树，对每条叶子字符串跑真实消息编译器，收集编译错误（issue 形状就地内联，不留单一实现接口） */
function collectCompileIssues(locale: string, node: unknown, path: string) {
  const issues: { locale: string; path: string; code: number | undefined; message: string }[] = []
  if (typeof node === 'string') {
    let thrown: CompileError | null = null
    baseCompile(node, {
      location: false,
      jit: true,
      onError: (error) => {
        thrown ??= error
      },
    })
    if (thrown) issues.push({ locale, path, code: thrown.code, message: thrown.message })
    return issues
  }
  if (Array.isArray(node)) {
    node.forEach((value, index) => collectCompileIssues(locale, value, `${path}[${index}]`).forEach((issue) => issues.push(issue)))
    return issues
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      collectCompileIssues(locale, value, path ? `${path}.${key}` : key).forEach((issue) => issues.push(issue))
    }
  }
  return issues
}

describe('renderer 组合 locale 消息编译检查', () => {
  it('检查自检：已知坏样本（裸 { 与裸 @）必须被检出（防 walker 失效假绿）', () => {
    const issues = collectCompileIssues('self-check', { brace: '{ "x": 1 }', at: 'run pnpm --filter @taiji/x build' }, '')
    expect(issues.map((issue) => issue.path).sort()).toEqual(['at', 'brace'])
  })

  it.each([
    ['zh-CN', zhCN],
    ['en-US', enUS],
  ])('%s 全量叶子文案经 @intlify 消息编译器零编译错误', (locale, messages) => {
    const issues = collectCompileIssues(locale, messages, '')
    expect(issues).toEqual([])
  })
})
