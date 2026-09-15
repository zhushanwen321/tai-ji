/**
 * D1 台账 auto-respawn 四态事件接线测试（crash-forensics-and-watchdog §3.3 D1，实施单元 u1d1）。
 *
 * 锁定（验收条款④）：pi-respawn 状态机四态决策点（schedule/attempt/fail/success）各有
 * 台账事件，success（event=auto-respawn, reason=succeeded）与 failed（event=
 * auto-respawn-failed, reason=retry-scheduled | breaker-tripped）可区分；事件携带
 * attempt 序号与延迟 ms（schema 无专字段，落 detailDigest 摘要）。
 *
 * 形态：直接构造 RespawnOrchestrator + 可编程 fake deps；5s 调度延迟用 fake timers
 * 推进（timer 测试红线）。真实 IO 写入 mkdtempSync 自建 tmp（fs-guard 合规），断言前
 * writer.close() 取确定性 flush 点。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/crash-journal-respawn-events.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrashJournalEvent } from '@taiji/shared'
import { RespawnOrchestrator, RESPAWN_DELAY_MS } from '../services/session/pi-respawn.js'
import { closeCrashJournal, initCrashJournal } from '../infra/crash-journal.js'

let dataDir: string

function makeOrchestrator(restoreImpl: () => Promise<unknown>) {
  return new RespawnOrchestrator({
    isActive: vi.fn(() => false),
    restore: vi.fn(restoreImpl),
    publish: vi.fn(),
  })
}

async function readJournal(): Promise<CrashJournalEvent[]> {
  await closeCrashJournal()
  const file = join(dataDir, 'logs', 'crashes', 'runtime.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as CrashJournalEvent)
}

describe('D1 台账 auto-respawn 四态事件接线（u1d1）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dataDir = mkdtempSync(join(tmpdir(), 'crash-journal-u1d1-respawn-'))
    initCrashJournal(dataDir)
  })

  afterEach(async () => {
    await closeCrashJournal().catch(() => {})
    vi.useRealTimers()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('验收④ 成功路径：schedule → attempt → succeeded 三态各有事件，reason 可区分且携带 attempt/延迟', async () => {
    const respawn = makeOrchestrator(() => Promise.resolve({}))

    respawn.schedule('sid-ok')
    await vi.advanceTimersByTimeAsync(RESPAWN_DELAY_MS)

    const events = await readJournal()
    expect(events.map((e) => `${e.event}:${e.reason ?? ''}`)).toEqual([
      'auto-respawn:scheduled',
      'auto-respawn:attempt',
      'auto-respawn:succeeded',
    ])
    expect(events[0]).toMatchObject({ layer: 'pi', sessionId: 'sid-ok' })
    expect(events[0].detailDigest).toContain(`delayMs=${RESPAWN_DELAY_MS}`)
    expect(events[0].detailDigest).toContain('attempt=1')
    expect(events[1].detailDigest).toContain('attempt=1/2')
    expect(events[2].detailDigest).toContain('attempt=1')
  })

  it('验收④ 失败路径：两次失败后熔断，failed 事件 reason 区分 retry-scheduled / breaker-tripped', async () => {
    const respawn = makeOrchestrator(() => Promise.reject(new Error('restore exploded')))

    respawn.schedule('sid-fail')
    await vi.advanceTimersByTimeAsync(RESPAWN_DELAY_MS) // 第 1 次尝试失败 → 续排重试
    await vi.advanceTimersByTimeAsync(RESPAWN_DELAY_MS) // 第 2 次尝试失败 → 熔断

    const events = await readJournal()
    expect(events.map((e) => `${e.event}:${e.reason ?? ''}`)).toEqual([
      'auto-respawn:scheduled',
      'auto-respawn:attempt',
      'auto-respawn-failed:retry-scheduled',
      'auto-respawn:attempt',
      'auto-respawn-failed:breaker-tripped',
    ])
    // 错误消息内嵌 digest（归因不依赖外部日志）
    expect(events[2].detailDigest).toContain('restore exploded')
    expect(events[4].detailDigest).toContain('willRetry=false')

    // 熔断后 schedule 是「不调度」决策：不产生新事件（守卫 early-return 不属四态）
    respawn.schedule('sid-fail')
    const eventsAfter = await readJournal()
    expect(eventsAfter).toHaveLength(events.length)
  })
})
