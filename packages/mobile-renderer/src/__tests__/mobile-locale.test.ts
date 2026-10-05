// 移动壳自有 locale 双侧结构守卫（mobile 命名空间 key 双侧镜像）。
//
// 背景：壳自有新增 key（tab/列表/表单等壳 chrome 文案）不在 check_i18n_locale_sync
// 的两根扫描范围（renderer 壳 + ui locale 模块）内——本测试是该域的机器守卫，
// 防 zh-CN/en-US 漂移（下沉域 key 由 sync 守卫 + ui locale 结构测试双层覆盖，不在此重复）。
import { describe, expect, it } from 'vitest'
import zhCN from '../locales/zh-CN'
import enUS from '../locales/en-US'

/** 拍平嵌套文案树为完整 key 路径集合 */
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

describe('mobile 壳自有 locale 双侧结构一致', () => {
  it('zh-CN 与 en-US key 路径集合完全相等（无缺 key 无多 key）', () => {
    const zhKeys = flattenKeyPaths(zhCN)
    const enKeys = flattenKeyPaths(enUS)
    expect(zhKeys.length).toBeGreaterThan(0)
    expect(enKeys).toEqual(zhKeys)
  })

  it('顶层命名空间为 mobile（壳自有 key 与下沉域不混居）', () => {
    expect(Object.keys(zhCN)).toEqual(['mobile'])
    expect(Object.keys(enUS)).toEqual(['mobile'])
  })
})
