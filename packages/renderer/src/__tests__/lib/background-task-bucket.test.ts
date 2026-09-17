/**
 * background-task-bucket 单测 —— 分桶 / 筛选 / 计数 / statusIcon SSOT
 *（u-renderer-store 验收条款：分桶判据谓词复用 isActive/isTerminal；statusIcon 判定顺序
 * killed null 优先 dim / exitCode!==0 吸 null → danger / orphaned→info，D10①⑤）。
 *
 * 「谓词复用」的可测口径：四 state 全枚举的 bucket 结果与契约谓词
 * isActiveBackgroundTaskState / isTerminalBackgroundTaskState 逐一对账（实现若改为
 * 本地重写枚举判定，对账仍绿但 filter/count 的同源一致性断言会锁死两处不可漂移；
 * 谓词身份由行为等价 + 全枚举覆盖锁定）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/lib/background-task-bucket.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  isActiveBackgroundTaskState,
  isTerminalBackgroundTaskState,
} from '@zhushanwen/extension-protocol'
import {
  backgroundTaskBucket,
  filterBackgroundTasks,
  backgroundTaskStatusIcon,
  type BackgroundTaskEntry,
} from '@/lib/background-task-bucket'

/** 构造 registry 条目（协议镜像形状；未给出的字段取合法默认）。 */
function entry(overrides: Partial<BackgroundTaskEntry> & { state: BackgroundTaskEntry['state'] }): BackgroundTaskEntry {
  return {
    taskId: 'bt-test-a1b2c3',
    pid: 53241,
    command: 'pnpm test',
    outputFile: '/tmp/bt.log',
    startedAt: 1_000,
    ownerPiPid: 100,
    sessionId: 'sess-x',
    ...overrides,
  }
}

const RUNNING = entry({ state: 'running' })
const KILLING = entry({ state: 'killing' })
const EXITED_OK = entry({ state: 'exited', exitCode: 0, reason: 'natural', endedAt: 5_000, durationMs: 4_000 })
const EXITED_FAIL = entry({ state: 'exited', exitCode: 1, reason: 'natural', endedAt: 6_000, durationMs: 5_000 })
const EXITED_KILLED = entry({ state: 'exited', exitCode: null, reason: 'killed', endedAt: 7_000, durationMs: 6_000 })
const EXITED_TIMEOUT = entry({ state: 'exited', exitCode: null, reason: 'timeout', endedAt: 8_000, durationMs: 7_000 })
const ORPHANED = entry({ state: 'orphaned', endedAt: 9_000 })

describe('backgroundTaskBucket 分桶判据（谓词复用 isActive/isTerminal）', () => {
  it('四 state 全枚举：bucket 结果与契约谓词逐一对账', () => {
    const states: BackgroundTaskEntry['state'][] = ['running', 'killing', 'exited', 'orphaned']
    for (const state of states) {
      const e = entry({ state })
      const active = backgroundTaskBucket(e) === 'active'
      // 对账契约谓词：active 桶 ⇔ isActiveBackgroundTaskState；ended 桶 ⇔ isTerminal
      expect(active).toBe(isActiveBackgroundTaskState(e.state))
      expect(!active).toBe(isTerminalBackgroundTaskState(e.state))
    }
  })

  it('运行中桶 = running + killing（killing 是活跃瞬态，不落入已结束）', () => {
    expect(backgroundTaskBucket(RUNNING)).toBe('active')
    expect(backgroundTaskBucket(KILLING)).toBe('active')
  })

  it('已结束桶 = exited（含 killed/timeout）+ orphaned', () => {
    expect(backgroundTaskBucket(EXITED_OK)).toBe('ended')
    expect(backgroundTaskBucket(EXITED_KILLED)).toBe('ended')
    expect(backgroundTaskBucket(EXITED_TIMEOUT)).toBe('ended')
    expect(backgroundTaskBucket(ORPHANED)).toBe('ended')
  })
})

describe('filterBackgroundTasks 过滤与排序（S1 验收口径同源）', () => {
  // 乱序输入：ended 按 endedAt 倒序应翻转；active 按 startedAt 升序
  const tasks = [EXITED_TIMEOUT, RUNNING, EXITED_OK, KILLING, ORPHANED, EXITED_FAIL, EXITED_KILLED]

  it("filter='active' 只留运行中（含 killing），startedAt 升序", () => {
    const out = filterBackgroundTasks(tasks, 'active')
    expect(out.map((t) => t.taskId)).toEqual([RUNNING.taskId, KILLING.taskId])
  })

  it("filter='ended' 只留终态（exited+orphaned），endedAt 倒序（最近结束在前）", () => {
    const out = filterBackgroundTasks(tasks, 'ended')
    expect(out.map((t) => t.state)).toEqual(['orphaned', 'exited', 'exited', 'exited', 'exited'])
    const endedAts = out.map((t) => t.endedAt as number)
    expect([...endedAts].sort((a, b) => b - a)).toEqual(endedAts)
  })

  it("filter='all' 运行中置顶（startedAt 升序）+ 已结束段倒序——全量保持分组有序", () => {
    const out = filterBackgroundTasks(tasks, 'all')
    expect(out).toHaveLength(tasks.length)
    expect(out.map((t) => backgroundTaskBucket(t))).toEqual([
      'active', 'active',
      'ended', 'ended', 'ended', 'ended', 'ended',
    ])
    const firstEndedIdx = out.findIndex((t) => backgroundTaskBucket(t) === 'ended')
    const activeSegment = out.slice(0, firstEndedIdx)
    const endedSegment = out.slice(firstEndedIdx)
    expect(activeSegment.map((t) => t.startedAt)).toEqual(
      [...activeSegment].map((t) => t.startedAt).sort((a, b) => a - b),
    )
    const endedAts = endedSegment.map((t) => t.endedAt as number)
    expect([...endedAts].sort((a, b) => b - a)).toEqual(endedAts)
  })

  it('空列表三值过滤均返回空数组', () => {
    for (const f of ['active', 'ended', 'all'] as const) {
      expect(filterBackgroundTasks([], f)).toEqual([])
    }
  })
})

describe('backgroundTaskStatusIcon 判定顺序（D10⑤，顺序即语义）', () => {
  it('state 先分流：running → accent 旋转环；killing → warn 点；orphaned → info 点', () => {
    expect(backgroundTaskStatusIcon(RUNNING)).toEqual({
      shape: 'spinner', tone: 'accent', statusKey: 'running',
    })
    expect(backgroundTaskStatusIcon(KILLING)).toEqual({
      shape: 'dot', tone: 'warn', statusKey: 'killing',
    })
    expect(backgroundTaskStatusIcon(ORPHANED)).toEqual({
      shape: 'dot', tone: 'info', statusKey: 'orphaned',
    })
  })

  it('killed 优先 dim：reason=killed + exitCode=null 不误入 danger（判定顺序锚——先判 exitCode 会红）', () => {
    expect(backgroundTaskStatusIcon(EXITED_KILLED)).toEqual({
      shape: 'dot', tone: 'dim', statusKey: 'killed',
    })
  })

  it('exitCode!==0 吸收 null：timeout（exitCode=null）与显式失败（exitCode=1）同为 danger，色档不区分 reason', () => {
    expect(backgroundTaskStatusIcon(EXITED_TIMEOUT)).toEqual({
      shape: 'dot', tone: 'danger', statusKey: 'failed',
    })
    expect(backgroundTaskStatusIcon(EXITED_FAIL)).toEqual({
      shape: 'dot', tone: 'danger', statusKey: 'failed',
    })
  })

  it('exitCode===0 → success 点', () => {
    expect(backgroundTaskStatusIcon(EXITED_OK)).toEqual({
      shape: 'dot', tone: 'success', statusKey: 'succeeded',
    })
  })
})
