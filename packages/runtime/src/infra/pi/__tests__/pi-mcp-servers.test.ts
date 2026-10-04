/**
 * PiMcpServers 表驱动单测（pi-mcp-management 装配波 u2b 验收）。
 *
 * 组合真 pi-mcp-store（路径经 setMcpStorePathForTest 重定向 mkdtemp 自建自删）+
 * fake probeRunner（防真进程 spawn），锁定 infra 组合层的缝：
 * - list 投影：空文件 = 空清单 + corruption null（§3.1 同形态）；损坏 = servers 空 +
 *   corruption 有值（S6 读侧错误态）；坏条目 configError 标注照原样投影（D4/D8③）；
 * - add：ADR-0065 verbatim 原样写入 + 写后落盘终态回读；显式 type:"streamable-http"
 *   原样落盘（§4 断言② 对齐——闭集含旧称不误拦）；重名/归并同名/name_invalid/混填
 *   拦截信封（corruption 缺省）；损坏拒入信封（corruption 携带，S6 fail-fast）；
 * - update：外键判别分叉两语义——无外键 entry = form 合并（底外键保留 + 清空删键，
 *   D7 编辑写回契约）；含外键 entry = code 整体替换（外键以 entry 为准）；not_found 信封；
 * - remove：删除前值回显（port 契约）；不存在信封；损坏拒入信封；
 * - test：句柄立即返回（testId 形状）+ probeRunner 同步段被触发 + D3 墙钟公式
 *   （大 timeout 条目放大，无显式 timeout = 默认下限 150 秒）。
 *
 * 运行：pnpm -C packages/runtime test pi-mcp-servers
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROBE_TIMEOUT_MS, type McpProbeOptions, type McpProbeResult } from '../pi-mcp-probe.js'
import { PiMcpServers } from '../pi-mcp-servers.js'
import { setMcpStorePathForTest } from '../pi-mcp-store.js'
import type { McpServerEntryValue } from '@taiji/shared'

let tmpDir: string
let mcpPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pi-mcp-servers-'))
  mcpPath = join(tmpDir, 'mcp.json')
  mkdirSync(tmpDir, { recursive: true })
  setMcpStorePathForTest(mcpPath)
})

afterEach(() => {
  setMcpStorePathForTest(null)
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** fake probeRunner（ok 空结果；按用例覆写）。返回类型保留 vi.fn 推导（断言 .mock 用）。 */
function makeProbeRunner(result: McpProbeResult = { kind: 'ok', exitCode: 0, servers: [], configErrors: [] }) {
  return vi.fn(async (_options: McpProbeOptions): Promise<McpProbeResult> => result)
}

function makeServers(probeResult?: McpProbeResult): { servers: PiMcpServers; runner: ReturnType<typeof makeProbeRunner> } {
  const runner = makeProbeRunner(probeResult)
  return { servers: new PiMcpServers({ probeRunner: runner }), runner }
}

function writeRaw(content: string): void {
  writeFileSync(mcpPath, content, 'utf-8')
}

const STDIO_ENTRY: McpServerEntryValue = { command: 'npx', args: ['-y', 'server-filesystem', '.'] }

describe('PiMcpServers.list（读投影）', () => {
  it('文件不存在 = 空清单 + corruption null（与「文件存在但无条目」同形态，§3.1）', () => {
    const { servers, runner } = makeServers()
    expect(servers.list()).toEqual({ servers: [], corruption: null })
  })

  it('正常条目投影：name + value 原样 + 无 configError；filePath 来自 activePath', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: STDIO_ENTRY } }))
    const { servers, runner } = makeServers()
    const result = servers.list()
    expect(result.corruption).toBeNull()
    expect(result.servers).toEqual([{ name: 'fs', value: STDIO_ENTRY }])
  })

  it('文件损坏 = servers 空 + corruption 有值（S6 读侧错误态，filePath = 修复入口）', () => {
    writeRaw('{ broken json')
    const { servers, runner } = makeServers()
    const result = servers.list()
    expect(result.servers).toEqual([])
    expect(result.corruption?.filePath).toBe(mcpPath)
    expect(result.corruption?.corruptCopyPath).toBeNull()
  })

  it('坏条目照原样投影 + configError 标注（D4 不阻塞其余条目管理，D8③）', () => {
    writeRaw(JSON.stringify({ mcpServers: { ok: STDIO_ENTRY, bad: { description: 'no transport' } } }))
    const { servers, runner } = makeServers()
    const result = servers.list()
    expect(result.servers).toHaveLength(2)
    const bad = result.servers.find((s) => s.name === 'bad')
    expect(bad?.value).toEqual({ description: 'no transport' })
    expect(bad?.configError).toContain('bad')
    const ok = result.servers.find((s) => s.name === 'ok')
    expect(ok?.configError).toBeUndefined()
  })

  it('非对象坏条目投影空对象 + configError 标注（协议对象类型边界，值以标注承载）', () => {
    writeRaw(JSON.stringify({ mcpServers: { weird: 'just a string' } }))
    const { servers, runner } = makeServers()
    const result = servers.list()
    expect(result.servers[0]).toMatchObject({ name: 'weird', value: {}, configError: expect.any(String) })
  })
})

describe('PiMcpServers.add（ADR-0065 verbatim 原样写入）', () => {
  it('正常：原样落盘 + reply entry = 写后落盘终态（回读）', () => {
    const { servers, runner } = makeServers()
    const result = servers.add('fs', STDIO_ENTRY)
    expect(result).toEqual({ ok: true, entry: { name: 'fs', value: STDIO_ENTRY } })
    const onDisk = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(onDisk.mcpServers.fs).toEqual(STDIO_ENTRY)
  })

  it('显式 type:"streamable-http" + url 原样落盘（§4 断言②：旧称闭集内不误拦）', () => {
    const { servers, runner } = makeServers()
    const entry: McpServerEntryValue = { url: 'https://example.com/mcp', type: 'streamable-http' }
    const result = servers.add('legacy', entry)
    expect(result.ok).toBe(true)
    const onDisk = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(onDisk.mcpServers.legacy).toEqual(entry)
  })

  it('重名拦截：ok:false 信封报「已存在同名服务器，请编辑该条目」（不采用替换语义，D4）', () => {
    const { servers, runner } = makeServers()
    expect(servers.add('fs', STDIO_ENTRY).ok).toBe(true)
    const result = servers.add('fs', { command: 'other' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('已存在同名服务器')
    expect(result.corruption).toBeUndefined()
  })

  it('归并同名拦截（-/_ 视为同名，不变量 1 归并条款）', () => {
    const { servers, runner } = makeServers()
    expect(servers.add('a-b', STDIO_ENTRY).ok).toBe(true)
    const result = servers.add('a_b', { command: 'other' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('a-b')
  })

  it('名称非法拦截信封（name_invalid，D4 三不变量）', () => {
    const { servers, runner } = makeServers()
    const result = servers.add('my server', STDIO_ENTRY)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('非法字符')
  })

  it('command+url 混填拦截信封（transport_conflict——taiji 有意收紧，D4；code 原样路径校验生效）', () => {
    const { servers, runner } = makeServers()
    const result = servers.add('mixed', { command: 'npx', url: 'https://example.com' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('不能同时填写')
  })

  it('损坏拒入信封：ok:false + corruption 携带（S6 fail-fast，不覆盖外部手编内容）', () => {
    writeRaw('{ broken')
    const { servers, runner } = makeServers()
    const result = servers.add('fs', STDIO_ENTRY)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.corruption?.filePath).toBe(mcpPath)
    expect(result.error).toContain('请先修复文件')
    // 拒入后文件原样（外部手编内容未被覆盖）
    expect(readFileSync(mcpPath, 'utf-8')).toBe('{ broken')
  })
})

describe('PiMcpServers.update（外键判别分叉两语义，ADR-0065 transformable）', () => {
  it('无外键 entry = form 合并语义：底外键原样保留 + 清空删键（D7 编辑写回契约）', () => {
    writeRaw(JSON.stringify({
      mcpServers: { fs: { ...STDIO_ENTRY, timeout: 30, oauth: { clientId: 'c1' }, description: 'old' } },
    }))
    const { servers, runner } = makeServers()
    // 表单产物：只改 description + command；timeout/oauth 是外键必须保留；args 清空 = 删键
    const result = servers.update('fs', { command: 'node', description: 'new' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({ command: 'node', timeout: 30, oauth: { clientId: 'c1' }, description: 'new' })
  })

  it('无外键 entry = form 合并语义：type 键无条件剥离（D7，stale type 坏形态封死）', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: { url: 'https://example.com', type: 'http', timeout: 5 } } }))
    const { servers, runner } = makeServers()
    // 表单模式切换传输类型：url 侧字段清空 → stdio 侧 command 回填；type 剥离；timeout 外键保留
    const result = servers.update('fs', { command: 'npx' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({ command: 'npx', timeout: 5 })
    expect(result.entry.value.type).toBeUndefined()
  })

  it('含外键 entry = code 整体替换语义：外键以 entry 为准（含外键投影回写/代码模式）', () => {
    writeRaw(JSON.stringify({
      mcpServers: { fs: { ...STDIO_ENTRY, timeout: 30, oauth: { clientId: 'old' } } },
    }))
    const { servers, runner } = makeServers()
    // 代码模式产物：entry 整体作为条目值（底 oauth 不保留——textarea 所见即落盘）
    const result = servers.update('fs', { command: 'node', timeout: 60 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({ command: 'node', timeout: 60 })
  })

  it('启停切换形态（整条目回写 + enabled 覆盖，u3 消费形态）：含外键原值原样回写', () => {
    writeRaw(JSON.stringify({
      mcpServers: { fs: { url: 'https://example.com', type: 'http', timeout: 5 } },
    }))
    const { servers, runner } = makeServers()
    const result = servers.update('fs', { url: 'https://example.com', type: 'http', timeout: 5, enabled: false })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({ url: 'https://example.com', type: 'http', timeout: 5, enabled: false })
  })

  it('条目不存在 = ok:false 信封（修复动作指向清单刷新）', () => {
    const { servers, runner } = makeServers()
    const result = servers.update('ghost', { command: 'npx' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('不存在')
  })

  it('form 语义校验失败信封：清空传输字段 → transport_missing（D4 三不变量，不落盘）', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: STDIO_ENTRY } }))
    const { servers, runner } = makeServers()
    const result = servers.update('fs', { description: 'no transport fields' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('缺少传输参数')
    // 校验不过不落盘（fail-fast）
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.fs).toEqual(STDIO_ENTRY)
  })
})

describe('PiMcpServers.remove（删除前值回显）', () => {
  it('正常：entry = 被删条目删除前落盘值（port 契约回显）+ 文件已删该键', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: STDIO_ENTRY, keep: { command: 'x' } } }))
    const { servers, runner } = makeServers()
    const result = servers.remove('fs')
    expect(result).toEqual({ ok: true, entry: { name: 'fs', value: STDIO_ENTRY } })
    const onDisk = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(onDisk.mcpServers.fs).toBeUndefined()
    expect(onDisk.mcpServers.keep).toEqual({ command: 'x' })
  })

  it('条目不存在 = ok:false 信封（不抛错，幂等意图由信封表达）', () => {
    const { servers, runner } = makeServers()
    const result = servers.remove('ghost')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('不存在')
  })

  it('损坏拒入信封：不触发删除（S6，外部手编内容不被触碰）', () => {
    writeRaw('{ broken')
    const { servers, runner } = makeServers()
    const result = servers.remove('fs')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.corruption?.filePath).toBe(mcpPath)
    expect(readFileSync(mcpPath, 'utf-8')).toBe('{ broken')
  })
})

describe('PiMcpServers.test（D3 异步任务形态 + 墙钟公式）', () => {
  it('句柄立即返回（testId 形状）+ probeRunner 同步段被触发', async () => {
    const { servers, runner } = makeServers()
    const handle = servers.test('fs')
    expect(handle.testId).toMatch(/^mcp-test-\d+$/)
    expect(runner).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(runner.mock.results[0]?.value).resolves.toBeTruthy())
  })

  it('无显式 timeout = 默认墙钟下限 150 秒（D3 量级依据）', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: STDIO_ENTRY } }))
    const { servers, runner } = makeServers()
    servers.test('fs')
    expect(runner.mock.calls[0]?.[0]?.timeoutMs).toBe(DEFAULT_PROBE_TIMEOUT_MS)
  })

  it('最大显式 timeout 放大墙钟：2 × timeout + 30 秒余量（D3 公式）', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: STDIO_ENTRY, slow: { command: 'x', timeout: 120 } } }))
    const { servers, runner } = makeServers()
    servers.test('fs')
    expect(runner.mock.calls[0]?.[0]?.timeoutMs).toBe(120 * 2 * 1000 + 30_000)
  })

  it('timeout 坏值（负数/非数字）不参与放大（pi 加载期是值域权威）', () => {
    writeRaw(JSON.stringify({ mcpServers: { a: { command: 'x', timeout: -5 }, b: { command: 'y', timeout: 'fast' } } }))
    const { servers, runner } = makeServers()
    servers.test('a')
    expect(runner.mock.calls[0]?.[0]?.timeoutMs).toBe(DEFAULT_PROBE_TIMEOUT_MS)
  })
})

describe('PiMcpServers.onTestResult（probe 终态回填回调，u5b 打回接线）', () => {
  /** 构造带回调的实例（probeRunner fake 固定返回传入结果）。 */
  function makeServersWithCallback(probeResult: McpProbeResult) {
    const events: unknown[] = []
    const runner = makeProbeRunner(probeResult)
    const servers = new PiMcpServers({ probeRunner: runner, onTestResult: (e) => events.push(e) })
    return { servers, events }
  }

  it('probe ok + 条目 connected → 回调携带 D8① probe 徽标（state/toolCount/testedAt）', async () => {
    const { servers, events } = makeServersWithCallback({
      kind: 'ok',
      exitCode: 0,
      configErrors: [],
      servers: [
        { name: 'fs', scope: 'user', exposure: 'direct', transport: 'npx', status: { kind: 'connected', toolsCount: 3, toolNames: ['a', 'b', 'c'] } },
      ],
    })
    const handle = servers.test('fs')
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({
      name: 'fs',
      testId: handle.testId,
      badge: { source: 'probe', state: 'connected', toolCount: 3 },
    })
    expect((events[0] as { badge: { testedAt: number } }).badge.testedAt).toBeGreaterThan(0)
  })

  it('probe ok + 条目 failed → 徽标携带 pi 原始 state 与 errorDetail 全文（D8① 失败详情）', async () => {
    const { servers, events } = makeServersWithCallback({
      kind: 'ok',
      exitCode: 1,
      configErrors: [],
      servers: [
        { name: 'broken', scope: 'user', exposure: 'codemode', transport: 'x', status: { kind: 'failed', state: 'failed', errorDetail: 'spawn /nonexistent ENOENT' } },
      ],
    })
    servers.test('broken')
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({
      name: 'broken',
      badge: { source: 'probe', state: 'failed', errorDetail: 'spawn /nonexistent ENOENT' },
    })
  })

  it('触发条目不在结果内（外部删除窗口）→ ui-local timeout 徽标（D3 本次无结果语义）', async () => {
    const { servers, events } = makeServersWithCallback({
      kind: 'ok',
      exitCode: 0,
      configErrors: [],
      servers: [
        { name: 'other', scope: 'user', exposure: 'codemode', transport: 'x', status: { kind: 'connected', toolsCount: 1, toolNames: ['t'] } },
      ],
    })
    servers.test('gone')
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ name: 'gone', badge: { source: 'ui-local', state: 'timeout' } })
  })

  it('probe 整体超时 → ui-local timeout 徽标（D3 整体无本次结果）', async () => {
    const { servers, events } = makeServersWithCallback({ kind: 'timeout', timeoutMs: 150_000 })
    servers.test('fs')
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ badge: { source: 'ui-local', state: 'timeout' } })
  })

  it('probe spawn-failed → failed 徽标携带降级原因全文', async () => {
    const { servers, events } = makeServersWithCallback({ kind: 'spawn-failed', message: 'pi 可执行文件定位失败' })
    servers.test('fs')
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({
      badge: { source: 'probe', state: 'failed', errorDetail: 'pi 可执行文件定位失败' },
    })
  })

  it('未注入回调（存量测试装配）→ 不炸、行为退回仅日志留痕', async () => {
    const { servers } = makeServers({ kind: 'ok', exitCode: 0, configErrors: [], servers: [] })
    expect(() => servers.test('fs')).not.toThrow()
  })
})
