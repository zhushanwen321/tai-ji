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
 * 双侧逐域镜像）。本测试守卫两层不变量：
 * 1. 迁移域清单锚定（每侧恰好 7 域，多域/缺域即红）
 * 2. 域文件自包含（纯文案数据，零 import——域文件引入壳层依赖即红）
 *
 * zh/en 双侧 key 结构一致性由 pre-commit check_i18n_locale_sync.py 守卫
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
