import { trashDirectory } from '../../../infra/system/trash.js';
import type { IMessageBus } from '../../message-bus/message-bus.js';
import type { IConfigStore } from '../../ports/config.js';
import type { IProcessManager } from '../../ports/pi-engine.js';
import type { ISessionStore } from '../../ports/session.js';
import type { WorkspaceService } from '../../workspace/workspace-service.js';
import { applySessionOccupancyTransition } from '../event-interpreter.js';
import { createSessionDeliveryRegistry } from '../session-delivery-registry.js';
import { ISessionRegisterDeps, type ILifecycleSessionOps } from '../session-internal.js';
import { SessionLifecycle } from '../session-lifecycle.js';
import { SkillInjectionResult, type SkillInjector } from '../skill-injector.js';
import type { IManagedSessionView } from '../types.js';
import type { SessionSummary } from '@taiji/shared';
import { getAttachmentsDir, getSessionStoreDir } from '@taiji/shared/paths';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/services/session/__tests__/session-attachment-cascade.test.ts
// ======================================================================

// D5 整树软删（trashDirectory）确定性化：platform 钉 linux → 非 mac 降级 rmSync 分支
// （真实 fs 效果，落在 globalSetup 钉扎的 tmp 数据目录内）；execFileSync mock 兜底
// 锁定零子进程（任何残留 mac 分支都不会触真实废纸篓）。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: () => 'linux' }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn() }
})


/** 唯一 sessionId（须匹配 getAttachmentsDir 的 `^[A-Za-z0-9_-]+$` 穿越校验）。 */
function uniqueSid(): string {
  return 'attachcascade' + Math.random().toString(36).slice(2, 10)
}


function makeLifecycle(sid: string, filePath: string, cwd: string): SessionLifecycle {
  const svc = {
    findScannedSession: vi.fn(() => ({
      id: sid,
      filePath,
      cwd,
      timestamp: new Date().toISOString(),
      name: 'test',
      outcome: null,
      lastModified: Date.now(),
      size: 100,
    })),
    removeSessionEntry: vi.fn(),
  } as unknown as ILifecycleSessionOps
  const sessionStore = {
    trash: vi.fn(async () => {}),
    // D5 整树软删经 ISessionStore.trashDirectory 端口（组合根注入 infra trashDirectory）：
    // mock 同源委托真实 infra 函数——platform 钉 linux 走 rmSync 分支，保住「真实 fs
    // 落盘效果」断言意图（no-op mock 会让树留在原地、断言必红）。
    trashDirectory: (dirPath: string) => trashDirectory(dirPath),
    invalidateMetaCache: vi.fn(),
    invalidateScanCache: vi.fn(),
    refreshAll: vi.fn(),
  } as unknown as ISessionStore
  const registerDeps = {
    adapterFactory: vi.fn(),
    getMessageBus: vi.fn(() => null),
    broadcastGlobal: vi.fn(),
  } as unknown as ISessionRegisterDeps
  return new SessionLifecycle(
    svc,
    {} as unknown as IProcessManager,
    {} as unknown as IConfigStore,
    sessionStore,
    {} as unknown as WorkspaceService,
    registerDeps,
  )
}


/**
 * 级联删除用例骨架：建 tmp 会话文件 +（seedAttachmentDir 时）树内附件目录树 → 断言种子在位 →
 * 驱动 `SessionLifecycle.delete` → 用例断言 → finally 双清理（workDir + session 存储树目录）。
 * 树目录经 shared 公式推导（globalSetup 钉扎的 tmp 数据目录内，不触真实数据目录）。
 */
async function withCascadeFixture(
  seedAttachmentDir: boolean,
  run: (ctx: { sid: string; filePath: string; attachmentDir: string; lifecycle: SessionLifecycle }) => Promise<void>,
): Promise<void> {
  const sid = uniqueSid()
  const workDir = mkdtempSync(join(tmpdir(), 'taiji-attachment-cascade-'))
  const filePath = join(workDir, `${sid}.jsonl`)
  writeFileSync(filePath, '{"type":"session"}\n')
  const attachmentDir = getAttachmentsDir(sid)
  if (seedAttachmentDir) {
    mkdirSync(attachmentDir, { recursive: true })
    writeFileSync(join(attachmentDir, 'paste-1.png'), 'png-bytes')
    writeFileSync(join(attachmentDir, 'paste-2.png'), 'png-bytes')
    expect(existsSync(attachmentDir)).toBe(true)
  }

  try {
    const lifecycle = makeLifecycle(sid, filePath, workDir)
    await run({ sid, filePath, attachmentDir, lifecycle })
  } finally {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    // 整树软删的残留面（树删失败 / 未建树的形态）+ 附件目录自身一并清理
    rmSync(join(getSessionStoreDir(), sid), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    rmSync(attachmentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-attachment-cascade', () => {
describe('SessionLifecycle.delete —— 附件目录随整树软删回收', () => {
  it('删会话 → `<root>/<sessionId>/` 整树消失（附件目录随树进废纸篓）', async () => {
    await withCascadeFixture(true, async ({ sid, attachmentDir, lifecycle }) => {
      await lifecycle.delete(sid)
      expect(existsSync(attachmentDir)).toBe(false)
      expect(existsSync(join(getSessionStoreDir(), sid))).toBe(false)
    })
  })

  it('重复删除幂等：树已不存在时 delete 不抛（存在性守卫，不空跑软删通道）', async () => {
    await withCascadeFixture(false, async ({ sid, attachmentDir, lifecycle }) => {
      await lifecycle.delete(sid) // 首次：树本就不存在（幂等 no-op）
      await lifecycle.delete(sid) // 再次：仍不抛
      expect(existsSync(attachmentDir)).toBe(false)
    })
  })
})
});

// ======================================================================
// ← src/services/session/__tests__/terminal-lifecycle-cascade.test.ts
// ======================================================================

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


vi.mock('node-pty', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-pty')>()
  return { ...actual, spawn: vi.fn(() => {
    const pty = createMockPty()
    pty.write = vi.fn()
    pty.resize = vi.fn()
    pty.kill = vi.fn()
    mockPtys.push(pty)
    return pty
  }), }
})


// ── 销毁收敛链 hermetic 化（防真实数据目录 / 真实 ps；同 session-entry-removal.test.ts）──
vi.mock('../../../infra/crash-journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/crash-journal.js')>()
  return { ...actual, getCrashJournal: () => ({ append: () => {} }), }
})

vi.mock('../runtime-checkpoint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime-checkpoint.js')>()
  return { ...actual, getRuntimeCheckpointStore: () => ({ removeSession: () => {} }), }
})

vi.mock('../background-task-reaper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../background-task-reaper.js')>()
  return { ...actual, reapSessionBackgroundTasks: vi.fn(async () => undefined), }
})

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => '/mock/pi-agent-dir', }
})


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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('terminal-lifecycle-cascade', () => {
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
});

// ======================================================================
// ← src/services/session/__tests__/session-delivery-injection.test.ts
// ======================================================================

/** 最小装置：真 registry + mock client/deps + 可编程 spy 注入器。 */
function makeHarness(injectorResult?: Partial<SkillInjectionResult>) {
  const calls: string[] = []
  const client = {
    prompt: vi.fn(async (..._args: unknown[]) => {
      calls.push('prompt')
      return {}
    }),
  }
  const view = {
    id: 's1',
    cwd: '/test/workspace',
    lastActiveAt: 1_000,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
  }
  const publish = vi.fn((_sid: string, msg: { type: string }) => {
    calls.push(`publish:${msg.type}`)
  })
  const inject = vi.fn(async (_client: unknown, text: string): Promise<SkillInjectionResult> => ({
    text: `<<injected:${text}>>`,
    notices: [],
    ...injectorResult,
  }))
  const injector = { inject } as unknown as SkillInjector
  const settledCbs: Array<(sid: string) => void> = []
  const registry = createSessionDeliveryRegistry(
    {
      getSession: (sid) => (sid === view.id ? (view as unknown as IManagedSessionView) : undefined),
      ensureActive: async (sid) => {
        calls.push(`ensureActive:${sid}`)
        return client as unknown as never
      },
      subscribeAgentSettled: (cb) => {
        settledCbs.push(cb)
        return () => {}
      },
      recordWorkspace: () => {},
      getMessageBus: () => ({ publish } as unknown as IMessageBus),
    },
    injector,
  )
  const emitSettled = (sid = view.id): void => {
    for (const cb of settledCbs) cb(sid)
  }
  return { registry, client, view, publish, inject, calls, emitSettled }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-delivery-injection', () => {
describe('A2-MF-C：deliverText 挂 skill 注入', () => {
  it('sendDirect：prompt 之前注入原始内容，notice 在 prompt 之后（顺序契约）', async () => {
    const notices = [{ reason: 'skill_missing' as const, skills: ['ghost'] }]
    const h = makeHarness({ notices })
    await h.registry.sendDirect('s1', '首条消息')
    // 注入收到原始内容（prompt 之前）
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(h.inject.mock.calls[0][1]).toBe('首条消息')
    // prompt 收到注入产物（三参形态：images undefined + streamingBehavior undefined）
    expect(h.client.prompt).toHaveBeenCalledWith('<<injected:首条消息>>', undefined, undefined)
    // 顺序：ensureActive → occupancy 'dispatching' 置位帧（[RT-4#10] 前移至 prompt 之前，
    // RPC 往返窗内预检/回收豁免不再呈 idle）→ prompt → notice（发送成功后才发布）。
    // prompt 后的置位重复调用被原语全等去重（不再广播第二帧）。
    expect(h.calls).toEqual(['ensureActive:s1', 'publish:session.occupancy', 'prompt', 'publish:session.skillNotice'])
    const noticeMsg = h.publish.mock.calls.find(([, msg]) => (msg as { type: string }).type === 'session.skillNotice')
    expect(noticeMsg![0]).toBe('s1')
    expect((noticeMsg![1] as unknown as { payload: { reason: string; skills: string[] } }).payload)
      .toEqual({ sessionId: 's1', reason: 'skill_missing', skills: ['ghost'] })
  })

  it('[RT-4#10] 置位先于 prompt：prompt 执行时点 occupancy 已 dispatching（RPC 往返窗内状态不再回退）', async () => {
    const h = makeHarness()
    let occupancyAtPrompt: { turn?: string; isGenerating?: boolean } | null = null
    ;(h.client.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // prompt mock 执行时点读取 session 视图：前移置位后此处必须已是 dispatching
      occupancyAtPrompt = {
        turn: (h.view as unknown as { occupancy?: { turn: string } }).occupancy?.turn,
      }
      return {}
    })
    await h.registry.sendDirect('s1', '内容')
    // prompt 执行时点：dispatching 已写入（旧实现此点仍是 idle——置位在 prompt 之后）
    expect(occupancyAtPrompt).toEqual({ turn: 'dispatching' })
  })

  it('[RT-4#10] prompt 失败按拒绝分型定终态：processing 拒绝 → idle（v3 busy 分型重试退役）', async () => {
    const h = makeHarness()
    ;(h.client.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('prompt failed: Cannot ... Agent is already processing'),
    )
    await expect(h.registry.sendDirect('s1', 'x')).rejects.toThrow('Agent is already processing')
    // v3：processing 不再分型反转（busy 分型重试随忙闲门禁退役）——与一切真失败同型收尾
    //（'reject-other'：turn 没跑起来 → idle，错误经调用方 throw 显式上报）
    expect(h.view.isGenerating).toBe(false)
    expect((h.view as unknown as { occupancy?: { turn: string } }).occupancy?.turn).toBe('idle')
  })

  it('[RT-4#10] prompt 失败按拒绝分型定终态：非 busy 真失败 → idle（不卡 dispatching）', async () => {
    const h = makeHarness()
    ;(h.client.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EPIPE gone'))
    await expect(h.registry.sendDirect('s1', 'x')).rejects.toThrow('EPIPE gone')
    // 'reject-other' 行：turn 没跑起来 → idle
    expect(h.view.isGenerating).toBe(false)
    expect((h.view as unknown as { occupancy?: { turn: string } }).occupancy?.turn).toBe('idle')
  })

  it('内核 send 入口（session_manager send / create 直投消费方）：同款注入', async () => {
    const h = makeHarness()
    await h.registry.getOrCreateDelivery('s1').sendChecked({ payload: { kind: 'text', content: 'agent 构造' } })
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(h.inject.mock.calls[0][1]).toBe('agent 构造')
    expect(h.client.prompt).toHaveBeenCalledWith('<<injected:agent 构造>>', undefined, 'steer')
  })

  it('busy 入队 → settled flush 的投递同样经注入（queued 路径不旁路）', async () => {
    const h = makeHarness()
    // busy 置位/复位经转移原语（u3c 单写原语收尾；publish null 与改前直写一致零广播）
    applySessionOccupancyTransition(h.view, null, 'generating')
    const handle = h.registry.getOrCreateDelivery('s1')
    handle.send({ payload: { kind: 'text', content: '排队的消息' } })
    expect(h.inject).not.toHaveBeenCalled() // busy 期只入队，未注入
    expect(handle.depth()).toBe(1)
    // idle 边沿（settled + 标志复位）→ flush：此刻才注入 + prompt
    applySessionOccupancyTransition(h.view, null, 'idle')
    h.emitSettled()
    await vi.waitFor(() => expect(handle.depth()).toBe(0), { interval: 1 })
    expect(h.inject).toHaveBeenCalledTimes(1)
    expect(h.inject.mock.calls[0][1]).toBe('排队的消息')
    expect(h.client.prompt).toHaveBeenCalledWith('<<injected:排队的消息>>', undefined, 'steer')
  })

  it('prompt 失败：notice 不发布（发送成功后时机契约的否定用例）', async () => {
    const h = makeHarness({ notices: [{ reason: 'skill_missing', skills: ['ghost'] }] })
    ;(h.client.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pi reject'))
    await expect(h.registry.sendDirect('s1', 'x')).rejects.toThrow('pi reject')
    // skillNotice 零发布（notice 时机契约否定用例不变）；[RT-4#10] occupancy 帧例外——
    // 前移置位 + 失败收尾会产生 dispatching/idle 两帧（合法派生视图，不属于 notice 否定用例）
    expect(h.publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.skillNotice')).toHaveLength(0)
  })

  it('notices 为空：不发布 skillNotice（no-op 零噪音）；真注入器纯文本 no-op 原文通过', async () => {
    const h = makeHarness()
    await h.registry.sendDirect('s1', '纯文本')
    // skillNotice 零发布；occupancy 帧是 D2 挂点迁移后的合法派生视图输出（'dispatching'），
    // 不在本断言否定用例内（顺序契约用例已单独锁定）
    expect(h.publish.mock.calls.filter(([, m]) => (m as { type: string }).type === 'session.skillNotice')).toHaveLength(0)
    // 真 SkillInjector：无标记在 parseSkillMarkers 短路，不触达映射源与任何 RPC
    //（映射源若被读取即翻红——stub 计数断言在下方）
    const { createSessionDeliveryRegistry: createReal } = await import('../session-delivery-registry.js')
    const { SkillInjector } = await import('../skill-injector.js')
    let sourceReads = 0
    const realClient = { prompt: vi.fn(async () => ({})) }
    const real = createReal(
      {
        getSession: () => h.view as unknown as IManagedSessionView,
        ensureActive: async () => realClient as unknown as never,
        subscribeAgentSettled: () => () => {},
        recordWorkspace: () => {},
        getMessageBus: () => null,
      },
      // [A1 接线] D7 切源后 SkillInjector 构造必传映射源（空扫描 stub：本用例只走
      // 无标记 no-op 短路，读取计数恒 0）
      new SkillInjector({
        getGlobalSkills: () => {
          sourceReads++
          return []
        },
        getProjectSkills: async () => {
          sourceReads++
          return []
        },
      }),
    )
    await real.sendDirect('s1', '纯文本无标记')
    expect(sourceReads).toBe(0)
    expect(realClient.prompt).toHaveBeenCalledWith('纯文本无标记', undefined, undefined)
  })
})
});
