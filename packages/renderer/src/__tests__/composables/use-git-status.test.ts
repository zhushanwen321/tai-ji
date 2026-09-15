/**
 * useGitStatus 迁移测试 —— ADR-0049 per-session 状态隔离回归防护。
 *
 * 被测行为：result/commitMsg/error 三个 per-session 状态经 useSessionScopedState 分区后，
 * 同实例切换 sessionId 时分区天然隔离——A 的 git 状态/commitMsg/error 不泄漏到 B。
 *
 * 这是 ADR-0049 checklist #2 要求的回归测试：useGitStatus 从 watch 清理派迁移到
 * Map 分区派范式，本测试验证迁移后隔离性成立。
 *
 * mock 边界：gitApi.status/stage/unstage/commit mock 掉（transport 层不在本层职责）；
 * useSessionEvents mock 掉（事件订阅编排不在本层职责，本测试聚焦分区隔离语义）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-git-status.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, h, ref, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import {
  triggerSessionCleanups,
  __clearSessionCleanupRegistryForTest,
} from '@/composables/useSessionScopedState'
import type { GitStatusResult } from '@taiji/shared'
import { useGitStatus } from '@/composables/features/file-tree/useGitStatus'

// ── mock gitApi ──
const statusMock = vi.hoisted(() => vi.fn())
const stageMock = vi.hoisted(() => vi.fn())
const unstageMock = vi.hoisted(() => vi.fn())
const commitMock = vi.hoisted(() => vi.fn())

vi.mock('@/api', () => ({
  git: {
    status: statusMock,
    stage: stageMock,
    unstage: unstageMock,
    commit: commitMock,
  },
}))

// ── mock useSessionEvents：返回 onMessage 注册器，handler 收集到 Map 供测试手动触发 ──
const handlers = vi.hoisted(() => new Map<string, () => void>())
vi.mock('@/composables/features/chat/useSessionEvents', () => ({
  useSessionEvents: () => (event: string, fn: () => void) => {
    handlers.set(event, fn)
  },
}))

// ── 共享测试基建 ──

const SID_A = 'session-a'
const SID_B = 'session-b'

function makeGitResult(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    isRepo: true,
    branch: 'main',
    files: [],
    stagedCount: 0,
    unstagedCount: 0,
    hasConflict: false,
    ahead: 0,
    behind: 0,
    ...overrides,
  } as GitStatusResult
}

const mountedWrappers: VueWrapper[] = []

interface HostHandle {
  sidRef: ReturnType<typeof ref<string | null>>
  git: ReturnType<typeof import('@/composables/features/file-tree/useGitStatus').useGitStatus>
}

function mountHost(initialSid: string | null): HostHandle {
  const sidRef = ref<string | null>(initialSid)
  const wrapper = mount(
    defineComponent({
      setup() {
        const git = useGitStatus(sidRef)
        return { git }
      },
      render: () => h('div'),
    }),
  )
  mountedWrappers.push(wrapper)
  const candidate = (wrapper.vm as { git?: unknown }).git
  if (!candidate || typeof candidate !== 'object' || !('result' in candidate)) {
    throw new Error('host 组件未暴露 git')
  }
  return { sidRef, git: candidate as HostHandle['git'] }
}

/** 排空在途异步链 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

beforeEach(() => {
  handlers.clear()
  statusMock.mockReset()
  stageMock.mockReset()
  unstageMock.mockReset()
  commitMock.mockReset()
  // 默认 status 返回空仓库结果
  statusMock.mockResolvedValue(makeGitResult())
  __clearSessionCleanupRegistryForTest()
})

afterEach(() => {
  while (mountedWrappers.length) mountedWrappers.pop()?.unmount()
})

// ── 测试用例 ──

describe('useGitStatus per-session 隔离（ADR-0049 迁移回归）', () => {
  it('同实例切换 sessionId 后，A 的 result 不泄漏到 B', async () => {
    const resultA = makeGitResult({ stagedCount: 3, branch: 'feat-a' })
    statusMock.mockImplementation((sid: string) => {
      if (sid === SID_A) return Promise.resolve(resultA)
      return Promise.resolve(makeGitResult())
    })

    const host = mountHost(SID_A)
    await settle() // immediate watch → refresh() → status(SID_A)

    expect(host.git.result.value).toEqual(resultA)

    // 切到 B：B 分区应为 init 默认值（result=null），不被 A 污染
    host.sidRef.value = SID_B
    await settle() // watch → refresh() → status(SID_B)

    // B 的 result 是 status(SID_B) 返回值，不是 A 的数据
    expect(host.git.result.value).toEqual(makeGitResult())
    expect(host.git.result.value?.branch).not.toBe('feat-a')
  })

  it('同实例切换 sessionId 后，A 的 commitMsg 不泄漏到 B', async () => {
    const host = mountHost(SID_A)
    await settle()

    // A 设置 commitMsg
    host.git.commitMsg.value = 'feat: add feature A'
    expect(host.git.commitMsg.value).toBe('feat: add feature A')

    // 切到 B：B 的 commitMsg 应为空（init 默认值）
    host.sidRef.value = SID_B
    await settle()
    expect(host.git.commitMsg.value).toBe('')

    // 切回 A：A 的 commitMsg 应保留
    host.sidRef.value = SID_A
    await settle()
    expect(host.git.commitMsg.value).toBe('feat: add feature A')
  })

  it('同实例切换 sessionId 后，A 的 error 不泄漏到 B', async () => {
    statusMock.mockImplementation((sid: string) => {
      if (sid === SID_A) return Promise.reject(new Error('git fatal: not a repo'))
      return Promise.resolve(makeGitResult())
    })

    const host = mountHost(SID_A)
    await settle() // immediate watch → refresh() → 失败 → error 写入 A 分区

    expect(host.git.error.value).toBe('git fatal: not a repo')

    // 切到 B：B 的 error 应为空（init 默认值）
    host.sidRef.value = SID_B
    await settle()
    expect(host.git.error.value).toBe('')

    // 切回 A：A 的 error 应保留（分区不丢数据）
    host.sidRef.value = SID_A
    await settle()
    // refresh 会再次调用 status(SID_A)，仍失败，error 重写
    expect(host.git.error.value).toBe('git fatal: not a repo')
  })

  it('commit 操作后 commitMsg 清空只影响当前 session 分区', async () => {
    statusMock.mockResolvedValue(makeGitResult({ stagedCount: 1 }))
    stageMock.mockResolvedValue(undefined)
    commitMock.mockResolvedValue(undefined)

    const host = mountHost(SID_A)
    await settle()

    // A 设置 commitMsg 并提交
    host.git.commitMsg.value = 'feat: test commit'
    await host.git.commit()
    await settle()

    expect(host.git.commitMsg.value).toBe('') // commit 后清空

    // 设置 B 的 commitMsg
    host.sidRef.value = SID_B
    await settle()
    host.git.commitMsg.value = 'fix: B 的修复'
    expect(host.git.commitMsg.value).toBe('fix: B 的修复')

    // 切回 A：A 的 commitMsg 应为空（commit 后已清空，不受 B 影响）
    host.sidRef.value = SID_A
    await settle()
    expect(host.git.commitMsg.value).toBe('')
  })

  it('stageAll/unstageAll 操作写入当前 session 分区', async () => {
    const resultAfterStage = makeGitResult({ stagedCount: 5, unstagedCount: 0 })
    statusMock.mockResolvedValue(makeGitResult({ stagedCount: 0, unstagedCount: 5 }))
    stageMock.mockResolvedValue(undefined)

    // 第二次 status 调用返回 stage 后结果
    let statusCallCount = 0
    statusMock.mockImplementation(() => {
      statusCallCount++
      if (statusCallCount <= 1) return Promise.resolve(makeGitResult({ stagedCount: 0, unstagedCount: 5 }))
      return Promise.resolve(resultAfterStage)
    })

    const host = mountHost(SID_A)
    await settle()

    await host.git.stageAll()
    await settle()

    expect(host.git.result.value).toEqual(resultAfterStage)
  })

  it('triggerSessionCleanups 后分区重置为 init 默认值', async () => {
    const resultA = makeGitResult({ stagedCount: 3 })
    statusMock.mockResolvedValue(resultA)

    const host = mountHost(SID_A)
    await settle()

    expect(host.git.result.value).toEqual(resultA)
    host.git.commitMsg.value = 'test'
    expect(host.git.commitMsg.value).toBe('test')

    // 清理 session A
    triggerSessionCleanups(SID_A)

    // 分区被清理，current 回到 init 默认值
    expect(host.git.result.value).toBeNull()
    expect(host.git.commitMsg.value).toBe('')
    expect(host.git.error.value).toBe('')
  })

  it('canCommit 依赖 commitMsg 和 pending 和 hasConflict（per-session 语义）', async () => {
    statusMock.mockResolvedValue(makeGitResult({ hasConflict: false, stagedCount: 1 }))

    const host = mountHost(SID_A)
    await settle()

    // 空 commitMsg → 不能提交
    expect(host.git.canCommit.value).toBe(false)

    // 有 commitMsg → 可提交
    host.git.commitMsg.value = 'test'
    expect(host.git.canCommit.value).toBe(true)

    // 切到 B（B 的 commitMsg 为空）→ 不能提交
    host.sidRef.value = SID_B
    await settle()
    expect(host.git.canCommit.value).toBe(false)

    // 切回 A（A 的 commitMsg 仍在）→ 可提交
    host.sidRef.value = SID_A
    await settle()
    expect(host.git.canCommit.value).toBe(true)
  })

  it('state/indicator 四态派生依赖 result 分区（per-session）', async () => {
    // A 有 conflict
    statusMock.mockImplementation((sid: string) => {
      if (sid === SID_A) return Promise.resolve(makeGitResult({ hasConflict: true }))
      return Promise.resolve(makeGitResult({ unstagedCount: 2 }))
    })

    const host = mountHost(SID_A)
    await settle()

    expect(host.git.state.value).toBe('conflict')
    expect(host.git.indicator.value.conflict).toBe(true)

    // 切到 B：B 是 dirty
    host.sidRef.value = SID_B
    await settle()

    expect(host.git.state.value).toBe('dirty')
    expect(host.git.indicator.value.dirty).toBe(true)
    expect(host.git.indicator.value.conflict).toBe(false)
  })

  it('message.complete 事件触发 refresh（幂等刷新，保持现状）', async () => {
    statusMock.mockResolvedValue(makeGitResult({ stagedCount: 1 }))

    const host = mountHost(SID_A)
    await settle()

    // 模拟 message.complete 事件
    const handler = handlers.get('message.complete')
    expect(handler).toBeDefined()
    handler!()
    await settle()

    // refresh 被调用（status 至少 2 次：immediate + message.complete）
    expect(statusMock).toHaveBeenCalledTimes(2)
  })
})
