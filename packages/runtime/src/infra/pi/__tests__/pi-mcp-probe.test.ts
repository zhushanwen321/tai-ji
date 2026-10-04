/**
 * pi-mcp-probe 表驱动单测（设计 pi-mcp-management §3.3 D3 通道契约 + D8 状态徽标，单元 u4）。
 *
 * 验收分支全覆盖（impl-plan u4）：正常输出解析（V2 字段集锚定）/ 单服务器 error 条目 /
 * 非零退出码 / 超时降级 / JSON 解析失败降级。不真实 spawn pi：spawn 经 DI 注入 fake，
 * 二进制定位经 piExecutable 注入跳过（真机验证归 u5b）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/pi-mcp-probe.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  mapServerReport,
  parseMcpListOutput,
  runMcpProbe,
  type McpProbeSpawnImpl,
} from '../pi-mcp-probe.js'
import { getConfigDir, getPiAgentDir } from '../pi-paths.js'

const FAKE_PI = '/fake/path/to/pi'

/** fake 子进程：只实现 probe 消费的结构（stdout/stderr 事件、error/close、kill）。 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killSignals: (NodeJS.Signals | number | undefined)[] = []

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal)
    return true
  }
}

interface CapturedCall { // oe-exempt:20261004:framework:spawnImpl 注入缝的测试 fake 调用记录形状（DI 缝断言契约）
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

function makeHarness() {
  const children: FakeChild[] = []
  const calls: CapturedCall[] = []
  const spawnImpl: McpProbeSpawnImpl = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env })
    const child = new FakeChild()
    children.push(child)
    return child
  }
  return { children, calls, spawnImpl }
}

function startProbe(spawnImpl: McpProbeSpawnImpl, timeoutMs?: number): ReturnType<typeof runMcpProbe> {
  return runMcpProbe(timeoutMs === undefined
    ? { piExecutable: FAKE_PI, spawnImpl }
    : { piExecutable: FAKE_PI, spawnImpl, timeoutMs })
}

/**
 * V2 字段集锚定 fixture：pi 1.0.0 cli.js:348-383 条目报告的全部字段（含可选
 * toolExposure/resources/resourceTemplates/error），errors[] 一条，note 一条。
 */
const V2_FULL_OUTPUT = {
  servers: [
    {
      name: 'filesystem',
      scope: 'global',
      source: '/data/agent/mcp.json',
      enabled: true,
      exposure: 'direct',
      transport: 'npx -y @modelcontextprotocol/server-filesystem .',
      state: 'connected',
      tools: ['list_directory', 'read_file', 'write_file'],
      toolExposure: { read_file: 'deferred' },
      resources: 2,
      resourceTemplates: 1,
    },
    {
      name: 'legacy-srv',
      scope: 'global',
      source: '/data/agent/mcp.json',
      enabled: false,
      exposure: 'codemode',
      transport: 'node /path/old.js',
      state: 'disabled',
      tools: [],
    },
    {
      name: 'broken-srv',
      scope: 'global',
      source: '/data/agent/mcp.json',
      enabled: true,
      exposure: 'codemode',
      transport: 'npx -y @modelcontextprotocol/not-exist',
      state: 'failed',
      tools: [],
      error: 'spawn npx ENOENT\n    at ChildProcess.spawn (node:internal/child_process)',
    },
  ],
  errors: ['/data/agent/mcp.json: server "bad name": names may only contain letters, digits, "_" and "-"'],
  note: '/data/.pi/mcp.json is ignored because the project is not trusted.',
}

describe('parseMcpListOutput · 表驱动（V2 字段集锚定 + 分支降级）', () => {
  it('正常输出：三态徽标映射正确，errors/note 原文透传，exitCode 透传', () => {
    const result = parseMcpListOutput(JSON.stringify(V2_FULL_OUTPUT), '', 0)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.exitCode).toBe(0)
    expect(result.configErrors).toEqual(V2_FULL_OUTPUT.errors)
    expect(result.note).toBe(V2_FULL_OUTPUT.note)
    expect(result.servers).toEqual([
      {
        name: 'filesystem',
        scope: 'global',
        exposure: 'direct',
        transport: 'npx -y @modelcontextprotocol/server-filesystem .',
        status: {
          kind: 'connected',
          toolsCount: 3,
          toolNames: ['list_directory', 'read_file', 'write_file'],
        },
      },
      {
        name: 'legacy-srv',
        scope: 'global',
        exposure: 'codemode',
        transport: 'node /path/old.js',
        status: { kind: 'disabled' },
      },
      {
        name: 'broken-srv',
        scope: 'global',
        exposure: 'codemode',
        transport: 'npx -y @modelcontextprotocol/not-exist',
        status: {
          kind: 'failed',
          state: 'failed',
          errorDetail: 'spawn npx ENOENT\n    at ChildProcess.spawn (node:internal/child_process)',
        },
      },
    ])
  })

  it('单服务器 error 条目：errorDetail 保留完整多行错误全文（D8 详情入口素材）', () => {
    const output = {
      servers: [V2_FULL_OUTPUT.servers[2]],
      errors: [],
    }
    const result = parseMcpListOutput(JSON.stringify(output), '', 1)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.servers).toHaveLength(1)
    expect(result.servers[0].status).toEqual({
      kind: 'failed',
      state: 'failed',
      errorDetail: V2_FULL_OUTPUT.servers[2].error,
    })
  })

  it('非零退出码（有失败服务器）：仍为 ok 结果不抛错，exitCode 原样透出（D3 不阻塞）', () => {
    const result = parseMcpListOutput(JSON.stringify(V2_FULL_OUTPUT), '', 1)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.exitCode).toBe(1)
    expect(result.servers.find((entry) => entry.name === 'broken-srv')?.status.kind).toBe('failed')
  })

  it.each([
    { name: 'stdout 非法 JSON', stdout: '{"servers": [ truncated', stderr: '', expectExcerpt: '{"servers": [ truncated' },
    { name: 'stdout 空输出退 stderr 摘要', stdout: '', stderr: 'Unknown mcp command "lst"', expectExcerpt: 'Unknown mcp command "lst"' },
    { name: '顶层形状不符（servers 缺失）', stdout: JSON.stringify({ foo: 1 }), stderr: '', expectExcerpt: '{"foo":1}' },
    { name: 'JSON 标量（非对象）', stdout: '42', stderr: '', expectExcerpt: '42' },
  ])('降级：$name → invalid-output 含原始输出摘要', ({ stdout, stderr, expectExcerpt }) => {
    const result = parseMcpListOutput(stdout, stderr, 0)
    expect(result).toEqual({ kind: 'invalid-output', rawExcerpt: expect.stringContaining(expectExcerpt) })
  })
})

describe('mapServerReport · pi state 枚举映射穷尽表驱动（D8）', () => {
  const base = { scope: 'global', source: '/x', enabled: true, exposure: 'codemode', transport: 'npx x' }

  it.each([
    { state: 'connected', tools: ['a', 'b'], expectStatus: { kind: 'connected', toolsCount: 2, toolNames: ['a', 'b'] } },
    { state: 'needs-auth', tools: [], expectStatus: { kind: 'needs-auth' } },
    { state: 'disabled', tools: [], expectStatus: { kind: 'disabled' } },
    { state: 'failed', tools: [], error: 'connection refused', expectStatus: { kind: 'failed', state: 'failed', errorDetail: 'connection refused' } },
    { state: 'disconnected', tools: [], expectStatus: { kind: 'failed', state: 'disconnected' } },
    { state: 'closed', tools: [], expectStatus: { kind: 'failed', state: 'closed' } },
    { state: 'connecting', tools: [], expectStatus: { kind: 'failed', state: 'connecting' } },
  ])('state=$state → ${expectStatus.kind}', ({ state, tools, error, expectStatus }) => {
    const report = mapServerReport({ ...base, name: 'srv', state, tools, ...(error !== undefined ? { error } : {}) })
    expect(report?.status).toEqual(expectStatus)
  })

  it('未知 state 守卫为 failed（不信任外部格式，不编造状态）', () => {
    const report = mapServerReport({ ...base, name: 'srv', state: 'some-future-state', tools: [] })
    expect(report?.status).toEqual({ kind: 'failed', state: 'failed' })
  })

  it.each([
    { name: '非对象条目', raw: 'not-an-object' },
    { name: 'name 缺失', raw: { ...base, state: 'connected', tools: [] } },
    { name: 'name 非字符串', raw: { ...base, name: 42, state: 'connected', tools: [] } },
  ])('非法条目丢弃：$name', ({ raw }) => {
    expect(mapServerReport(raw)).toBeUndefined()
  })

  it('字段缺失按 CLI 默认值兜底（scope=global / exposure=codemode / transport 空串）', () => {
    const report = mapServerReport({ name: 'srv', state: 'disabled' })
    expect(report).toEqual({
      name: 'srv',
      scope: 'global',
      exposure: 'codemode',
      transport: '',
      status: { kind: 'disabled' },
    })
  })
})

describe('runMcpProbe · spawn 通道编排（D3 契约）', () => {
  it('正常路径：args=pi mcp list --json，env 经出站契约构建且 PI_CODING_AGENT_DIR 与会话同源，cwd=数据目录', async () => {
    const harness = makeHarness()
    const promise = startProbe(harness.spawnImpl)
    const child = harness.children[0]
    child.stdout.emit('data', JSON.stringify(V2_FULL_OUTPUT))
    child.emit('close', 0, null)
    const result = await promise

    expect(harness.calls).toHaveLength(1)
    const call = harness.calls[0]
    expect(call.command).toBe(FAKE_PI)
    expect(call.args).toEqual(['mcp', 'list', '--json'])
    // D3 契约②：spawn cwd = taiji 数据目录（非任何会话目录），测试范围恒用户级条目。
    expect(call.cwd).toBe(getConfigDir())
    // D3 契约①：PI_CODING_AGENT_DIR 与会话 spawn 同源（getPiAgentDir SSOT 同值）。
    expect(call.env.PI_CODING_AGENT_DIR).toBe(getPiAgentDir())
    expect(call.env.TAIJI_AGENT_PACKAGED).toBeUndefined()
    expect(call.env.TAIJI_RUNTIME_TOKEN).toBeUndefined()
    expect(result.kind).toBe('ok')
  })

  it('整体墙钟超时：到点 kill 进程，kind=timeout 无任何条目（D3 结构限制：无部分结果）', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      const promise = startProbe(harness.spawnImpl, DEFAULT_PROBE_TIMEOUT_MS)
      const child = harness.children[0]

      vi.advanceTimersByTime(DEFAULT_PROBE_TIMEOUT_MS)
      expect(child.killSignals).toHaveLength(1)

      child.emit('close', null, 'SIGTERM')
      const result = await promise
      expect(result).toEqual({ kind: 'timeout', timeoutMs: DEFAULT_PROBE_TIMEOUT_MS })
    } finally {
      vi.useRealTimers()
    }
  })

  it('超时先于正常退出：kill 后到达的 stdout 不被解析为结果', async () => {
    vi.useFakeTimers()
    try {
      const harness = makeHarness()
      const promise = startProbe(harness.spawnImpl, DEFAULT_PROBE_TIMEOUT_MS)
      const child = harness.children[0]

      vi.advanceTimersByTime(DEFAULT_PROBE_TIMEOUT_MS)
      child.stdout.emit('data', JSON.stringify(V2_FULL_OUTPUT))
      child.emit('close', 1, 'SIGTERM')
      const result = await promise
      expect(result.kind).toBe('timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('spawn 系统级错误（error 事件）→ spawn-failed 含错误信息', async () => {
    const harness = makeHarness()
    const promise = startProbe(harness.spawnImpl)
    const child = harness.children[0]
    child.emit('error', new Error('spawn /fake/path/to/pi ENOENT'))
    child.emit('close', null, null)
    const result = await promise

    expect(result).toEqual({
      kind: 'spawn-failed',
      message: expect.stringContaining('ENOENT'),
    })
  })

  it('通道级 stdout 非法 JSON → invalid-output（含原始输出摘要）', async () => {
    const harness = makeHarness()
    const promise = startProbe(harness.spawnImpl)
    const child = harness.children[0]
    child.stdout.emit('data', 'pi-internal panic: not json')
    child.emit('close', 2, null)
    const result = await promise

    expect(result).toEqual({
      kind: 'invalid-output',
      rawExcerpt: expect.stringContaining('pi-internal panic: not json'),
    })
  })
})
