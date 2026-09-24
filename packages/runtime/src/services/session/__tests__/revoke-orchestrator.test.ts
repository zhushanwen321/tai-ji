/**
 * RevokeOrchestrator（消息撤回七步编排，message-revoke 设计 §3.3 D2）单元验收测试。
 *
 * 材料范式（对齐 session-delivery-registry.test.ts）：真实编排逻辑 + 真实投递内核注册表
 * （revoking hold 是其真实现）+ 真实 MessageDispatcher.sendSystemCommand（信令旁路不走
 * 内核/hook 是 ⑧ 的断言对象）；mock 仅 pi 边界（rpc client 的 get_entries / prompt /
 * getCommands / clear_queue / onEvent）。pi 树形态经可变 tree 对象驱动（prompt 副作用
 * 模拟 navigateTree 的叶子回退 + label 锚落盘）。
 *
 * 八族断言（对应验收计划 A11/A12/A8/⑥③ 等）：
 * ① 临界区互斥（并发两撤回恰一条 revoked 一条 busy）
 * ② nav-failed 幂等重试（⑥ 校验失败 → 重发命中 ⑤ 幂等判定回 revoked:true）
 * ③ no-mapping 双分支（u- 双通道 miss / entryId 不在文件）
 * ④ hold try/finally 全路径释放（busy / workflow-running / no-mapping 提前 return 后 hold 已释）
 * ⑤ compaction_end 边沿不提前投递（revoking hold 窗口内）
 * ⑥ ③ b 末尾锚（内嵌标记字面不误命中）
 * ⑦ revoking 进 hold 判定 + 与 compacting 叠加
 * ⑧ 信令不污染（prompt 只收命令串、无标记尾附、不经内核）
 *
 * 运行：pnpm --filter @taiji/runtime exec vitest run src/services/session/__tests__/revoke-orchestrator.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TAIJI_NAV_COMMAND } from '@taiji/shared'
import {
  createSessionDeliveryRegistry,
  resetActiveDeliveryRegistryForTest,
  type SessionDeliveryDeps,
} from '../session-delivery-registry.js'
import {
  RevokeOrchestrator,
  resetRevocationSignalNotifierForTest,
  setActiveRevocationSignalNotifier,
} from '../revoke-orchestrator.js'
import { MessageDispatcher } from '../message-dispatcher.js'
import type { IDispatcherSessionOps } from '../session-internal.js'
import type { IPiEngine } from '../../ports/pi-engine.js'
import type { IProcessManager } from '../../ports/pi-engine.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { IManagedSessionView } from '../types.js'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { SkillInjectionResult, SkillInjector, SkillNotice } from '../skill-injector.js'

const SID = 's1'
const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const UUID_B = '11111111-2222-4333-8444-555555555555'

/** mock session view（occupancy 经转移原语写入——与 registry 测试同款 sentinel 视图）。 */
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
function customEntry(id: string, parentId: string | null, customType: string, data: unknown): unknown {
  return { type: 'custom', id, parentId, customType, data }
}
function labelEntry(id: string, parentId: string | null, targetId: string): unknown {
  return { type: 'label', id, parentId, label: 'taiji:revoked', targetId }
}

/** 可变 pi 树（get_entries 的数据源；prompt 副作用 mutate 它模拟 navigateTree）。 */
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

interface HarnessOptions {
  view?: Partial<IManagedSessionView>
  hasRunningWorkflow?: (sessionId: string) => Promise<boolean>
  /**
   * prompt 到达副作用 = navigateTree 成功语义模拟（label 锚挂 expectedParent、叶子切换）。
   * 缺省 undefined = 树不变（模拟 command 抛错 / nav 无效果形态）。
   */
  rewind?: { target: string; parent: string | null }
}

function makeHarness(opts: HarnessOptions = {}) {
  const view = makeView(opts.view)
  const tree: MutableTree = { entries: [], leafId: null }
  const promptCalls: string[] = []
  let getEntriesGate: Promise<void> | null = null
  let releaseGate: (() => void) | null = null
  const evictSpy = vi.fn()
  const invalidateSpy = vi.fn()
  // 撤回信号广播腿经进程内活动槽注入（生产 = 组合根注册 pluginService.notifyEntryInvalidation）
  const signalSpy = vi.fn()
  setActiveRevocationSignalNotifier(signalSpy)

  const client = {
    prompt: vi.fn(async (text: string) => {
      promptCalls.push(text)
      if (opts.rewind) applyRewind(tree, opts.rewind.target, opts.rewind.parent)
      return {}
    }),
    getEntries: vi.fn(async () => {
      if (getEntriesGate) await getEntriesGate
      return { data: { entries: tree.entries, leafId: tree.leafId } }
    }),
    getCommands: vi.fn(async () => [{ name: TAIJI_NAV_COMMAND, source: 'taiji' }]),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    onEvent: vi.fn(() => () => {}),
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

  // 真实 dispatcher 的 sendSystemCommand（⑧ 断言对象：不经 hook / 不经内核 / 直连 prompt）
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
    hasRunningWorkflow: opts.hasRunningWorkflow ?? (async () => false),
    evictHistoryRebuildCache: evictSpy,
    invalidateDerivedState: invalidateSpy,
    sendSystemCommand: (sid, commandLine, requireCommand) => dispatcher.sendSystemCommand(sid, commandLine, requireCommand),
  })

  const revoke = (targetId: string) => orchestrator.revokeMessage(SID, targetId)
  /** flush 异步链（编排各 await 段 + 内核投递交接）。 */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve()
  }
  return {
    view, tree, registry, client, promptCalls, evictSpy, invalidateSpy, signalSpy, revoke, flush,
    setTree: (entries: unknown[], leafId: string | null) => {
      tree.entries = entries
      tree.leafId = leafId
    },
    /** 卡住下一次起的 get_entries（编排数据面卡点构造）。 */
    blockGetEntries: () => {
      getEntriesGate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
    },
    releaseGetEntries: () => {
      releaseGate?.()
      getEntriesGate = null
      releaseGate = null
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetActiveDeliveryRegistryForTest()
})

afterEach(() => {
  vi.useRealTimers()
  resetActiveDeliveryRegistryForTest()
  resetRevocationSignalNotifierForTest()
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

describe('U4 撤回编排：happy path（⑧ 信令不污染 + ⑦ 前置）', () => {
  it('entryId 直用形态：revoked:true + transcript 原文（含裸标记 raw 不剥）+ prompt 只收命令串 + 无内核条目', async () => {
    const h = makeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke('e2')

    expect(reply).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })
    // ⑧：prompt 只收命令串（TAIJI_NAV_COMMAND 拼装 + entryId），无裸标记尾附、无其他文本
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} e2`])
    // ⑧：信令不经内核（registry 无条目——若经 submit 会留下条目/标记文本）
    expect(h.registry.entries(SID)?.active ?? []).toHaveLength(0)
    // ④ history 缓存清理触达；派生态失效同样触达但后置⑥（时序契约见「派生态失效时序」用例）
    expect(h.evictSpy).toHaveBeenCalledWith(SID)
    expect(h.invalidateSpy).toHaveBeenCalledWith(SID)
  })

  it('u- 形态 通道 a（msg-id-mapper custom entry 映射）：clientUuid → userEntryId 定位成功', async () => {
    const h = makeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    h.setTree(
      [
        msgEntry('e1', null, 'user', '你好'),
        msgEntry('e2', 'e1', 'user', `帮我写个排序\n<!--taiji:msg:${UUID_A}-->`),
        customEntry('c1', 'e2', 'taiji.client-msg-id', { clientUuid: `u-${UUID_A}`, userEntryId: 'e2' }),
        msgEntry('e3', 'e2', 'assistant', '好的'),
      ],
      'e3',
    )

    const reply = await h.revoke(`u-${UUID_A}`)

    expect(reply.revoked).toBe(true)
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} e2`])
  })

  it('u- 形态 通道 b（纯文本无映射 entry → 裸标记末尾锚）：定位成功', async () => {
    const h = makeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    h.setTree(
      [
        msgEntry('e1', null, 'user', '你好'),
        msgEntry('e2', 'e1', 'user', `纯文本消息\n<!--taiji:msg:${UUID_A}-->`),
        msgEntry('e3', 'e2', 'assistant', '收到'),
      ],
      'e3',
    )

    const reply = await h.revoke(`u-${UUID_A}`)

    expect(reply.revoked).toBe(true)
    if (reply.revoked) expect(reply.content).toBe(`纯文本消息\n<!--taiji:msg:${UUID_A}-->`)
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} e2`])
  })

  it('裸 uuid 形态 targetId（U8 保号，无 u- 前缀）→ 进双通道，通道 b 末尾锚命中', async () => {
    const h = makeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    // U8 外来条目保号：气泡/内核条目 id 为裸 uuid（无 u- 前缀），裸标记恰以裸 uuid 落盘
    const reply = await h.revoke(UUID_A)

    expect(reply).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} e2`])
  })

  it('8 位 hex entryId 形态（pi entryId）仍直用：不进 uuid 双通道分派', async () => {
    const h = makeHarness({ rewind: { target: 'a1b2c3d4', parent: 'e1' } })
    h.setTree(
      [
        msgEntry('e1', null, 'user', '你好'),
        msgEntry('a1b2c3d4', 'e1', 'user', '直用目标'),
        msgEntry('e3', 'a1b2c3d4', 'assistant', '回复'),
      ],
      'e3',
    )

    const reply = await h.revoke('a1b2c3d4')

    expect(reply).toEqual({ sessionId: SID, revoked: true, content: '直用目标' })
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} a1b2c3d4`])
  })

  it('首条消息完备分支：expectedParentId=null → 回溯链终止于根（label 成根）校验通过', async () => {
    const h = makeHarness({ rewind: { target: 'e1', parent: null } })
    h.setTree(
      [
        msgEntry('e1', null, 'user', `首条消息\n<!--taiji:msg:${UUID_A}-->`),
        msgEntry('e2', 'e1', 'assistant', '回复'),
      ],
      'e2',
    )

    const reply = await h.revoke(`u-${UUID_A}`)

    expect(reply.revoked).toBe(true)
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} e1`])
  })
})

describe('① 临界区互斥（A12①：并发两撤回恰一条 revoked 一条 busy）', () => {
  it('第一个撤回卡在 workflow 检查 await 时，第二个撤回同步段互斥自检回 busy', async () => {
    let releaseWorkflow: (() => void) | undefined
    const workflowGate = new Promise<void>((resolve) => {
      releaseWorkflow = resolve
    })
    const h = makeHarness({
      hasRunningWorkflow: () => workflowGate.then(() => false),
      rewind: { target: 'e2', parent: 'e1' },
    })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    // 第一个撤回：同步段置位 revoking → 卡在 workflow 检查（临界区后第一个 await）
    const p1 = h.revoke('e2')
    const p2 = h.revoke('e1') // 第二个撤回在第一个的 await 窗口内到达
    const r2 = await p2
    expect(r2).toEqual({ sessionId: SID, revoked: false, error: 'busy' })

    releaseWorkflow?.()
    const r1 = await p1
    expect(r1).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })
    // 互斥释放后可再次置位（无泄漏）
    expect(h.registry.beginRevokeHold(SID)).toBe(true)
    h.registry.endRevokeHold(SID)
  })
})

describe('② nav-failed 幂等重试（A8/A12：⑥ 校验失败 → 重试命中 ⑤ 幂等判定）', () => {
  it('第一次撤回树未回退 → nav-failed；重试时目标已被带走（全文件存在、不在活跃路径）→ revoked:true 且不发信令', async () => {
    // 第一次：prompt 不产生树变更（navigateTree throw 形态——command 抛错 prompt 照常成功）
    const h = makeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const first = await h.revoke('e2')
    expect(first).toEqual({ sessionId: SID, revoked: false, error: 'nav-failed' })
    expect(h.promptCalls).toHaveLength(1)
    // nav-failed 不触发派生态失效（树未确认回退）
    expect(h.invalidateSpy).not.toHaveBeenCalled()

    // 重试时点：树实际已回退（前次撤回真实生效但 reply 丢失的形态）——label 挂 e1、leaf 切走
    applyRewind(h.tree, 'e2', 'e1')
    const getEntriesBefore = h.client.getEntries.mock.calls.length
    const second = await h.revoke('e2')

    expect(second).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })
    // ⑤ 两分支均不发信令（防复活性跳转）：prompt 无新增调用
    expect(h.promptCalls).toHaveLength(1)
    // 只消费了一次 get_entries（⑤ 数据面），无 ⑥ 校验读
    expect(h.client.getEntries.mock.calls.length).toBe(getEntriesBefore + 1)
    // 幂等分支补触发派生态失效（首次尝试可能已树回退但失效未触发——残影在此清除）
    expect(h.invalidateSpy).toHaveBeenCalledTimes(1)
    expect(h.invalidateSpy).toHaveBeenCalledWith(SID)
  })

  it('get_entries RPC 自身失败归 nav-failed（不误报 no-mapping），不触发信令', async () => {
    const h = makeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)
    h.client.getEntries.mockRejectedValueOnce(new Error('transport broken'))

    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'nav-failed' })
    expect(h.promptCalls).toHaveLength(0)
  })
})

describe('③ no-mapping 双分支', () => {
  it('u- 双通道 miss（无 custom entry 映射 + 无末尾锚命中）→ no-mapping，无信令', async () => {
    const h = makeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke(`u-${UUID_B}`)
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'no-mapping' })
    expect(h.promptCalls).toHaveLength(0)
    // 定位失败提前 return：④ history 缓存清理未触达（撤回未发生）
    expect(h.evictSpy).not.toHaveBeenCalled()
  })

  it('entryId 不在文件（基线 stale）→ ⑤ 兜底判 no-mapping', async () => {
    const h = makeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke('e999')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'no-mapping' })
    expect(h.promptCalls).toHaveLength(0)
  })
})

describe('④ hold try/finally 全路径释放（A11 硬契约：提前 return 后 hold 已释）', () => {
  it('busy 提前 return（isGenerating）→ hold 已释放（再次置位成功）', async () => {
    const h = makeHarness({ view: { isGenerating: true, occupancy: { turn: 'generating', compacting: false, bash: false } } })
    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'busy' })
    expect(h.registry.beginRevokeHold(SID)).toBe(true)
    h.registry.endRevokeHold(SID)
  })

  it('workflow-running 提前 return → hold 已释放', async () => {
    const h = makeHarness({ hasRunningWorkflow: async () => true })
    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'workflow-running' })
    expect(h.registry.beginRevokeHold(SID)).toBe(true)
    h.registry.endRevokeHold(SID)
  })

  it('no-mapping 提前 return → hold 已释放，后续提交正常投递（不永久 queued）', async () => {
    const h = makeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke(`u-${UUID_B}`)
    expect(reply.revoked).toBe(false)
    if (!reply.revoked) expect(reply.error).toBe('no-mapping')

    // 行为锚：hold 释放后新提交不被持有（泄漏形态 = 永久 queued 死轮询）
    h.registry.submit(SID, { content: '新消息', clientUuid: `u-${UUID_B}` })
    await h.flush()
    await vi.advanceTimersByTimeAsync(600)
    expect(h.promptCalls).toHaveLength(1)
  })
})

describe('⑤ compaction_end 边沿不提前投递（A11：hold 窗口内判定源唯一）', () => {
  it('revoking hold 期间 compaction 边沿到达（compacting 复位）不投递；revoking 释放后投递', async () => {
    const h = makeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    // 撤回开始并卡在数据面（get_entries gate——② 已快照过 active 集合）。① 空闲检查
    // 在此通过（view 空闲开局），compaction 在撤回窗口**内**开始（步骤见下）——这是
    // 「撤回进行中恰好有 compaction 短暂发生又结束」的真实时序。
    h.blockGetEntries()
    const p = h.revoke('e2')
    await h.flush()

    // 撤回窗口内新 compaction 开始：view 置 compacting
    const compactingSpy = vi.spyOn(h.view, 'isCompacting', 'get').mockReturnValue(true)
    h.view.occupancy = { ...h.view.occupancy!, compacting: true }

    // revoking 窗口内新提交（② 快照之后 → 不被编排 cancel，A11 场景形态；compacting
    // 期间提交 → lane=queued，deliverOne 持有于 'compacting'）
    h.registry.submit(SID, { content: '撤回期间的新消息', clientUuid: `u-${UUID_B}` })
    await h.flush()

    // compaction_end 边沿：compacting 复位——正常（无 revoking）会在此边沿后投递
    compactingSpy.mockReturnValue(false)
    h.view.occupancy = { ...h.view.occupancy!, compacting: false }
    await vi.advanceTimersByTimeAsync(1_500)

    // 判定源唯一：compaction 边沿不提前投递（revoking 仍持有）
    expect(h.promptCalls.filter((t2) => t2.startsWith(`/${TAIJI_NAV_COMMAND}`))).toHaveLength(0)
    expect(h.promptCalls).toHaveLength(0)

    // 释放数据面卡点 → 编排走完（⑥ 校验过）→ finally 释放 hold → 持有期轮询退出 → 投递
    h.releaseGetEntries()
    const reply = await p
    expect(reply.revoked).toBe(true)
    await vi.advanceTimersByTimeAsync(1_500)
    await h.flush()

    const navCalls = h.promptCalls.filter((t2) => t2.startsWith(`/${TAIJI_NAV_COMMAND}`))
    const userCalls = h.promptCalls.filter((t2) => !t2.startsWith(`/${TAIJI_NAV_COMMAND}`))
    expect(navCalls).toEqual([`/${TAIJI_NAV_COMMAND} e2`])
    // revoking 释放 + compacting 已复位 → 新消息按新分支正常投递（A11 验收锚）
    expect(userCalls).toHaveLength(1)
    expect(userCalls[0]).toContain('撤回期间的新消息')
  })
})

describe('⑥ ③ b 末尾锚（内嵌标记字面不误命中）', () => {
  it('标记字面内嵌非末尾 → 不命中（no-mapping）；末尾真标记命中（对照组）', async () => {
    const h = makeHarness({ rewind: { target: 'eB', parent: 'eA' } })
    h.setTree(
      [
        msgEntry('e0', null, 'user', '你好'),
        // UUID_A 内嵌在正文中（非末尾）——用户原文里的标记字面
        msgEntry('eA', 'e0', 'user', `用户提到了 <!--taiji:msg:${UUID_A}--> 这个字面，然后继续说`),
        // UUID_B 的真标记恒尾附
        msgEntry('eB', 'eA', 'user', `另一条消息\n<!--taiji:msg:${UUID_B}-->`),
        msgEntry('eC', 'eB', 'assistant', '回复'),
      ],
      'eC',
    )

    // 内嵌字面不误命中（恒尾附构造保证真标记在尾）
    const miss = await h.revoke(`u-${UUID_A}`)
    expect(miss).toEqual({ sessionId: SID, revoked: false, error: 'no-mapping' })

    // 对照组：末尾锚命中（custom entry 缺失 → 纯 b 通道）
    const hit = await h.revoke(`u-${UUID_B}`)
    expect(hit.revoked).toBe(true)
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} eB`])
  })
})

describe('⑦ revoking 进 hold 判定 + 与 compacting 叠加', () => {
  it('revoking 单独有效：置位期间 submit 被持有，释放后投递', async () => {
    const h = makeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    expect(h.registry.beginRevokeHold(SID)).toBe(true)
    h.registry.submit(SID, { content: 'hold 窗口内提交', clientUuid: `u-${UUID_A}` })
    await h.flush()
    await vi.advanceTimersByTimeAsync(1_200)
    expect(h.promptCalls).toHaveLength(0) // revoking hold（无 compacting/bash——判定源是 revoking 本身）

    h.registry.endRevokeHold(SID)
    await vi.advanceTimersByTimeAsync(1_200)
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
  })

  it('与 compacting 叠加：compacting 复位后 revoking 仍持有（两 hold 并存，逐一释放）', async () => {
    const h = makeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    vi.spyOn(h.view, 'isCompacting', 'get').mockReturnValue(true)
    h.view.occupancy = { ...h.view.occupancy!, compacting: true }
    expect(h.registry.beginRevokeHold(SID)).toBe(true)

    h.registry.submit(SID, { content: '叠加 hold 提交', clientUuid: `u-${UUID_A}` })
    await h.flush()

    // 第一个 hold 源释放（compaction_end 边沿）——revoking 仍持有
    vi.spyOn(h.view, 'isCompacting', 'get').mockReturnValue(false)
    h.view.occupancy = { ...h.view.occupancy!, compacting: false }
    await vi.advanceTimersByTimeAsync(1_200)
    expect(h.promptCalls).toHaveLength(0)

    // 第二个 hold 源释放（撤回编排 finally）——投递恢复
    h.registry.endRevokeHold(SID)
    await vi.advanceTimersByTimeAsync(1_200)
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
  })
})

describe('⑧ 信令不污染（A6 单测腿：prompt 只收命令串、无标记尾附、不经内核）', () => {
  it('u- 形态经通道 b 定位：命令串 = TAIJI_NAV_COMMAND 拼装 + 定位出的 entryId，prompt 文本不含裸标记', async () => {
    const h = makeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    h.setTree(
      [
        msgEntry('e1', null, 'user', '你好'),
        msgEntry('e2', 'e1', 'user', `帮我写个排序\n<!--taiji:msg:${UUID_A}-->`),
        msgEntry('e3', 'e2', 'assistant', '好的'),
      ],
      'e3',
    )

    const reply = await h.revoke(`u-${UUID_A}`)
    expect(reply.revoked).toBe(true)

    expect(h.promptCalls).toHaveLength(1)
    const cmd = h.promptCalls[0]!
    // 只收命令串：精确等值（TAIJI_NAV_COMMAND 常量拼装，无用户文本混入）
    expect(cmd).toBe(`/${TAIJI_NAV_COMMAND} e2`)
    // 无标记尾附（不经内核 submit——withDeliveryMarker 尾附会污染 command args）
    expect(cmd).not.toContain('taiji:msg')
    // 内核无信令条目（信令不进 FIFO / 不占车道）
    const entries = h.registry.entries(SID)
    expect([...(entries?.active ?? []), ...(entries?.tombstones ?? [])].map((e) => e.id)).not.toContain(cmd)
  })
})

describe('派生态失效时序（⑥ 树回退校验通过后触发——信令前失效 = 无效失效，回归钉）', () => {
  it('invalidateDerivedState 晚于信令 prompt 与 ⑥ 校验读，且失效时点的树 = 撤回后树（label 锚已挂、leaf 已切）', async () => {
    const h = makeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    // pi 真实时序模拟（harness 的 prompt 副作用按 navigateTree 语义切树，getEntries 返回值
    // 随之切换）：逐次记录 getEntries 返回的 leafId——信令前（③⑤ 定位/校验读）= 撤回前
    // leaf，信令后（⑥ 校验读）= 撤回后 leaf，钉住「无参 getEntries 的取数时序」缺陷核心面。
    const getEntriesLeafIds: Array<string | null> = []
    const baseGetEntries = h.client.getEntries.getMockImplementation()!
    h.client.getEntries.mockImplementation(async () => {
      const msg = await baseGetEntries()
      getEntriesLeafIds.push(msg.data.leafId)
      return msg
    })
    // 失效时点的树快照（SessionRecords.invalidateDerivedState 同步触发 fire-and-forget
    // 全量重算——重算消费调用时点的树；记录调用时点可变树状态即重算消费面）
    const consumedTrees: Array<{ leafId: string | null; hasLabel: boolean }> = []
    h.invalidateSpy.mockImplementation(() => {
      consumedTrees.push({
        leafId: h.tree.leafId,
        hasLabel: h.tree.entries.some((e) => (e as { id?: unknown }).id === 'L-e2'),
      })
    })

    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })

    // 取数时序：两次拉取即 ③⑤ 数据面（撤回前 leaf=e3）与 ⑥ 校验读（撤回后 leaf=L-e2），
    // 值切换点 = prompt 副作用，构造性对齐真实 pi 的同 client 顺序处理
    expect(getEntriesLeafIds).toEqual(['e3', 'L-e2'])
    // 时序断言（vi 全局单调调用序）：失效晚于信令 prompt、也晚于 ⑥ 校验读（树回退确认后）
    const invalidateOrder = h.invalidateSpy.mock.invocationCallOrder[0]!
    expect(invalidateOrder).toBeGreaterThan(h.client.prompt.mock.invocationCallOrder[0]!)
    expect(invalidateOrder).toBeGreaterThan(h.client.getEntries.mock.invocationCallOrder[1]!)
    // 失效触发的重算消费撤回后树：调用时点 label 锚已挂、叶子已切（若失效先行触发，
    // 此处消费的是撤回前树 → 全量重建被撤残影）
    expect(consumedTrees).toEqual([{ leafId: 'L-e2', hasLabel: true }])
  })
})

describe('撤回信号广播（插件镜像重建腿：与派生态失效恒配对，U7）', () => {
  it('⑥′ 时点：撤回信号广播晚于信令 prompt 与 ⑥ 校验读，且与 invalidateDerivedState 成对触发', async () => {
    const h = makeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })

    // 时序（vi 全局单调调用序）：信号晚于信令 prompt 与 ⑥ 校验读（树回退确认后——
    // 信令前广播 = 插件重拉仍读撤回前数据，无效重建）
    expect(h.signalSpy).toHaveBeenCalledTimes(1)
    expect(h.signalSpy).toHaveBeenCalledWith(SID)
    const signalOrder = h.signalSpy.mock.invocationCallOrder[0]!
    expect(signalOrder).toBeGreaterThan(h.client.prompt.mock.invocationCallOrder[0]!)
    expect(signalOrder).toBeGreaterThan(h.client.getEntries.mock.invocationCallOrder[1]!)
    // 恒配对：records 失效腿先行同批触发（同处 invalidateDerived 私有入口）
    expect(h.invalidateSpy).toHaveBeenCalledTimes(1)
    expect(h.invalidateSpy.mock.invocationCallOrder[0]).toBeLessThan(signalOrder)
  })

  it('树未回退（「目标仍在活跃链」nav-failed 分支）→ 无信号无失效', async () => {
    const h = makeHarness() // 无 rewind = 树不变
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'nav-failed' })
    expect(h.signalSpy).not.toHaveBeenCalled()
    expect(h.invalidateSpy).not.toHaveBeenCalled()
  })

  it('定位失败提前 return（no-mapping）→ 无信号', async () => {
    const h = makeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke('e999')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'no-mapping' })
    expect(h.signalSpy).not.toHaveBeenCalled()
  })

  it('⑤ 幂等分支（目标已被前序撤回带走）→ 信号与失效同步各一次', async () => {
    const h = makeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)
    // 前次撤回真实生效但 reply 丢失的形态：label 挂 e1、leaf 切走
    applyRewind(h.tree, 'e2', 'e1')

    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })
    expect(h.invalidateSpy).toHaveBeenCalledTimes(1)
    expect(h.signalSpy).toHaveBeenCalledTimes(1)
    expect(h.signalSpy).toHaveBeenCalledWith(SID)
  })
})

describe('错误码边界（D8）', () => {
  it('pi-reclaimed：ensureActive 拉活失败回终态码（区别于 extension-missing）', async () => {
    const h = makeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)
    // 拉活失败（编排数据面的 ensureActive——⑤ 之前）：直接构造 orchestrator 级失败
    const failing = new RevokeOrchestrator({
      getSession: () => undefined,
      ensureActive: async () => {
        throw new Error('restore failed')
      },
      hasRunningWorkflow: async () => false,
      evictHistoryRebuildCache: vi.fn(),
      invalidateDerivedState: vi.fn(),
      sendSystemCommand: vi.fn(async () => ({ kind: 'sent' as const })),
    })
    // beginRevokeHold 需要 registry（harness 已装配）
    const reply = await failing.revokeMessage(SID, 'e2')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'pi-reclaimed' })
    // hold 已释放（finally 覆盖 pi-reclaimed 提前 return）
    expect(h.registry.beginRevokeHold(SID)).toBe(true)
    h.registry.endRevokeHold(SID)
  })

  it('extension-missing：命令探测耗尽 fail-closed，命令串不进模型（prompt 零调用）', async () => {
    const h = makeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)
    h.client.getCommands.mockResolvedValue([])

    const replyPromise = h.revoke('e2')
    // 探测重试预算（500ms × 6 次 + 首探）
    const reply = await vi.advanceTimersByTimeAsync(4_000).then(() => replyPromise)
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'extension-missing' })
    expect(h.promptCalls).toHaveLength(0)
  })
})
