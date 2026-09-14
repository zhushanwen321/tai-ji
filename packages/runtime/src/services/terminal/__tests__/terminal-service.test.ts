/**
 * TerminalService 单元测试（Phase 2 V2.1）。
 *
 * mock 策略：vi.mock('node-pty') 模拟 IPty（EventEmitter 模拟 onData/onExit + write/resize/kill）。
 * 断言 broadcast 收到的 ServerMessage 类型和 payload。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/terminal/__tests__/terminal-service.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'

// ── mock node-pty ─────────────────────────────────────────────────────────
// vi.mock 工厂被 hoisting 提升到文件顶，不能直接引用模块级变量。
// 用 vi.hoisted 创建跨工厂/测试共享的容器（vitest 标准范式）。
const { mockPtys, createMockPty } = vi.hoisted(() => {
  // IPty 的 onData/onExit 是 IEvent<T>（(listener) => IDisposable），非 EventEmitter。
  // mock 实现：维护 listener 列表，emit 时遍历调用。
  interface MockPty {
    onData: (listener: (data: string) => void) => { dispose: () => void }
    onExit: (listener: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void }
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    kill: () => void
    pid: number
    __emitData: (data: string) => void
    __emitExit: (exitCode: number) => void
  }
  const mockPtys: MockPty[] = []
  function createMockPty(): MockPty {
    const dataListeners: Array<(data: string) => void> = []
    const exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = []
    return {
      onData: (listener) => {
        dataListeners.push(listener)
        return { dispose: () => { const i = dataListeners.indexOf(listener); if (i >= 0) dataListeners.splice(i, 1) } }
      },
      onExit: (listener) => {
        exitListeners.push(listener)
        return { dispose: () => { const i = exitListeners.indexOf(listener); if (i >= 0) exitListeners.splice(i, 1) } }
      },
      write: () => {},
      resize: () => {},
      kill: () => {},
      pid: Math.floor(Math.random() * 100000),
      __emitData: (data: string) => { for (const l of dataListeners) l(data) },
      __emitExit: (exitCode: number) => { for (const l of exitListeners) l({ exitCode }) },
    }
  }
  return { mockPtys, createMockPty }
})

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const pty = createMockPty()
    // 用 vi.fn 包装让测试能 toHaveBeenCalled 断言
    pty.write = vi.fn()
    pty.resize = vi.fn()
    pty.kill = vi.fn()
    mockPtys.push(pty)
    return pty
  }),
}))

// import 必须在 vi.mock 之后
const { TerminalService } = await import('../terminal-service.js')
const { MessageBus } = await import('../../message-bus/message-bus.js')

/** 收集 publish 收到的消息（wave:perf-w07：deps 通道从 broadcast 改为 publish(sid, msg)）。 */
function createPublishCollector() {
  const messages: ServerMessage[] = []
  const publish = (_sid: string, msg: ServerMessage) => messages.push(msg)
  return { messages, publish }
}

/** mock ws（BusClient 契约：readyState + send），收集收到的原始 payload。 */
function createMockWs() {
  const sent: string[] = []
  return {
    readyState: 1 as const,
    sent,
    send: (payload: string) => { sent.push(payload) },
  }
}

/** 解析 ws 收到的最后 N 条消息。 */
function parseSent(ws: { sent: string[] }): ServerMessage[] {
  return ws.sent.map((s) => JSON.parse(s) as ServerMessage)
}

/** 从消息列表找指定 type。 */
function findMsg(msgs: ServerMessage[], type: string): ServerMessage | undefined {
  return msgs.find((m) => m.type === type)
}

beforeEach(() => {
  mockPtys.length = 0
  vi.clearAllMocks()
})

// 恢复 it 内 vi.spyOn 创建的 spy（如 console.error），避免污染后续测试。
// 只影响 vi.spyOn，不动 vi.mock 模块工厂 / vi.fn。
afterEach(() => {
  vi.restoreAllMocks()
})

describe('TerminalService', () => {
  it('TS-1: spawn 后广播 terminal.alive，ptyMap 持有 sid', async () => {
    const { messages, publish } = createPublishCollector()
    const svc = new TerminalService({ publish })
    await svc.spawn('s1', '/tmp', 80, 24)
    const alive = findMsg(messages, 'terminal.alive')
    expect(alive).toBeDefined()
    expect((alive!.payload as { sessionId: string }).sessionId).toBe('s1')
    // write 能找到 PTY（间接证明 ptyMap 持有）
    svc.write('s1', 'echo hi\n')
    expect(mockPtys[0]!.write).toHaveBeenCalledWith('echo hi\n')
  })

  it('TS-2: write 转发到 pty.write', async () => {
    const { publish } = createPublishCollector()
    const svc = new TerminalService({ publish })
    await svc.spawn('s2', undefined, 80, 24)
    svc.write('s2', 'ls -la')
    expect(mockPtys.at(-1)!.write).toHaveBeenCalledWith('ls -la')
  })

  it('TS-3: resize 转发到 pty.resize', async () => {
    const { publish } = createPublishCollector()
    const svc = new TerminalService({ publish })
    await svc.spawn('s3', undefined, 80, 24)
    svc.resize('s3', 120, 40)
    expect(mockPtys.at(-1)!.resize).toHaveBeenCalledWith(120, 40)
  })

  it('TS-4: PTY onData 触发 terminal.data 广播（含 sessionId + data）', async () => {
    const { messages, publish } = createPublishCollector()
    const svc = new TerminalService({ publish })
    await svc.spawn('s4', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitData('hello world\r\n')
    const dataMsg = findMsg(messages, 'terminal.data')
    expect(dataMsg).toBeDefined()
    expect((dataMsg!.payload as { sessionId: string; data: string })).toMatchObject({
      sessionId: 's4',
      data: 'hello world\r\n',
    })
  })

  it('TS-5: PTY onExit 触发 terminal.exit 广播 + 清理 ptyMap', async () => {
    const { messages, publish } = createPublishCollector()
    const svc = new TerminalService({ publish })
    await svc.spawn('s5', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    pty.__emitExit(42)
    const exitMsg = findMsg(messages, 'terminal.exit')
    expect(exitMsg).toBeDefined()
    expect((exitMsg!.payload as { exitCode: number }).exitCode).toBe(42)
    // 清理后 write 不再转发（ptyMap 已删）
    svc.write('s5', 'should be no-op')
    expect(pty.write).not.toHaveBeenCalledWith('should be no-op')
  })

  it('TS-6: destroyPty 调 pty.kill + 清 ptyMap', async () => {
    const { publish } = createPublishCollector()
    const svc = new TerminalService({ publish })
    await svc.spawn('s6', undefined, 80, 24)
    const pty = mockPtys.at(-1)!
    svc.destroyPty('s6')
    expect(pty.kill).toHaveBeenCalled()
    // 清理后 write no-op
    svc.write('s6', 'x')
    expect(pty.write).not.toHaveBeenCalledWith('x')
  })

  it('TS-7: kill 不存在的 sid 是 no-op（不抛错）', async () => {
    const { publish } = createPublishCollector()
    const svc = new TerminalService({ publish })
    expect(() => svc.kill('nonexistent')).not.toThrow()
    expect(() => svc.write('nonexistent', 'x')).not.toThrow()
    expect(() => svc.resize('nonexistent', 80, 24)).not.toThrow()
    expect(() => svc.destroyPty('nonexistent')).not.toThrow()
  })

  it('TS-8: spawn 幂等（同 sid 重复 spawn 不新建 PTY）', async () => {
    const { publish } = createPublishCollector()
    const svc = new TerminalService({ publish })
    await svc.spawn('s8', undefined, 80, 24)
    await svc.spawn('s8', undefined, 80, 24)
    // node-pty.spawn 应只被调一次
    const { spawn } = await import('node-pty')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('TS-9: spawn 失败抛 spawn_failed 错误（含 code）', async () => {
    const { spawn } = await import('node-pty')
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw new Error('ENOENT: shell not found')
    })
    const { publish } = createPublishCollector()
    const svc = new TerminalService({ publish })
    await expect(svc.spawn('s9', undefined, 80, 24)).rejects.toMatchObject({
      code: 'spawn_failed',
      message: expect.stringContaining('shell not found'),
    })
  })

  it('TS-10: spawn 失败时 console.error 收到序列化后的 plain object（含 message/stack/code），非裸 Error 实例', async () => {
    // 回归守卫：spawn catch 块用 serializeError(e) 把 Error 转成 plain object 再传给 console.error。
    // 若有人改回裸 e，Error 实例经 logger 的 JSON.stringify 会变成 {}，日志看不出真实错误。
    const { spawn } = await import('node-pty')
    // 带 code 的 Error（模拟 node 系统错误，验证 code 透出）
    const spawnErr = Object.assign(new Error('ENOENT: shell not found'), { code: 'ENOENT' })
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw spawnErr
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { publish } = createPublishCollector()
    const svc = new TerminalService({ publish })

    await expect(svc.spawn('s10', undefined, 80, 24)).rejects.toMatchObject({
      code: 'spawn_failed',
    })

    expect(errorSpy).toHaveBeenCalled()
    // console.error 第二个参数是 serializeError(e) 的返回值
    const serialized = errorSpy.mock.calls[0]![1]
    // 关键：不是裸 Error 实例（裸 Error 会被 logger JSON.stringify 成 {}）
    expect(serialized).not.toBeInstanceOf(Error)
    // 是含 message/stack/code 的 plain object
    expect(serialized).toMatchObject({
      message: 'ENOENT: shell not found',
      stack: expect.any(String),
      code: 'ENOENT',
    })
    // 模拟 logger 的 JSON.stringify：plain object 能正确序列化出 message（裸 Error 会变 {}）
    expect(JSON.parse(JSON.stringify(serialized)).message).toBe('ENOENT: shell not found')
  })

  // [2026-09 测试舰队审查 r2-26] TS-11（spawn env 清 ELECTRON_* 三键 + TERM 保留）已删：
  // 是 terminal-service-env.test.ts 用例 3 的真子集（那边还多 C-proc-09 deny 两键与
  // 拷贝拓扑证据键 MY_OWN_SHELL_SETTING），env 契约唯一权威在 env 文件。
})

// ── W07（D1-1 / R-05）：TerminalService × MessageBus 集成 ─────────────────
// deps.publish 注入真实 MessageBus.publish，锁定 topic 三分类语义在 terminal 三类消息上的落地：
// terminal.data=transient（订阅者收到、无 seq、不占 ring、不动 seq 计数）、
// terminal.alive/exit=stream（带 seq 入 ring，重连订阅可回放）。
describe('TerminalService × MessageBus（wave:perf-w07）', () => {
  it('W07-1: terminal.data publish 后订阅者收到且无 seq；ring 长度不变、seq 计数不变（transient 语义）', async () => {
    const bus = new MessageBus()
    const ws = createMockWs()
    bus.subscribe('s-terminal', ws)

    const svc = new TerminalService({ publish: (sid, msg) => bus.publish(sid, msg) })
    await svc.spawn('s-terminal', undefined, 80, 24)

    // spawn 已发一条 terminal.alive（stream，seq=1）。记录 data 前基线。
    const before = bus.subscribe('s-terminal', createMockWs())
    expect(before.lastSeq).toBe(1)
    expect(before.snapshot).toHaveLength(1) // alive

    mockPtys.at(-1)!.__emitData('chunk-1\r\n')

    // 订阅者收到 terminal.data，且消息无 seq 字段（transient 不分配）
    const msgs = parseSent(ws).filter((m) => m.type === 'terminal.data')
    expect(msgs).toHaveLength(1)
    expect((msgs[0]!.payload as { sessionId: string; data: string })).toMatchObject({
      sessionId: 's-terminal',
      data: 'chunk-1\r\n',
    })
    expect(msgs[0]!.seq).toBeUndefined()

    // 新订阅者视角：ring 未被 terminal.data 填充（长度仍 1），seq 计数未动（仍 1）
    const after = bus.subscribe('s-terminal', createMockWs())
    expect(after.snapshot).toHaveLength(1)
    expect(after.snapshot[0]!.type).toBe('terminal.alive')
    expect(after.lastSeq).toBe(1)
  })

  it('W07-2: terminal.alive / terminal.exit 入 ring（stream 语义：带 seq，重连订阅可回放）', async () => {
    const bus = new MessageBus()
    const svc = new TerminalService({ publish: (sid, msg) => bus.publish(sid, msg) })
    await svc.spawn('s-stream', undefined, 80, 24)
    mockPtys.at(-1)!.__emitExit(7)

    // 重连订阅者：从 ring 回放 alive + exit 两条，seq 单调递增
    const late = bus.subscribe('s-stream', createMockWs())
    expect(late.snapshot.map((m) => m.type)).toEqual(['terminal.alive', 'terminal.exit'])
    expect(late.snapshot[0]!.seq).toBe(1)
    expect(late.snapshot[1]!.seq).toBe(2)
    expect((late.snapshot[1]!.payload as { exitCode: number }).exitCode).toBe(7)
    expect(late.lastSeq).toBe(2)

    // 在线订阅者也实时收到带 seq 的 exit（exit 后 ptyMap 已清理，重新 spawn 拿新 PTY）
    const ws = createMockWs()
    bus.subscribe('s-stream', ws)
    const svc2 = new TerminalService({ publish: (sid, msg) => bus.publish(sid, msg) })
    await svc2.spawn('s-stream', undefined, 80, 24)
    mockPtys.at(-1)!.__emitExit(0)
    const exitMsgs = parseSent(ws).filter((m) => m.type === 'terminal.exit')
    expect(exitMsgs).toHaveLength(1)
    expect(typeof exitMsgs[0]!.seq).toBe('number')
  })
})
