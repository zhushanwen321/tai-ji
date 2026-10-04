import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import zhCNAggregate from '../zh-CN'
import enUSAggregate from '../en-US'
import { enUS, zhCN } from '../index'

/**
 * ui locale 模块结构测试。
 *
 * 域文件级下沉规则：被 ui 组件消费任何 key 的 i18n 域文件整体迁入本模块（zh/en
 * 双侧逐域镜像）。本测试守卫三层不变量：
 * 1. 迁移域清单锚定（每侧恰好 7 域，多域/缺域即红）
 * 2. 每域 zh-CN 与 en-US 深度 key 结构完全一致（拍平路径集合逐域相等）
 * 3. 域文件自包含（纯文案数据，零 import——域文件引入壳层依赖即红）
 */

const EXPECTED_DOMAINS = ['common', 'composable', 'extensionUI', 'newTask', 'panel', 'search', 'settings'] as const

/** 拍平嵌套文案树为完整 key 路径集合（数组值视为叶子） */
function flattenKeyPaths(obj: unknown, prefix = ''): string[] {
  const paths: string[] = []
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...flattenKeyPaths(value, full))
    } else {
      paths.push(full)
    }
  }
  return paths.sort()
}

describe('ui locale 聚合形态', () => {
  it('index.ts 具名导出 zhCN / enUS 双侧聚合', () => {
    expect(zhCN).toBeDefined()
    expect(enUS).toBeDefined()
  })

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

describe('迁移域 zh-CN / en-US 深度 key 结构一致', () => {
  it.each(EXPECTED_DOMAINS)('%s 域双侧 key 路径集合完全相等', (domain) => {
    const zhModule = zhCNAggregate[domain]
    const enModule = enUSAggregate[domain]
    expect(zhModule).toBeDefined()
    expect(enModule).toBeDefined()
    const zhKeys = flattenKeyPaths(zhModule)
    const enKeys = flattenKeyPaths(enModule)
    expect(zhKeys.length).toBeGreaterThan(0)
    expect(enKeys).toEqual(zhKeys)
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
