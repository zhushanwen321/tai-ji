/**
 * TerminalService 多实例单元测试（terminal-multi-instance u1）。
 *
 * 覆盖验收条款：同会话两次新建编号 1/2 且关闭后不复用（T8 语义）、交叉校验独立码、
 * listInstances 会话范围钉死 + 含冒号 sid 负例（T13 语义、设计 §0.5 P7）、
 * destroySessionPties / destroyAllPties / destroyPty 会话维度全实例杀（T4 语义）、
 * spawn 指定形态（存活幂等 / 不存在 unknown_terminal_id）。
 *
 * mock 策略：vi.mock('node-pty')（同 terminal-service.test.ts 范式），configService 注入固定
 * shell 跳过 dscl 登录 shell 探测（确定性）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/terminal/__tests__/terminal-service-instances.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockPtys, createMockPty } = vi.hoisted(() => {
  // 测试内 mock 形状载体，非契约接口——类型别名（interface 会被 oe-assert 单实现初筛误拦）
  type MockPty = {
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
    pty.write = vi.fn()
    pty.resize = vi.fn()
    pty.kill = vi.fn()
    mockPtys.push(pty)
    return pty
  }),
}))

const { TerminalService } = await import('../terminal-service.js')

function createService(): InstanceType<typeof TerminalService> {
  return new TerminalService({
    publish: () => {},
    configService: {
      getTerminalConfig: () => ({ config: { shell: '/bin/echo', shellArgs: [] }, corrupted: false }),
    },
  })
}

beforeEach(() => {
  mockPtys.length = 0
  vi.clearAllMocks()
})

describe('TerminalService 多实例编号', () => {
  it('MI-1: 同会话两次新建得 term:<sid>:1 / term:<sid>:2', async () => {
    const svc = createService()
    const first = await svc.spawn('sess-a', undefined, 80, 24)
    const second = await svc.spawn('sess-a', undefined, 80, 24)
    expect(first).toBe('term:sess-a:1')
    expect(second).toBe('term:sess-a:2')
    // 会话间独立计数
    const other = await svc.spawn('sess-b', undefined, 80, 24)
    expect(other).toBe('term:sess-b:1')
  })

  it('MI-2: 关闭其中一个后再新建不复用已用序号（实例死绝也不回落）', async () => {
    const svc = createService()
    await svc.spawn('sess-a', undefined, 80, 24)
    await svc.spawn('sess-a', undefined, 80, 24)
    // 关闭 :2（onExit 自然退出）
    mockPtys[1]!.__emitExit(0)
    // 死绝后新建得到 :3
    const third = await svc.spawn('sess-a', undefined, 80, 24)
    expect(third).toBe('term:sess-a:3')
    // 关闭剩余的 :1 与 :3，死绝后再新建继续递增（不回落 1）
    mockPtys[0]!.__emitExit(0)
    mockPtys[2]!.__emitExit(0)
    const fourth = await svc.spawn('sess-a', undefined, 80, 24)
    expect(fourth).toBe('term:sess-a:4')
  })
})

describe('TerminalService 交叉校验（独立码）', () => {
  it('MI-3: 会话段不一致 → terminal_id_session_mismatch；不存在实例 → unknown_terminal_id（两码不同）', async () => {
    const svc = createService()
    const id = await svc.spawn('sess-a', undefined, 80, 24)

    // 两个拒绝码必须不同（同码会让 renderer 误把存活实例判为幽灵并回收）
    expect('terminal_id_session_mismatch').not.toBe('unknown_terminal_id')

    // 触发条件 1：他会话的存活实例编号 + 本会话 id → 交叉校验拒绝（不触发注册表回收）
    let mismatch: unknown
    try {
      svc.write('sess-b', id, 'x')
    } catch (e) {
      mismatch = e
    }
    expect(mismatch).toMatchObject({ code: 'terminal_id_session_mismatch' })

    // 触发条件 2：会话段一致但实例不在注册表 → unknown_terminal_id
    let unknown: unknown
    try {
      svc.write('sess-a', 'term:sess-a:999', 'x')
    } catch (e) {
      unknown = e
    }
    expect(unknown).toMatchObject({ code: 'unknown_terminal_id' })
  })

  it('MI-4: spawn 指定形态——存活幂等 no-op；不存在 unknown_terminal_id；会话段不一致 mismatch', async () => {
    const svc = createService()
    const id = await svc.spawn('sess-a', undefined, 80, 24)
    const { spawn } = await import('node-pty')

    const again = await svc.spawn('sess-a', undefined, 80, 24, id)
    expect(again).toBe(id)
    expect(spawn).toHaveBeenCalledTimes(1) // 存活 → 不新建

    await expect(svc.spawn('sess-a', undefined, 80, 24, 'term:sess-a:999')).rejects.toMatchObject({
      code: 'unknown_terminal_id',
    })
    await expect(svc.spawn('sess-a', undefined, 80, 24, 'term:sess-b:1')).rejects.toMatchObject({
      code: 'terminal_id_session_mismatch',
    })
    // 失败路径未误建
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe('TerminalService.listInstances（范围钉死被查询会话）', () => {
  it('MI-5: 只返回被查询会话实例（含存活态）；他会话实例不参与', async () => {
    const svc = createService()
    const a1 = await svc.spawn('sess-a', undefined, 80, 24)
    const a2 = await svc.spawn('sess-a', undefined, 80, 24)
    const b1 = await svc.spawn('sess-b', undefined, 80, 24)

    expect(svc.listInstances('sess-a')).toEqual([
      { terminalId: a1, alive: true },
      { terminalId: a2, alive: true },
    ])
    expect(svc.listInstances('sess-b')).toEqual([{ terminalId: b1, alive: true }])
    expect(svc.listInstances('sess-none')).toEqual([])

    // 退出后从清单消失（派生视图）
    mockPtys[0]!.__emitExit(0)
    expect(svc.listInstances('sess-a')).toEqual([{ terminalId: a2, alive: true }])
  })

  it('MI-6: 含冒号 sid 形态不误匹配（精确前缀负例）', async () => {
    const svc = createService()
    const plain = await svc.spawn('a', undefined, 80, 24) // term:a:1
    const colon = await svc.spawn('a:1', undefined, 80, 24) // term:a:1:1

    // 负例断言：查询 sid 'a:1' 不得命中外层 sid 'a' 的实例键 term:a:1
    expect(svc.listInstances('a:1')).toEqual([{ terminalId: colon, alive: true }])
    expect(svc.listInstances('a:1').map((i) => i.terminalId)).not.toContain(plain)

    // 正向：sid 'a' 的清单仍持有自己的实例
    expect(svc.listInstances('a')).toContainEqual({ terminalId: plain, alive: true })
  })
})

describe('TerminalService 生命周期回收 API', () => {
  it('MI-7: destroySessionPties 杀掉该会话全部实例，不动他会话实例', async () => {
    const svc = createService()
    await svc.spawn('sess-a', undefined, 80, 24)
    await svc.spawn('sess-a', undefined, 80, 24)
    await svc.spawn('sess-b', undefined, 80, 24)
    const [aPty1, aPty2, bPty] = mockPtys

    svc.destroySessionPties('sess-a')

    expect(aPty1!.kill).toHaveBeenCalled()
    expect(aPty2!.kill).toHaveBeenCalled()
    expect(bPty!.kill).not.toHaveBeenCalled()
    expect(svc.listInstances('sess-a')).toEqual([])
    expect(svc.listInstances('sess-b')).toHaveLength(1)
  })

  it('MI-8: destroyAllPties 全量杀', async () => {
    const svc = createService()
    await svc.spawn('sess-a', undefined, 80, 24)
    await svc.spawn('sess-b', undefined, 80, 24)
    const [aPty, bPty] = mockPtys

    svc.destroyAllPties()

    expect(aPty!.kill).toHaveBeenCalled()
    expect(bPty!.kill).toHaveBeenCalled()
    expect(svc.listInstances('sess-a')).toEqual([])
    expect(svc.listInstances('sess-b')).toEqual([])
    // 幂等：无实例时再次调用不抛
    expect(() => svc.destroyAllPties()).not.toThrow()
  })

  it('MI-9: destroyPty 仍可调用，语义 = 会话维度全实例杀', async () => {
    const svc = createService()
    await svc.spawn('sess-a', undefined, 80, 24)
    await svc.spawn('sess-a', undefined, 80, 24)
    const [aPty1, aPty2] = mockPtys

    svc.destroyPty('sess-a')

    expect(aPty1!.kill).toHaveBeenCalled()
    expect(aPty2!.kill).toHaveBeenCalled()
    expect(svc.listInstances('sess-a')).toEqual([])
  })
})
