/**
 * genStats i18n 双侧对齐定向测试（composer-gen-stats）。
 *
 * 背景：locale-sync-check.test.ts（U7）用正则解析源码做全仓 key 对齐，但按审查意见补一条
 * 直连 import 的定向断言（运行时真值，非文本解析），专锁 panel context 段 genStats* key：
 * zh/en 双侧 key 集合完全一致 + 逐 key 存在且为字符串，使「en 侧零自动化保障」不再成立。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/gen-stats-i18n.test.ts
 */
import { describe, it, expect } from 'vitest'
import zhPanel from '@/i18n/locales/zh-CN/panel'
import enPanel from '@/i18n/locales/en-US/panel'

/** 运行时守卫收缩（禁裸 as / 禁 any）：locale 段必须是可索引对象 */
function asRecord(v: unknown): Record<string, unknown> {
  if (v == null || typeof v !== 'object') throw new Error('locale 段形状异常：期望对象')
  return v as Record<string, unknown>
}

/** 拍平嵌套对象为 '.' 路径集合 */
function flattenKeys(obj: Record<string, unknown>, prefix = ''): Set<string> {
  const out = new Set<string>()
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (v != null && typeof v === 'object') {
      for (const sub of flattenKeys(asRecord(v), full)) out.add(sub)
    } else {
      out.add(full)
    }
  }
  return out
}

describe('genStats i18n zh/en 双侧对齐', () => {
  it('panel context 段 zh/en 拍平 key 集合完全一致（含 genStats* 全部 key）', () => {
    const zhKeys = flattenKeys(asRecord(asRecord(zhPanel).context))
    const enKeys = flattenKeys(asRecord(asRecord(enPanel).context))
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k))
    const extraInEn = [...enKeys].filter((k) => !zhKeys.has(k))
    expect({ missingInEn, extraInEn }).toEqual({ missingInEn: [], extraInEn: [] })
  })

  it('genStats* key 逐 key 双侧存在且为字符串文案', () => {
    const zhCtx = asRecord(asRecord(zhPanel).context)
    const enCtx = asRecord(asRecord(enPanel).context)
    const genStatsKeys = Object.keys(zhCtx).filter((k) => k.startsWith('genStats'))
    // 防空转：本用例的意义在于 genStats 段确实存在（删光 key 时红）
    expect(genStatsKeys.length).toBeGreaterThan(0)
    for (const k of genStatsKeys) {
      expect(typeof zhCtx[k], `zh-CN panel.context.${k}`).toBe('string')
      expect(typeof enCtx[k], `en-US panel.context.${k}`).toBe('string')
    }
  })
})
