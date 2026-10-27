import { clearExitHandlers, emitPiLine, lastWrittenJson, resetRpcClientMock } from '../../test/helpers/rpc-client-mock';
import { RpcClient, type PiMessage } from '../infra/pi/rpc-client.js';
import { fanOutSettled } from '../services/session/agent-settled-fanout.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/__tests__/rpc-client.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('rpc-client', () => {
// ════════════════ 来源: rpc-client-bash.test.ts ════════════════
describe('rpc-client-bash', () => {
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

  // ── Mocks（工厂单源在 test/helpers/rpc-client-mock.ts，vi.mock 声明留本文件——路径按本文件解析）──

  vi.mock('node:child_process', async () =>
    (await import('../../test/helpers/rpc-client-mock')).childProcessModule())

  // D10 后 stdout 分帧走 rpc-client 自实现的 LF-only 读取器（同模块直调，无法从模块边界 mock）。
  // 测试在 fake stdout 上桥接 'data' handler，emitPiLine 直投「整行 + \n」由读取器分帧；
  // LF-only 分帧行为由 rpc-client-lf-framing.test.ts 专项覆盖。

  vi.mock('@taiji/shared', async () =>
    // U3 起 rpc-client 经 infra/spawn-env 门面消费 shared 的 buildOutboundChildEnv；
    // mock 需保留真实导出（否则构建器为 undefined），仅收窄白名单前缀获得可控基座
    (await import('../../test/helpers/rpc-client-mock')).sharedModule())

  vi.mock('@taiji/shared/paths', async () =>
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
      client = new RpcClient({ cwd: '/project' })
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
});
// ════════════════ 来源: rpc-client-response-guard.test.ts ════════════════
describe('rpc-client-response-guard', () => {
  /**
   * RpcClient handleMessage resolve 检查回归测试（data-source-governance review findings #7）。
   *
   * 锁定：
   * - pi 0.84.1 新增 bash_execution_update 流事件复用发起 bash RPC 的 id 且先于 response 到达
   *   （node_modules @earendil-works/pi-coding-agent dist/core/agent-session.js:2210 executeBash
   *   onChunk 回调 `this._emit({ type: "bash_execution_update", id: options?.id, delta })`；
   *   docs/rpc.md:26「bash_execution_update events also include the id of their originating
   *   bash command」）。handleMessage 仅凭 id 命中 pending 就 resolve 会把首条 delta 误当
   *   response（真 response 到达时 pending 已删 → 真实 output 丢失，bash() shape guard 落
   *   [protocol error: malformed] fallback——`!` bash live 输出丢失事故的根因）。
   * - 检查：resolve 只认 type === 'response'（pi rpc-types.ts RpcResponse union 所有变体
   *   type:'response'）；非 response 的带 id 消息走 listener 路径（event-adapter NULL_EVENTS
   *   已登记 bash_execution_update 为 no-op）。
   *
   * 红性：删掉 handleMessage 的 type 检查后 T1 三条断言（pending 未被流事件 settle /
   * resolve 到真 response 的 output / 流事件进 listener）必红。
   *
   * 策略：与 rpc-client-bash.test.ts 同构——mock node:child_process + readline，捕获 stdin
   * 写入的命令 + emitPiLine 投递伪造 pi stdout 行，测真实 bash 方法与 handleMessage 分派。
   *
   * 运行：npx vitest run src/__tests__/rpc-client-response-guard.test.ts
   */

  // ── Mocks（工厂单源在 test/helpers/rpc-client-mock.ts，vi.mock 声明留本文件——路径按本文件解析）──

  vi.mock('node:child_process', async () =>
    (await import('../../test/helpers/rpc-client-mock')).childProcessModule())

  // D10 后 stdout 分帧走 rpc-client 自实现的 LF-only 读取器（同模块直调，无法从模块边界 mock）。
  // 测试在 fake stdout 上桥接 'data' handler，emitPiLine 直投「整行 + \n」由读取器分帧；
  // LF-only 分帧行为由 rpc-client-lf-framing.test.ts 专项覆盖。

  vi.mock('@taiji/shared', async () =>
    // U3 起 rpc-client 经 infra/spawn-env 门面消费 shared 的 buildOutboundChildEnv；
    // mock 需保留真实导出（否则构建器为 undefined），仅收窄白名单前缀获得可控基座
    (await import('../../test/helpers/rpc-client-mock')).sharedModule())

  vi.mock('@taiji/shared/paths', async () =>
    (await import('../../test/helpers/rpc-client-mock')).sharedPathsModule())

  vi.mock('node:os', async () =>
    (await import('../../test/helpers/rpc-client-mock')).osModule())

  vi.mock('../infra/pi/pi-paths.js', async () =>
    (await import('../../test/helpers/rpc-client-mock')).piPathsModule())

  vi.mock('../infra/pi/pi-provider-store.js', async () =>
    (await import('../../test/helpers/rpc-client-mock')).piProviderStoreModule())

  vi.mock('../infra/logger.js', async () =>
    (await import('../../test/helpers/rpc-client-mock')).loggerModule())

  /** 等一个 macrotask，让 promise 的 settle 状态可观测（不用 fake timers——无 timer 断言需求） */
  async function nextMacrotask(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0))
  }

  // ── Tests ────────────────────────────────────────────────────────

  describe('RpcClient handleMessage resolve 检查（type === "response"）', () => {
    let client: RpcClient

    beforeEach(async () => {
      resetRpcClientMock()

      const { RpcClient } = await import('../infra/pi/rpc-client.js')
      client = new RpcClient({ cwd: '/project' })
      await client.start()
    })

    afterEach(async () => {
      try { await client.kill() } catch { /* noop */ }
      clearExitHandlers()
    })

    // T1（核心红性）：带同 id 的非 response 消息（bash_execution_update）先到 + response 后到
    it('T1: bash_execution_update 先到不误 resolve；真 response 后到才 resolve，流事件进 listener', async () => {
      const events: PiMessage[] = []
      client.onEvent((e) => events.push(e))

      let settled = false
      const resultPromise = client.bash('pwd')
      void resultPromise.then(() => { settled = true })
      await Promise.resolve()

      const sent = lastWrittenJson()
      expect(sent.type).toBe('bash')

      // 1) 流事件先到（复用同一 RPC id，对齐 pi 0.84.1 agent-session.js:2210 的 emit 形态）
      emitPiLine({ type: 'bash_execution_update', id: sent.id, delta: '/Users/x\n' })
      await nextMacrotask()
      // pending 未被流事件 settle（删检查时此处红：首条 delta 已误 resolve）
      expect(settled).toBe(false)

      // 2) 真 response 后到 → resolve 到的是真 response（data.output 为真值而非 protocol error fallback）
      emitPiLine({
        type: 'response',
        command: 'bash',
        id: sent.id,
        success: true,
        data: { output: '/Users/x\n', exitCode: 0, cancelled: false, truncated: false },
      })
      const result = await resultPromise
      expect(result.output).toBe('/Users/x\n')
      expect(result.exitCode).toBe(0)

      // 3) 流事件走 listener 路径不吞（删检查时此处红：bash_execution_update 被 pending resolve 吞掉）。
      //    delta 是 pi 0.84.1 流事件顶层字段（PiMessage 宽类型未声明，运行时检查式断言）
      expect(
        events.some((e) => e.type === 'bash_execution_update' && e.id === sent.id
          && (e as { delta?: unknown }).delta === '/Users/x\n'),
      ).toBe(true)
    })

    // T2: 检查反向对照——response 消息仍走 pending resolve，不泄漏进 listener
    it('T2: response（带 pending id）resolve 后不进 onEvent listener', async () => {
      const events: PiMessage[] = []
      client.onEvent((e) => events.push(e))

      const resultPromise = client.bash('echo ok')
      await Promise.resolve()
      const sent = lastWrittenJson()

      emitPiLine({
        type: 'response',
        command: 'bash',
        id: sent.id,
        success: true,
        data: { output: 'ok\n', exitCode: 0, cancelled: false, truncated: false },
      })
      const result = await resultPromise
      expect(result.output).toBe('ok\n')
      expect(events.filter((e) => e.type === 'response')).toHaveLength(0)
    })

    // T3: 多条流事件（多次 delta）全部进 listener，pending 只被最终 response resolve
    it('T3: 多条 bash_execution_update 全部进 listener，pending 等最终 response', async () => {
      const events: PiMessage[] = []
      client.onEvent((e) => events.push(e))

      const resultPromise = client.bash('seq 1 3')
      await Promise.resolve()
      const sent = lastWrittenJson()

      emitPiLine({ type: 'bash_execution_update', id: sent.id, delta: '1\n' })
      emitPiLine({ type: 'bash_execution_update', id: sent.id, delta: '2\n' })
      emitPiLine({ type: 'bash_execution_update', id: sent.id, delta: '3\n' })
      emitPiLine({
        type: 'response',
        command: 'bash',
        id: sent.id,
        success: true,
        data: { output: '1\n2\n3\n', exitCode: 0, cancelled: false, truncated: false },
      })

      const result = await resultPromise
      expect(result.output).toBe('1\n2\n3\n')
      expect(events.filter((e) => e.type === 'bash_execution_update')).toHaveLength(3)
    })
  })
});
});

// ======================================================================
// ← src/__tests__/agent-settled-fanout.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('agent-settled-fanout', () => {
describe('fanOutSettled', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // 吞掉 warn 输出防测试刷屏；断言其调用次数与内容（异常隔离的观测范围）
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('全部订阅者收到同一 sessionId', () => {
    const a = vi.fn()
    const b = vi.fn()
    const listeners = new Set([a, b])

    fanOutSettled(listeners, 'sess-1')

    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith('sess-1')
    expect(b).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledWith('sess-1')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('单订阅者抛错不阻断其余路径（异常隔离契约）', () => {
    const first = vi.fn(() => { throw new Error('delivery kernel exploded') })
    const second = vi.fn()
    const third = vi.fn()
    const listeners = new Set([first, second, third])

    // 不应向调用方抛出（interpret 批次不能因单个订阅者崩溃）
    expect(() => fanOutSettled(listeners, 'sess-1')).not.toThrow()

    // 抛错订阅者之后的路径照常收到分发
    expect(second).toHaveBeenCalledWith('sess-1')
    expect(third).toHaveBeenCalledWith('sess-1')
  })

  it('异常订阅者 warn 留痕（含错误对象，可观测）', () => {
    const boom = new Error('listener failed')
    const listeners = new Set([() => { throw boom }, () => {}])

    fanOutSettled(listeners, 'sess-1')

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith('[runtime] agentSettled listener failed:', boom)
  })

  it('全部订阅者异常 → 每个各 warn 一次，不抛出', () => {
    const listeners = new Set([
      () => { throw new Error('a') },
      () => { throw new Error('b') },
    ])

    expect(() => fanOutSettled(listeners, 'sess-1')).not.toThrow()
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  it('空订阅列表 → no-op 且不 warn', () => {
    fanOutSettled(new Set(), 'sess-1')
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
});
