/**
 * McpServersService 测试（pi-mcp-management 设计，IMcpServers port 组合层）。
 *
 * 锁定（验收条款①服务层：fake store/probe 注入——本层对 port 是纯组合，fake port 即
 * 覆盖 store 与 probe 两类 infra 缝）：
 * - 五操作正常路径：参数原样传递 + 返回值原样透传（单行委托契约）；
 * - 损坏错误态透传：list 回 { servers: [], corruption }（S6 读侧错误态形状）、add 拒入
 *   回 ok:false 信封含 error + corruption（损坏拒入不 throw 不吞）；
 * - 校验错误信封透传：ok:false 且 corruption 缺省（D4 校验类失败与损坏拒入的形状区分）；
 * - test 异步任务形态（D3/前提 A4）：句柄立即返回（testId 非空字符串），触发调用携带
 *   目标名——连接测试不占 request/reply 往返，真实 probe 由 port 实现（u2b）后台执行；
 *   setEnabled（启停专用操作）与 testCancel（D3「取消」按钮）同款单行委托透传。
 *
 * 运行：pnpm -C packages/runtime test mcp-servers-service
 */
import { describe, it, expect, vi } from 'vitest'
import { McpServersService } from '../src/services/mcp-servers-service.js'
import type { IMcpServers } from '../src/services/ports/mcp-servers.js'
import type {
  McpListResult,
  McpMutationResult,
  McpServerEntry,
  McpServerEntryValue,
  McpTestHandle,
} from '@taiji/shared'

const ENTRY: McpServerEntry = {
  name: 'filesystem',
  value: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
}

/** 损坏错误态样例（S6：filePath 定位与修复入口 + 隔离副本提示）。 */
const CORRUPTION = { filePath: '/data/agent/mcp.json', corruptCopyPath: null }

/** fake port（fake store/probe）：默认返回正常路径形状，按用例覆写单方法。 */
function makeFakePort(overrides: Partial<IMcpServers> = {}) {
  return {
    list: vi.fn((): McpListResult => ({ servers: [ENTRY], corruption: null, agentDir: '/data/agent' })),
    add: vi.fn((_name: string, _entry: McpServerEntryValue): McpMutationResult => ({ ok: true, entry: ENTRY })),
    update: vi.fn((_name: string, _entry: McpServerEntryValue): McpMutationResult => ({ ok: true, entry: ENTRY })),
    setEnabled: vi.fn((_name: string, _enabled: boolean): McpMutationResult => ({ ok: true, entry: ENTRY })),
    remove: vi.fn((_name: string): McpMutationResult => ({ ok: true, entry: ENTRY })),
    test: vi.fn((_name: string): McpTestHandle => ({ testId: 'test-1' })),
    testCancel: vi.fn((_testId: string): boolean => true),
    ...overrides,
  }
}

describe('McpServersService（IMcpServers 组合层）', () => {
  it('list 正常路径：无参调用 + 返回值原样透传', () => {
    const port = makeFakePort()
    const svc = new McpServersService(port)
    const result = svc.list()
    expect(port.list).toHaveBeenCalledOnce()
    expect(result).toEqual({ servers: [ENTRY], corruption: null, agentDir: '/data/agent' })
  })

  it('list 损坏错误态透传：servers 空数组 + corruption 有值（S6 形状，不 throw）', () => {
    const port = makeFakePort({
      list: vi.fn((): McpListResult => ({ servers: [], corruption: CORRUPTION, agentDir: '/data/agent' })),
    })
    const svc = new McpServersService(port)
    const result = svc.list()
    expect(result).toEqual({ servers: [], corruption: CORRUPTION, agentDir: '/data/agent' })
    expect(result.corruption?.filePath).toBe('/data/agent/mcp.json')
  })

  it('add 正常路径：name 与 entry 原样传递给 port + 终态信封透传', () => {
    const port = makeFakePort()
    const svc = new McpServersService(port)
    const entryValue: McpServerEntryValue = { url: 'https://example.com/mcp' }
    const result = svc.add('remote', entryValue)
    expect(port.add).toHaveBeenCalledOnce()
    expect(port.add).toHaveBeenCalledWith('remote', entryValue)
    expect(result).toEqual({ ok: true, entry: ENTRY })
  })

  it('add 损坏拒入信封透传：ok:false + error 含路径与修复动作 + corruption 携带（S6 fail-fast，不 throw）', () => {
    const rejected: McpMutationResult = {
      ok: false,
      error: `mcp.json 已损坏，拒绝写入。文件: ${CORRUPTION.filePath}。请修复或删除该文件后重试。`,
      corruption: CORRUPTION,
    }
    const port = makeFakePort({ add: vi.fn((): McpMutationResult => rejected) })
    const svc = new McpServersService(port)
    const result = svc.add('x', { command: 'npx' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain(CORRUPTION.filePath)
    expect(result.corruption).toEqual(CORRUPTION)
  })

  it('校验错误信封透传：ok:false 且 corruption 缺省（D4 校验类失败形状，与损坏拒入区分）', () => {
    const invalid: McpMutationResult = {
      ok: false,
      error: '服务器名只能包含字母、数字、下划线、连字符。请修改名称后重试。',
    }
    const port = makeFakePort({ add: vi.fn((): McpMutationResult => invalid) })
    const svc = new McpServersService(port)
    const result = svc.add('my server', { command: 'npx' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.corruption).toBeUndefined()
  })

  it('update 正常路径：参数原样传递 + reply 终态条目透传（D7 合并后生效值由 port 产出）', () => {
    const port = makeFakePort()
    const svc = new McpServersService(port)
    const entryValue: McpServerEntryValue = { command: 'node', args: ['server.js'] }
    svc.update('filesystem', entryValue)
    expect(port.update).toHaveBeenCalledWith('filesystem', entryValue)
  })

  it('remove 正常路径：name 传递 + entry 为被删条目回显（port 契约）', () => {
    const port = makeFakePort()
    const svc = new McpServersService(port)
    const result = svc.remove('filesystem')
    expect(port.remove).toHaveBeenCalledWith('filesystem')
    expect(result).toEqual({ ok: true, entry: ENTRY })
  })

  it('test 异步任务形态：句柄立即返回（testId 非空）+ 触发携带目标名（D3/前提 A4）', () => {
    const port = makeFakePort({ test: vi.fn((_name: string): McpTestHandle => ({ testId: 'probe-run-7' })) })
    const svc = new McpServersService(port)
    const handle = svc.test('filesystem')
    expect(port.test).toHaveBeenCalledOnce()
    expect(port.test).toHaveBeenCalledWith('filesystem')
    expect(handle.testId).toBe('probe-run-7')
  })

  it('setEnabled：参数原样传递给 port + 终态信封透传（§3.1 启停专用操作）', () => {
    const port = makeFakePort()
    const svc = new McpServersService(port)
    const result = svc.setEnabled('filesystem', false)
    expect(port.setEnabled).toHaveBeenCalledOnce()
    expect(port.setEnabled).toHaveBeenCalledWith('filesystem', false)
    expect(result).toEqual({ ok: true, entry: ENTRY })
  })

  it('testCancel：testId 传递 + 布尔结果原样透传（D3「取消」按钮）', () => {
    const port = makeFakePort({ testCancel: vi.fn((_testId: string): boolean => false) })
    const svc = new McpServersService(port)
    expect(svc.testCancel('probe-run-7')).toBe(false)
    expect(port.testCancel).toHaveBeenCalledOnce()
    expect(port.testCancel).toHaveBeenCalledWith('probe-run-7')
  })
})
