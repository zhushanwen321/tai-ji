// @vitest-environment node

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
import zhPanel from '@taiji/ui/locale/zh-CN/panel'
import enPanel from '@taiji/ui/locale/en-US/panel'

/** 运行时类型收窄（禁裸 as / 禁 any）：locale 段必须是可索引对象 */
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

  it('TTFT 卡 key 双侧齐（title/note；分布矩阵改造后行 label 走共用 genStatsWindow*/genStatsCol*）', () => {
    const zhCtx = asRecord(asRecord(zhPanel).context)
    const enCtx = asRecord(asRecord(enPanel).context)
    const TTFT_KEYS = ['genStatsTtftTitle', 'genStatsTtftNote'] as const
    for (const k of TTFT_KEYS) {
      expect(typeof zhCtx[k], `zh-CN panel.context.${k}`).toBe('string')
      expect(typeof enCtx[k], `en-US panel.context.${k}`).toBe('string')
    }
    // [HISTORICAL] 专属 p50 行 label（genStatsTtftDay/D7/D30）随分布矩阵退役——
    // 保留断言防「改回专属键」时静默重建双份语义文案
    for (const k of ['genStatsTtftDay', 'genStatsTtftD7', 'genStatsTtftD30'] as const) {
      expect(zhCtx[k], `zh-CN panel.context.${k} 应已退役`).toBeUndefined()
      expect(enCtx[k], `en-US panel.context.${k} 应已退役`).toBeUndefined()
    }
  })

  it('分布矩阵 key 双侧齐且非空（5 统计量列 + 3 窗口行 + P99 口径补句）', () => {
    const zhCtx = asRecord(asRecord(zhPanel).context)
    const enCtx = asRecord(asRecord(enPanel).context)
    const MATRIX_KEYS = [
      'genStatsColAvg',
      'genStatsColP50',
      'genStatsColP99',
      'genStatsColP99Note',
      'genStatsColMax',
      'genStatsColMin',
      'genStatsWindowDay',
      'genStatsWindowD7',
      'genStatsWindowD30',
    ] as const
    for (const k of MATRIX_KEYS) {
      expect(typeof zhCtx[k], `zh-CN panel.context.${k}`).toBe('string')
      expect(typeof enCtx[k], `en-US panel.context.${k}`).toBe('string')
      expect((zhCtx[k] as string).length, `zh-CN panel.context.${k} 空文案`).toBeGreaterThan(0)
      expect((enCtx[k] as string).length, `en-US panel.context.${k} 空文案`).toBeGreaterThan(0)
    }
    // 五列名互不相同（同文会让矩阵列头读不出区别）
    const zhLabels = ['genStatsColAvg', 'genStatsColP50', 'genStatsColP99', 'genStatsColMax', 'genStatsColMin']
      .map((k) => zhCtx[k])
    expect(new Set(zhLabels).size).toBe(5)
  })
})
