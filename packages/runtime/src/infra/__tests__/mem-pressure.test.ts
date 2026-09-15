/**
 * mem-pressure 即时查询单测（crash-forensics-and-watchdog §3.3 D3/D4，实施单元 u5）。
 *
 * 覆盖（A4 验收：高水位延迟不依赖采样环，冷启动单样本即可判定）：
 * - 平台解析纯函数：/proc/meminfo（Linux）与 `sysctl vm.swapusage`（macOS）两形态；
 *   解析失败 → null（unknown ≠ 0，不伪造「无 swap」）。
 * - isMemPressureHigh 真值表：swap 占比边界（恰等 0.95 → 高压）、空闲占比边界（恰等
 *   0.01 → 高压）、swap 未知（null/0 总量）判据收窄不误判、双判据独立性。
 * - queryMemPressure 即时语义：无任何历史/状态依赖——同参数两次调用各自 fresh 判定；
 *   注入探针抛错降级 null（查询契约永不 reject）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/__tests__/mem-pressure.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEM_PRESSURE_THRESHOLDS,
  isMemPressureHigh,
  parseLinuxMemInfoSwap,
  parseMacSwapUsage,
  queryMemPressure,
  type MemPressureSample,
} from '../mem-pressure.js'

function sample(overrides: Partial<MemPressureSample> = {}): MemPressureSample {
  return {
    swapUsedMB: null,
    swapTotalMB: null,
    freeMB: 4 * 1024,
    totalMB: 16 * 1024,
    ...overrides,
  }
}

describe('parseLinuxMemInfoSwap（/proc/meminfo 形态）', () => {
  it('解析 SwapTotal/SwapFree kB 字段并换算 MB（used = total − free）', () => {
    const text = [
      'MemTotal:       16384000 kB',
      'MemFree:          102400 kB',
      'SwapTotal:       2097152 kB',
      'SwapFree:         524288 kB',
      'HugePages_Total:       0',
    ].join('\n')
    expect(parseLinuxMemInfoSwap(text)).toEqual({ swapUsedMB: 1536, swapTotalMB: 2048 })
  })

  it.each([
    ['字段缺失', 'MemTotal: 100 kB'],
    ['空文本', ''],
  ])('%s → null（unknown ≠ 0）', (_label, text) => {
    expect(parseLinuxMemInfoSwap(text)).toBeNull()
  })
})

describe('parseMacSwapUsage（sysctl vm.swapusage 形态）', () => {
  it('解析 total/used M 字段', () => {
    expect(parseMacSwapUsage('total: 2048.00M used: 512.00M free: 1536.00M (encrypted)'))
      .toEqual({ swapUsedMB: 512, swapTotalMB: 2048 })
  })

  it.each([
    ['缺 used 字段', 'total: 2048.00M free: 1536.00M'],
    ['非 swap 输出', 'vm.swapusage: unable to'],
    ['空文本', ''],
  ])('%s → null', (_label, text) => {
    expect(parseMacSwapUsage(text)).toBeNull()
  })
})

describe('isMemPressureHigh 真值表（无历史依赖，单样本判定 = A4 语义）', () => {
  it('swap 占比恰等阈值（0.95）→ 高压；低一分 → 不高压', () => {
    expect(isMemPressureHigh(sample({ swapUsedMB: 950, swapTotalMB: 1000 }))).toBe(true)
    expect(isMemPressureHigh(sample({ swapUsedMB: 949, swapTotalMB: 1000 }))).toBe(false)
  })

  it('空闲占比恰等下限（0.01）→ 高压；高一分 → 不高压', () => {
    expect(isMemPressureHigh(sample({ freeMB: 160, totalMB: 16_000 }))).toBe(true)
    expect(isMemPressureHigh(sample({ freeMB: 161, totalMB: 16_000 }))).toBe(false)
  })

  it('swap 未知（null）时判据收窄，物理空闲判据仍在（不因 unknown 误判或漏判空闲）', () => {
    // swap null + 空闲充足 → 不高压（swap 判据跳过，空闲判据不命中）
    expect(isMemPressureHigh(sample())).toBe(false)
    // swap null + 空闲触底 → 高压（swap unknown 不拖累另一判据）
    expect(isMemPressureHigh(sample({ freeMB: 1, totalMB: 16_000 }))).toBe(true)
  })

  it('swap 总量为 0 / null（无 swap 配置形态）不参与占比判定，不伪造命中', () => {
    expect(isMemPressureHigh(sample({ swapUsedMB: 0, swapTotalMB: 0 }))).toBe(false)
    expect(isMemPressureHigh(sample({ swapUsedMB: 100, swapTotalMB: null }))).toBe(false)
    // swap 用量未知（null）但总量已知 → swap 判据跳过
    expect(isMemPressureHigh(sample({ swapUsedMB: null, swapTotalMB: 1000 }))).toBe(false)
  })

  it('双判据独立：swap 命中即使空闲充足也高压（swap 是溢出信号）', () => {
    expect(isMemPressureHigh(sample({ swapUsedMB: 990, swapTotalMB: 1000, freeMB: 8 * 1024 }))).toBe(true)
  })

  it('阈值注入可覆盖默认（Gate W 校准入口）', () => {
    const s = sample({ swapUsedMB: 900, swapTotalMB: 1000 })
    expect(isMemPressureHigh(s)).toBe(false)
    expect(isMemPressureHigh(s, { ...DEFAULT_MEM_PRESSURE_THRESHOLDS, swapUsedRatio: 0.9 })).toBe(true)
  })
})

describe('queryMemPressure（即时查询契约）', () => {
  it('物理字段来自 os 当前值，swap 字段来自探针（即时，无任何历史状态）', async () => {
    const first = await queryMemPressure({ probeSwap: async () => ({ swapUsedMB: 10, swapTotalMB: 100 }) })
    const second = await queryMemPressure({ probeSwap: async () => ({ swapUsedMB: 20, swapTotalMB: 100 }) })
    expect(first.totalMB).toBeGreaterThan(0)
    expect(first.freeMB).toBeGreaterThanOrEqual(0)
    expect(first.swapUsedMB).toBe(10)
    // 第二次调用 swap 立即反映新探针值——零缓存零采样环，冷启动单次调用即可判定
    expect(second.swapUsedMB).toBe(20)
  })

  it('探针抛错 → swap 字段降级 null，查询不 reject（best-effort 契约）', async () => {
    const s = await queryMemPressure({ probeSwap: async () => { throw new Error('probe boom') } })
    expect(s.swapUsedMB).toBeNull()
    expect(s.swapTotalMB).toBeNull()
    expect(s.totalMB).toBeGreaterThan(0)
  })

  it('真实平台冒烟：默认探针可执行且返回合法样本（平台差异收敛在 probeSwapPressure 内）', async () => {
    const s = await queryMemPressure()
    expect(s.totalMB).toBeGreaterThan(0)
    expect(s.freeMB).toBeGreaterThanOrEqual(0)
    if (s.swapTotalMB !== null) {
      expect(s.swapTotalMB).toBeGreaterThanOrEqual(0)
      expect(s.swapUsedMB ?? 0).toBeLessThanOrEqual(s.swapTotalMB)
    }
  })
})
