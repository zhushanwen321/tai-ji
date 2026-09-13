/**
 * RpcClient 出站 env 契约回归锁定（U3，docs/architecture/env-propagation-boundary.md §5-U3）。
 *
 * B3（runtime→pi）是本案泄道收口点：私有 buildSafeEnv 被 buildOutboundChildEnv 取代后，
 * 子进程 env 必须满足——deny 清单两键（XYZ_AGENT_PACKAGED / XYZ_RUNTIME_TOKEN）无论从
 * 哪条通路进来都不出现在 spawn 的 env 里；PATH/HOME 基座与必备注入键不受牵连；
 * options.env override 与 undefined 键的既有语义逐项保留。
 *
 * 策略：mock node:child_process 捕获 spawn 第三参数的 env（spawn-args 测试同构骨架）；
 * 父进程 env 污染经 vi.stubEnv 注入（R3：禁止直接读写真实 process.env）。
 *
 * 运行：npx vitest run src/__tests__/rpc-client-spawn-env.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient } from '../infra/pi/rpc-client.js'

// ── Mocks（骨架与 rpc-client-spawn-args.test.ts 同构，差异仅捕获 spawn 第三参数）──

let capturedEnv: Record<string, string> | null = null

const fakeProc = {
  on: vi.fn(),
  off: vi.fn(),
  removeListener: vi.fn(),
  stdout: { on: vi.fn(), resume: vi.fn(), destroy: vi.fn() },
  stderr: { on: vi.fn() },
  stdin: { write: vi.fn(), once: vi.fn() },
  kill: vi.fn(),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 形位对齐真实签名便于阅读
  spawn: (_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
    capturedEnv = opts?.env ?? null
    return fakeProc
  },
}))

vi.mock('@xyz-agent/shared', async (importOriginal) => {
  // 保留真实导出（rpc-client 经 infra/spawn-env 门面消费构建器本体），仅收窄白名单前缀
  const actual = await importOriginal<typeof import('@xyz-agent/shared')>()
  return { ...actual, ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'] }
})

vi.mock('@xyz-agent/shared/paths', () => ({ getDataDir: () => '/mock/home/.xyz-agent' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.xyz-agent/sessions',
    getPiAgentDir: () => '/mock/home/.xyz-agent/agent',
  }
})

vi.mock('../infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
  // u5b D6-④：rpc-client 新增 import 的内存快照采集（mock 面随源码 import 面同步）
  captureMemorySnapshot: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4 }),
}))

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient 出站 env 契约（U3：deny 剥除 + 基座保全）', () => {
  let client: RpcClient | null = null

  async function startWith(options: { env?: Record<string, string> } = {}): Promise<void> {
    const { RpcClient } = await import('../infra/pi/rpc-client.js')
    client = new RpcClient({ cwd: '/project', ...options })
    await client.start()
  }

  beforeEach(() => {
    capturedEnv = null
  })

  afterEach(async () => {
    if (client) {
      try { await client.kill() } catch { /* noop */ }
      client = null
    }
    vi.unstubAllEnvs()
  })

  it('T1: 污染父 env → spawn env 不含 deny 两键，PATH/HOME 基座与 PI_CODING_AGENT_DIR 必备键仍在', async () => {
    vi.stubEnv('XYZ_AGENT_PACKAGED', '1')
    vi.stubEnv('XYZ_RUNTIME_TOKEN', 'deadbeef-hex')
    vi.stubEnv('PATH', '/usr/bin:/bin')
    vi.stubEnv('HOME', '/mock/home')

    await startWith({ env: { XYZ_AGENT_DATA_DIR: '/mock/home/.xyz-agent' } })

    expect(capturedEnv).not.toBeNull()
    const env = capturedEnv!
    // deny 两键：无论从哪条通路进入，出站契约兜底剥除（本案核心修复点）
    expect(env).not.toHaveProperty('XYZ_AGENT_PACKAGED')
    expect(env).not.toHaveProperty('XYZ_RUNTIME_TOKEN')
    // R2：白名单过滤后的父 env 基座保全（整体替换语义下 PATH/HOME 丢失即远距离爆炸）
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/mock/home')
    // 必备注入键：pi 子树数据隔离根目录
    expect(env.PI_CODING_AGENT_DIR).toBe('/mock/home/.xyz-agent/agent')
    expect(env.XYZ_AGENT_DATA_DIR).toBe('/mock/home/.xyz-agent')
  })

  it('T2: 非 deny 的白名单内产品变量仍放行（收口只剥 deny 清单，不做全量掐断）', async () => {
    vi.stubEnv('XYZ_AGENT_DEBUG', '1')

    await startWith()

    expect(capturedEnv!.XYZ_AGENT_DEBUG).toBe('1')
  })

  it('T3: options.env override 覆盖白名单继承值（extras 在基座之上覆盖的既有优先级）', async () => {
    vi.stubEnv('XYZ_AGENT_DEBUG', '1')

    await startWith({ env: { XYZ_AGENT_DEBUG: '0' } })

    expect(capturedEnv!.XYZ_AGENT_DEBUG).toBe('0')
  })

  it('T4: 经 options.env 强塞的 deny 键同样被剥除（deny 兜底位于 extras 之后，不可被调用方复活）', async () => {
    await startWith({ env: { XYZ_RUNTIME_TOKEN: 'forged-token' } })

    expect(capturedEnv).not.toBeNull()
    expect(capturedEnv).not.toHaveProperty('XYZ_RUNTIME_TOKEN')
  })

  it('T5: options.env 含 undefined 键时跳过不删（锁定旧实现行为，防吞掉白名单基座 — R2）', async () => {
    vi.stubEnv('PATH', '/usr/bin:/bin')
    vi.stubEnv('XYZ_AGENT_DEBUG', '1')

    await startWith({
      // 上游若违反 RpcClientOptions.env 类型契约传入 undefined 值：旧行为是跳过该键、
      // 基座继承值原样保留（删除语义属 main 侧 safe-env）；迁移后必须逐字等价。
      env: { XYZ_AGENT_DEBUG: undefined, PATH: undefined } as unknown as Record<string, string>,
    })

    expect(capturedEnv!.PATH).toBe('/usr/bin:/bin')
    expect(capturedEnv!.XYZ_AGENT_DEBUG).toBe('1')
  })
})
