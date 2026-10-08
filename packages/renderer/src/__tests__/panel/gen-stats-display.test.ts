// @vitest-environment node

/**
 * gen-stats-display 显示纯函数测试（构建者白盒，直连模块命名导出）。
 *
 * [迁移来源] 原断言在 gen-stats-triggers.test.ts（经 GenStatsTriggers SFC 普通 script 块
 * 再导出直连）——ui-optimize 决策 6 退役平铺触发器形态后组件删除，纯函数本体
 * （gen-stats-display.ts）仍被 GenStatsTtftCard（hover 指标聚合页）消费，断言迁至本文件
 * 直连模块（SFC 再导出层随之消亡）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/gen-stats-display.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  TTFT_DANGER_THRESHOLD_MS,
  TTFT_WARN_THRESHOLD_MS,
  formatTtftDuration,
  ttftTier,
} from '@/components/panel/gen-stats-display'

describe('TTFT 纯函数：formatTtftDuration / ttftTier', () => {
  it('formatTtftDuration：<1000 → 整数毫秒（0 是真实测量值显「0ms」，非无值）', () => {
    expect(formatTtftDuration(0)).toBe('0ms')
    expect(formatTtftDuration(820)).toBe('820ms')
    expect(formatTtftDuration(999)).toBe('999ms')
  })

  it('formatTtftDuration：≥1000 → s 1 位小数四舍五入去尾 0', () => {
    expect(formatTtftDuration(1000)).toBe('1s')
    expect(formatTtftDuration(1200)).toBe('1.2s')
    expect(formatTtftDuration(1250)).toBe('1.3s') // Math.round(12.5)=13 → 1.3s（四舍五入）
    expect(formatTtftDuration(1499)).toBe('1.5s')
    expect(formatTtftDuration(3000)).toBe('3s')
    expect(formatTtftDuration(3210)).toBe('3.2s')
  })

  it('ttftTier：阈值边界与 null 恒中性（S5；阈值常量与实现同源导入）', () => {
    expect(TTFT_WARN_THRESHOLD_MS).toBe(1500)
    expect(TTFT_DANGER_THRESHOLD_MS).toBe(3000)
    expect(ttftTier(null)).toBe('neutral')
    expect(ttftTier(0)).toBe('success')
    expect(ttftTier(1499)).toBe('success')
    expect(ttftTier(1500)).toBe('warn')
    expect(ttftTier(3000)).toBe('warn')
    expect(ttftTier(3001)).toBe('danger')
  })
})
