/**
 * useTraceJump 溯源跳转编排单测（design §3.1 样例 5，trace-jump）。
 *
 * 覆盖：
 * - target_not_found：parentSession 两形态都无法解析到列表 session
 * - 成功路径（sessionId 形态 + 文件路径形态）：selectSession 切换 + 目标分区切 Trace 视图
 *   + 清过滤 + 等 ready + revealTraceEntry 定位 forkEntryId（selectedKey + revealRequest）
 * - 目标 trace 加载失败（error 态）→ load_failed
 *
 * selectSession mock 为 panel focusedSessionId 切换（生产里 selectSession 内部
 * syncSessionToPanel 同步做同一件事），避免拉起 useSidebar 的重依赖链。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/session-trace/useTraceJump.test.ts
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { computed } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { usePanelStore, ROOT_PANEL_ID } from '@/stores/panel'
import { useSessionStore } from '@/stores/session'
import type { ServerMessageMap, SessionGroup } from '@taiji/shared'

// ── mock '@/api'（loadTrace 走 session.getTraceEntries）──
const apiMock = vi.hoisted(() => ({ getTraceEntries: vi.fn() }))
vi.mock('@/api', () => ({
  session: { getTraceEntries: apiMock.getTraceEntries },
}))

// ── mock useSidebar：selectSession 记录调用 + 模拟 focusedSessionId 切换 ──
const sidebarMock = vi.hoisted(() => ({ selectSession: vi.fn() }))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ selectSession: sidebarMock.selectSession }),
}))

import { jumpToParentSession } from '@/composables/features/trace/useTraceJump'
import {
  _resetTraceStoreForTest,
  bindTraceSessionId,
  setTraceFilter,
  useSessionTrace,
} from '@/composables/features/trace/useSessionTrace'

const FORK_SID = 'sid-fork-child'
const SRC_SID = 'sid-fork-src'
const SRC_FILE = '/root/dirA/2026-08-20T09-41-02_sid-fork-src.jsonl'

/** 源 session trace snapshot（header 带 forkEntryId 指回的 entry 由测试数据表达）。 */
function buildSrcSnapshot(): ServerMessageMap['session.traceEntries'] {
  return {
    sessionId: SRC_SID,
    source: 'file',
    header: { type: 'session', version: 1, id: 'h-src', cwd: '/w/src' },
    entries: [
      { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: '源消息' } },
      { type: 'message', id: 'fork-point', parentId: 'e1', message: { role: 'assistant', provider: 'p', model: 'm', content: [{ type: 'text', text: 'fork 点' }] } },
    ],
    malformed: [],
    leafId: 'fork-point',
  }
}

/** 装配 sidebar 列表（两个 session：fork 子 + 源）。 */
function seedSessions(): void {
  const groups: SessionGroup[] = [
    {
      cwd: '/w',
      sessions: [
        {
          id: FORK_SID, label: 'fork-child', cwd: '/w', status: 'done', lastActiveAt: 1, modelId: 'm', tokenCount: 0,
          sessionFile: '/root/dirA/2026-08-20T10-00-00_sid-fork-child.jsonl',
        },
        {
          id: SRC_SID, label: 'fork-src', cwd: '/w', status: 'done', lastActiveAt: 2, modelId: 'm', tokenCount: 0,
          sessionFile: SRC_FILE,
        },
      ],
    },
  ]
  // ADR-0059 薄壳 store 无 setGroups 整表入口（main 侧 W 修订），走 applySnapshot
  //（new-task use-new-task-flow.test.ts 同款范式）
  useSessionStore().applySnapshot({ groups })
}

/** 挂载后的响应式上下文建立（模块级 watch 无需组件；await 一轮微任务让初始 ensureLoaded 启动）。 */
async function setupShim(): Promise<void> {
  await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMock.getTraceEntries.mockReset()
  apiMock.getTraceEntries.mockResolvedValue(buildSrcSnapshot())
  sidebarMock.selectSession.mockReset()
  // selectSession mock：模拟生产 selectSession 内部的 focusedSessionId 切换（同步）
  sidebarMock.selectSession.mockImplementation(async (id: string) => {
    usePanelStore().loadSession(ROOT_PANEL_ID, id)
  })
  _resetTraceStoreForTest()
  setActivePinia(createPinia())
  bindTraceSessionId(computed(() => usePanelStore().focusedSessionId))
  usePanelStore().loadSession(ROOT_PANEL_ID, FORK_SID)
  seedSessions()
})

describe('jumpToParentSession（溯源跳转编排）', () => {
  it('目标不在列表 → target_not_found，不切 session', async () => {
    const result = await jumpToParentSession(FORK_SID, 'gone-id')
    expect(result).toEqual({ ok: false, reason: 'target_not_found' })
    expect(sidebarMock.selectSession).not.toHaveBeenCalled()
  })

  it('sessionId fallback 形态：切源 session + Trace 视图 + 清过滤 + 定位 forkEntryId', async () => {
    await setupShim()
    // 预置目标分区的脏过滤态（验证跳转清过滤保证行可见）
    setTraceFilter(SRC_SID, { contextOnly: true, activeGroups: ['messages'], searchText: 'xx' })
    const result = await jumpToParentSession(FORK_SID, SRC_SID, 'fork-point')
    expect(result).toEqual({ ok: true, targetSessionId: SRC_SID })
    // 切换 + 视图 + 过滤清空
    expect(sidebarMock.selectSession).toHaveBeenCalledWith(SRC_SID)
    const p = useSessionTrace().partition.value
    expect(p.view).toBe('trace')
    expect(p.contextOnly).toBe(false)
    expect(p.activeGroups).toEqual([])
    expect(p.searchText).toBe('')
    // 定位：选中 + reveal 请求指向 forkEntryId
    expect(p.selectedKey).toBe('fork-point')
    expect(p.revealRequest?.key).toBe('fork-point')
    expect(p.revealRequest?.nonce).toBeGreaterThan(0)
  })

  it('文件路径形态：sessionFile 精确匹配命中同一源', async () => {
    await setupShim()
    const result = await jumpToParentSession(FORK_SID, SRC_FILE, 'fork-point')
    expect(result).toEqual({ ok: true, targetSessionId: SRC_SID })
    expect(useSessionTrace().partition.value.selectedKey).toBe('fork-point')
  })

  it('目标 trace 加载失败 → load_failed，不写定位', async () => {
    await setupShim()
    apiMock.getTraceEntries.mockRejectedValue(new Error('boom'))
    const result = await jumpToParentSession(FORK_SID, SRC_SID, 'fork-point')
    expect(result).toEqual({ ok: false, reason: 'load_failed' })
    expect(useSessionTrace().partition.value.revealRequest).toBeNull()
  })

  it('无 forkEntryId：只切视图不定位（selectedKey 不写）', async () => {
    await setupShim()
    const result = await jumpToParentSession(FORK_SID, SRC_SID)
    expect(result).toEqual({ ok: true, targetSessionId: SRC_SID })
    const p = useSessionTrace().partition.value
    expect(p.view).toBe('trace')
    expect(p.selectedKey).toBeNull()
    expect(p.revealRequest).toBeNull()
  })
})
