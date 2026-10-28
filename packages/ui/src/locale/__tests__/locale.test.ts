/**
 * locale 模块合并测试产物（round5-g ui idx9）。
 *
 * 来源节（每来源文件包以基名命名的 describe）：
 *   locale-message-compile / locale-structure
 *
 * 同被测单元 = src/locale 聚合模块族（index.ts 双侧聚合 + zh-CN/en-US 域文件不变量）。
 * 零 vi.mock；compile 节用 @intlify 真实编译器扫描，structure 节做结构/自包含静态断言。
 *
 * 运行：cd packages/ui && npx vitest run src/locale/__tests__/locale.test.ts
 */
import { baseCompile } from '@intlify/message-compiler'
import type { CompileError } from '@intlify/message-compiler'
import { describe, expect, it } from 'vitest'
import { enUS, zhCN } from '../index'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import zhCNAggregate from '../zh-CN'
import enUSAggregate from '../en-US'

/**
 * locale 模块合并测试产物（round5-g ui idx9）。
 *
 * 来源节（每来源文件包以基名命名的 describe）：
 *   locale-message-compile / locale-structure
 *
 * 同被测单元 = src/locale 聚合模块族（index.ts 双侧聚合 + zh-CN/en-US 域文件不变量）。
 * 零 vi.mock；compile 节用 @intlify 真实编译器扫描，structure 节做结构/自包含静态断言。
 *
 * 运行：cd packages/ui && npx vitest run src/locale/__tests__/locale.test.ts
 */

describe('locale-message-compile', () => {
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

})

describe('locale-structure', () => {
/**
 * ui locale 模块结构测试。
 *
 * 域文件级下沉规则：被 ui 组件消费任何 key 的 i18n 域文件整体迁入本模块（zh/en
 * 双侧逐域镜像）。本测试检查两层不变量：
 * 1. 迁移域清单锚定（每侧恰好 7 域，多域/缺域即红）
 * 2. 域文件自包含（纯文案数据，零 import——域文件引入壳层依赖即红）
 *
 * zh/en 双侧 key 结构一致性由 pre-commit check_i18n_locale_sync.py 检查
 * （拍平 key 完整路径集合比对，glob 覆盖 renderer 与 ui 两组 locale 根目录）。
 */

const EXPECTED_DOMAINS = ['common', 'composable', 'extensionUI', 'newTask', 'panel', 'search', 'settings'] as const

describe('ui locale 聚合形态', () => {
  it.each([
    ['zh-CN', zhCNAggregate],
    ['en-US', enUSAggregate],
  ])('%s 单侧聚合恰好含迁移域全集，无多域无缺域', (_locale, aggregate) => {
    expect(Object.keys(aggregate).sort()).toEqual([...EXPECTED_DOMAINS].sort())
  })

  it('index 双侧导出与单侧聚合文件同一对象形态', () => {
    expect(zhCN).toEqual(zhCNAggregate)
    expect(enUS).toEqual(enUSAggregate)
  })
})

describe('域文件自包含（纯文案数据）', () => {
  it.each(EXPECTED_DOMAINS)('%s 域 zh/en 双侧文件零 import', (domain) => {
    for (const side of ['zh-CN', 'en-US'] as const) {
      const source = readFileSync(resolve(__dirname, `../${side}/${domain}.ts`), 'utf8')
      // 断言模块级 import 语句（行首）而非单词——英文文案值可合法含 "import" 字样
      expect(source).not.toMatch(/^import\s/m)
      expect(source).toMatch(/export default/)
    }
  })
})

})
