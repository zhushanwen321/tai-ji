/**
 * backgroundTask 域 RPC 封装单测（corrupted 链路收尾补丁：list 透传 reply 对象形状）。
 *
 * 覆盖：
 *   - list → command('backgroundTask.list', { sessionId })，透传 reply 全形对象
 *     （sessionId + tasks + corrupted；不折叠为纯数组——S7 错误条依赖拉取路 corrupted）
 *   - list 的 corrupted 缺省形态（正常拍显式 false / 旧协议无字段）原样透传不加工
 *   - output → maxBytes 可选展开（未传键不出现）+ lost 降级 reply 透传
 *   - kill → command('backgroundTask.kill', { sessionId, taskId })
 *
 * 三封装调用 command 均显式传第三参 timeoutMs = RPC_BACKSTOP_TIMEOUT_MS（G5 必传化
 * 后漏传 = 编译错误；断言对齐同目录 worktree.test.ts / domains.test.ts 三参范式）。
 *
 * mock 边界：command 经 vi.mock 隔离（对齐同目录 request.test.ts 范式），
 * reply 样例按 shared protocol backgroundTask.tasks / outputResult / killResult payload 形状。
 *
 * 运行命令：cd packages/core && npx vitest run src/transport/api/__tests__/background-task-domain.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const commandMock = vi.hoisted(() => vi.fn())
vi.mock('../request', () => ({
  command: commandMock,
}))

import { list, output, kill } from '../domains/background-task'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import type { BackgroundTaskRegistryEntry } from '@zhushanwen/extension-protocol'

function makeEntry(taskId: string, overrides: Partial<BackgroundTaskRegistryEntry> = {}): BackgroundTaskRegistryEntry {
  return {
    taskId,
    pid: 53241,
    command: 'pnpm test',
    outputFile: '/tmp/bt.log',
    startedAt: 1_700_000_000_000,
    state: 'running',
    ownerPiPid: 40001,
    sessionId: 'sess-1',
    ...overrides,
  }
}

beforeEach(() => {
  commandMock.mockReset()
})

describe('backgroundTask.list 透传（corrupted 链路收尾）', () => {
  it('损坏拍：reply 全形透传（tasks 空 + corrupted:true），不折叠为纯数组', async () => {
    const reply = { sessionId: 'sess-1', tasks: [], corrupted: true }
    commandMock.mockResolvedValue(reply)

    const result = await list('sess-1')

    expect(commandMock).toHaveBeenCalledWith('backgroundTask.list', { sessionId: 'sess-1' }, RPC_BACKSTOP_TIMEOUT_MS)
    expect(result).toBe(reply)
    expect(result.corrupted).toBe(true)
    expect(result.tasks).toHaveLength(0)
  })

  it('正常拍：corrupted 显式 false 原样透传 + 条目全量（consumer parseListReply 对象分支命中）', async () => {
    const entry = makeEntry('bt-1')
    const reply = { sessionId: 'sess-1', tasks: [entry], corrupted: false }
    commandMock.mockResolvedValue(reply)

    const result = await list('sess-1')

    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0].taskId).toBe('bt-1')
    expect(result.corrupted).toBe(false)
  })

  it('corrupted 字段缺省（前向兼容形态）透传时不伪造值', async () => {
    const reply = { sessionId: 'sess-1', tasks: [] }
    commandMock.mockResolvedValue(reply)

    const result = await list('sess-1')

    expect('corrupted' in result).toBe(false)
  })
})

describe('backgroundTask.output 封装', () => {
  it('maxBytes 未传：params 不出现该键', async () => {
    commandMock.mockResolvedValue({ sessionId: 'sess-1', taskId: 'bt-1', text: '', truncated: false, lost: true })
    await output('sess-1', 'bt-1')
    expect(commandMock).toHaveBeenCalledWith('backgroundTask.output', { sessionId: 'sess-1', taskId: 'bt-1' }, RPC_BACKSTOP_TIMEOUT_MS)
  })

  it('maxBytes 传入：params 展开 + lost reply 透传', async () => {
    const reply = { sessionId: 'sess-1', taskId: 'bt-1', text: 'tail', truncated: true, lost: false }
    commandMock.mockResolvedValue(reply)
    const result = await output('sess-1', 'bt-1', 4096)
    expect(commandMock).toHaveBeenCalledWith('backgroundTask.output', { sessionId: 'sess-1', taskId: 'bt-1', maxBytes: 4096 }, RPC_BACKSTOP_TIMEOUT_MS)
    expect(result).toBe(reply)
    expect(result.lost).toBe(false)
  })
})

describe('backgroundTask.kill 封装', () => {
  it('command("backgroundTask.kill", { sessionId, taskId })，回执 reason 透传', async () => {
    const reply = { sessionId: 'sess-1', taskId: 'bt-1', killed: true, reason: 'killed' as const }
    commandMock.mockResolvedValue(reply)
    const result = await kill('sess-1', 'bt-1')
    expect(commandMock).toHaveBeenCalledWith('backgroundTask.kill', { sessionId: 'sess-1', taskId: 'bt-1' }, RPC_BACKSTOP_TIMEOUT_MS)
    expect(result).toBe(reply)
    expect(result.reason).toBe('killed')
  })
})
