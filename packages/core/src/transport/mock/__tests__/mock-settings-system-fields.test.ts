/**
 * mock settings 域 system 设置项字段 + usage 域单测 —— [C3] seam 收编配套的
 * 内存态 fixture 行为契约。
 *
 * 语义（mock/index.ts [C3] 块）：get 返回当前内存值、set 写内存后回显生效值、
 * 无持久化、无独立广播通道。断言锚「写后读回一致」（不锚模块初值——内存态
 * fixture 无跨用例 reset，初值断言会与用例执行顺序耦合）。
 *
 * 时序：setMockTiming 全键压至 1ms（照 mock-domains.test.ts 模式，ack 类 sleep
 * 不占真实墙钟），afterAll 还原默认。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { setMockTiming, resetMockTiming, settings, usage } from '../index'
import type { Timing } from '../run-send-stream'

const FAST_TIMING: Timing = {
  ack: 1, startGap: 1, chunk: 1, done: 1, switchCmd: 1, thinkingGap: 1,
  toolGap: 1, fileChangesGap: 1, retryGap: 1, bashDelay: 1,
}

setMockTiming(FAST_TIMING)
afterAll(() => {
  resetMockTiming()
})

describe('mock settings system 字段（worktree）：set 回显 + 写后读回', () => {
  it('rootDir / setupScript / bareSetupScript：字符串回显与读回', async () => {
    expect(await settings.setWorktreeRootDir('/tmp/wt-root')).toEqual({ dir: '/tmp/wt-root' })
    expect(await settings.getWorktreeRootDir()).toEqual({ dir: '/tmp/wt-root' })

    expect(await settings.setSetupScript('echo setup')).toEqual({ script: 'echo setup' })
    expect(await settings.getSetupScript()).toEqual({ script: 'echo setup' })

    expect(await settings.setBareSetupScript('echo bare')).toEqual({ script: 'echo bare' })
    expect(await settings.getBareSetupScript()).toEqual({ script: 'echo bare' })
  })

  it('timeout / defaultBaseBranch：数值与分支名回显与读回', async () => {
    expect(await settings.setWorktreeTimeout(120)).toEqual({ timeout: 120 })
    expect(await settings.getWorktreeTimeout()).toEqual({ timeout: 120 })

    expect(await settings.setDefaultBaseBranch('develop')).toEqual({ baseBranch: 'develop' })
    expect(await settings.getDefaultBaseBranch()).toEqual({ baseBranch: 'develop' })
  })
})

describe('mock settings system 字段（自动重命名）：set 回显 + 写后读回', () => {
  it('enabled / mode / model 三字段', async () => {
    expect(await settings.setAutoRenameEnabled(true)).toEqual({ enabled: true })
    expect(await settings.getAutoRenameEnabled()).toEqual({ enabled: true })

    expect(await settings.setRenameMode('first-stop')).toEqual({ mode: 'first-stop' })
    expect(await settings.getRenameMode()).toEqual({ mode: 'first-stop' })

    expect(await settings.setRenameModel('claude-sonnet-4.5')).toEqual({ model: 'claude-sonnet-4.5' })
    expect(await settings.getRenameModel()).toEqual({ model: 'claude-sonnet-4.5' })
  })
})

describe('mock settings system 字段（智能上下文）：set 回显 + 写后读回 + 拷贝隔离', () => {
  it('enabled / compactModel / thresholds / excludedModels', async () => {
    expect(await settings.setSmartContextEnabled(true)).toEqual({ enabled: true })
    expect(await settings.setSmartContextCompactModel('glm-flash')).toEqual({ model: 'glm-flash' })

    expect(await settings.setSmartContextThresholds([80, 92])).toEqual({ thresholds: [80, 92] })
    expect(await settings.setSmartContextExcludedModels(['a/b', 'c/d'])).toEqual({ models: ['a/b', 'c/d'] })

    const cfg = await settings.getSmartContextConfig()
    expect(cfg).toEqual({
      enabled: true,
      compactModel: 'glm-flash',
      reminderThresholds: [80, 92],
      excludedModels: ['a/b', 'c/d'],
    })
  })

  it('thresholds 入参拷贝隔离：外部数组后续修改不渗入 mock 内存态', async () => {
    const input = [50, 75]
    await settings.setSmartContextThresholds(input)
    input.push(999)
    expect((await settings.getSmartContextConfig()).reminderThresholds).toEqual([50, 75])
  })
})

describe('mock usage 域（[C3] getUsageStats fixture）', () => {
  it('返回 2 条日级用量行 fixture（演示链路完整），sessionCount=2、skippedLines=0', async () => {
    const r = await usage.getUsageStats()
    expect(r.rows).toHaveLength(2)
    expect(r.rows.map((x) => x.date)).toEqual(['2026-09-24', '2026-09-23'])
    expect(r.sessionCount).toBe(2)
    expect(r.skippedLines).toBe(0)
    expect(r.scannedAt).toBeGreaterThan(0)
    // 首行六项指标与 mock 常量对齐（anthropic 主模型行）
    expect(r.rows[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4.5',
      project: 'mock-project',
      input: 12_000,
      output: 3_400,
      cacheRead: 8_000,
      cacheWrite: 500,
      costUSD: 0.42,
      messages: 26,
    })
    // 次行 compaction 摘要行（聚合自压缩摘要的同形行）
    expect(r.rows[1]).toMatchObject({ provider: 'compaction', model: 'compaction' })
  })
})
