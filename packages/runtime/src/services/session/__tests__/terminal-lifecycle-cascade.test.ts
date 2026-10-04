/**
 * u4 生命周期级联单测（terminal-multi-instance，设计 §0.5 P5 / §2.3 不变量③ / impl-plan §2 u4 行）。
 *
 * 覆盖：
 * - ①会话删除级联：index.ts 组合根回调改为 `destroySessionPties(sid)`——经真实会话销毁收敛链
 *   （SessionEntryRemovalOrchestrator 的 `fireOnSessionDelete` 扇出步，四路删除路径的唯一汇聚点）
 *   驱动，断言该会话**全部**终端实例进程被杀、他会话实例不受影响（多实例逐一核对）。
 * - ②shutdown 链：`dispose-terminal-pties` 步在场且紧随 server-stop，重复调用幂等
 *   （destroyAllPties 无实例 / 二次调用均不抛、同一实例不重复杀）。
 * - ③序列一致性：SHUTDOWN_STEP_SEQUENCE 常量 ⇄ index.ts 实际打点序列逐项相等（机械对照），
 *   且打点与清理动作调用相邻（防「留打点删动作」的假接线）。打点序列按调用点文本位置收集，
 *   本体已提取成可 import 模块的步骤（EXTRACTED_STEP_MODULES 登记）按其模块内的打点字面量
 *   展开——登记不等于豁免：调用点从 index.ts 消失同样红。
 *
 * 源码级断言先例：src/__tests__/index-composition-root-wiring.test.ts（index.ts import 即执行
 * main()，无法直测，对源文件文本断言符号存在性与顺序）。
 *
 * mock 策略：vi.mock('node-pty')（同 terminal-service.test.ts 范式）；crash-journal / checkpoint
 * store / background-task-reaper / pi-paths 拦截为 hermetic（防真实数据目录与真实 ps，同
 * session-entry-removal.test.ts 范式）。终端实例经真实 TerminalService（u1 交付）驱动。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/terminal-lifecycle-cascade.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import type { SessionSummary } from '@taiji/shared'

// ── mock node-pty ─────────────────────────────────────────────────────────
const { mockPtys, createMockPty } = vi.hoisted(() => {
  // 测试内 mock 形状载体，非契约接口——类型别名（interface 会被 oe-assert 单实现初筛误拦）
  type MockPty = {
    onData: (listener: (data: string) => void) => { dispose: () => void }
    onExit: (listener: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void }
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    kill: (signal?: string) => void
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

// ── 销毁收敛链 hermetic 化（防真实数据目录 / 真实 ps；同 session-entry-removal.test.ts）──
vi.mock('../../../infra/crash-journal.js', () => ({
  getCrashJournal: () => ({ append: () => {} }),
}))
vi.mock('../runtime-checkpoint.js', () => ({
  getRuntimeCheckpointStore: () => ({ removeSession: () => {} }),
}))
vi.mock('../background-task-reaper.js', () => ({
  reapSessionBackgroundTasks: vi.fn(async () => undefined),
}))
vi.mock('../../../infra/pi/pi-paths.js', () => ({
  getPiAgentDir: () => '/mock/pi-agent-dir',
}))

const { TerminalService } = await import('../../terminal/terminal-service.js')
const { SessionEntryRemovalOrchestrator } = await import('../session-entry-removal.js')
const { SHUTDOWN_STEP_SEQUENCE, shutdownStep } = await import('../rolling-restart.js')

function createService(): InstanceType<typeof TerminalService> {
  return new TerminalService({
    publish: () => {},
    configService: {
      getTerminalConfig: () => ({ config: { shell: '/bin/echo', shellArgs: [] }, corrupted: false }),
    },
  })
}

/** 组合根 index.ts 的会话删除接线形态（u4：destroySessionPties，会话维度全实例杀）。 */
function createRemovalOrchestrator(svc: InstanceType<typeof TerminalService>): InstanceType<typeof SessionEntryRemovalOrchestrator> {
  return new SessionEntryRemovalOrchestrator({
    getSession: () => undefined,
    removeEntry: () => {},
    toSummary: (s) => ({ id: s.id, label: s.id, cwd: '', status: 'dead', lastActiveAt: 0, modelId: '', tokenCount: 0 }) as SessionSummary,
    cancelRespawn: () => {},
    clearSessionViewed: () => {},
    // index.ts: `sessionService.setOnSessionDelete((sid) => { terminalService.destroySessionPties(sid) })`
    fireOnSessionDelete: (sid) => { svc.destroySessionPties(sid) },
    getOnSessionDestroyedHandlers: () => [],
    unwatchBackgroundTasks: () => {},
    disposeHistoryReader: () => {},
    disposeTraceSync: () => {},
    disposeProjection: () => {},
    disposeRecords: () => {},
    clearMessageBusSession: () => {},
  })
}

const source = readFileSync(new URL('../../../index.ts', import.meta.url), 'utf8')

/**
 * shutdown 链中「打点 + 动作本体」已提取为可 import 模块的步骤符号 → 模块源文件。
 * 先例：index.ts import 即执行 main() 不可直测，`dispose-terminal-ptys` 步本体提取到
 * services/terminal/dispose-terminal-ptys-step.ts 后，打点字面量随之离开 index.ts 文本。
 * 源级机械对照若只扫 index.ts，会把「本体搬走了」误判成「这步没了」——按调用点位置把这些
 * 步骤展开即可保序。本表是提取登记（加登记才扫得到），不是跳过断言的豁免清单：调用点
 * 不在 index.ts 出现、或模块内打点字面量不是恰好一个，都会红。
 */
const EXTRACTED_STEP_MODULES: Record<string, URL> = {
  disposeTerminalPtysStep: new URL('../../terminal/dispose-terminal-ptys-step.ts', import.meta.url),
}

/** 读已提取步骤模块内的打点字面量（每模块恰一步：多处 / 缺漏皆为登记失效）。 */
function readExtractedStepName(moduleUrl: URL): string {
  const names = [...readFileSync(moduleUrl, 'utf8').matchAll(/shutdownStep\('([^']+)'\)/g)].map((m) => m[1]!)
  expect(names).toHaveLength(1)
  return names[0]!
}

/**
 * 按 index.ts 文本顺序收集 shutdown 实际打点序列：`shutdownStep('name')` 字面量直接取，
 * 登记过的已提取步骤取其在模块内的打点名（序列位置 = 调用点位置）。
 */
function collectActualShutdownSteps(): string[] {
  const symbols = Object.keys(EXTRACTED_STEP_MODULES)
  const pattern = new RegExp(`shutdownStep\\('([^']+)'\\)|\\b(${symbols.join('|')})\\s*\\(`, 'g')
  const steps: string[] = []
  for (const m of source.matchAll(pattern)) {
    if (m[1] !== undefined) {
      steps.push(m[1])
      continue
    }
    steps.push(readExtractedStepName(EXTRACTED_STEP_MODULES[m[2]!]!))
  }
  return steps
}

beforeEach(() => {
  mockPtys.length = 0
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('u4 ①会话删除级联（收敛链扇出 → 会话维度全实例杀）', () => {
  it('多实例会话删除：该会话全部实例进程被杀，他会话实例不受影响', async () => {
    const svc = createService()
    await svc.spawn('sess-a', undefined, 80, 24)
    await svc.spawn('sess-a', undefined, 80, 24)
    await svc.spawn('sess-b', undefined, 80, 24)
    const [aPty1, aPty2, bPty] = mockPtys

    // 走真实销毁收敛链（四路删除路径的唯一汇聚点），而非直接调服务方法——
    // 链内 onSessionDelete 扇出步即 index.ts 接线点。
    createRemovalOrchestrator(svc).remove('sess-a')

    expect(aPty1!.kill).toHaveBeenCalledTimes(1)
    expect(aPty2!.kill).toHaveBeenCalledTimes(1)
    expect(bPty!.kill).not.toHaveBeenCalled()
    expect(svc.listInstances('sess-a')).toEqual([])
    expect(svc.listInstances('sess-b')).toHaveLength(1)
  })

  it('删除不可重得的会话（无实例）不抛：收敛链扇出对新会话是 no-op', async () => {
    const svc = createService()
    expect(() => createRemovalOrchestrator(svc).remove('sess-none')).not.toThrow()
    expect(svc.listInstances('sess-none')).toEqual([])
  })
})

describe('u4 ②shutdown 终端清理步 + 幂等', () => {
  it('shutdown 序列含 dispose-terminal-pties 且紧随 server-stop', () => {
    const seq = SHUTDOWN_STEP_SEQUENCE as readonly string[]
    const terminalIdx = seq.indexOf('dispose-terminal-pties')
    expect(terminalIdx).toBe(seq.indexOf('server-stop') + 1)
    expect(seq).toContain('dispose-terminal-pties')
    expect(seq.indexOf('engine-pool-dispose')).toBeGreaterThan(terminalIdx)
    expect(seq.indexOf('close-logger')).toBeGreaterThan(terminalIdx)
  })

  it('destroyAllPties 幂等：二次调用不抛、同一实例不重复杀、无实例时 no-op', async () => {
    const svc = createService()
    // 无实例时先调一次（shutdown 早于任何终端使用 / 已清理过的重入形态）
    expect(() => svc.destroyAllPties()).not.toThrow()

    await svc.spawn('sess-a', undefined, 80, 24)
    await svc.spawn('sess-b', undefined, 80, 24)
    const [aPty, bPty] = mockPtys

    svc.destroyAllPties()
    expect(aPty!.kill).toHaveBeenCalledTimes(1)
    expect(bPty!.kill).toHaveBeenCalledTimes(1)

    // 重复调用（shutdown 重入 / 多信号）不得抛错，也不得对已回收实例重复 kill
    expect(() => svc.destroyAllPties()).not.toThrow()
    expect(aPty!.kill).toHaveBeenCalledTimes(1)
    expect(bPty!.kill).toHaveBeenCalledTimes(1)
    expect(svc.listInstances('sess-a')).toEqual([])
    expect(svc.listInstances('sess-b')).toEqual([])
  })

  it('shutdownStep 打点输出步骤名（index.ts 的打点通道与常量表同源）', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    shutdownStep('dispose-terminal-pties')
    expect(spy.mock.calls.flat().join('\n')).toContain('dispose-terminal-pties')
  })
})

describe('u4 ③序列常量与 index.ts 打点序列一致（源码级机械对照）', () => {
  it('index.ts shutdown 内 shutdownStep 调用序列逐项等于 SHUTDOWN_STEP_SEQUENCE', () => {
    expect(collectActualShutdownSteps()).toEqual([...SHUTDOWN_STEP_SEQUENCE])
  })

  it('登记的已提取步骤其调用点在 index.ts 在场（登记 ≠ 豁免：调用点消失即红）', () => {
    for (const symbol of Object.keys(EXTRACTED_STEP_MODULES)) {
      expect(source).toContain(`${symbol}(`)
    }
  })

  it('dispose-terminal-pties 打点与 destroyAllPties 调用相邻（防留打点删动作）', () => {
    const stepIdx = source.indexOf("shutdownStep('dispose-terminal-pties')")
    const callIdx = source.indexOf('terminalService.destroyAllPties()')
    expect(stepIdx).toBeGreaterThan(-1)
    expect(callIdx).toBeGreaterThan(stepIdx)
    expect(callIdx - stepIdx).toBeLessThan(400)
  })

  it('会话删除回调调 destroySessionPties（唯一会话维度回收入口，不残留 destroyPty 旧名）', () => {
    expect(source).toContain('terminalService.destroySessionPties(sid)')
    // destroyPty 旧名已从 port/实现整体删除；本断言防其以过渡态名义回流
    expect(source).not.toMatch(/terminalService\.destroyPty\(sid\)/)
  })
})
