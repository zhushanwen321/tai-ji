/**
 * RpcClient bash/abortBash 透传测试（composer-bash-execute W1）。
 *
 * 锁定：
 * - bash(command, excludeFromContext) → sendCommand('bash', {command[, excludeFromContext]})，
 *   excludeFromContext undefined 时不传该键（走 pi 默认），显式 true/false 时透传。
 * - 返回值归一为 PiBashResult（sendCommand 已归一 data ?? payload）。
 * - abortBash() → sendCommand('abort_bash')，无参数。
 *
 * 策略：RpcClient.sendCommand 是 protected，无法直接 spy。沿用 test/rpc-client.test.ts 的
 * mock node:child_process + readline 模式——捕获 stdin 写入的命令结构 + 投递伪造 pi response
 * 驱动 pending resolve。这样测的是真实 bash/abortBash 方法（不绕过实现）。
 *
 * 运行：npx vitest run src/__tests__/rpc-client-bash.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RpcClient } from '../infra/pi/rpc-client.js'
import {
  clearExitHandlers,
  emitPiLine,
  lastWrittenJson,
  resetRpcClientMock,
} from '../../test/helpers/rpc-client-mock'
const clientOpts = { startupDelayMs: 0 } as const // 测试注入：启动确认窗口归零（窗口语义不变，见 RpcClientOptions.startupDelayMs）

// ── Mocks（工厂单源在 test/helpers/rpc-client-mock.ts，vi.mock 声明留本文件——路径按本文件解析）──

vi.mock('node:child_process', async () =>
  (await import('../../test/helpers/rpc-client-mock')).childProcessModule())

// D10 后 stdout 分帧走 rpc-client 自实现的 LF-only 读取器（同模块直调，无法从模块边界 mock）。
// 测试在 fake stdout 上桥接 'data' handler，emitPiLine 直投「整行 + \n」由读取器分帧；
// LF-only 分帧行为由 rpc-client-lf-framing.test.ts 专项覆盖。

vi.mock('@xyz-agent/shared', async () =>
  // U3 起 rpc-client 经 infra/spawn-env 门面消费 shared 的 buildOutboundChildEnv；
  // mock 需保留真实导出（否则构建器为 undefined），仅收窄白名单前缀获得可控基座
  (await import('../../test/helpers/rpc-client-mock')).sharedModule())

vi.mock('@xyz-agent/shared/paths', async () =>
  (await import('../../test/helpers/rpc-client-mock')).sharedPathsModule())

vi.mock('node:os', async () =>
  (await import('../../test/helpers/rpc-client-mock')).osModule())

vi.mock('../infra/pi/pi-paths.js', async () =>
  (await import('../../test/helpers/rpc-client-mock')).piPathsModule())

vi.mock('../infra/pi/pi-provider-store.js', async () =>
  (await import('../../test/helpers/rpc-client-mock')).piProviderStoreModule())

vi.mock('../infra/logger.js', async () =>
  (await import('../../test/helpers/rpc-client-mock')).loggerModule())

// ── Tests ────────────────────────────────────────────────────────

describe('RpcClient bash/abortBash 透传', () => {
  let client: RpcClient

  beforeEach(async () => {
    resetRpcClientMock()

    const { RpcClient } = await import('../infra/pi/rpc-client.js')
    client = new RpcClient({ ...clientOpts, cwd: '/project' })
    await client.start()
  })

  afterEach(async () => {
    try { await client.kill() } catch { /* noop */ }
    clearExitHandlers()
  })

  // T1: bash(command, false) → sendCommand('bash', {command, excludeFromContext:false})
  it('T1: bash("git status", false) → 写入 {type:"bash", command, excludeFromContext:false} + 返回值归一为 PiBashResult', async () => {
    const resultPromise = client.bash('git status', false)
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.type).toBe('bash')
    expect(sent.command).toBe('git status')
    expect(sent.excludeFromContext).toBe(false)

    // pi 回 success + data（PiBashResult 结构），归一后应原样返回
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { output: 'nothing to commit', exitCode: 0, cancelled: false, truncated: false },
    })

    const result = await resultPromise
    expect(result).toEqual({
      output: 'nothing to commit',
      exitCode: 0,
      cancelled: false,
      truncated: false,
    })
  })

  // T2: bash(command) 不传第二参 → params 不含 excludeFromContext 键
  it('T2: bash("pwd") 不传 excludeFromContext → 写入的 params 不含 excludeFromContext 键', async () => {
    const resultPromise = client.bash('pwd')
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.type).toBe('bash')
    expect(sent.command).toBe('pwd')
    // 关键：键不存在，走 pi 默认
    expect(sent).not.toHaveProperty('excludeFromContext')

    // 让 pending resolve
    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { output: '/project', exitCode: 0, cancelled: false, truncated: false },
    })
    const result = await resultPromise
    expect(result.output).toBe('/project')
  })

  // T3: abortBash() → sendCommand('abort_bash')，无业务参数
  it('T3: abortBash() → 写入 {type:"abort_bash"}（无 command 等业务参数）', async () => {
    const resultPromise = client.abortBash()
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.type).toBe('abort_bash')
    // abort_bash 无业务参数（不传 command）
    expect(sent).not.toHaveProperty('command')

    // 让 pending resolve
    emitPiLine({ type: 'response', id: sent.id, success: true, data: {} })
    await resultPromise
  })

  // T3b: bash(command, true) → excludeFromContext 透传 true（覆盖显式 true 分支）
  it('T3b: bash("ls", true) → 写入 excludeFromContext:true（显式 true 透传）', async () => {
    const resultPromise = client.bash('ls', true)
    await Promise.resolve()

    const sent = lastWrittenJson()
    expect(sent.excludeFromContext).toBe(true)

    emitPiLine({
      type: 'response',
      id: sent.id,
      success: true,
      data: { output: 'a\n', exitCode: 0, cancelled: false, truncated: false },
    })
    await resultPromise
  })
})
