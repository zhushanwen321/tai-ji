/**
 * refreshHistory 对账编排测试（remote-use U9 / A6——connected 边沿当前会话对账）。
 *
 * refreshHistory = 切入链步 9 已 hydrate 分支提为实例公开方法（getHistory + reconcileFromReply
 * 统一编排：historyWindowFromReply 窗口归一 + persistImagesNewestFirst 图片落盘随行），
 * 供 connected 边沿重连对账与切入链共用同一入口（单一编排定义点）。壳内直调 chat 端口
 * 裸 reconcileHistory 的两处缺陷（U9 归并依据①②）由本文件以真实 chat store 行为锁死：
 *   ① 窗口参数丢 → reconcileHistory 走整体合并，A2 已加载的更早历史被基线清掉
 *     （store.ts A5b 负面场景）+ 截断窗口状态不刷新；
 *   ② 旁路 persistImagesNewestFirst → 重连对账拉回的 toolResult 图片不落盘。
 *
 * 模式（对齐 use-session.test.ts fixture 形态，chat 端口接真实 createChatStore——
 * 合并/窗口/落盘是 chat store 真实行为，mock 端口断言只证编排调用序、证不了窗口
 * 参数不丢的终端效果）：api/panel/navigation/hooks 最小 mock，getHistory mock RPC 响应，
 * 其余 chat 端口成员透传真实 store。beforeEach 调 resetSessionListSubForTest()。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import type { BatchDeleteResult, ImageCacheWriteImage, ImageCacheWriteResult, Message } from '@taiji/shared'
import { createChatStore } from '../../chat/store'
import { createSessionStore } from '../store'
import { createUseSession, resetSessionListSubForTest } from '../use-session'
import type { UseSessionDeps, SessionCleanupHooks } from '../use-session'
import { setImageCacheWritePort, _resetImageCacheForTest } from '../../chat/image-cache'

const SID = 'u9-rc-sid'

/** session.history RPC 响应形状（ChatHydratePort.getHistory 的 await 返回） */
type HistoryReply = Awaited<ReturnType<UseSessionDeps['chat']['getHistory']>>

/** 完整 assistant 消息（complete 态 + piEntryId——reconcileHistory 窗口切分锚取 `piEntryId ?? id`） */
function msg(id: string, piEntryId: string): Message {
  return { id, role: 'assistant', content: `msg-${id}`, status: 'complete', timestamp: 1, piEntryId }
}

function makeFixture() {
  const scope = effectScope(true)
  const chatStore = scope.run(() => createChatStore())!
  const sessionStore = scope.run(() => createSessionStore())!
  const getHistory = vi.fn<(sid: string) => Promise<HistoryReply>>()
  // chat 端口：getHistory mock（RPC 边界），其余成员透传真实 store（断言落到合并/窗口终端效果）
  const chat: UseSessionDeps['chat'] = {
    getHistory: (sid) => getHistory(sid),
    isHydrated: (sid) => chatStore.isHydrated(sid),
    hydrate: (sid, messages) => chatStore.hydrate(sid, messages),
    reconcileHistory: (sid, messages, window) => chatStore.reconcileHistory(sid, messages, window),
    clearHistoryError: (sid) => chatStore.clearHistoryError(sid),
    markHistoryFailed: (sid) => chatStore.markHistoryFailed(sid),
  }
  const api = {
    list: vi.fn().mockResolvedValue([]),
    switchSession: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    rename: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    removeByCwd: vi.fn().mockResolvedValue({ cwd: '/a', deleted: [], failed: [] } as BatchDeleteResult),
    migrateImage: vi.fn(),
    onConfigSessions: vi.fn(() => vi.fn()),
  }
  const hooks: SessionCleanupHooks = {
    clearFileTree: vi.fn(), clearSubagent: vi.fn(), clearWorkflow: vi.fn(),
    clearExtensionUI: vi.fn(), clearExtensionHost: vi.fn(), evictChat: vi.fn(),
    evictVirtualKeys: vi.fn(), clearAgentCallMapping: vi.fn(), disposeChat: vi.fn(),
    invalidateStatus: vi.fn(), browserDestroy: vi.fn(),
  }
  const deps: UseSessionDeps = {
    store: sessionStore,
    api,
    panel: {
      focusedSessionId: vi.fn(() => null),
      activePanelId: vi.fn(() => null),
      findPanelBySession: vi.fn(() => null),
      loadSession: vi.fn(),
      openPanel: vi.fn(),
    },
    navigation: { push: vi.fn() },
    chat,
    hooks,
  }
  const session = scope.run(() => createUseSession(deps))!
  return {
    session,
    chatStore,
    getHistory,
    dispose: () => scope.stop(),
  }
}

/**
 * 构造「已加载更早历史」的分区形态（A2 加载更早成功后）：
 * 初始 hydrate 尾窗 2 轮（truncated=true）→ loadMore 前插 1 轮更早 + 窗口状态累计
 * （真实 loadMoreHistory 的写入面 = prependHistory + setHistoryWindow，useChat.ts 游标翻页）。
 */
function seedPartitionWithEarlierHistory(f: ReturnType<typeof makeFixture>): void {
  const earlier = msg('m-e1', 'pi-e1')
  const w1 = msg('m-w1', 'pi-w1')
  const w2 = msg('m-w2', 'pi-w2')
  f.chatStore.hydrate(SID, [w1, w2], { truncated: true, loadedTurns: 2, totalTurnsEstimate: 5 })
  f.chatStore.prependHistory(SID, [earlier])
  f.chatStore.setHistoryWindow(SID, { truncated: true, loadedTurns: 3, totalTurnsEstimate: 5 })
}

describe('refreshHistory（U9/A6 对账编排公开方法）', () => {
  let f: ReturnType<typeof makeFixture>

  beforeEach(() => {
    resetSessionListSubForTest()
    _resetImageCacheForTest()
    f = makeFixture()
  })

  afterEach(() => {
    _resetImageCacheForTest()
    f.dispose()
  })

  it('窗口参数不丢：已加载更早历史在重连对账后保留（走窗口合并切分，非整体替换）', async () => {
    seedPartitionWithEarlierHistory(f)
    // 窗口响应：首条与分区窗口段首条同文件侧身份（pi-w1）→ 切分锚命中，更早历史保留
    f.getHistory.mockResolvedValue({
      messages: [msg('m-w1b', 'pi-w1'), msg('m-w2b', 'pi-w2'), msg('m-w3', 'pi-w3')],
      truncated: true, loadedTurns: 3, totalTurnsEstimate: 6,
    })

    await f.session.refreshHistory(SID)

    const ids = f.chatStore.getMessages(SID).map((m) => m.id)
    // 更早历史 m-e1 保留（负面场景①的终端效果：裸 reconcileHistory 无 window 时整体
    // 合并，m-e1 被基线清掉）；窗口段被响应刷新（w1→w1b 替换 + 新增 w3）
    expect(ids).toEqual(['m-e1', 'm-w1b', 'm-w2b', 'm-w3'])
  })

  it('截断窗口状态随对账响应刷新（truncated=true 保持「加载更早」入口；loadedTurns/totalTurnsEstimate 归一写入）', async () => {
    seedPartitionWithEarlierHistory(f)
    f.getHistory.mockResolvedValue({
      messages: [msg('m-w1b', 'pi-w1'), msg('m-w2b', 'pi-w2')],
      truncated: true, loadedTurns: 3, totalTurnsEstimate: 7,
    })

    await f.session.refreshHistory(SID)

    // 窗口状态 = 响应窗口（historyWindowFromReply 归一），非对账前残留的 loadMore 累计值
    expect(f.chatStore.getHistoryWindow(SID)).toEqual({ truncated: true, loadedTurns: 3, totalTurnsEstimate: 7 })
  })

  it('全量响应（truncated=false）窗口状态收敛收敛到 false（「加载更早」顶部条结构性消失）', async () => {
    seedPartitionWithEarlierHistory(f)
    f.getHistory.mockResolvedValue({
      messages: [msg('m-all1', 'pi-a1'), msg('m-all2', 'pi-a2')],
      truncated: false, loadedTurns: 4, totalTurnsEstimate: 4,
    })

    await f.session.refreshHistory(SID)

    expect(f.chatStore.getHistoryWindow(SID)).toEqual({ truncated: false, loadedTurns: 4, totalTurnsEstimate: 4 })
  })

  it('未 hydrate 会话 no-op：不拉取、不建分区（重连对账不承担首次回填——首次 hydrate 属切入链步 9）', async () => {
    await f.session.refreshHistory(SID)

    expect(f.getHistory).not.toHaveBeenCalled()
    expect(f.chatStore.isHydrated(SID)).toBe(false)
    expect(f.chatStore.getMessages(SID)).toEqual([])
  })

  it('getHistory 失败静默不抛、分区与窗口状态保持不变（对齐切入链已 hydrate 刷新失败语义：旧数据仍在）', async () => {
    seedPartitionWithEarlierHistory(f)
    const before = f.chatStore.getMessages(SID).map((m) => m.id)
    const windowBefore = f.chatStore.getHistoryWindow(SID)
    f.getHistory.mockRejectedValue(new Error('conn lost'))

    await expect(f.session.refreshHistory(SID)).resolves.toBeUndefined()

    // 不 markHistoryFailed（失败态语义属未 hydrate 通路——landing 重试出口；已 hydrate
    // 分区有旧数据可看，静默保留）
    expect(f.getHistory).toHaveBeenCalledTimes(1)
    expect(f.chatStore.getMessages(SID).map((m) => m.id)).toEqual(before)
    expect(f.chatStore.getHistoryWindow(SID)).toEqual(windowBefore)
  })

  it('图片落盘随行：对账拉回的 toolResult 图经 persistImagesNewestFirst 落盘（负面场景②旁路防御）；重复对账幂等不双写', async () => {
    const calls: Array<{ sessionId: string; order: string[] }> = []
    setImageCacheWritePort(
      vi.fn((sessionId: string, images: ImageCacheWriteImage[]): Promise<ImageCacheWriteResult> => {
        calls.push({ sessionId, order: images.map((i) => i.data) })
        return Promise.resolve({
          results: images.map((i) => ({ status: 'written' as const, path: `/cache/${i.data}.png`, bytes: 10 })),
          quotaFull: false,
        })
      }),
    )
    const withImage = (id: string, piEntryId: string, data: string): Message =>
      ({
        id, role: 'assistant', content: '', status: 'complete', timestamp: 1, piEntryId,
        toolCalls: [{ id: `t-${id}`, toolName: 'shot', input: {}, status: 'completed', startTime: 0, images: [{ data, mimeType: 'image/png' }] }],
      }) as unknown as Message
    f.chatStore.hydrate(SID, [msg('m-w1', 'pi-w1')], { truncated: false, loadedTurns: 1, totalTurnsEstimate: 1 })
    // 消息序（旧→新）old-1 在前、new-2 在后
    f.getHistory.mockResolvedValue({
      messages: [withImage('m-i1', 'pi-i1', 'old-1'), withImage('m-i2', 'pi-i2', 'new-2')],
      truncated: false, loadedTurns: 2, totalTurnsEstimate: 2,
    })

    await f.session.refreshHistory(SID)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe(SID)
    // 落盘序契约：消息序反转为新→旧交 port（超帽弃最旧，D6-⑨ 顺序契约）
    expect(calls[0]!.order).toEqual(['new-2', 'old-1'])

    // 重复对账（重连反复触发）幂等：已落盘图按内容 hash 记账剔除，port 不再被调
    await f.session.refreshHistory(SID)
    expect(calls).toHaveLength(1)
  })

  it('切入链与对账共用同一编排入口：已 hydrate 切入的刷新产出与 refreshHistory 等价（窗口参数同随行）', async () => {
    // selectSession 步 9 已 hydrate 分支重构后即 refreshHistory 本体——断言同一入口下
    // 两触发点（切入/对账）在真实 store 上产出等价分区与窗口状态（编排序由既有
    // use-session.test.ts 锁定，本用例锁「共用单一编排定义点」本身）
    const reply = {
      messages: [msg('m-w1b', 'pi-w1'), msg('m-w2b', 'pi-w2'), msg('m-w3', 'pi-w3')],
      truncated: true, loadedTurns: 3, totalTurnsEstimate: 6,
    } satisfies Awaited<ReturnType<UseSessionDeps['chat']['getHistory']>>
    seedPartitionWithEarlierHistory(f)
    f.getHistory.mockResolvedValue(reply)

    await f.session.refreshHistory(SID)
    const afterRefresh = {
      ids: f.chatStore.getMessages(SID).map((m) => m.id),
      window: f.chatStore.getHistoryWindow(SID),
    }

    // 另一实例同初始态走切入链（已 hydrate 分支）——产出应与 refreshHistory 一致
    const f2 = makeFixture()
    seedPartitionWithEarlierHistory(f2)
    f2.getHistory.mockResolvedValue(reply)
    await f2.session.selectSession(SID)
    const afterSelect = {
      ids: f2.chatStore.getMessages(SID).map((m) => m.id),
      window: f2.chatStore.getHistoryWindow(SID),
    }

    expect(afterSelect).toEqual(afterRefresh)
    f2.dispose()
  })
})
