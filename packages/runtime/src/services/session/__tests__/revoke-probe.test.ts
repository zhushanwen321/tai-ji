/**
 * U7 探针沉淀（message-revoke 设计 §4 验收表 A6/A9 的 CI 可跑单测形态）。
 *
 * 与 revoke-orchestrator.test.ts（U4 编排逻辑族①-⑧）的分界：本文件只沉淀两条
 * 「机制成立性」探针——A6 信令不污染（transcript 撤回前后对比 + `__taiji_nav__`
 * 命令串零残留）与 A9 workflow-running 拦截回执。材料范式对齐该文件：真实编排 +
 * 真实投递内核注册表（revoking hold / cancel / 投影视图是真实现）+ 真实
 * MessageDispatcher.sendSystemCommand（信令旁路本身是探针对象）；mock 仅 pi 边界
 * （prompt / getEntries / getCommands / clear_queue）与数据源（session view /
 * workflow 投影）。
 *
 * 探针保真度关键（A6 的牙齿）：prompt mock 按 pi 语义分派——注册命令串
 * （`/__taiji_nav__` 前缀）同步执行树回退副作用、不落 message entry（P2 前提：
 * command 不进模型、无 turn）；其余 prompt 一律按普通用户消息落 user message
 * entry（pi 开新回合的 transcript 行为）。信令若回归「走用户消息面」形态，A6 的
 * transcript 对比断言即红。
 *
 * A9 的 workflow 投影：测试内构造 records.getWorkflows 投影数据源，推导式与组合根
 * session-service 的 hasRunningWorkflow 接线逐字一致（`.records.some(r =>
 * r.status === 'running')`）——拦截锚是投影里的 running 状态本身，非硬编码布尔；
 * 不 import session-records（U6d 领地，避免在途改动耦合）。
 *
 * 运行：pnpm --filter @taiji/runtime exec vitest run src/services/session/__tests__/revoke-probe.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TAIJI_NAV_COMMAND } from '@taiji/shared'
import {
  createSessionDeliveryRegistry,
  type SessionDeliveryDeps,
} from '../session-delivery-registry.js'
import { RevokeOrchestrator } from '../revoke-orchestrator.js'
import { MessageDispatcher } from '../message-dispatcher.js'
import type { IDispatcherSessionOps } from '../session-internal.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { IManagedSessionView } from '../types.js'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { SkillInjectionResult, SkillInjector, SkillNotice } from '../skill-injector.js'

const SID = 's1'
const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const UUID_B = '11111111-2222-4333-8444-555555555555'

/** mock session view（occupancy 经转移原语写入——与 revoke-orchestrator.test.ts 同款 sentinel 视图）。 */
function makeView(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: SID,
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    occupancy: { turn: 'idle', compacting: false, bash: false },
    ...overrides,
  }
}

function msgEntry(id: string, parentId: string | null, role: string, text: string): unknown {
  return { type: 'message', id, parentId, message: { role, content: text } }
}
function labelEntry(id: string, parentId: string | null, targetId: string): unknown {
  return { type: 'label', id, parentId, label: 'taiji:revoked', targetId }
}

/** 可变 pi 树（get_entries 的数据源；prompt 副作用 mutate 它模拟 pi transcript 行为）。 */
interface MutableTree {
  entries: unknown[]
  leafId: string | null
}

/** 模拟 navigateTree 成功：label 锚挂 expectedParent、叶子切换（appendLabelChange 落盘语义）。 */
function applyRewind(tree: MutableTree, targetEntryId: string, expectedParentId: string | null): void {
  const label = labelEntry(`L-${targetEntryId}`, expectedParentId, targetEntryId) as { id: string }
  tree.entries = [...tree.entries, label]
  tree.leafId = label.id
}

/** workflow run 投影的最小形态（组合根 hasRunningWorkflow 推导只读 .records[].status）。 */
interface WorkflowRunProjection {
  id: string
  status: string
}

/** mock records 投影（A9 数据源——形态对齐组合根消费面，不 import session-records）。 */
interface WorkflowRecordsProjection {
  getWorkflows(sessionId: string): Promise<{ records: WorkflowRunProjection[] }>
}

function makeWorkflowRecords(runs: readonly WorkflowRunProjection[]): WorkflowRecordsProjection {
  return {
    async getWorkflows() {
      return { records: [...runs] }
    },
  }
}

/** 投影条目 payload 文本（守卫式读取——kind text 的 content 字段）。 */
function payloadContentOf(entry: unknown): string {
  const payload = (entry as { payload?: { content?: unknown } }).payload
  return typeof payload?.content === 'string' ? payload.content : ''
}

interface ProbeHarnessOptions {
  view?: Partial<IManagedSessionView>
  /** workflow run 投影（A9 数据源；缺省空 = 无在跑 run）。 */
  workflowRuns?: ReadonlyArray<WorkflowRunProjection>
  /** navigateTree 成功语义模拟（label 锚挂 parent、叶子切换）；缺省 = 命令无效果形态。 */
  rewind?: { target: string; parent: string | null }
}

function makeProbeHarness(opts: ProbeHarnessOptions = {}) {
  const view = makeView(opts.view)
  const tree: MutableTree = { entries: [], leafId: null }
  const promptCalls: string[] = []
  const evictSpy = vi.fn()
  const invalidateSpy = vi.fn()
  // 撤回信号广播腿 spy（[MF-1-7] deps.notifyEntryInvalidation 注入——生产 = pluginService notify 闭包）
  const signalSpy = vi.fn()
  const workflowRecords = makeWorkflowRecords(opts.workflowRuns ?? [])

  // pi 事件流的 mock 订阅槽（送达回执 message_end 经此注入——D2 第二阶段确认通道）
  let piEventHandler: ((event: unknown) => void) | undefined
  const client = {
    prompt: vi.fn(async (text: string) => {
      promptCalls.push(text)
      if (text.startsWith(`/${TAIJI_NAV_COMMAND} `)) {
        // 注册命令串：pi 同步执行、不进模型、无 turn（P2 前提）——transcript 只长 label 锚
        if (opts.rewind) applyRewind(tree, opts.rewind.target, opts.rewind.parent)
      } else {
        // 其余 prompt = pi 开新回合：user message entry 落 transcript（A6 探针的对照面——
        // 信令若走用户消息面，这里长出的 message entry 会被撤回前后对比抓红）
        const id = `m-${tree.entries.length + 1}`
        tree.entries = [...tree.entries, msgEntry(id, tree.leafId, 'user', text)]
        tree.leafId = id
      }
      return {}
    }),
    getEntries: vi.fn(async () => ({ data: { entries: tree.entries, leafId: tree.leafId } })),
    getCommands: vi.fn(async () => [{ name: TAIJI_NAV_COMMAND, source: 'taiji' }]),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    onEvent: vi.fn((handler: (event: unknown) => void) => {
      piEventHandler = handler
      return () => {
        piEventHandler = undefined
      }
    }),
    touchActivity: vi.fn(),
  }
  const injector = {
    inject: vi.fn(async (_client: unknown, text: string): Promise<SkillInjectionResult> => ({
      text,
      notices: [] as SkillNotice[],
    })),
  } as unknown as SkillInjector
  const deliveryDeps: SessionDeliveryDeps = {
    getSession: (sid: string) => (sid === SID ? view : undefined),
    ensureActive: vi.fn(async () => client as unknown as IPiEngine),
    subscribeAgentSettled: () => () => {},
    recordWorkspace: vi.fn(),
    getMessageBus: () => ({ publish: () => undefined }) as unknown as IMessageBus,
  }
  const registry = createSessionDeliveryRegistry(deliveryDeps, injector)

  // 真实 dispatcher 的 sendSystemCommand（探针对象：不经 hook / 不经内核 / 直连 prompt）
  const dispatcher = new MessageDispatcher(
    {
      ensureActive: async () => client as unknown as IPiEngine,
      getSessionByClient: () => view,
      persistSessionOutcome: vi.fn(),
      getSession: (sid: string) => (sid === SID ? view : undefined),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    } as unknown as IDispatcherSessionOps,
    { getClient: (sid: string) => (sid === SID ? (client as unknown as IPiEngine) : undefined) } as unknown as IProcessManager,
    {} as unknown as WorkspaceService,
    undefined,
  )

  const orchestrator = new RevokeOrchestrator({
    getSession: (sid: string) => (sid === SID ? view : undefined),
    ensureActive: async () => client as unknown as IPiEngine,
    // 组合根同款推导（session-service 接线逐字一致）——拦截锚是投影 running 状态
    hasRunningWorkflow: async (sid) =>
      (await workflowRecords.getWorkflows(sid)).records.some((r) => r.status === 'running'),
    evictHistoryRebuildCache: evictSpy,
    invalidateDerivedState: invalidateSpy,
    notifyEntryInvalidation: signalSpy,
    registry: () => registry,
    sendSystemCommand: (sid, commandLine, requireCommand) => dispatcher.sendSystemCommand(sid, commandLine, requireCommand),
  })

  const revoke = (targetId: string) => orchestrator.revokeMessage(SID, targetId)
  /** flush 异步链（编排各 await 段 + 内核受理微任务）。 */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve()
  }
  return {
    view, tree, registry, client, promptCalls, evictSpy, invalidateSpy, signalSpy, revoke, flush,
    /** 注入一条 pi 事件（送达回执 message_end 等——watchClient 订阅的 mock 通道）。 */
    emitPiEvent: (event: unknown) => piEventHandler?.(event),
    setTree: (entries: unknown[], leafId: string | null) => {
      tree.entries = entries
      tree.leafId = leafId
    },
    /** mock transcript 快照（撤回前后对比的数据面——经 get_entries 同一观察通道取）。 */
    snapshotTranscript: async (): Promise<{ entries: unknown[]; leafId: string | null }> => {
      const msg = (await client.getEntries()) as { data?: { entries?: unknown; leafId?: unknown } }
      const entries = msg.data?.entries
      return {
        entries: Array.isArray(entries) ? [...entries] : [],
        leafId: typeof msg.data?.leafId === 'string' ? msg.data.leafId : null,
      }
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** 标准树：e1(首条 user) → e2(user M，撤回目标) → e3(assistant)，leaf=e3。 */
function standardTree(): { entries: unknown[]; leafId: string } {
  return {
    entries: [
      msgEntry('e1', null, 'user', '你好\n<!--taiji:msg:00000000-0000-4000-8000-000000000001-->'),
      msgEntry('e2', 'e1', 'user', `帮我写个排序\n<!--taiji:msg:${UUID_A}-->`),
      msgEntry('e3', 'e2', 'assistant', '好的，这是排序实现……'),
    ],
    leafId: 'e3',
  }
}

const typeOf = (entry: unknown): unknown => (entry as { type?: unknown }).type

describe('A6 信令不污染（探针：transcript 撤回前后对比 + 命令串零残留）', () => {
  it('撤回前后 transcript 对比：新增条目恰一条非 message 的 label 锚，message entry 集合逐字不变', async () => {
    const h = makeProbeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const before = await h.snapshotTranscript()
    const reply = await h.revoke('e2')
    const after = await h.snapshotTranscript()

    expect(reply.revoked).toBe(true)
    // 撤回成功前提下的污染断言：唯一新增条目是 navigateTree 的 label 锚——
    // 若信令走用户消息面（prompt mock 会落 user message entry），此处即红（P2 探针）
    expect(after.entries.length).toBe(before.entries.length + 1)
    const added = after.entries.slice(before.entries.length)
    expect(added).toHaveLength(1)
    expect(typeOf(added[0])).toBe('label')
    // message entry 集合逐字不变（无新增 message entry、既有条目零改写）
    const messagesOf = (entries: unknown[]) => entries.filter((e) => typeOf(e) === 'message')
    expect(messagesOf(after.entries)).toStrictEqual(messagesOf(before.entries))
  })

  it('__taiji_nav__ 命令串零残留：任何 message entry 不含，session.delivery 投影（帧数据源 = 内核投影视图）不含——对照锚：已送达用户消息文本确在投影中（断言非空）', async () => {
    const h = makeProbeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    // 预置一条已送达的内核条目（真实链路：submit → 投出 → message_end(user) 裸标记回执
    // → delivered），使 session.delivery 投影非空——delivered 条目按 D4 惰性残留口径留存
    // 投影（cancelled tombstone 是轻量元数据不进投影，故对照锚必须用 delivered 条目）
    const seededText = `早期已送达的用户消息\n<!--taiji:msg:${UUID_B}-->`
    h.registry.submit(SID, { content: '早期已送达的用户消息', clientUuid: `u-${UUID_B}` })
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
    expect(h.promptCalls[0]).toBe(seededText) // 出站文本 = 原文 + 裸标记（内核 withDeliveryMarker）
    h.emitPiEvent({ type: 'message_end', message: { role: 'user', content: seededText } })
    await h.flush()
    // 投递收口副作用复位（markSessionActive 置 dispatching + 派生 isGenerating=true；
    // 真实回落 = armOccupancySettleWindow 的 timer 回调，fake timers 不推进——按
    // event-interpreter 'idle' 行语义手动复位，撤回前置 = 空闲。isGenerating 是只读派生
    // 属性，经 spyOn getter 复位——与 revoke-orchestrator.test.ts 的 isCompacting 同款手法）
    vi.spyOn(h.view, 'isGenerating', 'get').mockReturnValue(false)
    h.view.occupancy = { turn: 'idle', compacting: false, bash: false }

    const before = await h.snapshotTranscript()
    const reply = await h.revoke('e2')
    const after = await h.snapshotTranscript()

    expect(reply.revoked).toBe(true)
    // 两条 prompt = 种子投递 + 命令串（信令是唯一新增 prompt，且为命令形态）
    expect(h.promptCalls).toEqual([seededText, `/${TAIJI_NAV_COMMAND} e2`])

    // ① transcript：撤回后全部 message entry 序列化不含命令串（信令不被记录成对话内容）
    for (const entry of after.entries) {
      if (typeOf(entry) !== 'message') continue
      expect(JSON.stringify(entry)).not.toContain(TAIJI_NAV_COMMAND)
    }
    expect(after.entries.length).toBe(before.entries.length + 1)

    // ② session.delivery 投影（session-delivery-topic 的帧数据源 = handle.projection() 投影视图）：
    // 命令串零残留。若信令回归走内核 submit 面，命令条目将滞留 active（command 无
    // message_end 回执、永不 delivered）→ 此断言即红（D1 否决记录的「僵尸条目」形态）
    const projectionEntries = h.registry.getOrCreateDelivery(SID).projection().entries
    for (const entry of projectionEntries) {
      expect(JSON.stringify(entry)).not.toContain(TAIJI_NAV_COMMAND)
    }
    // 对照锚（防空投影假绿）：已送达条目确在投影中，payload 含用户文本
    expect(projectionEntries.some((e) => payloadContentOf(e).includes('早期已送达的用户消息'))).toBe(true)
    // ③ 内核全量视图（active + tombstone）序列化同样零残留，且撤回后无在册条目
    expect(JSON.stringify(h.registry.entries(SID))).not.toContain(TAIJI_NAV_COMMAND)
    expect(h.registry.entries(SID)?.active ?? []).toHaveLength(0)
  })
})

describe('A9 workflow-running 拦截回执（探针：mock workflow 投影）', () => {
  it('投影含 running run → {revoked:false, error:"workflow-running"}，零信令、树逐字不变、数据面零拉取', async () => {
    const h = makeProbeHarness({
      workflowRuns: [{ id: 'wf-1', status: 'running' }],
      rewind: { target: 'e2', parent: 'e1' }, // 信令若被错误发出，树会变——反向断言锚
    })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const before = await h.snapshotTranscript()
    const getEntriesBeforeRevoke = h.client.getEntries.mock.calls.length

    const reply = await h.revoke('e2')

    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'workflow-running' })
    // 零信令：prompt 零调用（run 不被终止的 runtime 侧锚——树回退信令未发出）
    expect(h.promptCalls).toHaveLength(0)
    // 树逐字不变（entries + leafId 均未动）
    const after = await h.snapshotTranscript()
    expect(after).toEqual(before)
    // 拦截先于数据面：编排零 get_entries 拉取（此后仅 +1 = after 快照自身的对照读）
    expect(h.client.getEntries.mock.calls.length).toBe(getEntriesBeforeRevoke + 1)
    // ④ history 缓存清理与 ⑥′ 派生态失效均未触达（撤回未发生，拦截先于缓存步骤）
    expect(h.evictSpy).not.toHaveBeenCalled()
    expect(h.invalidateSpy).not.toHaveBeenCalled()
  })

  it('对照：同投影 run 已完成（completed）→ 拦截不触发，撤回正常完成——拦截锚是 running 状态本身', async () => {
    const h = makeProbeHarness({
      workflowRuns: [{ id: 'wf-1', status: 'completed' }],
      rewind: { target: 'e2', parent: 'e1' },
    })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke('e2')

    expect(reply.revoked).toBe(true)
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} e2`])
  })
})
