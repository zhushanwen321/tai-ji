/**
 * RpcClient start 启动参数特征锚定测试（复杂度债务偿还 W3 批）。
 *
 * 背景：start（原 cyclo 33）按处理阶段提取 helper（resolveStartModel / buildPiOutboundEnv /
 * buildPiArgs / appendToolArgs / toolOptionConflict / wireProcessHandlers / awaitStartupSettled，
 * 行为保持重构）。本文件锚定提取涉及且现有测试未覆盖的分支：
 * - --model 拼装三态（options.model / 全局默认兜底 / inheritSessionModel 抑制，P1 语义）
 * - W-RT-6 工具选项互斥冲突 warn（文案逐字节 + 优先级取一）
 * - 出站 env 契约（undefined extras 键跳过 / XYZ_AGENT_EXT_LOG 恒注入 / PI_CODING_AGENT_DIR）
 *
 * 复用 rpc-client-preset-args.test.ts 的 spawn mock 范式（额外捕获 env）。
 *
 * 运行：cd packages/runtime && npx vitest run test/rpc-client-start-args-anchor.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClientOptions } from '../src/infra/pi/rpc-client.js'

let spawnArgs: string[] = []
let spawnEnv: NodeJS.ProcessEnv = {}

const fakeProc = {
  on: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => fakeProc),
  off: vi.fn(),
  removeListener: vi.fn(),
  stdout: {
    on: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
  },
  stderr: { on: vi.fn() },
  stdin: {
    write: vi.fn(),
    once: vi.fn(),
  },
  kill: vi.fn((_signal?: NodeJS.Signals | number) => {
    // kill 即死（mock 语义）：从 on.mock.calls 找 exit listener 微任务驱动，短路 grace 真实等待
    // （beforeEach 已 mockClear，calls 仅含本用例注册；重复驱动由链内 settled 幂等守卫兑底）
    queueMicrotask(() => {
      for (const [event, handler] of fakeProc.on.mock.calls) {
        if (event === 'exit') (handler as (code: number | null) => void)(0)
      }
    })
    return true
  }),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_cmd: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv }) => {
    spawnArgs = [...args]
    spawnEnv = opts.env
    return fakeProc
  }),
}))

// W-TR-2：importOriginal spread 保留 actual 符号；仅覆盖 ENV_WHITELIST_PREFIXES 防 spawn
// env 断言被真实环境变量污染（与 rpc-client-preset-args.test.ts 同款）。
vi.mock('@xyz-agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyz-agent/shared')>()
  return {
    ...actual,
    ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'],
  }
})

vi.mock('@xyz-agent/shared/paths', () => ({
  getDataDir: () => '/mock/home/.xyz-agent',
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.xyz-agent/sessions',
    getPiAgentDir: () => '/mock/home/.xyz-agent/agent',
  }
})

// getDefaultModel 经 hoisted holder 可控（三态 --model 断言需要）
const providerStoreMock = vi.hoisted(() => ({
  defaultModel: null as { provider: string; modelId: string } | null,
}))
vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => providerStoreMock.defaultModel }
})

vi.mock('../src/infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
}))

const clientOpts = { startupDelayMs: 0 } as const // 测试注入：启动确认窗口归零

async function startWith(options: RpcClientOptions): Promise<import('../src/infra/pi/rpc-client.js').RpcClient> {
  const { RpcClient } = await import('../src/infra/pi/rpc-client.js')
  const client = new RpcClient({ ...clientOpts, ...options })
  await client.start()
  return client
}

describe('RpcClient start 启动参数锚定（W3 复杂度债务偿还）', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    spawnArgs = []
    spawnEnv = {}
    providerStoreMock.defaultModel = null
    fakeProc.on.mockClear()
    fakeProc.stdin.write.mockClear()
    fakeProc.kill.mockClear()
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    consoleWarnSpy.mockRestore()
    // 触发 exit handler 清理（对齐 rpc-client-preset-args.test.ts afterEach）
    try {
      const exitHandlers = fakeProc.on.mock.calls
        .filter(([event]) => event === 'exit')
        .map(([, handler]) => handler as (code: number | null) => void)
      for (const h of exitHandlers) h(0)
    } catch {
      // ignore cleanup errors
    }
  })

  // ── --model 三态（P1 pi-assumption final gate 语义） ──────────────

  it('M1: options.model 传入 → args 含 --model <options.model>（显式值优先于全局默认）', async () => {
    providerStoreMock.defaultModel = { provider: 'prov', modelId: 'default-mid' }
    await startWith({ cwd: '/project', model: 'custom/model-1' })

    expect(spawnArgs).toContain('--model')
    expect(spawnArgs[spawnArgs.indexOf('--model') + 1]).toBe('custom/model-1')
  })

  it('M2: options.model 未传 + 全局默认存在 → 兜底 --model <provider/modelId>', async () => {
    providerStoreMock.defaultModel = { provider: 'prov', modelId: 'default-mid' }
    await startWith({ cwd: '/project' })

    expect(spawnArgs).toContain('--model')
    expect(spawnArgs[spawnArgs.indexOf('--model') + 1]).toBe('prov/default-mid')
  })

  it('M3: options.model 未传 + 全局默认不存在 → args 不含 --model（空串不拼）', async () => {
    providerStoreMock.defaultModel = null
    await startWith({ cwd: '/project' })

    expect(spawnArgs).not.toContain('--model')
  })

  it('M4: inheritSessionModel=true → 恒不拼 --model（附着恢复路径，options.model 与全局默认兜底都被抑制）', async () => {
    providerStoreMock.defaultModel = { provider: 'prov', modelId: 'default-mid' }
    await startWith({ cwd: '/project', model: 'custom/model-1', inheritSessionModel: true })

    expect(spawnArgs).not.toContain('--model')
  })

  // ── W-RT-6 工具选项互斥冲突（文案逐字节 + 优先级取一） ─────────────

  it('T1: noTools + tools 冲突 → warn 精确文案 + args 按 noTools > tools 取 --no-tools（不抛错）', async () => {
    await startWith({ cwd: '/project', noTools: true, tools: ['read', 'grep'] })

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[rpc] conflicting tool options detected, using priority: noTools > tools > excludeTools',
    )
    expect(spawnArgs).toContain('--no-tools')
    expect(spawnArgs).not.toContain('--tools')
  })

  it('T2: tools + excludeTools 冲突 → warn + args 按 tools > excludeTools 取 --tools', async () => {
    await startWith({ cwd: '/project', tools: ['read'], excludeTools: ['bash'] })

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[rpc] conflicting tool options detected, using priority: noTools > tools > excludeTools',
    )
    expect(spawnArgs).toContain('--tools')
    expect(spawnArgs[spawnArgs.indexOf('--tools') + 1]).toBe('read')
    expect(spawnArgs).not.toContain('--exclude-tools')
  })

  it('T3: 单选项无冲突 → 不 warn（现状语义）', async () => {
    await startWith({ cwd: '/project', tools: ['read'] })

    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('conflicting tool options'),
    )
  })

  // ── 出站 env 契约（B3 构建器 + D4 观测注入） ──────────────────────

  it('E1: env extras——undefined 键跳过不写、非 undefined 键整体覆盖出站、XYZ_AGENT_EXT_LOG 恒为 1、PI_CODING_AGENT_DIR 在场', async () => {
    await startWith({
      cwd: '/project',
      env: { GOOD_KEY: 'v1', SKIP_ME: undefined } as unknown as Record<string, string>,
    })

    // undefined extras 键跳过（「undefined=删除」语义不进出站 env）
    expect(spawnEnv.SKIP_ME).toBeUndefined()
    expect('SKIP_ME' in spawnEnv).toBe(false)
    // 非 undefined extras 覆盖出站（extras 在白名单基座之上）
    expect(spawnEnv.GOOD_KEY).toBe('v1')
    // D4/G4 托管环境恒注入（不开放 options.env 覆盖）
    expect(spawnEnv.XYZ_AGENT_EXT_LOG).toBe('1')
    // xyz-pi agent 目录隔离
    expect(spawnEnv.PI_CODING_AGENT_DIR).toBe('/mock/home/.xyz-agent/agent')
    // 白名单基座继承（PATH 来自父 env）
    expect(spawnEnv.PATH).toBe(process.env.PATH)
  })
})
