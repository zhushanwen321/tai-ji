/**
 * SessionService × BackgroundTaskService 接线测试（u-runtime-rpc，
 * docs/architecture/background-task-sidebar-view.md §3.3 D2/D3/D8 + §3.4 P6）。
 *
 * 覆盖：
 * - 组装：SessionService 构造即创建 backgroundTasks 域（公有成员，handler 经 ctx 结构读取）
 *   并启动 mtime 轮询（fake timers 拦截 interval，变更检测手动触发）
 * - D3 广播组装：registry 变更 → checkForChanges → messageBus.publish(sessionId,
 *   backgroundTask:updated { sessionId, tasks })——单 payload 对象、sessionId 必带（规则 1/7）
 * - P6 双 session 分区：A/B 双 watched，A 变更只 publish A（payload 不含 B 的任务）；反向同
 * - D8③ 退订：removeSessionEntry 汇聚点（与 reaper 触发面 A 同挂点）unwatch——销毁后变更
 *   不再广播
 * - bus 未注入（nullable）→ 广播 no-op 不抛（晚期注入语义）
 *
 * Mock 边界：getPiAgentDir mock 到 mkdtemp tmp（真实 BackgroundTaskService 读 tmp registry，
 * 自建自删，禁触真实数据目录）；SessionService 依赖桩仿 test/session-service.test.ts
 * createSetup 最小集（构造期零 fs 触点，子模块仅存引用）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-service-background-task.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// pi-paths 动态指向 tmp（hoisted 容器承载 beforeEach 生成的新目录；BackgroundTaskService
// 与 session-service 的 reapSessionBackgroundTasks 共享同一 mock 模块实例）。
const paths = vi.hoisted(() => ({ agentDir: '' }))
vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getPiAgentDir: () => paths.agentDir,
  }
})

import { SessionService } from '../session-service.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'
import { PiSessionStore } from '../../../infra/pi/session-store.js'
import { EventAdapter } from '../../../infra/pi/event-adapter.js'
import type { IProcessManager } from '../../../services/ports/pi-engine.js'
import type { IExtensionService } from '../../../interfaces.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { BackgroundTaskRegistryEntry } from '@xyz-agent/extension-protocol'
import type { IMessageBus } from '../../../services/message-bus/message-bus.js'
import type { ServerMessage } from '@xyz-agent/shared'

// ── fixtures ──────────────────────────────────────────────────────

const SID_A = 'sess-a'
const SID_B = 'sess-b'
const TASK_ID = 'bt-1789-test'
const TASK_PID = 53241
const OWNER_PID = 40001
const STARTED_AT = 1_700_000_000_000
const BASE_MTIME = 1_700_000_100_000

/** mtime 计数器：显式 utimesSync 递增，规避同毫秒重写 mtime 不变导致变更检测漏拍。 */
let mtimeTick = 0

let agentDir: string

function registryPath(sessionId: string): string {
  return join(agentDir, 'base-tool-enhance', sessionId, 'registry.json')
}

function makeEntry(sessionId: string, overrides: Partial<BackgroundTaskRegistryEntry> = {}): BackgroundTaskRegistryEntry {
  return {
    taskId: TASK_ID,
    pid: TASK_PID,
    command: `pnpm test (${sessionId})`,
    outputFile: join(agentDir, 'base-tool-enhance', sessionId, `${TASK_ID}.log`),
    startedAt: STARTED_AT,
    state: 'running',
    ownerPiPid: OWNER_PID,
    sessionId,
    ...overrides,
  }
}

/** 按契约形状写 registry 并强制递增 mtime（tmp 自建自删）。 */
function writeRegistry(entries: BackgroundTaskRegistryEntry[], sessionId: string): void {
  mkdirSync(join(agentDir, 'base-tool-enhance', sessionId), { recursive: true })
  writeFileSync(registryPath(sessionId), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
  utimesSync(registryPath(sessionId), new Date(BASE_MTIME + ++mtimeTick * 1_000), new Date(BASE_MTIME + mtimeTick * 1_000))
}

/** 写非法 JSON registry（模拟损坏）并强制递增 mtime（触发 last-seen 变更判定）。 */
function writeBrokenRegistry(sessionId: string): void {
  mkdirSync(join(agentDir, 'base-tool-enhance', sessionId), { recursive: true })
  writeFileSync(registryPath(sessionId), '{ broken json', 'utf8')
  utimesSync(registryPath(sessionId), new Date(BASE_MTIME + ++mtimeTick * 1_000), new Date(BASE_MTIME + mtimeTick * 1_000))
}

// ── SessionService 最小装置 ───────────────────────────────────────

interface Setup {
  service: SessionService
  messageBus: IMessageBus
}

function createSetup(withBus: boolean = true): Setup {
  const messageBus: IMessageBus = {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    clearSession: vi.fn(),
  } as unknown as IMessageBus

  const service = new SessionService(
    // pm：构造期只注册 onSessionExit 回调（其余 IProcessManager 成员本域不触达，桩收窄）
    { onSessionExit: vi.fn(), getClient: vi.fn(), hasClient: vi.fn(() => false), destroyAll: vi.fn() } as unknown as IProcessManager,
    // broker
    { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() },
    // adapterFactory：桩（本域不附着 session）
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    // configStore / sessionStore：真实实例（构造期零 IO，同既有 session-service 测试范式）
    new PiConfigStore(),
    new PiSessionStore(),
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    { record: vi.fn(), list: vi.fn(() => []) } as unknown as WorkspaceService,
    withBus ? messageBus : undefined,
  )
  if (withBus) service.setMessageBus(messageBus)
  return { service, messageBus }
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'bg-task-wiring-'))
  paths.agentDir = agentDir
  mtimeTick = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── 组装 ─────────────────────────────────────────────────────────

describe('SessionService.backgroundTasks 组装', () => {
  it('构造即创建 backgroundTasks 域并启动轮询（fake timers 拦截 interval）；registry 缺失读为静默空表', () => {
    vi.useFakeTimers()
    const { service } = createSetup()
    expect(service.backgroundTasks).toBeDefined()
    expect(service.backgroundTasks.listTasks('any-sid')).toEqual({ entries: [], corrupted: false })
  })

  it('bus 未注入（nullable 构造）→ 变更广播 no-op 不抛', () => {
    vi.useFakeTimers()
    const { service } = createSetup(false)
    writeRegistry([makeEntry(SID_A)], SID_A)
    service.backgroundTasks.markWatched(SID_A)
    writeRegistry([makeEntry(SID_A, { state: 'exited', exitCode: 0 })], SID_A)
    expect(() => service.backgroundTasks.checkForChanges()).not.toThrow()
  })
})

// ── D3 广播组装 ──────────────────────────────────────────────────

describe('backgroundTask:updated 广播（D3）', () => {
  it('markWatched 基线不广播；registry 变更后 → publish(sessionId, 单 payload 对象，sessionId 必带)', () => {
    vi.useFakeTimers()
    const { service, messageBus } = createSetup()
    writeRegistry([makeEntry(SID_A)], SID_A)
    service.backgroundTasks.markWatched(SID_A)

    // 基线：markWatched 后 mtime 未变，变更检测不广播
    service.backgroundTasks.checkForChanges()
    expect(messageBus.publish).not.toHaveBeenCalled()

    // 状态迁移（running → exited）：watched 命中 → 组装广播
    writeRegistry([makeEntry(SID_A, { state: 'exited', exitCode: 1, reason: 'natural' })], SID_A)
    service.backgroundTasks.checkForChanges()

    expect(messageBus.publish).toHaveBeenCalledTimes(1)
    const [sid, msg] = vi.mocked(messageBus.publish).mock.calls[0]
    expect(sid).toBe(SID_A)
    expect(msg.type).toBe('backgroundTask:updated')
    const payload = msg.payload as ServerMessage<'backgroundTask:updated'>['payload']
    expect(payload.sessionId).toBe(SID_A)
    expect(payload.tasks).toHaveLength(1)
    expect(payload.tasks[0]).toMatchObject({ taskId: TASK_ID, state: 'exited', exitCode: 1 })
    // 正常拍显式 corrupted:false（审查修复：S7 错误条需要区分真空表与损坏空表）
    expect(payload.corrupted).toBe(false)
    // mtime 未再变：轮询重复 tick 不重播（D2 单广播源）
    service.backgroundTasks.checkForChanges()
    expect(messageBus.publish).toHaveBeenCalledTimes(1)
  })

  it('损坏拍广播 corrupted=true（.corrupt 隔离）；自愈后恢复拍 corrupted=false（审查修复验收②③）', () => {
    vi.useFakeTimers()
    const { service, messageBus } = createSetup()
    writeRegistry([makeEntry(SID_A)], SID_A)
    service.backgroundTasks.markWatched(SID_A)

    // 损坏：registry 被覆写为非法 JSON → mtime 变化 → 检测 → 广播 corrupted=true 空表
    writeBrokenRegistry(SID_A)
    service.backgroundTasks.checkForChanges()
    const calls = vi.mocked(messageBus.publish).mock.calls.filter(([, m]) => m.type === 'backgroundTask:updated')
    expect(calls).toHaveLength(1)
    const corruptPayload = calls[0][1].payload as ServerMessage<'backgroundTask:updated'>['payload']
    expect(corruptPayload.sessionId).toBe(SID_A)
    expect(corruptPayload.corrupted).toBe(true)
    expect(corruptPayload.tasks).toHaveLength(0)

    // 单广播源不破坏（验收③）：corrupted=true 广播恰一次——parse 失败仅在首拍隔离一次，
    // 共享 last-seen 判定不受透传影响（损坏拍后 .corrupt rename 引起的文件消失是另一拍
    // 合法变化，发 corrupted:false 空表，不重复损坏广播）
    service.backgroundTasks.checkForChanges()
    const callsAfter = vi.mocked(messageBus.publish).mock.calls.filter(([, m]) => m.type === 'backgroundTask:updated')
    expect(callsAfter.filter(([, m]) => (m.payload as { corrupted?: boolean }).corrupted === true)).toHaveLength(1)

    // 自愈：合法 registry 重新落盘 → 后续拍 corrupted=false + 条目恢复（S7 错误条消失依据）
    vi.mocked(messageBus.publish).mockClear()
    writeRegistry([makeEntry(SID_A)], SID_A)
    service.backgroundTasks.checkForChanges()
    const healedCalls = vi.mocked(messageBus.publish).mock.calls.filter(([, m]) => m.type === 'backgroundTask:updated')
    expect(healedCalls).toHaveLength(1)
    const healedPayload = healedCalls[0][1].payload as ServerMessage<'backgroundTask:updated'>['payload']
    expect(healedPayload.corrupted).toBe(false)
    expect(healedPayload.tasks).toHaveLength(1)
  })
})

// ── P6 双 session 分区 ───────────────────────────────────────────

describe('P6：双 session 广播分区', () => {
  it('A/B 双 watched：A 变更只 publish A（恰一次），payload 不串 B 的任务', () => {
    vi.useFakeTimers()
    const { service, messageBus } = createSetup()
    writeRegistry([makeEntry(SID_A)], SID_A)
    writeRegistry([makeEntry(SID_B, { command: 'pnpm dev (B)' })], SID_B)
    service.backgroundTasks.markWatched(SID_A)
    service.backgroundTasks.markWatched(SID_B)

    // 只 A 迁移
    writeRegistry([makeEntry(SID_A, { state: 'exited', exitCode: 0 })], SID_A)
    service.backgroundTasks.checkForChanges()

    expect(messageBus.publish).toHaveBeenCalledTimes(1)
    const [sid, msg] = vi.mocked(messageBus.publish).mock.calls[0]
    expect(sid).toBe(SID_A)
    const payload = msg.payload as ServerMessage<'backgroundTask:updated'>['payload']
    expect(payload.sessionId).toBe(SID_A)
    // 分区断言：payload 只含 A 的任务，B 的条目不出现
    expect(payload.tasks).toHaveLength(1)
    expect(payload.tasks.every((t) => t.sessionId === SID_A)).toBe(true)

    // 反向：只 B 迁移 → 只 publish B
    vi.mocked(messageBus.publish).mockClear()
    writeRegistry([makeEntry(SID_B, { command: 'pnpm dev (B)', state: 'killing' })], SID_B)
    service.backgroundTasks.checkForChanges()
    expect(messageBus.publish).toHaveBeenCalledTimes(1)
    const [sidB, msgB] = vi.mocked(messageBus.publish).mock.calls[0]
    expect(sidB).toBe(SID_B)
    expect((msgB.payload as ServerMessage<'backgroundTask:updated'>['payload']).sessionId).toBe(SID_B)
  })
})

// ── D8③ session 销毁退订 ─────────────────────────────────────────

describe('removeSessionEntry watched 退订（D8③）', () => {
  it('销毁后该 sid 的 registry 变更不再广播（bus.clearSession 同汇聚点触发）', () => {
    vi.useFakeTimers()
    const { service, messageBus } = createSetup()
    writeRegistry([makeEntry(SID_A)], SID_A)
    service.backgroundTasks.markWatched(SID_A)

    service.removeSessionEntry(SID_A)
    expect(messageBus.clearSession).toHaveBeenCalledWith(SID_A)

    // 销毁后变更：watched 已移出，变更检测不广播
    writeRegistry([makeEntry(SID_A, { state: 'exited', exitCode: 0 })], SID_A)
    service.backgroundTasks.checkForChanges()
    const updatedCalls = vi.mocked(messageBus.publish).mock.calls.filter(([, m]) => m.type === 'backgroundTask:updated')
    expect(updatedCalls).toHaveLength(0)
  })
})

// ── D2 触发面②组合根接线（index.ts adapterFactory 第三参）────────

describe('事件钩子 → checkForChanges 接线（D2 触发面②）', () => {
  it('bash 工具结束事件 → 组合根闭包触发 checkForChanges → watched 变更广播', () => {
    vi.useFakeTimers()
    const { service, messageBus } = createSetup()
    writeRegistry([makeEntry(SID_A)], SID_A)
    service.backgroundTasks.markWatched(SID_A)

    // 复刻 index.ts createAdapter 第三参的闭包形态：事件旁路 → 端口 checkForChanges
    // （回调不消费 sid——checkForChanges 对整个 watched 集合跑检测，D2 定向性豁免语义）
    const checkForChangesSpy = vi.spyOn(service.backgroundTasks, 'checkForChanges')
    const onBackgroundTaskActivity = (_sid: string) => service.backgroundTasks?.checkForChanges()

    // 真实 EventAdapter：attach 后注入 bash 工具结束事件（spawn 路径旁路触发源）
    const adapter = new EventAdapter(SID_A, vi.fn(), onBackgroundTaskActivity)
    let listener: (event: unknown) => void = () => {}
    adapter.attach({ onEvent: (l) => { listener = l as typeof listener; return () => {} } })

    // 非旁路事件不触发；bash 工具结束触发恰一次
    listener({ type: 'agent_start' })
    expect(checkForChangesSpy).not.toHaveBeenCalled()
    listener({ type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', result: { content: [] }, isError: false })
    expect(checkForChangesSpy).toHaveBeenCalledTimes(1)

    // 端到端：registry 变更落盘后事件触发 → 变更检测经共享 last-seen 判定 → 广播发出
    writeRegistry([makeEntry(SID_A, { state: 'exited', exitCode: 0 })], SID_A)
    listener({ type: 'tool_execution_end', toolCallId: 'tc-2', toolName: 'bash', result: { content: [] }, isError: false })
    const updatedCalls = vi.mocked(messageBus.publish).mock.calls.filter(([, m]) => m.type === 'backgroundTask:updated')
    expect(updatedCalls).toHaveLength(1)
    expect(updatedCalls[0][0]).toBe(SID_A)
  })
})
