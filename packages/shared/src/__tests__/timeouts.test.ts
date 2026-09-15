/**
 * shared timeouts 单测（timeout-slow-flow-wallclock D2，u-y2；D3，u-y3）。
 *
 * 守护：BASH_RPC_TIMEOUT_MS 值与语义（1h 回收层有界兜底档，非任务正常路径超时）；
 * COMPACT_RPC_TIMEOUT_MS / RENDERER_RPC_MARGIN_MS 值与校准链关系
 * （renderer = runtime 第一刀 + margin，结构保证 renderer 恒不先于 runtime 判死）。
 * 值漂移会同时破坏 runtime 第一刀与 renderer backstop 的校准链。
 */
import { describe, it, expect } from 'vitest'
import { BASH_RPC_TIMEOUT_MS, COMPACT_RPC_TIMEOUT_MS, RENDERER_RPC_MARGIN_MS } from '../timeouts.js'

describe('BASH_RPC_TIMEOUT_MS（D2 composer bash RPC 独立常量）', () => {
  it('值 = 3_600_000（1 小时，对齐 worktree TIMEOUT_MAX=3600 先例）', () => {
    expect(BASH_RPC_TIMEOUT_MS).toBe(3_600_000)
  })

  it('量级为小时级（≥ 30min），与 compact 的分钟级常量（300s）无跨粒级共用', () => {
    // D2 的取值论证：bash 是任务级慢速流（合法耗时可达小时级），1h 是回收层有界兜底档。
    // 若未来调小到分钟级（<30min）即回到「!sleep 320 被误杀」的前科形态，必须重新过设计。
    expect(BASH_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(1_800_000)
  })
})

describe('COMPACT_RPC_TIMEOUT_MS / RENDERER_RPC_MARGIN_MS（D3 compact 双端对齐）', () => {
  it('值：COMPACT_RPC_TIMEOUT_MS = 1_800_000（30min）；RENDERER_RPC_MARGIN_MS = 60_000（60s）', () => {
    expect(COMPACT_RPC_TIMEOUT_MS).toBe(1_800_000)
    expect(RENDERER_RPC_MARGIN_MS).toBe(60_000)
  })

  it('校准链关系：renderer backstop = COMPACT + MARGIN > COMPACT（runtime 第一刀恒先收口）', () => {
    // D3 不变量：renderer 恒不先于 runtime 判死。renderer 超时取
    // COMPACT_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS 表达式（chat.ts 编译期同源），
    // 本断言守护「余量为正」这一前提——MARGIN ≤ 0 时表达式退化为零余量竞态前科形态。
    expect(COMPACT_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS).toBeGreaterThan(COMPACT_RPC_TIMEOUT_MS)
  })

  it('量级为分钟级（< bash 的 1h），与 BASH_RPC_TIMEOUT_MS 无跨粒级共用', () => {
    // D2/D3 联合守护：compact（LLM 压缩链）与 bash（命令执行）量级差一个数量级，
    // 若两常量相等即回到「bash 借 compact 常量」的前科形态。
    expect(COMPACT_RPC_TIMEOUT_MS).toBeLessThan(BASH_RPC_TIMEOUT_MS)
  })
})
