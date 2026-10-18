import { baseCompile } from '@intlify/message-compiler'
import type { CompileError } from '@intlify/message-compiler'
import { describe, expect, it } from 'vitest'
import { enUS, zhCN } from '../index'

/**
 * locale 消息编译检查测试。
 *
 * 背景（2026-10-15 事故）：vue-i18n 懒编译——t(key) 首次渲染时才编译文案。文案里的
 * 裸 `{` 会被当占位符起始，后续 token 非法即抛 INVALID_TOKEN_IN_PLACEHOLDER（code 2）；
 * 裸 `@` 抛 INVALID_LINKED_FORMAT（code 10）。编译发生在渲染函数内，同步 throw →
 * 渲染树崩溃（MCP 添加弹窗切「代码」tab 即白屏：codeHint / codePlaceholder 含
 * 字面 JSON 花括号）。这类错误只在「该 key 首次被渲染」时爆，用例级黑盒很难覆盖全，
 * 故对全量叶子文案做真实编译器扫描。
 *
 * 实现要点：
 * - 直接 import 真实聚合对象编译，不扫源码字符串（正则提取 TS 字面量不可靠，且会漏
 *   运行时拼装形态）
 * - onError 用「收集不抛」形态：裸调 baseCompile 不挂 onError 时解析器静默吞错
 *   （返回的 ast 无 errors 字段），任何不挂 onError 的体检都是假绿——运行时真实路径
 *   （compile 包装）正是靠默认 onError 兜底才 throw 的
 * - 字面花括号 / @ 的合法转义写法：{'{'} / {'}'} / {'@'}（vue-i18n literal interpolation）
 */

/** 深度遍历 messages 树，对每条叶子字符串跑真实消息编译器，收集编译错误（issue 形状就地内联，不留单一实现接口） */
function collectCompileIssues(locale: string, node: unknown, path: string) {
  const issues: { locale: string; path: string; code: number | undefined; message: string }[] = []
  if (typeof node === 'string') {
    // 回调内赋值的变量 TS 无法跟踪（收窄成 never），改用数组承载首个错误
    const errors: CompileError[] = []
    baseCompile(node, {
      location: false,
      jit: true,
      onError: (error) => {
        if (errors.length === 0) errors.push(error)
      },
    })
    if (errors.length > 0) {
      issues.push({ locale, path, code: errors[0].code, message: errors[0].message })
    }
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

describe('locale 消息编译检查', () => {
  it('检查自检：已知坏样本（裸 { 与裸 @）必须被检出（防 walker 失效假绿）', () => {
    const issues = collectCompileIssues('self-check', { brace: '{ "x": 1 }', at: 'run pnpm --filter @taiji/x build' }, '')
    expect(issues.map((issue) => issue.path).sort()).toEqual(['at', 'brace'])
  })

  it.each([
    ['zh-CN', zhCN],
    ['en-US', enUS],
  ])('%s 全量叶子文案经 @intlify 消息编译器零编译错误', (locale, aggregate) => {
    const issues = collectCompileIssues(locale, aggregate, '')
    expect(issues).toEqual([])
  })
})
