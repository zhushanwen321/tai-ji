import { type PiMessage, RpcClient } from '../src/infra/pi/rpc-client.js';
import { clearExitHandlers, collector, earlyFrame, earlyFrameBufferOf, emitPiLine, emitStdinError, killAndDriveExit, killSignals, lastWrittenJson, resetRpcClientMock } from './helpers/rpc-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('rpc-client', () => {
// ════════════════ 来源: rpc-client.test.ts ════════════════
describe('rpc-client', () => {
  /**
   * RpcClient W1 单元测试（U1-U5）+ stdin stream error 处置（RT-2#1）。
   *
   * 覆盖 plan.json：
   * - U1: sendCommand 归一 payload→data
   * - U2: sendCommand 归一正常路径（data 优先，无副作用）
   * - U3: switchSession 写入 switch_session + sessionPath
   * - U4: sendExtensionUiResponse 走 sendRaw，pending 不增长
   * - U5: sendExtensionUiResponse 三种 payload 格式（cancelled/confirmed/value）
   *
   * 退役登记（ADR-0122 防御机制清查）：W3 超时语义（U8/U8b 迟到响应丢弃 / D3a
   * RpcTimeoutError 判别）随 RPC 墙钟超时机制整体删除。
   *
   * 测试策略：mock node:child_process 的 spawn，捕获 stdin 写入，并提供一个
   * emitLine 入口把伪造的 pi stdout JSONL 行投递给 RpcClient 的 line handler，
   * 从而驱动 pending resolve。这样不依赖真实 pi 进程。
   */

  // ── Mocks（工厂单源在 helpers/rpc-client-mock.ts，vi.mock 声明留本文件——路径按本文件解析）──

  vi.mock('node:child_process', async () =>
    (await import('./helpers/rpc-client-mock')).childProcessModule())

  // D10 后 stdout 分帧走 rpc-client 自实现的 LF-only 读取器（同模块直调，无法从模块边界 mock）。
  // 测试在 fake stdout 上桥接 'data' handler，emitPiLine 直投「整行 + \n」由读取器分帧；
  // LF-only 分帧行为由 rpc-client-lf-framing.test.ts 专项覆盖。

  vi.mock('@taiji/shared', async () =>
    (await import('./helpers/rpc-client-mock')).sharedModule())

  vi.mock('@taiji/shared/paths', async () =>
    (await import('./helpers/rpc-client-mock')).sharedPathsModule())

  vi.mock('node:os', async () =>
    (await import('./helpers/rpc-client-mock')).osModule())

  vi.mock('../src/infra/pi/pi-paths.js', async () =>
    (await import('./helpers/rpc-client-mock')).piPathsModule())

  vi.mock('../src/infra/pi/pi-provider-store.js', async () =>
    (await import('./helpers/rpc-client-mock')).piProviderStoreModule())

  vi.mock('../src/infra/logger.js', async () =>
    (await import('./helpers/rpc-client-mock')).loggerModule())

  /** 读取 RpcClient 内部 pending 数（反射，仅测试用；U1 pi-rpc 收敛后经 registry 部件 pendingSize 只读侧）。 */
  function pendingSize(client: unknown): number {
    return (client as { pendingRegistry: { pendingSize: number } }).pendingRegistry.pendingSize
  }

  // ── Tests ──────────────────────────────────────────────────────────

  describe('RpcClient W1', () => {
    let client: RpcClient

    beforeEach(async () => {
      resetRpcClientMock()

      const { RpcClient } = await import('../src/infra/pi/rpc-client.js')
      client = new RpcClient({ cwd: '/project' })
      await client.start()
    })

    afterEach(async () => {
      // kill 走 SIGTERM + 等待 exit；helper fakeProc 的 kill 即死语义微任务驱动 exit 清 pending
      try { await client.kill() } catch { /* noop */ }
      clearExitHandlers()
    })

    // ── U1: sendCommand 归一 payload→data ────────────────────────────
    it('U1: sendCommand resolves with data normalized from payload when data absent', async () => {
      // 通过 public getState 间接驱动 sendCommand('get_state')，捕获 nextId
      const statePromise = client.getState()
      // 等一拍让 sendCommand 写完 stdin 并注册 pending
      await Promise.resolve()

      // pi 回 {type:'response', id, success:true, payload:{foo:1}}（无 data）
      const sent = lastWrittenJson()
      emitPiLine({ type: 'response', id: sent.id, success: true, payload: { foo: 1 } })

      const state = await statePromise
      // 归一后 data === payload
      expect(state).toEqual({ foo: 1 })
    })

    // ── U2: sendCommand 归一正常路径（data 优先，无副作用）────────────
    it('U2: sendCommand resolves with data when both data present (data wins, no payload leak)', async () => {
      const statePromise = client.getState()
      await Promise.resolve()

      const sent = lastWrittenJson()
      // pi 回 data + payload 同时存在 → data 优先
      emitPiLine({
        type: 'response',
        id: sent.id,
        success: true,
        data: { bar: 2 },
        payload: { shouldNotWin: true },
      })

      const state = await statePromise
      expect(state).toEqual({ bar: 2 })
    })

    // ── U3: switchSession 写入 switch_session + sessionPath ───────────
    it('U3: switchSession writes {type:"switch_session", sessionPath} to stdin', async () => {
      const switchPromise = client.switchSession('/path/to/session')
      await Promise.resolve()

      const sent = lastWrittenJson()
      expect(sent.type).toBe('switch_session')
      expect(sent.sessionPath).toBe('/path/to/session')

      // 让 pi 回一个 success 让 promise resolve（switch_session 在 W1 仍走 sendCommand）
      emitPiLine({ type: 'response', id: sent.id, success: true, data: {} })
      await switchPromise
    })

    // ── U4: sendExtensionUiResponse 走 sendRaw，pending 不增长 ─────────
    it('U4: sendExtensionUiResponse writes via sendRaw (no pending entry created)', () => {
      const sizeBefore = pendingSize(client)

      client.sendExtensionUiResponse('req-1', true, 'confirm')

      const sent = lastWrittenJson()
      expect(sent.type).toBe('extension_ui_response')
      expect(sent.id).toBe('req-1')
      expect(sent.confirmed).toBe(true)

      expect(pendingSize(client)).toBe(sizeBefore)
    })

    // ── U5: sendExtensionUiResponse 三种 payload 格式 ─────────────────
    it('U5a: sendExtensionUiResponse(result=null, method=select) → {cancelled:true}', () => {
      client.sendExtensionUiResponse('r1', null, 'select')
      const sent = lastWrittenJson()
      expect(sent.id).toBe('r1')
      expect(sent.cancelled).toBe(true)
      expect(sent.confirmed).toBeUndefined()
      expect(sent.value).toBeUndefined()
    })

    it('U5b: sendExtensionUiResponse(result=true, method=confirm) → {confirmed:true}', () => {
      client.sendExtensionUiResponse('r2', true, 'confirm')
      const sent = lastWrittenJson()
      expect(sent.id).toBe('r2')
      expect(sent.confirmed).toBe(true)
      expect(sent.cancelled).toBeUndefined()
      expect(sent.value).toBeUndefined()
    })

    it('U5c: sendExtensionUiResponse(result="hello", method=input) → {value:"hello"}', () => {
      client.sendExtensionUiResponse('r3', 'hello', 'input')
      const sent = lastWrittenJson()
      expect(sent.id).toBe('r3')
      expect(sent.value).toBe('hello')
      expect(sent.confirmed).toBeUndefined()
      expect(sent.cancelled).toBeUndefined()
    })

    // [HISTORICAL] U5d「bridge 场景 {id, response} 包裹格式」用例已删除：旧 bridge 通道的
    // `{id, response}` 死分支随 bridge 重写清理（设计 bridge-rewrite-pi-0.84 §3.3-D6），
    // 唯一调用方（runtime 内部应答通道）已全改 JSON.stringify + 'select'（value 通道），该形态无
    // 生产调用方；该通道整体随 plugin-bridge 退役删除（pi1-disposition-chat-flow D7）。

    // ── U6: compact/getCommands/getSessionStats 用归一后的 data（删 readRpcData 后仍工作） ──
    it('U6a: compact returns normalized data (works without readRpcData)', async () => {
      const p = client.compact()
      await Promise.resolve()
      const sent = lastWrittenJson()
      emitPiLine({
        type: 'response',
        id: sent.id,
        success: true,
        data: { summary: 's', firstKeptEntryId: 'e1', tokensBefore: 100 },
      })
      const result = await p
      expect(result.summary).toBe('s')
      expect(result.firstKeptEntryId).toBe('e1')
      expect(result.tokensBefore).toBe(100)
    })

    it('U6b: compact returns data normalized from payload (data absent)', async () => {
      const p = client.compact()
      await Promise.resolve()
      const sent = lastWrittenJson()
      emitPiLine({
        type: 'response',
        id: sent.id,
        success: true,
        payload: { summary: 's2', firstKeptEntryId: 'e2', tokensBefore: 200 },
      })
      const result = await p
      expect(result.summary).toBe('s2')
    })

    it('U6c: getCommands returns normalized data.commands (含 sourceInfo 透传)', async () => {
      const p = client.getCommands()
      await Promise.resolve()
      const sent = lastWrittenJson()
      emitPiLine({
        type: 'response',
        id: sent.id,
        success: true,
        payload: {
          commands: [
            {
              name: 'cmd1',
              source: 'skill',
              sourceInfo: { path: '/proj/skills/cmd1/SKILL.md', source: 'skill', scope: 'project' },
            },
            { name: 'cmd2', source: 'builtin' },
          ],
        },
      })
      const result = await p
      expect(result).toEqual([
        {
          name: 'cmd1',
          source: 'skill',
          sourceInfo: { path: '/proj/skills/cmd1/SKILL.md', source: 'skill', scope: 'project' },
        },
        { name: 'cmd2', source: 'builtin' },
      ])
    })

    it('U6d: getSessionStats returns normalized data', async () => {
      const p = client.getSessionStats()
      await Promise.resolve()
      const sent = lastWrittenJson()
      emitPiLine({
        type: 'response',
        id: sent.id,
        success: true,
        data: { contextUsage: { tokens: 50, contextWindow: 1000, percent: 5 } },
      })
      const result = await p
      expect(result.contextUsage?.tokens).toBe(50)
    })

    // ── U7: setSessionName 写 set_session_name + name（W1 数据源治理）────
    it('U7a: setSessionName writes {type:"set_session_name", name} to stdin and resolves on success', async () => {
      const p = client.setSessionName('重构计划')
      await Promise.resolve()

      // 命令名与参数是 W1 接口契约锁定项（字面量 'set_session_name'，参数 { name }）
      const sent = lastWrittenJson()
      expect(sent.type).toBe('set_session_name')
      expect(sent.name).toBe('重构计划')

      emitPiLine({ type: 'response', id: sent.id, success: true, data: {} })
      await p
    })

    it('U7b: setSessionName rejects when pi responds success:false（success 检查对齐 sendCommand 约定）', async () => {
      const p = client.setSessionName('x')
      await Promise.resolve()
      const sent = lastWrittenJson()
      emitPiLine({ type: 'response', id: sent.id, success: false, error: 'pi internal error' })

      await expect(p).rejects.toThrow('pi internal error')
    })
  })

  // ── RT-2#1：stdin 流错误源头处置（同族 stdout/stderr 处置链）──────────

  describe('RpcClient stdin stream error 处置（RT-2#1）', () => {
    let client: RpcClient

    beforeEach(async () => {
      resetRpcClientMock()

      const { RpcClient } = await import('../src/infra/pi/rpc-client.js')
      client = new RpcClient({ cwd: '/project' })
      await client.start()
    })

    afterEach(async () => {
      try { await client.kill() } catch { /* noop */ }
      clearExitHandlers()
    })

    it('stdin emit error → pending reject + _exited 置位 + SIGKILL 自愈强杀', async () => {
      // 先注册一条 pending（挂起的 RPC，stream error 后必须被 reject 而非挂满超时）
      const commandPromise = client.sendCommand('get_state')
      await Promise.resolve()

      emitStdinError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))

      // ① pending reject（消息含流名，可归因 stdin 而非「pi 无响应」）
      await expect(commandPromise).rejects.toThrow(/stdin stream error/)
      // ② _exited 置位（后续 sendRaw / isAlive 立即可见死亡态）
      expect((client as unknown as { _exited: boolean })._exited).toBe(true)
      // ③ 自愈强杀触发（SIGKILL 加速进程死亡，exit 为死亡通知唯一出口）
      expect(killSignals()).toContain('SIGKILL')
    })

    it('stdin error 后 sendRaw 返回 false（失败语义源头可观测，不落 uncaught-policy log-continue）', () => {
      emitStdinError(new Error('write after end'))

      expect(client.sendRaw('{"type":"ping"}')).toBe(false)
    })
  })

  // ── W3 S6：超时后迟到响应被丢弃，不当 event 广播（自 rpc-client-timeout.test.ts 并入）──
});
// ════════════════ 来源: rpc-client-early-frame-buffer.test.ts ════════════════
describe('rpc-client-early-frame-buffer', () => {
  /**
   * RpcClient 早期帧缓冲单元测试（early-frame-buffer 设计 D1-D6 / 实施计划 u-r1-frame-buffer）。
   *
   * 覆盖（验收 7 项）：
   * - R1-1 空窗帧入缓冲；首 listener 注册同步按序重放（顺序与 pi 输出序一致）；新帧随后直通
   * - R1-2 pending 命中的 response 帧不入缓冲（D2：与 listener 无关）
   * - R1-3 上限 256 drop-oldest + warn 恰好一次（不刷屏）
   * - R1-4 重放期间某帧 listener throw 单帧隔离，后续帧继续重放（D5）
   * - R1-5 缓冲一次性：关闭后 listeners 再空集（detach 形态），新帧直通丢弃、再注册不重放（r2 复审 S3）
   * - R1-6 第二个及后续 listener 注册不触发重放（现状 Set 语义）
   * - R1-7 既有直通行为回归：listeners 非空时多播 / response 优先 / timedOutIds 迟到帧丢弃，
   *   行为与改动前完全一致
   *
   * 测试策略与 rpc-client.test.ts / rpc-client-kill-sigcont.test.ts 一致：mock node:child_process
   * 的 spawn，emitPiLine 入口把伪造的 pi stdout JSONL 行投递给 RpcClient 的 stdout data
   * handler（LF-only 读取器分帧）。不依赖真实 pi 进程。mock 骨架与驱动 helpers 收敛
   * test/helpers/rpc-client-mock.ts。
   *
   * 运行：npx vitest run test/rpc-client-early-frame-buffer.test.ts
   */

  // ── Mocks（工厂单源在 helpers/rpc-client-mock.ts，vi.mock 声明留本文件——路径按本文件解析）──

  vi.mock('node:child_process', async () =>
    (await import('./helpers/rpc-client-mock')).childProcessModule())
  vi.mock('@taiji/shared', async () =>
    (await import('./helpers/rpc-client-mock')).sharedModule())
  vi.mock('@taiji/shared/paths', async () =>
    (await import('./helpers/rpc-client-mock')).sharedPathsModule())
  vi.mock('node:os', async () =>
    (await import('./helpers/rpc-client-mock')).osModule())
  vi.mock('../src/infra/pi/pi-paths.js', async () =>
    (await import('./helpers/rpc-client-mock')).piPathsModule())
  vi.mock('../src/infra/pi/pi-provider-store.js', async () =>
    (await import('./helpers/rpc-client-mock')).piProviderStoreModule())
  vi.mock('../src/infra/logger.js', async () =>
    (await import('./helpers/rpc-client-mock')).loggerModule())


  // ── Helpers ────────────────────────────────────────────────────────

  /** getState 注册 pending 后以 response 帧回填并 resolve（R1-2 / R1-7b 共用装配；断言留在用例）。 */
  async function getStateAndReply(client: RpcClient, data: Record<string, unknown>): Promise<unknown> {
    const statePromise = client.getState()
    await Promise.resolve()
    const sent = lastWrittenJson()
    emitPiLine({ type: 'response', id: sent.id, success: true, data })
    return statePromise
  }

  // ── Tests ──────────────────────────────────────────────────────────

  describe('RpcClient 早期帧缓冲（early-frame-buffer D1-D6）', () => {
    let client: RpcClient
    let warnSpy: ReturnType<typeof vi.spyOn>
    let errorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(async () => {
      resetRpcClientMock()
      // 缓冲溢出 warn / 重放隔离 error 走 console——spy 掉避免测试输出噪音，供次数断言
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      client = new RpcClient({ cwd: '/project' })
      await client.start()
      // start 的 500ms startup 检查已结束，其注册的 exit handlers 已被 cleanup 移除
      clearExitHandlers()
    })

    afterEach(async () => {
      vi.useRealTimers()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
      await killAndDriveExit(client)
    })

    // ── R1-1 空窗入缓冲 + 首注册同步按序重放（G3 全序）────────────────
    it('R1-1: 空窗帧入缓冲；首个 listener 注册时同步按序重放，之后新帧直通且不重复', () => {
      // 空窗：无 listener，pi 依次输出 3 帧（session_start → bridge:sync → bridge:event）
      const f1 = { type: 'session_start', payload: { sessionId: 's1' } }
      const f2 = { type: 'extension_ui_request', id: 'req_sync', payload: { method: 'select' } }
      const f3 = { type: 'extension_ui_request', id: 'req_event', payload: { method: 'select' } }
      emitPiLine(f1)
      emitPiLine(f2)
      emitPiLine(f3)
      expect(earlyFrameBufferOf(client).map((m) => m.type)).toEqual(['session_start', 'extension_ui_request', 'extension_ui_request'])

      // 首 listener 注册：重放发生在 onEvent 返回前（同步），顺序 = pi 输出序
      const received: PiMessage[] = []
      client.onEvent(collector(received))
      expect(received).toEqual([f1, f2, f3])

      // attach 后新帧直通（现状分支不变），不重复投递
      const f4 = { type: 'agent_start', payload: { sessionId: 's1' } }
      emitPiLine(f4)
      expect(received).toEqual([f1, f2, f3, f4])
    })

    // ── R1-2 pending 命中的 response 帧不入缓冲（D2）──────────────────
    it('R1-2: pending 命中的 response 帧走 resolve、不进缓冲（后续 listener 不收到它）', async () => {
      const state = await getStateAndReply(client, { sessionId: 'real-id' })
      expect(state).toEqual({ sessionId: 'real-id' })

      // response 帧未入缓冲：首 listener 注册后收到的重放为空
      const received: PiMessage[] = []
      client.onEvent(collector(received))
      expect(received).toHaveLength(0)
      expect(earlyFrameBufferOf(client)).toHaveLength(0)
    })

    // ── R1-3 上限 256 drop-oldest + warn 一次（D3）────────────────────
    it('R1-3: 超过 256 帧丢最旧、重放保留最近 256 帧窗口；warn 恰好一次不刷屏', () => {
      const TOTAL = 300
      for (let i = 1; i <= TOTAL; i++) emitPiLine(earlyFrame(i, true))

      // 超限丢最旧：缓冲保留最近 256 帧（f45..f300）
      expect(earlyFrameBufferOf(client)).toHaveLength(256)
      expect(earlyFrameBufferOf(client)[0]?.type).toBe('evt_45')
      expect(earlyFrameBufferOf(client)[255]?.type).toBe('evt_300')

      // warn 一次（第 257 帧首次超限时），后续 43 次 drop 静默
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('256')

      // 重放 = 最近 256 帧连续窗口，序与 pi 输出序一致
      const received: PiMessage[] = []
      client.onEvent(collector(received))
      expect(received).toHaveLength(256)
      expect(received[0]?.type).toBe('evt_45')
      expect(received[255]?.type).toBe('evt_300')
    })

    // ── R1-4 重放 per-帧 throw 隔离（D5）──────────────────────────────
    it('R1-4: 重放中某帧 listener throw 不中断后续帧，也不炸到 onEvent 调用方', () => {
      emitPiLine({ type: 'session_start' })
      emitPiLine({ type: 'agent_start' })
      emitPiLine({ type: 'agent_end' })

      const received: PiMessage[] = []
      // 第 2 帧 throw：单帧隔离，重放继续、onEvent 正常返回
      expect(() => {
        client.onEvent((msg) => {
          if (msg.type === 'agent_start') throw new Error('interpret boom')
          received.push(msg)
        })
      }).not.toThrow()

      expect(received.map((m) => m.type)).toEqual(['session_start', 'agent_end'])
      expect(errorSpy).toHaveBeenCalledTimes(1)

      // 重放完成后缓冲已关闭，新帧照常直通
      emitPiLine({ type: 'turn_end' })
      expect(received.map((m) => m.type)).toEqual(['session_start', 'agent_end', 'turn_end'])
    })

    // ── R1-5 缓冲一次性：关闭后再空集不重放陈旧帧（r2 复审 S3）────────
    it('R1-5: 缓冲关闭后 listeners 再空集（detach 形态），新帧直通丢弃、再注册不重放', () => {
      emitPiLine({ type: 'session_start' })
      emitPiLine({ type: 'agent_start' })

      // 首注册：重放 2 帧 + 关闭缓冲
      const got1: PiMessage[] = []
      const off1 = client.onEvent(collector(got1))
      expect(got1.map((m) => m.type)).toEqual(['session_start', 'agent_start'])

      // detach：listeners 再空集（event-adapter detachSession 真实形态）
      off1()

      // 此刻新帧 = 直通丢弃（现状语义），不重新入缓冲
      emitPiLine({ type: 'agent_end' })
      expect(earlyFrameBufferOf(client)).toHaveLength(0)

      // 再注册（restore/fork 形态的首注册）：不重放陈旧帧（agent_end 已被丢弃，无帧可重放）
      const got2: PiMessage[] = []
      client.onEvent(collector(got2))
      expect(got2).toHaveLength(0)

      // 新 listener 只收未来帧
      emitPiLine({ type: 'turn_end' })
      expect(got2.map((m) => m.type)).toEqual(['turn_end'])
    })

    // ── R1-6 第二 listener 不重放（现状 Set 语义）─────────────────────
    it('R1-6: 第二个及后续 listener 注册不触发重放，只收注册之后的直通帧', () => {
      emitPiLine({ type: 'session_start' })
      emitPiLine({ type: 'agent_start' })

      const got1: PiMessage[] = []
      client.onEvent(collector(got1))
      // 首注册重放空窗帧
      expect(got1.map((m) => m.type)).toEqual(['session_start', 'agent_start'])

      // 第二注册：无重放（handoff-service ensureActive 到达形态）
      const got2: PiMessage[] = []
      client.onEvent(collector(got2))
      expect(got2).toHaveLength(0)

      // 直通多播：后续帧两个 listener 都收到（现状广播语义不变）
      emitPiLine({ type: 'agent_end' })
      expect(got1.map((m) => m.type)).toEqual(['session_start', 'agent_start', 'agent_end'])
      expect(got2.map((m) => m.type)).toEqual(['agent_end'])
    })

    // ── R1-7 既有直通行为回归（listeners 非空时与改动前一致）──────────
    it('R1-7a: listeners 非空时事件帧多播给全部 listener（现状语义不变）', () => {
      const got1: PiMessage[] = []
      const got2: PiMessage[] = []
      client.onEvent(collector(got1))
      client.onEvent(collector(got2))

      emitPiLine({ type: 'session_start', payload: { sessionId: 's1' } })
      emitPiLine({ type: 'extension_ui_request', id: 'req_sync', payload: { method: 'select' } })

      expect(got1).toHaveLength(2)
      expect(got2).toHaveLength(2)
      expect(got1[0]?.type).toBe('session_start')
      expect(got1[1]?.id).toBe('req_sync')
      expect(got2).toEqual(got1)
    })

    it('R1-7b: listeners 非空时 pending 命中的 response 仍优先 resolve、不广播给 listener', async () => {
      const got1: PiMessage[] = []
      client.onEvent(collector(got1))

      const state = await getStateAndReply(client, { sessionId: 'real-id' })
      expect(state).toEqual({ sessionId: 'real-id' })
      // response 帧未被当作 event 广播（改动前行为）
      expect(got1).toHaveLength(0)
    })

  })
});
});
