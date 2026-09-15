import { describe, it, expect } from 'vitest'
import {
  BACKGROUND_TASK_REGISTRY_FILENAME,
  BASE_TOOL_ENHANCE_DIRNAME,
  BACKGROUND_TASK_REGISTRY_VERSION,
  MAX_TERMINAL_REGISTRY_ENTRIES,
  isActiveBackgroundTaskState,
  isTerminalBackgroundTaskState,
  isBackgroundTaskRegistryEntry,
  type BackgroundTaskState,
  type BackgroundTaskEndReason,
  type BackgroundTaskRegistryEntry,
  type BackgroundTaskRegistryFile,
} from './index'

/** 枚举值双向穷尽锁：类型侧多值/删值任一方向漂移都会让 satisfies 编译失败。 */
const ALL_STATES = {
  running: true,
  killing: true,
  exited: true,
  orphaned: true,
} satisfies Record<BackgroundTaskState, boolean>

const ALL_END_REASONS = {
  natural: true,
  timeout: true,
  killed: true,
  'process-exit': true,
} satisfies Record<BackgroundTaskEndReason, boolean>

/** 类型可编译证明：registry 持久化条目（必填 8 + 可选 6 全量在场）能按契约类型构造。 */
const fullEntry: BackgroundTaskRegistryEntry = {
  taskId: 'bt-1',
  pid: 100,
  command: 'sleep 300',
  outputFile: '/tmp/out.log',
  startedAt: 1700000000000,
  state: 'running',
  ownerPiPid: 200,
  sessionId: 'sess-a',
  exitCode: 0,
  reason: 'natural',
  endedAt: 1700000003000,
  durationMs: 3000,
  tailSummary: 'done',
  pidStartTime: 1700000000,
}

const registryFile: BackgroundTaskRegistryFile = {
  version: BACKGROUND_TASK_REGISTRY_VERSION,
  entries: [fullEntry],
}

describe('background-task registry 常量', () => {
  it('关键常量值与写侧现状锁定一致', () => {
    expect(BACKGROUND_TASK_REGISTRY_FILENAME).toBe('registry.json')
    expect(BASE_TOOL_ENHANCE_DIRNAME).toBe('base-tool-enhance')
    expect(BACKGROUND_TASK_REGISTRY_VERSION).toBe(1)
    expect(MAX_TERMINAL_REGISTRY_ENTRIES).toBe(50)
  })

  it('目录布局拼装出 <agentDir>/base-tool-enhance/<sessionId>/registry.json', () => {
    // 路径分段的值级锁（实际拼装在写侧 getRegistryPath，契约只锁分段字面量）
    const segments = [BASE_TOOL_ENHANCE_DIRNAME, 'sess-a', BACKGROUND_TASK_REGISTRY_FILENAME]
    expect(segments.join('/')).toBe('base-tool-enhance/sess-a/registry.json')
  })

  it('状态枚举恰为 running/killing/exited/orphaned 四值', () => {
    expect(Object.keys(ALL_STATES).sort()).toEqual(['exited', 'killing', 'orphaned', 'running'])
  })

  it('reason 枚举恰为 natural/timeout/killed/process-exit 四值', () => {
    expect(Object.keys(ALL_END_REASONS).sort()).toEqual(['killed', 'natural', 'process-exit', 'timeout'])
  })
})

describe('状态判定 helper', () => {
  it('活跃态 = running + killing', () => {
    expect(isActiveBackgroundTaskState('running')).toBe(true)
    expect(isActiveBackgroundTaskState('killing')).toBe(true)
    expect(isActiveBackgroundTaskState('exited')).toBe(false)
    expect(isActiveBackgroundTaskState('orphaned')).toBe(false)
  })

  it('终态 = exited + orphaned（orphaned 属终态——收殓幂等的构造性来源）', () => {
    expect(isTerminalBackgroundTaskState('exited')).toBe(true)
    expect(isTerminalBackgroundTaskState('orphaned')).toBe(true)
    expect(isTerminalBackgroundTaskState('running')).toBe(false)
    expect(isTerminalBackgroundTaskState('killing')).toBe(false)
  })
})

describe('isBackgroundTaskRegistryEntry', () => {
  it('全字段合法条目通过', () => {
    expect(isBackgroundTaskRegistryEntry(fullEntry)).toBe(true)
  })

  it('仅必填字段的条目通过（可选字段缺省合法）', () => {
    const minimal: BackgroundTaskRegistryEntry = {
      taskId: 'bt-2',
      pid: 1,
      command: 'echo hi',
      outputFile: '/tmp/o.log',
      startedAt: 1,
      state: 'running',
      ownerPiPid: 2,
      sessionId: 's',
    }
    expect(isBackgroundTaskRegistryEntry(minimal)).toBe(true)
  })

  it('任一必填字段缺失/脏类型拒绝（对齐写侧 isValidRegistryEntry）', () => {
    const cases: unknown[] = [
      { ...fullEntry, taskId: 1 },
      { ...fullEntry, pid: '1' },
      { ...fullEntry, command: undefined },
      { ...fullEntry, outputFile: null },
      { ...fullEntry, startedAt: 'x' },
      { ...fullEntry, state: 1 },
      { ...fullEntry, ownerPiPid: undefined },
      { ...fullEntry, sessionId: 3 },
    ]
    for (const c of cases) expect(isBackgroundTaskRegistryEntry(c)).toBe(false)
  })

  it('非对象输入拒绝', () => {
    expect(isBackgroundTaskRegistryEntry(null)).toBe(false)
    expect(isBackgroundTaskRegistryEntry('bt-1')).toBe(false)
    expect(isBackgroundTaskRegistryEntry(42)).toBe(false)
  })
})

describe('registry 文件形状与终态写入形状', () => {
  it('文件形状 = { version: 1, entries: [...] }', () => {
    expect(registryFile.version).toBe(1)
    expect(registryFile.entries).toHaveLength(1)
    const parsed = JSON.parse(JSON.stringify(registryFile)) as BackgroundTaskRegistryFile
    expect(Object.keys(parsed).sort()).toEqual(['entries', 'version'])
  })

  it('orphaned 终态条目序列化字段名与契约精确一致（收殓写入形状锁）', () => {
    // 收殓器写法（reaper writeOrphanedTerminal）：继承原条目 + state/endedAt/durationMs，reason 保持缺省
    const orphaned: BackgroundTaskRegistryEntry = {
      ...fullEntry,
      state: 'orphaned',
      endedAt: 1700000010000,
      durationMs: 1700000010000 - fullEntry.startedAt,
    }
    const serialized = JSON.parse(JSON.stringify(orphaned)) as Record<string, unknown>
    expect(Object.keys(serialized).sort()).toEqual(
      [
        'command',
        'durationMs',
        'endedAt',
        'exitCode',
        'outputFile',
        'ownerPiPid',
        'pid',
        'pidStartTime',
        'reason',
        'sessionId',
        'startedAt',
        'state',
        'tailSummary',
        'taskId',
      ].sort(),
    )
    expect(serialized.state).toBe('orphaned')
    expect(serialized.endedAt).toBe(1700000010000)
    expect(serialized.durationMs).toBe(10000)
  })

  it('exitCode null 合法（signal 终止语义）且可序列化', () => {
    const signaled: BackgroundTaskRegistryEntry = {
      ...fullEntry,
      state: 'exited',
      reason: 'killed',
      exitCode: null,
    }
    expect(isBackgroundTaskRegistryEntry(signaled)).toBe(true)
    expect((JSON.parse(JSON.stringify(signaled)) as BackgroundTaskRegistryEntry).exitCode).toBeNull()
  })
})
