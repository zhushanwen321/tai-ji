/**
 * TerminalService.buildEnv 出站接线单测（U4-B7，docs/architecture/env-propagation-boundary.md §5-U4/D5）。
 *
 * 覆盖三个验收断言点：
 * 1. TERM 在输出中保持（含缺省时 fallback xterm-256color）；
 * 2. PR #105 三项 ELECTRON_* 删除语义保留；
 * 3. 拷贝拓扑不变（pass-all：任意用户自定义键跟随；deny 两键剔除由构建器兜底）。
 *
 * node-pty 经 vi.mock 拦截捕获 spawn options.env；configService 注入固定 shell，
 * 避免 resolveShell 触发真实 dscl 子进程。process.env 一律经 vi.stubEnv 注入/还原
 * （红线 R3）。运行：cd packages/runtime && npx vitest run src/services/terminal/__tests__
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'

// ── mock node-pty（仅捕获 options.env 的最小 IPty 形状）──────────────────────
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}))

// import 必须在 vi.mock 之后
const { TerminalService } = await import('../terminal-service.js')

/** 收集 publish 消息（TerminalService 契约：publish-only 通道）。 */
function createPublishCollector() {
  const messages: ServerMessage[] = []
  return { messages, publish: (_sid: string, msg: ServerMessage): void => { messages.push(msg) } }
}

/** 固定 shell 注入，跳过 dscl 登录 shell 探测（测试确定性）。 */
function createService(publish: (_sid: string, msg: ServerMessage) => void): InstanceType<typeof TerminalService> {
  return new TerminalService({
    publish,
    configService: {
      getTerminalConfig: () => ({ config: { shell: '/bin/echo', shellArgs: [] }, corrupted: false }),
    },
  })
}

/** 最小 IPty stub：onData/onExit 注册即弃。 */
function stubPty(): void {
  spawnMock.mockImplementation(() => ({
    pid: 4242,
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
  }))
}

describe('TerminalService buildEnv 出站接线（U4-B7/D5）', () => {
  afterEach(() => {
    spawnMock.mockReset()
    vi.unstubAllEnvs()
  })

  it('TERM 在输出中保持原值', async () => {
    vi.stubEnv('TERM', 'xterm-custom')
    stubPty()
    const { publish } = createPublishCollector()
    await createService(publish).spawn('sid-term', '/tmp', 80, 24)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const opts = spawnMock.mock.calls[0][2] as Record<string, unknown>
    const env = opts.env as Record<string, string>
    // 验收检查点：TERM 保持（用户终端渲染依赖）
    expect(env.TERM).toBe('xterm-custom')
  })

  it('TERM 缺省时 fallback xterm-256color（原 || 语义不变）', async () => {
    vi.stubEnv('TERM', '')
    stubPty()
    const { publish } = createPublishCollector()
    await createService(publish).spawn('sid-fallback', '/tmp', 80, 24)

    const env = (spawnMock.mock.calls[0][2] as Record<string, unknown>).env as Record<string, string>
    expect(env.TERM).toBe('xterm-256color')
  })

  it('PR #105 三项 ELECTRON_* 删除保留 + deny 两键剔除 + 拷贝拓扑保持任意用户键', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    vi.stubEnv('ELECTRON_NO_ASAR', '1')
    vi.stubEnv('ELECTRON_OVERRIDE_DIST_PATH', '/fake/dist')
    vi.stubEnv('XYZ_AGENT_PACKAGED', '1')
    vi.stubEnv('XYZ_RUNTIME_TOKEN', 'secret-token')
    // 非白名单普通用户变量：D5 跟随最小剥离 → 必须仍出现在输出（拷贝拓扑不变的证据）
    vi.stubEnv('MY_OWN_SHELL_SETTING', 'keep-me')

    stubPty()
    const { publish } = createPublishCollector()
    await createService(publish).spawn('sid-polluted', '/tmp', 80, 24)

    const env = (spawnMock.mock.calls[0][2] as Record<string, unknown>).env as Record<string, string>
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.ELECTRON_NO_ASAR).toBeUndefined()
    expect(env.ELECTRON_OVERRIDE_DIST_PATH).toBeUndefined()
    expect(env.XYZ_AGENT_PACKAGED).toBeUndefined()
    expect(env.XYZ_RUNTIME_TOKEN).toBeUndefined()
    expect(env.MY_OWN_SHELL_SETTING).toBe('keep-me')
  })
})
