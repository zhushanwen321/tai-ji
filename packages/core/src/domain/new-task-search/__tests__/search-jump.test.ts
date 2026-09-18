/**
 * useSearchJump 单测（IF6，core 版）。
 *
 * 覆盖 plan TC-7..TC-10：app 命令执行 + recents、slash 注入 pendingSlash、command action 抛错、
 * file 分支成败（selectFile + drawerTab）、session 反查成败、symbol 占位。
 * 端口全 vi.fn() 注入；真实 createCommandStore。
 * 环境：vitest node。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { FileNode, SessionGroup } from '@taiji/shared'
import type { KVStorage } from '../../../platform/port'
import { createCommandStore } from '../command-store'
import { useSearchJump } from '../search-jump'
import type { SearchDeps } from '../search-ports'
import type { AppCommand, SearchItem } from '../types'

/** Map 实现 KVStorage */
function makeMockStorage(initial?: Record<string, string>): KVStorage & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null
    },
    async set(key: string, value: string) {
      store.set(key, value)
    },
    async remove(key: string) {
      store.delete(key)
    },
  }
}

/** 构造 mock SearchDeps */
function makeDeps(overrides?: Partial<SearchDeps>): SearchDeps {
  const commandStore = createCommandStore(makeMockStorage())
  const deps: SearchDeps = {
    ports: {
      isMock: false,
      isMac: false,
      searchMock: vi.fn(async () => []),
      fileRead: vi.fn(async () => {}),
      fileCandidates: vi.fn(async () => [] as FileNode[]),
      sessionList: vi.fn(async () => [] as SessionGroup[]),
      selectSession: vi.fn(async () => {}),
      t: vi.fn((key: string) => key),
    },
    commandStore,
    storage: makeMockStorage(),
    fileTree: { loadTree: vi.fn(async () => {}), selectFile: vi.fn() },
    appCommandActions: {
      newSession: vi.fn(),
      goOverview: vi.fn(),
      toggleSidebar: vi.fn(),
      requestPresetOpen: vi.fn(),
    },
  }
  if (overrides) {
    if (overrides.ports) deps.ports = { ...deps.ports, ...overrides.ports }
    if (overrides.storage) deps.storage = overrides.storage
    if (overrides.fileTree) deps.fileTree = { ...deps.fileTree, ...overrides.fileTree }
    if (overrides.commandStore) deps.commandStore = overrides.commandStore
  }
  return deps
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TC-7: app 命令执行 + recents', () => {
  it('confirm({type:command, commandKind:app}) → action 调 + recents 写 + {ok:true}', async () => {
    const deps = makeDeps()
    const action = vi.fn()
    deps.commandStore.registerApp([{ id: 'n', name: '新建', action }])

    const { confirm } = useSearchJump(deps)
    const item: SearchItem = { type: 'command', title: '新建', sub: '⌘N', commandKind: 'app' }
    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result).toEqual({ ok: true })
    expect(action).toHaveBeenCalledTimes(1)
    // recents 写入（storage 已持久化）
    const raw = await deps.storage.get('taiji:search-recents')
    expect(raw).toContain('"command:新建"')
  })
})

describe('TC-8: slash 注入 pendingSlash', () => {
  it('confirm(slash 带 icon) → pendingSlash 写入（icon 透传 + sessionId 透传）+ {ok:true}', async () => {
    const deps = makeDeps()
    const { confirm } = useSearchJump(deps)
    const item: SearchItem = { type: 'command', title: 'commit', sub: '提交改动', icon: 'wrench', commandKind: 'slash' }
    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result).toEqual({ ok: true })
    expect(deps.commandStore.pendingSlash.value).not.toBeNull()
    expect(deps.commandStore.pendingSlash.value).toMatchObject({ command: 'commit', icon: 'wrench', sessionId: 's1' })
  })

  it('landing 态（activeSessionId=null）slash 注入放行，sessionId 透传 null', async () => {
    const deps = makeDeps()
    const { confirm } = useSearchJump(deps)
    const item: SearchItem = { type: 'command', title: 'review', sub: '代码评审', commandKind: 'slash' }
    const result = await confirm(item, { activeSessionId: null })

    expect(result).toEqual({ ok: true })
    expect(deps.commandStore.pendingSlash.value!.sessionId).toBeNull()
  })

  it('skill 命令项（isSkill:true + location）→ 两字段透传进 pendingSlash（消费侧据此分流 skill 通路）', async () => {
    const deps = makeDeps()
    const { confirm } = useSearchJump(deps)
    const item: SearchItem = {
      type: 'command',
      title: 'skill:code-review',
      sub: '代码评审',
      icon: 'star',
      commandKind: 'slash',
      isSkill: true,
      location: '/skills/code-review/SKILL.md',
    }
    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result).toEqual({ ok: true })
    expect(deps.commandStore.pendingSlash.value).toMatchObject({
      command: 'skill:code-review',
      icon: 'star',
      sessionId: 's1',
      isSkill: true,
      location: '/skills/code-review/SKILL.md',
    })
  })

  it('普通命令项（无 isSkill/location）→ pendingSlash 两字段 undefined（命令通路回归锁）', async () => {
    const deps = makeDeps()
    const { confirm } = useSearchJump(deps)
    const item: SearchItem = { type: 'command', title: 'goal', sub: '目标', icon: 'goal', commandKind: 'slash' }
    await confirm(item, { activeSessionId: 's1' })

    const pending = deps.commandStore.pendingSlash.value!
    expect(pending.isSkill).toBeUndefined()
    expect(pending.location).toBeUndefined()
  })

  it('command action 抛错 → {ok:false,error}（AC-6.8）', async () => {
    const deps = makeDeps()
    deps.commandStore.registerApp([{ id: 'n', name: '抛错', action: () => { throw new Error('boom') } }])
    const { confirm } = useSearchJump(deps)
    const item: SearchItem = { type: 'command', title: '抛错', sub: 'x', commandKind: 'app' }
    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toBe('boom')
  })

  it('app 命令未注册 → {ok:false,error}（search.commandNotFound）', async () => {
    const deps = makeDeps()
    const { confirm } = useSearchJump(deps)
    const item: SearchItem = { type: 'command', title: '不存在的命令', sub: 'x', commandKind: 'app' }
    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toBe('search.commandNotFound')
  })
})

describe('TC-9: file 分支（AC-6.5/6.9）', () => {
  it('file.read 成功 → selectFile 调 + {ok:true, drawerTab:detail} + recents 写', async () => {
    const deps = makeDeps()
    const { confirm } = useSearchJump(deps)
    const item: SearchItem = { type: 'file', title: 'a.ts', sub: 'src/a.ts' }
    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result).toEqual({ ok: true, drawerTab: 'detail' })
    expect(deps.ports.fileRead).toHaveBeenCalledWith('src/a.ts', 's1')
    expect(deps.fileTree.selectFile).toHaveBeenCalledWith('src/a.ts')
    const raw = await deps.storage.get('taiji:search-recents')
    expect(raw).toContain('"file:a.ts"')
  })

  it('file.read reject → {ok:false} + selectFile 不调（直调不吞错）', async () => {
    const deps = makeDeps()
    ;(deps.ports.fileRead as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EACCES'))
    const { confirm } = useSearchJump(deps)
    const item: SearchItem = { type: 'file', title: 'a.ts', sub: 'src/a.ts' }
    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toBe('EACCES')
    expect(deps.fileTree.selectFile).not.toHaveBeenCalled()
  })
})

describe('TC-10: session 分支（AC-6.6）', () => {
  it('session 反查命中 → selectSession(id) + {ok:true}', async () => {
    const deps = makeDeps()
    const groups: SessionGroup[] = [
      { cwd: '/tmp/x', sessions: [{ id: 's1', cwd: '/tmp/x', label: '测试会话' } as never] },
    ]
    ;(deps.ports.sessionList as ReturnType<typeof vi.fn>).mockResolvedValue(groups)
    const { confirm } = useSearchJump(deps)
    const item: SearchItem = { type: 'session', title: '测试会话', sub: '/tmp/x' }
    const result = await confirm(item, { activeSessionId: null })

    expect(result).toEqual({ ok: true })
    expect(deps.ports.selectSession).toHaveBeenCalledWith('s1')
  })

  it('session 反查未命中 → {ok:false} + selectSession 不调', async () => {
    const deps = makeDeps()
    ;(deps.ports.sessionList as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const { confirm } = useSearchJump(deps)
    const item: SearchItem = { type: 'session', title: '不存在', sub: '/tmp' }
    const result = await confirm(item, { activeSessionId: null })

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toBe('search.sessionNotFound')
    expect(deps.ports.selectSession).not.toHaveBeenCalled()
  })

  it('selectSession reject → {ok:false}（AC-6.6）', async () => {
    const deps = makeDeps()
    const groups: SessionGroup[] = [
      { cwd: '/tmp/x', sessions: [{ id: 's1', cwd: '/tmp/x', label: '测试会话' } as never] },
    ]
    ;(deps.ports.sessionList as ReturnType<typeof vi.fn>).mockResolvedValue(groups)
    ;(deps.ports.selectSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('switch failed'))
    const { confirm } = useSearchJump(deps)
    const item: SearchItem = { type: 'session', title: '测试会话', sub: '/tmp/x' }
    const result = await confirm(item, { activeSessionId: null })

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toBe('switch failed')
  })
})

describe('symbol 占位（D-001）', () => {
  it('confirm({type:symbol}) → {ok:false} 不调 domain/store', async () => {
    const deps = makeDeps()
    const { confirm } = useSearchJump(deps)
    const item: SearchItem = { type: 'symbol', title: 'sym()', sub: 'a.ts:42' }
    const result = await confirm(item, { activeSessionId: 's1' })

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toBe('search.symbolUnavailable')
    expect(deps.ports.fileRead).not.toHaveBeenCalled()
    expect(deps.ports.selectSession).not.toHaveBeenCalled()
    expect(deps.commandStore.pendingSlash.value).toBeNull()
  })
})
