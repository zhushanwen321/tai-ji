/**
 * btw-line-membership 单测（W4b 收编成员判别供数：喂入口径 + 负向记忆 + 失败分支）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 使用者（黑盒）：四个读取点（useCompletionNotify / useTrayCounts / useForkNoticeEffect /
 *   useBtwTabData 簿记）只经本模块出口判别，本文件锁住出口语义即锁住全部读取点行为；
 * - 观察者（形态）：补充拉取按需发起（事件驱动、不轮询）、在途去重、快照整表替换；
 * - 构建者（白盒）：负向记忆的写入条件（完整拉取的全集之外）与失效条件（相反证据）。
 *
 * 负向记忆的存在理由（本文件核心回归）：主会话与每个 subagent 会话每结束一个 turn 都走一次
 * message.complete → handleCompletion 步骤 0 判别；没有负向记忆时每个非线会话每次都落空并
 * 发起一次全量 session.list RPC（在途去重只能折叠并发、折叠不了连续调用），未读标记与完成
 * 提示音还被推迟一个 RPC 往返。
 *
 * mock 策略（TEST-STRATEGY §5）：vi.mock('@/api') 局部替换 session.listSessions（spread actual
 * 保门面其余域，useCompletionNotify / useBtwTabData 两测试同款）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/panel/btw-line-membership.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  __resetBtwLineMembershipForTest,
  ensureBtwLineMembership,
  isKnownBtwLine,
  noteBtwLinesPulled,
  refreshBtwLineMembership,
} from '@/composables/panel/btw-line-membership'

const sessionListMock = vi.hoisted(() => ({ listSessions: vi.fn() }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return { ...actual, session: { ...actual.session, listSessions: sessionListMock.listSessions } }
})

/** session.list reply 形态（SessionGroup[]）的最小 fixture：单组含全部线 id。 */
function btwGroup(ids: readonly string[]) {
  return [
    {
      cwd: '/repo/main',
      sessions: ids.map((id) => ({
        id,
        label: id,
        cwd: '/repo/main',
        status: 'idle',
        lastActiveAt: 0,
        surface: 'btw',
      })),
    },
  ]
}

beforeEach(() => {
  __resetBtwLineMembershipForTest()
  sessionListMock.listSessions.mockReset()
  sessionListMock.listSessions.mockResolvedValue([])
})

describe('btw-line-membership：正向缓存与喂入口径', () => {
  it('缓存命中（merge 喂入）同步判线，不发起 RPC', async () => {
    noteBtwLinesPulled(['line-1'])
    expect(isKnownBtwLine('line-1')).toBe(true)
    expect(await ensureBtwLineMembership('line-1')).toBe(true)
    expect(sessionListMock.listSessions).not.toHaveBeenCalled()
  })

  it('全量拉取整表替换（快照语义）：已关线的 id 出缓存', async () => {
    noteBtwLinesPulled(['line-1'])
    sessionListMock.listSessions.mockResolvedValue(btwGroup(['line-2']))
    const pulled = await refreshBtwLineMembership()
    expect([...(pulled ?? [])]).toEqual(['line-2'])
    expect(isKnownBtwLine('line-1')).toBe(false)
    expect(isKnownBtwLine('line-2')).toBe(true)
  })

  it('在途去重：并发落空的不同 id 共享同一次全量拉取', async () => {
    let resolveList!: (groups: unknown[]) => void
    sessionListMock.listSessions.mockImplementation(
      () => new Promise((resolve) => { resolveList = resolve }),
    )
    const a = ensureBtwLineMembership('main-a')
    const b = ensureBtwLineMembership('main-b')
    await vi.waitFor(() => expect(sessionListMock.listSessions).toHaveBeenCalledTimes(1), { interval: 1 })
    expect(sessionListMock.listSessions).toHaveBeenCalledWith({ surface: 'btw' })
    resolveList([])
    expect(await a).toBe(false)
    expect(await b).toBe(false)
  })
})

describe('btw-line-membership：负向记忆（已确认非线不再重复补充拉取）', () => {
  it('主会话 id 落空 → 补充拉取一次判非线；同一 id 再次判别不再触发全量拉取', async () => {
    expect(await ensureBtwLineMembership('main-1')).toBe(false)
    expect(sessionListMock.listSessions).toHaveBeenCalledTimes(1)
    // 负向记忆只影响 ensure 的补充拉取决策；同步读口仍是「未确认」语义（不是「确认是线」）
    expect(isKnownBtwLine('main-1')).toBe(false)
    // 连续 turn 完成（同 id 多次落空）：负向缓存命中，零 RPC
    expect(await ensureBtwLineMembership('main-1')).toBe(false)
    expect(await ensureBtwLineMembership('main-1')).toBe(false)
    expect(sessionListMock.listSessions).toHaveBeenCalledTimes(1)
  })

  it('subagent 会话同样落负向缓存：多个非线 id 各补充拉取一次后不再重复', async () => {
    expect(await ensureBtwLineMembership('sub-1')).toBe(false)
    expect(await ensureBtwLineMembership('sub-2')).toBe(false)
    expect(sessionListMock.listSessions).toHaveBeenCalledTimes(2)
    expect(await ensureBtwLineMembership('sub-1')).toBe(false)
    expect(await ensureBtwLineMembership('sub-2')).toBe(false)
    expect(sessionListMock.listSessions).toHaveBeenCalledTimes(2)
  })

  it('负向记忆被全量拉取刷新：先前判非线的 id 出现在后续全集 → 判线', async () => {
    expect(await ensureBtwLineMembership('late-line')).toBe(false)
    sessionListMock.listSessions.mockResolvedValue(btwGroup(['late-line']))
    // 另一个 id 落空触发全量拉取（拉取即刷新负向表）
    expect(await ensureBtwLineMembership('main-2')).toBe(false)
    expect(sessionListMock.listSessions).toHaveBeenCalledTimes(2)
    expect(await ensureBtwLineMembership('late-line')).toBe(true)
    expect(sessionListMock.listSessions).toHaveBeenCalledTimes(2)
  })

  it('负向记忆被 merge 喂入刷新：抽屉过滤拉取返回该 id → 同步判线', async () => {
    expect(await ensureBtwLineMembership('line-x')).toBe(false)
    noteBtwLinesPulled(['line-x'])
    expect(await ensureBtwLineMembership('line-x')).toBe(true)
    expect(sessionListMock.listSessions).toHaveBeenCalledTimes(1)
  })

  it('拉取失败 = 显式未知：不写负向缓存，后续仍按查找落空补充拉取', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sessionListMock.listSessions.mockRejectedValueOnce(new Error('ws down'))
    expect(await ensureBtwLineMembership('main-f')).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    expect(sessionListMock.listSessions).toHaveBeenCalledTimes(1)
    sessionListMock.listSessions.mockResolvedValue([])
    expect(await ensureBtwLineMembership('main-f')).toBe(false)
    expect(sessionListMock.listSessions).toHaveBeenCalledTimes(2)
    warnSpy.mockRestore()
  })
})
