/**
 * SessionMessageHandler backgroundTask 域 3 RPC case 分发测试（u-runtime-rpc，
 * docs/architecture/background-task-sidebar-view.md §3.3 D3/D7/D8 + §3.4 P6）。
 *
 * 覆盖：
 * - handles 认领 backgroundTask.list / output / kill
 * - list：reply backgroundTask.tasks 形状（sessionId 必带 + tasks 全量投影，D3）；
 *   副作用 = 加入 watched 集合（D8③ 订阅语义由 list 隐含：list 后 registry 变更触发
 *   onTasksChanged 变更检测回调）
 * - output：正常 tail 形状（text/truncated/lost:false，D7）+ 输出文件缺失 lost 降级
 *   （§3.1 失败路径「输出不可用」，reply 正常回执不走 error envelope）
 * - kill：回执形状 { sessionId, taskId, killed, reason }（D6 分支① killed /
 *   条目缺失 already-exited，reason 枚举透传）
 * - 端口缺省（SessionService 未组装，仅测试最小 mock 形态）→ background_task_unsupported
 *   error envelope（防御分支，对齐 handoffService 惯例）
 *
 * Mock 边界：BackgroundTaskService 用真实实例（piAgentDir 注入 mkdtemp tmp 自建自删，
 * 禁触真实数据目录；pid 原语依赖注入零真实进程）；ctx 仿 session-message-handler-import
 * 测试的 mockContext 范式。不启轮询（不调 start），变更检测手动调 checkForChanges。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/session-message-handler-background-task.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionMessageHandler, OUTPUT_TAIL_MAX_REQUEST_BYTES, type SessionHandlerContext } from '../session-message-handler.js'
import { BackgroundTaskService, type BackgroundTaskServiceDeps } from '../../services/background-task/background-task-service.js'
import type { ISessionService } from '../../interfaces.js'
import type { ClientMessage } from '@xyz-agent/shared'
import type { BackgroundTaskRegistryEntry } from '@xyz-agent/extension-protocol'

// ── fixtures / 装置（对齐 background-task-service.test.ts 形状）──────

const SID = 'sess-bg-1'
const SID_OTHER = 'sess-bg-2'
const TASK_ID = 'bt-1789-test'
const TASK_PID = 53241
const OWNER_PID = 40001
const STARTED_AT = 1_700_000_000_000

let agentDir: string

function registryPath(sessionId: string = SID): string {
  return join(agentDir, 'base-tool-enhance', sessionId, 'registry.json')
}

function makeEntry(overrides: Partial<BackgroundTaskRegistryEntry> = {}): BackgroundTaskRegistryEntry {
  return {
    taskId: TASK_ID,
    pid: TASK_PID,
    command: 'pnpm test',
    outputFile: join(agentDir, 'base-tool-enhance', SID, `${TASK_ID}.log`),
    startedAt: STARTED_AT,
    state: 'running',
    ownerPiPid: OWNER_PID,
    sessionId: SID,
    ...overrides,
  }
}

/** 按契约形状写 registry（JSON indent 2 + 尾部换行；tmp 自建自删）。 */
function writeRegistry(entries: BackgroundTaskRegistryEntry[], sessionId: string = SID): void {
  mkdirSync(join(agentDir, 'base-tool-enhance', sessionId), { recursive: true })
  writeFileSync(registryPath(sessionId), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
}

/** deps：按 pid 路由判活 + 探测/处置 spy（降级档恒过，对齐 svc 测试 makeDeps 缺省）。 */
function makeDeps(): BackgroundTaskServiceDeps {
  return {
    isPidAlive: vi.fn((pid: number) => pid === TASK_PID || pid === OWNER_PID),
    killProcessTree: vi.fn(),
    probeProcessStartTimeMs: vi.fn(async () => STARTED_AT),
  }
}

/** 真实 BackgroundTaskService（tmp piAgentDir + 注入原语；不 start 轮询）。 */
function makeService(onTasksChanged = vi.fn(), deps: BackgroundTaskServiceDeps = makeDeps()): BackgroundTaskService {
  return new BackgroundTaskService({ onTasksChanged, piAgentDir: agentDir, deps })
}

// ── handler ctx 装置（仿 session-message-handler-import.test.ts）────

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as any
}

function mockContext(sessionService: ISessionService): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    sessionService,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
  }
}

/** sessionService 桩：仅 backgroundTasks 端口被本域 case 消费（交叉可选属性缺失即防御分支形态）。 */
function fakeSessionService(backgroundTasks?: BackgroundTaskService): ISessionService {
  return (backgroundTasks ? { backgroundTasks } : {}) as unknown as ISessionService
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'bg-task-rpc-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── handles 清单 ────────────────────────────────────────────────

describe('SessionMessageHandler.handles（backgroundTask 域）', () => {
  it('认领 backgroundTask.list / output / kill 三消息', () => {
    const handler = new SessionMessageHandler(mockContext(fakeSessionService()))
    expect(handler.handles).toContain('backgroundTask.list')
    expect(handler.handles).toContain('backgroundTask.output')
    expect(handler.handles).toContain('backgroundTask.kill')
  })
})

// ── 端口缺省防御分支 ────────────────────────────────────────────

describe('SessionMessageHandler backgroundTask 端口缺省', () => {
  it('backgroundTasks 未组装 → background_task_unsupported error envelope（sessionId 必带）', async () => {
    const ctx = mockContext(fakeSessionService(undefined))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('backgroundTask.list', { sessionId: SID }), ws)
    await handler.handleSessionMessage(msg('backgroundTask.output', { sessionId: SID, taskId: TASK_ID }), ws)
    await handler.handleSessionMessage(msg('backgroundTask.kill', { sessionId: SID, taskId: TASK_ID }), ws)

    expect(ctx.sendError).toHaveBeenCalledTimes(3)
    for (const call of vi.mocked(ctx.sendError).mock.calls) {
      expect(call[1]).toBe('background_task_unsupported')
      expect(call[4]).toEqual({ sessionId: SID })
    }
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})

// ── backgroundTask.list ─────────────────────────────────────────

describe('SessionMessageHandler backgroundTask.list', () => {
  it('reply backgroundTask.tasks 形状：sessionId 必带 + registry 全量投影 + corrupted:false 正常拍；markWatched 基线不广播', async () => {
    writeRegistry([makeEntry(), makeEntry({ taskId: 'bt-1789-other', state: 'exited', exitCode: 0 })])
    const onTasksChanged = vi.fn()
    const svc = makeService(onTasksChanged)
    const ctx = mockContext(fakeSessionService(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('backgroundTask.list', { sessionId: SID }), ws)

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.tasks', {
      sessionId: SID,
      tasks: [
        expect.objectContaining({ taskId: TASK_ID, state: 'running' }),
        expect.objectContaining({ taskId: 'bt-1789-other', state: 'exited', exitCode: 0 }),
      ],
      corrupted: false,
    })
    // markWatched 基线语义：拉取时点即已见状态，list 本身不触发变更回调
    expect(onTasksChanged).not.toHaveBeenCalled()
  })

  it('list 拉取加入 watched（D8③）：list 后 registry 变更 → checkForChanges 触发 onTasksChanged', async () => {
    writeRegistry([makeEntry()])
    const onTasksChanged = vi.fn()
    const svc = makeService(onTasksChanged)
    const ctx = mockContext(fakeSessionService(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('backgroundTask.list', { sessionId: SID }), ws)
    expect(onTasksChanged).not.toHaveBeenCalled()

    // list 之后的状态迁移（running → exited）：watched 集合命中，变更检测回调触发
    writeRegistry([makeEntry({ state: 'exited', exitCode: 1 })])
    svc.checkForChanges()
    expect(onTasksChanged).toHaveBeenCalledTimes(1)
    expect(onTasksChanged).toHaveBeenCalledWith(SID)
  })

  it('损坏 registry（非法 JSON）→ reply corrupted=true + 空表（S7 错误条依据，.corrupt 隔离保留现场）', async () => {
    mkdirSync(join(agentDir, 'base-tool-enhance', SID), { recursive: true })
    writeFileSync(registryPath(), '{ broken json', 'utf8')
    const svc = makeService()
    const ctx = mockContext(fakeSessionService(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('backgroundTask.list', { sessionId: SID }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.tasks', {
      sessionId: SID,
      tasks: [],
      corrupted: true,
    })
    // D1 语义：损坏现场隔离为 .corrupt（人工恢复入口）
    expect(existsSync(`${registryPath()}.corrupt`)).toBe(true)
  })

  it('损坏后自愈（重新写入合法 registry）→ 后续 list 拍 corrupted=false（审查修复验收②）', async () => {
    mkdirSync(join(agentDir, 'base-tool-enhance', SID), { recursive: true })
    writeFileSync(registryPath(), '{ broken json', 'utf8')
    const svc = makeService()
    const ctx = mockContext(fakeSessionService(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    // 损坏拍
    await handler.handleSessionMessage(msg('backgroundTask.list', { sessionId: SID }, 'msg-corrupt'), ws)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-corrupt', 'backgroundTask.tasks', {
      sessionId: SID,
      tasks: [],
      corrupted: true,
    })

    // 自愈：合法 registry 重新落盘（extension 空表重建/AI 新任务路径）→ 后续拍恢复
    writeRegistry([makeEntry()])
    await handler.handleSessionMessage(msg('backgroundTask.list', { sessionId: SID }, 'msg-healed'), ws)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-healed', 'backgroundTask.tasks', {
      sessionId: SID,
      tasks: [expect.objectContaining({ taskId: TASK_ID, state: 'running' })],
      corrupted: false,
    })
  })

  it('目录/文件不存在（垃圾 sid）→ 空数组回执 + corrupted:false（非损坏，常态空表），不抛错', async () => {
    const svc = makeService()
    const ctx = mockContext(fakeSessionService(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('backgroundTask.list', { sessionId: 'nonexistent-sid' }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.tasks', {
      sessionId: 'nonexistent-sid',
      tasks: [],
      corrupted: false,
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})

// ── backgroundTask.output ───────────────────────────────────────

describe('SessionMessageHandler backgroundTask.output', () => {
  it('输出文件可读 → tail 形状 { sessionId, taskId, text, truncated:false, lost:false }', async () => {
    const entry = makeEntry()
    writeRegistry([entry])
    mkdirSync(join(agentDir, 'base-tool-enhance', SID), { recursive: true })
    writeFileSync(entry.outputFile, 'line-1\nline-2\nline-3\n', 'utf8')
    const svc = makeService()
    const ctx = mockContext(fakeSessionService(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('backgroundTask.output', { sessionId: SID, taskId: TASK_ID }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.outputResult', {
      sessionId: SID,
      taskId: TASK_ID,
      text: 'line-1\nline-2\nline-3\n',
      truncated: false,
      lost: false,
    })
  })

  it('条目不存在（registry 缺失）→ lost 降级：text 空串 + truncated false + lost true', async () => {
    const svc = makeService()
    const ctx = mockContext(fakeSessionService(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('backgroundTask.output', { sessionId: SID, taskId: TASK_ID }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.outputResult', {
      sessionId: SID,
      taskId: TASK_ID,
      text: '',
      truncated: false,
      lost: true,
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('maxBytes 超 1MB → clamp 到 OUTPUT_TAIL_MAX_REQUEST_BYTES（D6 #1/BG-4）；缺省不传透传 undefined（service 默认 32KB）', async () => {
    const entry = makeEntry()
    writeRegistry([entry])
    mkdirSync(join(agentDir, 'base-tool-enhance', SID), { recursive: true })
    writeFileSync(entry.outputFile, 'x'.repeat(64), 'utf8')
    const svc = makeService()
    const tailSpy = vi.spyOn(svc, 'getOutputTail')
    const ctx = mockContext(fakeSessionService(svc))
    const handler = new SessionMessageHandler(ctx)

    // 客户端声明 100MB 窗口 → 钳到 1MB（readOutputTail 按窗口 alloc，无上界即内存失控面）
    await handler.handleSessionMessage(
      msg('backgroundTask.output', { sessionId: SID, taskId: TASK_ID, maxBytes: 100 * 1024 * 1024 }),
      mockWs(),
    )
    expect(tailSpy).toHaveBeenCalledWith(SID, TASK_ID, OUTPUT_TAIL_MAX_REQUEST_BYTES)

    // 合法小窗口原样透传（clamp 只剪上界，不改写正常请求）
    await handler.handleSessionMessage(
      msg('backgroundTask.output', { sessionId: SID, taskId: TASK_ID, maxBytes: 1024 }, 'msg-2'),
      mockWs(),
    )
    expect(tailSpy).toHaveBeenLastCalledWith(SID, TASK_ID, 1024)

    // 缺省不传 → undefined 透传（service 层默认 32KB 生效，不被 clamp 改写为 1MB）
    await handler.handleSessionMessage(
      msg('backgroundTask.output', { sessionId: SID, taskId: TASK_ID }, 'msg-3'),
      mockWs(),
    )
    expect(tailSpy).toHaveBeenLastCalledWith(SID, TASK_ID, undefined)
  })
})

// ── backgroundTask.kill ─────────────────────────────────────────

describe('SessionMessageHandler backgroundTask.kill', () => {
  it('D6 分支①（pid 活 + 身份过 + 属主活）→ 回执 { killed:true, reason:"killed" }，registry 预写 killing', async () => {
    writeRegistry([makeEntry()])
    const deps = makeDeps()
    const svc = makeService(vi.fn(), deps)
    const ctx = mockContext(fakeSessionService(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('backgroundTask.kill', { sessionId: SID, taskId: TASK_ID }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.killResult', {
      sessionId: SID,
      taskId: TASK_ID,
      killed: true,
      reason: 'killed',
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
    // 锁内预写 killing + 发信号（D6 分支①动作序），service 侧矩阵细节由 svc 域单测覆盖
    expect(deps.killProcessTree).toHaveBeenCalledWith(TASK_PID)
  })

  it('条目不存在 → 回执 { killed:false, reason:"already-exited" }，无信号', async () => {
    const deps = makeDeps()
    const svc = makeService(vi.fn(), deps)
    const ctx = mockContext(fakeSessionService(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('backgroundTask.kill', { sessionId: SID, taskId: 'bt-missing' }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.killResult', {
      sessionId: SID,
      taskId: 'bt-missing',
      killed: false,
      reason: 'already-exited',
    })
    expect(deps.killProcessTree).not.toHaveBeenCalled()
  })
})

// ── P6 session 分区（handler 层：list 的 watched 按入参 sid 定向）──

describe('SessionMessageHandler backgroundTask 分区（P6 handler 侧）', () => {
  it('list(sid=A) 的 watched 与回执只含 A；B 的 registry 变更不触发 A 的变更回调', async () => {
    writeRegistry([makeEntry()], SID)
    writeRegistry([makeEntry({ sessionId: SID_OTHER })], SID_OTHER)
    const onTasksChanged = vi.fn()
    const svc = makeService(onTasksChanged)
    const ctx = mockContext(fakeSessionService(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    // 只拉取 A
    await handler.handleSessionMessage(msg('backgroundTask.list', { sessionId: SID }), ws)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.tasks', expect.objectContaining({ sessionId: SID }))

    // B 变更：A/B 的 watched 集合独立——B 未被 list 过，不触发；A 的 mtime 未变也不触发
    writeRegistry([makeEntry({ sessionId: SID_OTHER, state: 'exited', exitCode: 0 })], SID_OTHER)
    svc.checkForChanges()
    expect(onTasksChanged).not.toHaveBeenCalled()
  })
})
