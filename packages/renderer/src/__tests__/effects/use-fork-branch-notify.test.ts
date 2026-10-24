// @vitest-environment node

/**
 * fork 分支通知链路单测（V7 代码级断言：角标产生 → 读后清除 → 切会话保持）。
 *
 * 走真实接线（bindForkNoticeEffect，u16 收敛后形态）：真实 pinia session store groups +
 * 真实 events 内存注册表（onGlobalType/dispatchGlobal 无 WS 依赖），不 mock transport 层。
 * 断言链：session.forkNotice 广播 → registerFork 基线 → groups 广播 diff（active→done）
 * → unreadByBranch 角标产生 + 反馈行追加（RV2）→ clearUnread 清除 → 再次 groups 广播已读态
 * 不回灌（切会话语义：config.sessions 全量广播重放）；非活跃分支角标跨广播保留（ADR-0049）。
 *
 * 另含 ForkNotice suppress（btw 流渲染，[M4-a / btw-question D4]，P-invisible 渲染范围）：
 * 线是 fork 产物（header.parentSession 指向源）但「关联只删不显」——fork 反馈行/分支追踪
 * 状态不进 btw 流。抑制落 useForkNoticeFeed().notices 读口单点（MessageStream 全部消费方
 * 经此读取）；主会话 feed 行为回归对照在 suppress 用例内。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/effects/use-fork-branch-notify.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'
import * as events from '@taiji/core/transport/api'
import type { ServerMessage, SessionGroup, SessionSummary } from '@taiji/shared'
import {
  bindForkNoticeEffect,
  pushForkNoticeAsk,
  resetForkNoticeFeed,
  useForkNoticeFeed,
} from '@/composables/effects/useForkNoticeEffect'
// D9：useForkBranchBadges 门面已随 ForkGroup 退役删除（未读角标改由 SessionItemDisplay 直接读本模块），
// 测试同步为直接消费 useForkBranchNotify 的模块级单例。
import { clearUnread, unreadByBranch } from '@/composables/features/fork-handoff/useForkBranchNotify'
import { useSessionStore } from '@/stores/session'
import { __resetBtwLineMembershipForTest, noteBtwLinesPulled } from '@/composables/panel/btw-line-membership'

// W4b 收编：btw 线成员判别（ForkNotice suppress 读口）经 session.list {surface:'btw'}
// 拉取缓存供数——mock 掉 @/api 门面的 listSessions（spread actual 保其余域）。
const sessionListMock = vi.hoisted(() => ({ listSessions: vi.fn() }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return { ...actual, session: { ...actual.session, listSessions: sessionListMock.listSessions } }
})

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 's-x',
    label: '分支',
    cwd: '/tmp/proj',
    status: 'active',
    lastActiveAt: Date.now(),
    modelId: 'm-test',
    tokenCount: 0,
    ...overrides,
  }
}

function groupOf(...sessions: SessionSummary[]): SessionGroup[] {
  return [{ cwd: '/tmp/proj', sessions }]
}

/** 模拟 runtime 广播 session.forkNotice（fork 成功通知） */
function broadcastForkNotice(srcSessionId: string, newSessionId: string, branchName?: string): void {
  const msg: ServerMessage<'session.forkNotice'> = {
    type: 'session.forkNotice',
    payload: { srcSessionId, newSessionId, branchName },
  }
  events.dispatchGlobal(msg)
}

/** 推进 groups 广播（config.sessions 全量应用语义：整表替换） */
async function broadcastGroups(sessions: SessionSummary[]): Promise<void> {
  const { groups } = storeToRefs(useSessionStore())
  groups.value = groupOf(...sessions)
  await nextTick()
}

let scope: ReturnType<typeof effectScope> | undefined

beforeEach(() => {
  setActivePinia(createPinia())
  scope?.stop()
  resetForkNoticeFeed()
  // W4b 收编判别器：ForkNotice suppress 读口 = session.list {surface:'btw'} 拉取缓存成员
  // 判别（登记于 docs/constraints.json C-data-28 抑制类清单）——逐用例清零 + 按线预热。
  __resetBtwLineMembershipForTest()
  sessionListMock.listSessions.mockResolvedValue([])
  scope = effectScope()
  scope.run(() => {
    bindForkNoticeEffect()
  })
})

describe('fork 分支角标（V7：产生 → 读后清除 → 切会话保持）', () => {
  it('后台分支 active→done：未读角标产生 + 反馈行追加状态通知（RV2 全链）', async () => {
    const { notices } = useForkNoticeFeed()

    broadcastForkNotice('s-parent', 's-branch', 'fix-bug')
    await broadcastGroups([
      session({ id: 's-parent', status: 'active' }),
      session({ id: 's-branch', status: 'active', parentSession: 's-parent', label: 'fix-bug' }),
    ])
    // 运行中：无角标；fork 广播本身入 feed（RV1 forkedPrefix）
    expect(unreadByBranch.value.get('s-branch')).toBeUndefined()
    expect(notices('s-parent').some((n) => n.newSessionId === 's-branch')).toBe(true)

    await broadcastGroups([
      session({ id: 's-parent', status: 'active' }),
      session({ id: 's-branch', status: 'done', parentSession: 's-parent', label: 'fix-bug' }),
    ])
    // 角标产生
    expect(unreadByBranch.value.get('s-branch')).toBe(true)
    // 状态通知追加（RV2：kind=done）
    const doneNotice = notices('s-parent').find((n) => n.newSessionId === 's-branch' && n.kind === 'done')
    expect(doneNotice).toBeDefined()
  })

  it('用户查看分支 → clearUnread 清除；groups 再次广播（切会话重放）已读态不回灌', async () => {
    broadcastForkNotice('s-parent', 's-branch', 'fix-bug')
    const doneBranch = session({ id: 's-branch', status: 'done', parentSession: 's-parent', label: 'fix-bug' })
    await broadcastGroups([session({ id: 's-parent', status: 'active' }), doneBranch])
    expect(unreadByBranch.value.get('s-branch')).toBe(true)

    // 用户 select 跳转查看 → 清角标
    clearUnread('s-branch')
    expect(unreadByBranch.value.get('s-branch')).toBeUndefined()

    // 切会话语义：config.sessions 全量广播重放（同表或含无关 session），已读态不回灌
    await broadcastGroups([session({ id: 's-parent', status: 'active' }), doneBranch])
    await broadcastGroups([session({ id: 's-parent', status: 'active' })])
    expect(unreadByBranch.value.get('s-branch')).toBeUndefined()
  })

  it('非活跃分支的未读角标跨多次 groups 广播保留（ADR-0049：角标状态不随焦点切换丢失）', async () => {
    broadcastForkNotice('s-a', 's-branch-a', 'branch-a')
    broadcastForkNotice('s-b', 's-branch-b', 'branch-b')
    await broadcastGroups([
      session({ id: 's-a', status: 'active' }),
      session({ id: 's-branch-a', status: 'done', parentSession: 's-a', label: 'branch-a' }),
      session({ id: 's-b', status: 'active' }),
      session({ id: 's-branch-b', status: 'active', parentSession: 's-b', label: 'branch-b' }),
    ])
    expect(unreadByBranch.value.get('s-branch-a')).toBe(true)

    // 用户查看 branch-a 并清除；branch-b 仍在后台跑（无角标）
    clearUnread('s-branch-a')
    await broadcastGroups([
      session({ id: 's-a', status: 'active' }),
      session({ id: 's-branch-a', status: 'done', parentSession: 's-a', label: 'branch-a' }),
      session({ id: 's-b', status: 'active' }),
      session({ id: 's-branch-b', status: 'done', parentSession: 's-b', label: 'branch-b' }),
    ])
    // branch-a 已读态保持；branch-b 后台跑完产生新角标（与焦点在哪个 session 无关）
    expect(unreadByBranch.value.get('s-branch-a')).toBeUndefined()
    expect(unreadByBranch.value.get('s-branch-b')).toBe(true)
  })

  it('bind 卸载（App 卸载语义）→ 分支追踪/角标态清空', async () => {
    broadcastForkNotice('s-parent', 's-branch', 'fix-bug')
    await broadcastGroups([
      session({ id: 's-parent', status: 'active' }),
      session({ id: 's-branch', status: 'done', parentSession: 's-parent', label: 'fix-bug' }),
    ])
    expect(unreadByBranch.value.size).toBe(1)

    scope?.stop()
    await nextTick()
    expect(unreadByBranch.value.size).toBe(0)
  })
})

describe('ForkNotice suppress（btw 流）', () => {
  it('notice 推给 btw 线 → notices(线 id) 构造性空；主会话同型推送照常可见', () => {
    // W4b 收编判别器 = 拉取缓存成员判别：线 session id 经缓存预热（= 抽屉拉取产物喂入）
    noteBtwLinesPulled(['line-fn-1'])
    pushForkNoticeAsk('line-fn-1', 'new-branch-1', '旁路提问预览')
    pushForkNoticeAsk('main-fn-1', 'new-branch-2', '主分支预览')

    const feed = useForkNoticeFeed()
    expect(feed.notices('line-fn-1')).toHaveLength(0) // btw 流 suppress（D4）
    expect(feed.notices('main-fn-1')).toHaveLength(1) // 主会话行为不变（回归对照）

    // suppress 对交互幂等：dismiss/clear 对空表零动作不抛
    expect(() => feed.dismissNotice('line-fn-1', 1)).not.toThrow()
    expect(() => feed.clearSession('line-fn-1')).not.toThrow()
  })
})
