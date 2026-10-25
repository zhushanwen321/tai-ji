// @vitest-environment happy-dom

/**
 * 搜索迁移壳接线测试（W4b，设计 §3.3.1/§5-W4b）：
 * 全局搜索 / 新任务搜索的 session 源从 `config.sessions` 查询侧改吃 `session.list`
 * 纯查询消息，调用侧**显式传 { surface:'sidebar' }**（不依赖无参默认语义——无参全量
 * 是给抽屉/调试用的口径，搜索只要侧栏口径）。
 *
 * 覆盖（不接线则回归形态 = 搜索吃到含 btw 线的全量口径 / 或仍走旧双语义消息）：
 * - useSearchModalDeps 的 ports.sessionList 调 session.listSessions({surface:'sidebar'})
 *   （wire 层 type=session.list 契约由 core domains.test.ts 断言，本文件断言壳侧显式传参）；
 * - 返回值为 domain 解包后的 SessionGroup[]（端口形状不变——「同一 port 换消息」，
 *   search/search-jump 编排零改动）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/features/search-modal-deps-session-list.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { SessionGroup } from '@taiji/shared'

const listSessionsMock = vi.hoisted(() => vi.fn(async (): Promise<SessionGroup[]> => []))
const listMock = vi.hoisted(() => vi.fn(async (): Promise<SessionGroup[]> => []))
const listArchivesMock = vi.hoisted(() => vi.fn(async () => []))

vi.mock('@taiji/core/transport/api/domains/session', () => ({
  list: listMock,
  listSessions: listSessionsMock,
  listArchives: listArchivesMock,
}))

import { useSearchModalDeps } from '@/composables/features/search/useSearchModalDeps'

describe('useSearchModalDeps：搜索 session 源迁移 session.list（W4b）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    listSessionsMock.mockClear()
    listMock.mockClear()
  })

  it('ports.sessionList 调 listSessions({surface:"sidebar"})——显式传参，不依赖无参默认语义', async () => {
    const deps = useSearchModalDeps({ selectSession: vi.fn(), newSession: vi.fn() })
    await deps.ports.sessionList()
    expect(listSessionsMock).toHaveBeenCalledTimes(1)
    expect(listSessionsMock).toHaveBeenCalledWith({ surface: 'sidebar' })
    // 旧 config.sessions 查询侧不再被搜索消费（同一 port 换消息）
    expect(listMock).not.toHaveBeenCalled()
  })

  it('返回 SessionGroup[] 原样（端口形状不变，编排层零改动）', async () => {
    const groups: SessionGroup[] = [{ cwd: '/repo', sessions: [] }]
    listSessionsMock.mockResolvedValueOnce(groups)
    const deps = useSearchModalDeps({ selectSession: vi.fn(), newSession: vi.fn() })
    await expect(deps.ports.sessionList()).resolves.toEqual(groups)
  })
})
