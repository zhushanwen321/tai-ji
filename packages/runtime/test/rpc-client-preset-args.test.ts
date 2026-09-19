/**
 * RpcClient preset / systemPrompt 启动参数 CLI args 单测（wave1）。
 *
 * 覆盖各新增字段的 args push 行为：
 * - tools / excludeTools（逗号连接）
 * - noTools / noSkills / noContextFiles（单 flag）
 * - thinkingLevel（--thinking，非 --thinking-level）
 * - systemPrompt（--system-prompt，自 rpc-client-system-prompt.test.ts 并入）
 * - appendSystemPrompt（--append-system-prompt，u2 模式提示词注入通道）
 *
 * spawn mock 范式（捕获 args 数组）为 rpc-client args 系测试共享形态
 * （rpc-client-start-args-anchor.test.ts 同款）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClientOptions } from '../src/infra/pi/rpc-client.js'

let spawnArgs: string[] = []

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
  kill: vi.fn(),
  pid: 12345,
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_cmd: string, args: readonly string[]) => {
    spawnArgs = [...args]
    return fakeProc
  }),
}))

// W-TR-2：用 importOriginal spread 保留 actual 符号（DEFAULT_PRESETS/BUILTIN_PRESET_IDS/
// ThinkingLevel 等只读常量类型用 actual；仅覆盖 ENV_WHITELIST_PREFIXES 这一个可变环境白名单，
// 避免 spawn 时把真实环境的几十个变量扫进 pi args 污染断言）。与同文件 pi-paths mock 模式对齐。
vi.mock('@taiji/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared')>()
  return {
    ...actual,
    ENV_WHITELIST_PREFIXES: ['PATH', 'HOME', 'USER', 'LANG', 'TERM'],
  }
})

vi.mock('@taiji/shared/paths', () => ({
  getDataDir: () => '/mock/home/.taiji',
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/mock/home' }
})

vi.mock('../src/infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getSessionsDir: () => '/mock/home/.taiji/sessions',
    getPiAgentDir: () => '/mock/home/.taiji/agent',
  }
})

vi.mock('../src/infra/pi/pi-provider-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infra/pi/pi-provider-store.js')>()
  return { ...actual, getDefaultModel: () => null }
})

vi.mock('../src/infra/logger.js', () => ({
  createPiSessionLog: () => ({ write: vi.fn(), end: vi.fn() }),
}))

describe('RpcClient preset args CLI', () => {
  let RpcClientCtor: typeof import('../src/infra/pi/rpc-client.js').RpcClient

  beforeEach(async () => {
    spawnArgs = []
    fakeProc.on.mockClear()
    fakeProc.stdin.write.mockClear()
    fakeProc.kill.mockClear()

    const mod = await import('../src/infra/pi/rpc-client.js')
    RpcClientCtor = mod.RpcClient
  })

  afterEach(async () => {
    try {
      const exitHandlers = fakeProc.on.mock.calls
        .filter(([event]) => event === 'exit')
        .map(([, handler]) => handler as (code: number | null) => void)
      for (const h of exitHandlers) {
        h(0)
      }
    } catch {
      // ignore cleanup errors
    }
  })

  it('tools 非空 → args 含 --tools 和逗号连接值', async () => {
    const options = { cwd: '/project', tools: ['read', 'grep'] } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).toContain('--tools')
    const idx = spawnArgs.indexOf('--tools')
    expect(spawnArgs[idx + 1]).toBe('read,grep')
  })

  it('excludeTools 非空 → args 含 --exclude-tools 和逗号连接值', async () => {
    const options = { cwd: '/project', excludeTools: ['bash', 'write'] } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).toContain('--exclude-tools')
    const idx = spawnArgs.indexOf('--exclude-tools')
    expect(spawnArgs[idx + 1]).toBe('bash,write')
  })

  it('noTools=true → args 含 --no-tools', async () => {
    const options = { cwd: '/project', noTools: true } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).toContain('--no-tools')
  })

  it('noSkills=true → args 含 --no-skills', async () => {
    const options = { cwd: '/project', noSkills: true } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).toContain('--no-skills')
  })

  it('noContextFiles=true → args 含 --no-context-files', async () => {
    const options = { cwd: '/project', noContextFiles: true } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).toContain('--no-context-files')
  })

  it('thinkingLevel 非空 → args 含 --thinking 和级别值（非 --thinking-level）', async () => {
    const options = { cwd: '/project', thinkingLevel: 'high' } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).toContain('--thinking')
    const idx = spawnArgs.indexOf('--thinking')
    expect(spawnArgs[idx + 1]).toBe('high')
    // 关键：参数名是 --thinking 不是 --thinking-level
    expect(spawnArgs).not.toContain('--thinking-level')
  })

  it('全字段未传 → args 不含 6 个新参数（零回归）', async () => {
    const options = { cwd: '/project' } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).not.toContain('--tools')
    expect(spawnArgs).not.toContain('--exclude-tools')
    expect(spawnArgs).not.toContain('--no-tools')
    expect(spawnArgs).not.toContain('--no-skills')
    expect(spawnArgs).not.toContain('--no-context-files')
    expect(spawnArgs).not.toContain('--thinking')
    expect(spawnArgs).not.toContain('--append-system-prompt')
  })

  it('组合：tools + thinkingLevel + noSkills 同时生效', async () => {
    const options = {
      cwd: '/project',
      tools: ['read'],
      thinkingLevel: 'medium',
      noSkills: true,
    } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).toContain('--tools')
    expect(spawnArgs[spawnArgs.indexOf('--tools') + 1]).toBe('read')
    expect(spawnArgs).toContain('--thinking')
    expect(spawnArgs[spawnArgs.indexOf('--thinking') + 1]).toBe('medium')
    expect(spawnArgs).toContain('--no-skills')
  })
})

describe('RpcClient systemPrompt CLI arg（自 rpc-client-system-prompt.test.ts 并入）', () => {
  let RpcClientCtor: typeof import('../src/infra/pi/rpc-client.js').RpcClient

  beforeEach(async () => {
    spawnArgs = []
    fakeProc.on.mockClear()
    fakeProc.stdin.write.mockClear()
    fakeProc.kill.mockClear()

    const mod = await import('../src/infra/pi/rpc-client.js')
    RpcClientCtor = mod.RpcClient
  })

  afterEach(async () => {
    // 不 kill 也可以；如 kill 被调用，触发 exit 让清理逻辑走通
    try {
      const exitHandlers = fakeProc.on.mock.calls
        .filter(([event]) => event === 'exit')
        .map(([, handler]) => handler as (code: number | null) => void)
      for (const h of exitHandlers) {
        h(0)
      }
    } catch {
      // ignore cleanup errors
    }
  })

  it('options.systemPrompt 有值 → args 包含 --system-prompt 和该值（\n 前缀）', async () => {
    const options = { cwd: '/project', systemPrompt: 'custom core prompt' } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).toContain('--system-prompt')
    const idx = spawnArgs.indexOf('--system-prompt')
    // u2：内联值前置 \n（pi 二义陷阱构造性区分，见 spawn-args.toInlinePromptValue）
    expect(spawnArgs[idx + 1]).toBe('\ncustom core prompt')
  })

  it('options.appendSystemPrompt 有值 → args 包含 --append-system-prompt 和该值（\n 前缀）', async () => {
    const options = { cwd: '/project', appendSystemPrompt: 'mode append prompt' } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).toContain('--append-system-prompt')
    expect(spawnArgs[spawnArgs.indexOf('--append-system-prompt') + 1]).toBe('\nmode append prompt')
  })

  it('options.systemPrompt + appendSystemPrompt 同时给 → 两 flag 均出现（对称）', async () => {
    const options = { cwd: '/project', systemPrompt: 'sys', appendSystemPrompt: 'app' } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs[spawnArgs.indexOf('--system-prompt') + 1]).toBe('\nsys')
    expect(spawnArgs[spawnArgs.indexOf('--append-system-prompt') + 1]).toBe('\napp')
  })

  it('options.appendSystemPrompt 仅空白/未传 → args 不包含 --append-system-prompt', async () => {
    const blank = { cwd: '/project', appendSystemPrompt: '   \t\n  ' } as unknown as RpcClientOptions
    await new RpcClientCtor(blank).start()
    expect(spawnArgs).not.toContain('--append-system-prompt')

    spawnArgs = []
    const absent = { cwd: '/project' } as unknown as RpcClientOptions
    await new RpcClientCtor(absent).start()
    expect(spawnArgs).not.toContain('--append-system-prompt')
  })

  it('options.systemPrompt 仅空白 → args 不包含 --system-prompt', async () => {
    const options = { cwd: '/project', systemPrompt: '   \t\n  ' } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).not.toContain('--system-prompt')
  })

  it('options.systemPrompt 未传 → args 不包含 --system-prompt', async () => {
    const options = { cwd: '/project' } as unknown as RpcClientOptions
    const client = new RpcClientCtor(options)
    await client.start()

    expect(spawnArgs).not.toContain('--system-prompt')
  })
})

describe('RpcClient spawn 日志 argv 脱敏（设计 §7.2 argv 日志脱敏 / 探针 P15）', () => {
  let RpcClientCtor: typeof import('../src/infra/pi/rpc-client.js').RpcClient

  beforeEach(async () => {
    spawnArgs = []
    fakeProc.on.mockClear()
    fakeProc.stdin.write.mockClear()
    fakeProc.kill.mockClear()

    const mod = await import('../src/infra/pi/rpc-client.js')
    RpcClientCtor = mod.RpcClient
  })

  afterEach(() => {
    try {
      const exitHandlers = fakeProc.on.mock.calls
        .filter(([event]) => event === 'exit')
        .map(([, handler]) => handler as (code: number | null) => void)
      for (const h of exitHandlers) {
        h(0)
      }
    } catch {
      // ignore cleanup errors
    }
  })

  it('spawn 日志不含系统提示词正文，仅 --flag <N chars>（非值 token 保留）', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const secret = 'TOP SECRET MODE PROMPT BODY'
      const options = {
        cwd: '/project',
        systemPrompt: secret,
        appendSystemPrompt: `${secret} append`,
      } as unknown as RpcClientOptions
      await new RpcClientCtor(options).start()

      const spawnLines = logSpy.mock.calls
        .map((call) => call.map((part) => String(part)).join(' '))
        .filter((line) => line.includes('[rpc] spawning pi:'))
      expect(spawnLines).toHaveLength(1)
      const line = spawnLines[0]
      // 正文不出现；两个提示词 flag 只记字符数
      expect(line).not.toContain(secret)
      expect(line).toMatch(/--system-prompt <\d+ chars>/)
      expect(line).toMatch(/--append-system-prompt <\d+ chars>/)
      // 非值诊断 token 保留
      expect(line).toContain('--mode rpc')
    } finally {
      logSpy.mockRestore()
    }
  })
})
