/**
 * RpcClient.prompt streamingBehavior 透传测试（U1: session-delivery）。
 *
 * 锁定：prompt 调用链对 streamingBehavior 参数的透传契约——
 * - 带 streamingBehavior 时 JSONL 命令含该字段
 * - 不带时字段缺省（不出现 undefined 字符串）
 * - images 与 streamingBehavior 可独立组合
 *
 * mock 策略：mock spawn + readline，断言 stdin.write 收到的 JSON 命令内容。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/rpc-client-streaming-behavior.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
const clientOpts = { startupDelayMs: 0 } as const // 测试注入：启动确认窗口归零（窗口语义不变，见 RpcClientOptions.startupDelayMs）

// ── stdin.write 捕获 ──
const writeCalls: unknown[][] = []
const fakeStdin = {
  write: vi.fn((...args: unknown[]) => {
    writeCalls.push(args)
    return true
  }),
  once: vi.fn(),
  end: vi.fn(),
}

// ── readline 接口 mock ──
// ── stdout emitter（D10：LF-only 读取器桥接 'data'，替代旧 readline 的 rlEmitter）──
const stdoutEmitter = new EventEmitter()

// ── Mock modules ──
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    // exit listener 捕获：kill 即死语义（微任务驱动）短路 killPiProcess grace 真实等待
    const exitListeners: Array<(...args: unknown[]) => void> = []
    const proc = {
      stdin: fakeStdin,
      stdout: stdoutEmitter,
      stderr: new EventEmitter(),
      kill: vi.fn((_signal?: NodeJS.Signals | number) => {
        queueMicrotask(() => exitListeners.splice(0).forEach((h) => h(0)))
        return true
      }),
      pid: 12345,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'exit') exitListeners.push(handler)
        return proc
      }),
      removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const i = exitListeners.indexOf(handler)
        if (event === 'exit' && i >= 0) exitListeners.splice(i, 1)
        return proc
      }),
    }
    return proc
  }),
}))

vi.mock('../src/infra/pi/pi-paths.js', () => ({
  getSessionsDir: () => '/tmp/fake-sessions',
  getPiAgentDir: () => '/tmp/fake-pi-agent',
  // spawn-markers（rpc-client start 链，recordSpawnMarkers 默认 dataDir = getConfigDir()）
  // 会真实落盘 <dataDir>/run/pi-spawn-markers.json：读 globalSetup 注入的 env（fs-guard
  // 白名单第 2 项），写进 tmp 数据目录——与生产实现（sharedGetDataDir 读同一 env）同语义
  getConfigDir: () => process.env.XYZ_AGENT_DATA_DIR ?? '/tmp/fake-data',
}))

vi.mock('../src/infra/pi/pi-provider-store.js', () => ({
  getDefaultModel: () => ({ provider: 'test', modelId: 'test-model' }),
}))

vi.mock('../src/infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
}))

vi.mock('../src/utils/errors.js', () => ({
  RpcTimeoutError: class extends Error {
    constructor(public commandType: string, public timeoutMs: number) {
      super(`RPC timeout: ${commandType}`)
      this.name = 'RpcTimeoutError'
    }
  },
}))

// ── Tests ──
describe('RpcClient.prompt streamingBehavior 透传（U1: session-delivery）', () => {
  let RpcClient: typeof import('../src/infra/pi/rpc-client.js').RpcClient

  beforeEach(async () => {
    vi.clearAllMocks()
    writeCalls.length = 0
    stdoutEmitter.removeAllListeners()
    const mod = await import('../src/infra/pi/rpc-client.js')
    RpcClient = mod.RpcClient
  })

  /** 从 stdin.write 调用中解析最近一条 JSON 命令 */
  function lastWrittenCommand(): Record<string, unknown> {
    expect(writeCalls.length).toBeGreaterThan(0)
    const raw = writeCalls[writeCalls.length - 1]![0] as string
    return JSON.parse(raw.trim())
  }

  /** 启动 client（startupDelayMs=0 已注入，start() 即时 settle） */
  async function startClient(): Promise<InstanceType<typeof RpcClient>> {
    const client = new RpcClient({ ...clientOpts, cwd: '/tmp', sessionId: 'test-sid' })
    await client.start()
    return client
  }

  /** 发 prompt 并返回 stdin.write 捕获的命令 JSON，同时自动发 RPC 响应 */
  async function promptAndCapture(
    client: InstanceType<typeof RpcClient>,
    content: string,
    images?: Array<{ data: string; mimeType: string }>,
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<Record<string, unknown>> {
    writeCalls.length = 0

    const promptPromise = client.prompt(content, images, streamingBehavior)

    const cmd = lastWrittenCommand()

    // 模拟 pi RPC 响应（D10：投给 stdout 的 LF-only 读取器 data 入口，整行 + \n）
    stdoutEmitter.emit('data', JSON.stringify({ type: 'response', id: cmd.id, success: true }) + '\n')

    await promptPromise
    return cmd
  }

  it('U1: 不带 streamingBehavior 时字段不出现（非 undefined 字符串）', async () => {
    const client = await startClient()
    const cmd = await promptAndCapture(client, 'hello')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('hello')
    expect(cmd).not.toHaveProperty('streamingBehavior')
    expect(cmd).not.toHaveProperty('images')
  })

  it('U1: 带 streamingBehavior="steer" 时字段正确透传', async () => {
    const client = await startClient()
    const cmd = await promptAndCapture(client, 'steer me', undefined, 'steer')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('steer me')
    expect(cmd.streamingBehavior).toBe('steer')
    expect(cmd).not.toHaveProperty('images')
  })

  it('U1: 带 streamingBehavior="followUp" 时字段正确透传', async () => {
    const client = await startClient()
    const cmd = await promptAndCapture(client, 'follow up', undefined, 'followUp')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('follow up')
    expect(cmd.streamingBehavior).toBe('followUp')
  })

  it('U1: images + streamingBehavior 可独立组合', async () => {
    const client = await startClient()
    const images = [{ data: 'base64data', mimeType: 'image/png' }]
    const cmd = await promptAndCapture(client, 'with image', images, 'steer')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('with image')
    expect(cmd.images).toEqual([{ type: 'image', data: 'base64data', mimeType: 'image/png' }])
    expect(cmd.streamingBehavior).toBe('steer')
  })

  it('U1: 空 images 数组不传 images 字段 + streamingBehavior 仍透传', async () => {
    const client = await startClient()
    const cmd = await promptAndCapture(client, 'no images', [], 'followUp')

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('no images')
    expect(cmd).not.toHaveProperty('images')
    expect(cmd.streamingBehavior).toBe('followUp')
  })

  it('U2: 端口签名 arity——prompt 接受 4 个参数（content, images?, streamingBehavior?, options?）', () => {
    // 编译期类型测试：IPiEngine.prompt 的参数数量由 TypeScript 保证，
    // 运行期断言 RpcClient.prompt 的 length（4 = content + images + streamingBehavior + options）
    const client = new RpcClient({ ...clientOpts, cwd: '/tmp', sessionId: 'arity-check' })
    // prompt.length 是声明参数数（不含有默认值的参数），4 个参数 = arity 4。
    // 第 4 参 options（SendCommandOptions）为 R8① maintenance 透传（idle-pi-reclamation D1）：
    // promptReload 维护通道经 prompt 语义方法发起，maintenance 标记直达 sendCommand touch 排除，
    // 已提交的设计演化——本断言由 3 同步为 4。
    expect(client.prompt.length).toBe(4)
  })

  it('U2: 端口签名 arity——只传 images 不传 streamingBehavior 时，images 透传但 streamingBehavior 不出现', async () => {
    const client = await startClient()
    const images = [{ data: 'img', mimeType: 'image/jpeg' }]
    const cmd = await promptAndCapture(client, 'image only', images)

    expect(cmd.type).toBe('prompt')
    expect(cmd.message).toBe('image only')
    expect(cmd.images).toEqual([{ type: 'image', data: 'img', mimeType: 'image/jpeg' }])
    expect(cmd).not.toHaveProperty('streamingBehavior')
  })
})
