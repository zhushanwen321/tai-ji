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
import { getPiAgentDir } from '../pi-paths.js'
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
    expect(servers.list()).toEqual({ servers: [], corruption: null, agentDir: getPiAgentDir() })
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

  it('code 路径 verbatim：enabled 键随 entry 整体落盘（代码模式可见可改，非启停通道）', () => {
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

describe('PiMcpServers.setEnabled（启停专用操作，§3.1「写入 enabled 字段」最小语义）', () => {
  it('禁用：仅翻转 enabled 键（enabled:false 落键），其余键不触——外部并发形态保持', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: { ...STDIO_ENTRY, description: 'kept' } } }))
    const { servers, runner } = makeServers()
    const result = servers.setEnabled('fs', false)
    expect(result).toEqual({ ok: true, entry: { name: 'fs', value: { ...STDIO_ENTRY, description: 'kept', enabled: false } } })
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.fs).toEqual({
      ...STDIO_ENTRY, description: 'kept', enabled: false,
    })
  })

  it('启用：enabled 键删除（缺省启用，对齐 pi 写路径语义）', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: { ...STDIO_ENTRY, enabled: false } } }))
    const { servers, runner } = makeServers()
    const result = servers.setEnabled('fs', true)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value.enabled).toBeUndefined()
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.fs).toEqual(STDIO_ENTRY)
  })

  it('带外键条目：外键原样保留（以锁内最新读为底，非清单旧投影）', () => {
    writeRaw(JSON.stringify({
      mcpServers: { fs: { url: 'https://example.com', type: 'http', timeout: 5, oauth: { clientId: 'c1' } } },
    }))
    const { servers, runner } = makeServers()
    const result = servers.setEnabled('fs', false)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({
      url: 'https://example.com', type: 'http', timeout: 5, oauth: { clientId: 'c1' }, enabled: false,
    })
  })

  it('混填条目启停不被规范化改写（command/url 原样保留——互斥收紧只拦写路径新产物，D4）', () => {
    writeRaw(JSON.stringify({ mcpServers: { mixed: { command: 'npx', url: 'https://example.com' } } }))
    const { servers, runner } = makeServers()
    const result = servers.setEnabled('mixed', false)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({ command: 'npx', url: 'https://example.com', enabled: false })
  })

  it('启停吃进锁内最新磁盘内容：清单打开后外部新增字段不被覆盖（D2 并发契约）', () => {
    writeRaw(JSON.stringify({ mcpServers: { fs: STDIO_ENTRY } }))
    const { servers, runner } = makeServers()
    // 模拟「清单打开后外部（终端/手编）改动」：直接改文件
    writeRaw(JSON.stringify({ mcpServers: { fs: { ...STDIO_ENTRY, description: 'external edit' } } }))
    const result = servers.setEnabled('fs', false)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.entry.value).toEqual({ ...STDIO_ENTRY, description: 'external edit', enabled: false })
  })

  it('条目不存在 = ok:false 信封（修复动作指向清单刷新）', () => {
    const { servers, runner } = makeServers()
    const result = servers.setEnabled('ghost', false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toContain('不存在')
  })

  it('损坏拒入信封：不触发写路径（S6，外部手编内容不被触碰）', () => {
    writeRaw('{ broken')
    const { servers, runner } = makeServers()
    const result = servers.setEnabled('fs', false)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.corruption?.filePath).toBe(mcpPath)
    expect(readFileSync(mcpPath, 'utf-8')).toBe('{ broken')
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

describe('PiMcpServers.testCancel（D3「取消」按钮——等价于超时到点杀进程的主动形态）', () => {
  /**
   * fake runner 复刻真 runMcpProbe 的登记缝时序：同步段调用 options.onStarted 登记
   * 取消函数，登记后 probe 挂起（Promise 不 resolve），取消函数被调时以 cancelled 终态收敛。
   */
  function makeHangingRunner() {
    let resolveProbe: ((r: McpProbeResult) => void) | null = null
    const runner = vi.fn((options: McpProbeOptions): Promise<McpProbeResult> => new Promise((resolve) => {
      resolveProbe = resolve
      options.onStarted?.(() => {
        resolveProbe?.({ kind: 'cancelled' })
        return true
      })
    }))
    return { runner }
  }

  it('取消生效：testCancel 返回 true，probe 以 cancelled 终态收敛且不回填徽标', async () => {
    const events: unknown[] = []
    const { runner } = makeHangingRunner()
    const servers = new PiMcpServers({ probeRunner: runner, onTestResult: (e) => events.push(e) })
    const handle = servers.test('fs')
    expect(servers.testCancel(handle.testId)).toBe(true)
    await vi.waitFor(() => expect(runner.mock.results[0]?.value).resolves.toEqual({ kind: 'cancelled' }))
    // 收敛后微任务排空仍无徽标回填（cancelled 不广播——renderer 已在取消分支恢复原徽标）
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toHaveLength(0)
    // 句柄清退：重复取消返回 false
    expect(servers.testCancel(handle.testId)).toBe(false)
  })

  it('任务自然收敛后取消晚到：testCancel 返回 false，结果徽标照常回填', async () => {
    const events: unknown[] = []
    const runner = makeProbeRunner({ kind: 'ok', exitCode: 0, servers: [], configErrors: [] })
    const servers = new PiMcpServers({ probeRunner: runner, onTestResult: (e) => events.push(e) })
    const handle = servers.test('fs')
    await vi.waitFor(() => expect(runner.mock.results[0]?.value).resolves.toBeTruthy())
    expect(servers.testCancel(handle.testId)).toBe(false)
    expect(events).toHaveLength(1)
  })

  it('testId 不存在：返回 false（fake runner 未触发 onStarted 的存量装配形态同样安全）', () => {
    const { servers } = makeServers()
    expect(servers.testCancel('mcp-test-999')).toBe(false)
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

  it('触发条目不在结果内（外部删除窗口）→ 其余条目照常逐条回填 + 触发行补 ui-local timeout（D3 本次无结果语义）', async () => {
    const { servers, events } = makeServersWithCallback({
      kind: 'ok',
      exitCode: 0,
      configErrors: [],
      servers: [
        { name: 'other', scope: 'user', exposure: 'codemode', transport: 'x', status: { kind: 'connected', toolsCount: 1, toolNames: ['t'] } },
      ],
    })
    servers.test('gone')
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[0]).toMatchObject({ name: 'other', badge: { source: 'probe', state: 'connected', toolCount: 1 } })
    expect(events[1]).toMatchObject({ name: 'gone', badge: { source: 'ui-local', state: 'timeout' } })
  })

  it('probe ok 全清单回填（§3.1）：全部条目各发一帧（同一 testId），无须逐行触发', async () => {
    const { servers, events } = makeServersWithCallback({
      kind: 'ok',
      exitCode: 1,
      configErrors: [],
      servers: [
        { name: 'fs', scope: 'user', exposure: 'codemode', transport: 'npx', status: { kind: 'connected', toolsCount: 3, toolNames: ['a', 'b', 'c'] } },
        { name: 'broken', scope: 'user', exposure: 'codemode', transport: 'x', status: { kind: 'failed', state: 'failed', errorDetail: 'spawn ENOENT' } },
      ],
    })
    const handle = servers.test('fs')
    await vi.waitFor(() => expect(events).toHaveLength(2))
    for (const event of events) {
      expect(event).toMatchObject({ testId: handle.testId })
    }
    expect(events[0]).toMatchObject({ name: 'fs', badge: { source: 'probe', state: 'connected', toolCount: 3 } })
    expect(events[1]).toMatchObject({ name: 'broken', badge: { source: 'probe', state: 'failed', errorDetail: 'spawn ENOENT' } })
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
