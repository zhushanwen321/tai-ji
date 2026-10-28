import type { ShutdownStepName } from '../../session/rolling-restart.js';
import { disposeTerminalPtysStep } from '../dispose-terminal-ptys-step.js';
import type { ServerMessage } from '@taiji/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/terminal/__tests__/dispose-terminal-ptys-step.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('dispose-terminal-ptys-step', () => {
describe('disposeTerminalPtysStep（shutdown 链 dispose-terminal-ptys 步骤本体）', () => {
  it('先打点再 destroyAllPties（顺序契约：可观测打点在资源收尾之前）', () => {
    const order: string[] = []
    const destroyAllPties = vi.fn(() => { order.push('destroyAllPties') })
    const shutdownStep = vi.fn((name: ShutdownStepName) => { order.push(name) })
    disposeTerminalPtysStep({ destroyAllPties }, shutdownStep)
    expect(shutdownStep).toHaveBeenCalledExactlyOnceWith('dispose-terminal-ptys')
    expect(order).toEqual(['dispose-terminal-ptys', 'destroyAllPties'])
  })

  it('destroyAllPties 抛错不在此层吞（shutdown 外层 catch 统一记日志，错误路径语义不变）', () => {
    const destroyAllPties = vi.fn(() => { throw new Error('boom') })
    expect(() => disposeTerminalPtysStep({ destroyAllPties }, () => {})).toThrow('boom')
  })
})
});

// ======================================================================
// ← src/services/terminal/__tests__/terminal-service-env.test.ts
// ======================================================================

// ── mock node-pty（仅捕获 options.env 的最小 IPty 形状）──────────────────────
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))


vi.mock('node-pty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-pty')>()
  return { ...actual, spawn: spawnMock, }
})


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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('terminal-service-env', () => {
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
    vi.stubEnv('TAIJI_AGENT_PACKAGED', '1')
    vi.stubEnv('TAIJI_RUNTIME_TOKEN', 'secret-token')
    // 非白名单普通用户变量：D5 跟随最小剥离 → 必须仍出现在输出（拷贝拓扑不变的证据）
    vi.stubEnv('MY_OWN_SHELL_SETTING', 'keep-me')

    stubPty()
    const { publish } = createPublishCollector()
    await createService(publish).spawn('sid-polluted', '/tmp', 80, 24)

    const env = (spawnMock.mock.calls[0][2] as Record<string, unknown>).env as Record<string, string>
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.ELECTRON_NO_ASAR).toBeUndefined()
    expect(env.ELECTRON_OVERRIDE_DIST_PATH).toBeUndefined()
    expect(env.TAIJI_AGENT_PACKAGED).toBeUndefined()
    expect(env.TAIJI_RUNTIME_TOKEN).toBeUndefined()
    expect(env.MY_OWN_SHELL_SETTING).toBe('keep-me')
  })
})
});
