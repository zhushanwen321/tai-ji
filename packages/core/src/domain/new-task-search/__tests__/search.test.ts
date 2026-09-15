/**
 * useSearch 单测（IF6，core 版）。
 *
 * 覆盖 plan TC-1..TC-6 + DTO 映射：mock 轨 4 类型合并 + 符号占位、loadSeq 乱序守卫、
 * stale cache teardown、file 缓存命中不调端口、双源 reject 静默、WS 超时 race、截断、符号占位恒定。
 * 端口全 vi.fn() 注入（SearchDeps），真实 vue reactivity + 真实 createCommandStore/createFileSearchStore。
 * 环境：vitest node（无 happy-dom）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { FileNode, SessionGroup } from '@taiji/shared'
import type { KVStorage } from '../../../platform/port'
import { createCommandStore } from '../command-store'
import { createFileSearchStore } from '../file-search-store'
import { useSearch } from '../search'
import type { SearchDeps } from '../search-ports'
import type { AppCommand, Section, SearchItem } from '../types'
import type { SessionCommand } from '../command-store'

/** Map 实现 KVStorage（对齐 command-store.test.ts 的 makeMockStorage 模式） */
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

/** 构造 mock SearchDeps（每测试独立实例，断言 per-test） */
function makeDeps(overrides?: Partial<SearchDeps>): SearchDeps {
  const commandStore = createCommandStore(makeMockStorage())
  const fileSearchStore = createFileSearchStore()
  const deps: SearchDeps = {
    ports: {
      isMock: false,
      isMac: false,
      searchMock: vi.fn(async () => [] as Section[]),
      fileRead: vi.fn(async () => {}),
      fileCandidates: vi.fn(async () => [] as FileNode[]),
      sessionList: vi.fn(async () => [] as SessionGroup[]),
      selectSession: vi.fn(async () => {}),
      watchFileChanges: vi.fn(() => () => {}),
      // t 返回实际本地化标签（mock fixture 用中文标签，与 real 轨 i18n 行为一致）
      t: vi.fn((key: string) => {
        const labels: Record<string, string> = {
          'search.sectionSymbol': '符号',
          'search.recent': '最近',
          'search.suggestedCommand': '建议命令',
          'search.sectionCommand': '命令',
          'search.sectionFile': '文件',
          'search.sectionSession': '会话',
        }
        return labels[key] ?? key
      }),
    },
    commandStore,
    fileSearchStore,
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
    if (overrides.commandStore) deps.commandStore = overrides.commandStore
    if (overrides.fileSearchStore) deps.fileSearchStore = overrides.fileSearchStore
    if (overrides.storage) deps.storage = overrides.storage
    if (overrides.fileTree) deps.fileTree = { ...deps.fileTree, ...overrides.fileTree }
    if (overrides.appCommandActions) deps.appCommandActions = { ...deps.appCommandActions, ...overrides.appCommandActions }
  }
  return deps
}

/** 构造一个 file FileNode */
function fileNode(path: string, name?: string): FileNode {
  return { path, name: name ?? path.split('/').pop() ?? path, type: 'file' }
}

/** 从 sections 找指定 kind 的 section */
function findSection(sections: Section[], kind: Section['kind']): Section | undefined {
  return sections.find((s) => s.kind === kind)
}

describe('TC-1: mock 轨 4 类型合并 + 符号占位', () => {
  it('isMock=true + searchMock 返 3 section → 补 symbol 占位，返回 4 section', async () => {
    const deps = makeDeps()
    deps.ports.isMock = true
    const mockSections: Section[] = [
      { kind: 'command', label: '命令', items: [{ type: 'command', title: 'c1', sub: 's', commandKind: 'app' }] },
      { kind: 'file', label: '文件', items: [{ type: 'file', title: 'f1', sub: 'p' }] },
      { kind: 'session', label: '会话', items: [{ type: 'session', title: 'se1', sub: 'cwd' }] },
    ]
    ;(deps.ports.searchMock as ReturnType<typeof vi.fn>).mockResolvedValue(mockSections)

    const sid = ref<string | null>('s1')
    const { query } = useSearch(sid, deps)
    const sections = await query('x', { activeSessionId: 's1' })

    expect(sections.map((s) => s.kind)).toEqual(['command', 'file', 'session', 'symbol'])
    const symbol = findSection(sections, 'symbol')
    expect(symbol).toBeTruthy()
    expect(symbol!.items).toEqual([])
  })

  it('mock fixture 已含 symbol section → 不重复补', async () => {
    const deps = makeDeps()
    deps.ports.isMock = true
    const mockSections: Section[] = [
      { kind: 'symbol', label: '符号', items: [] },
      { kind: 'command', label: '命令', items: [] },
    ]
    ;(deps.ports.searchMock as ReturnType<typeof vi.fn>).mockResolvedValue(mockSections)

    const { query } = useSearch(ref<string | null>('s1'), deps)
    const sections = await query('x', { activeSessionId: 's1' })
    expect(sections.filter((s) => s.kind === 'symbol')).toHaveLength(1)
  })
})

describe('TC-2: loadSeq 乱序守卫', () => {
  it('第一次查询慢（永不 resolve），第二次快速：旧结果不覆盖第二次', async () => {
    const deps = makeDeps()
    const slowPending = new Promise<FileNode[]>(() => {}) // 永不 settle
    ;(deps.ports.fileCandidates as ReturnType<typeof vi.fn>).mockReturnValueOnce(slowPending)
    ;(deps.ports.fileCandidates as ReturnType<typeof vi.fn>).mockReturnValueOnce(Promise.resolve([fileNode('b.ts')]))

    const { query } = useSearch(ref<string | null>('s1'), deps)

    const firstP = query('a', { activeSessionId: 's1' })
    const secondSections = await query('b', { activeSessionId: 's1' })

    // 第二次命中文件 b.ts
    const fileSection = findSection(secondSections, 'file')
    expect(fileSection).toBeTruthy()
    expect(fileSection!.items.some((it) => it.title === 'b.ts')).toBe(true)

    // 第一次的 promise 仍 pending（永不 settle），不会 resolve 出旧结果覆盖
    const settled = await Promise.race([
      firstP.then(() => 'resolved'),
      Promise.resolve('pending'),
    ])
    expect(settled).toBe('pending')
  })
})

describe('TC-3: stale cache teardown', () => {
  it('activeSessionId 从 null → s1 时 watchFileChanges 端口被调（sid=s1）', async () => {
    const deps = makeDeps()
    const sid = ref<string | null>(null)
    useSearch(sid, deps)

    expect(deps.ports.watchFileChanges).not.toHaveBeenCalled()
    sid.value = 's1'
    await vi.waitFor(() => {
      expect(deps.ports.watchFileChanges).toHaveBeenCalledWith('s1', expect.any(Function))
    })
  })

  it('切换 sid 时旧 unwatch 被调 + 新 sid 重新订阅', async () => {
    const deps = makeDeps()
    const unwatch1 = vi.fn()
    const unwatch2 = vi.fn()
    ;(deps.ports.watchFileChanges as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(unwatch1)
      .mockReturnValueOnce(unwatch2)
    const sid = ref<string | null>('s1')
    useSearch(sid, deps)

    await vi.waitFor(() => {
      expect(deps.ports.watchFileChanges).toHaveBeenCalledTimes(1)
    })
    sid.value = 's2'
    await vi.waitFor(() => {
      expect(deps.ports.watchFileChanges).toHaveBeenCalledTimes(2)
      expect(unwatch1).toHaveBeenCalled()
    })
  })
})

describe('TC-4: file 缓存命中不调 fileCandidates', () => {
  it('fileSearchStore.get 返缓存 → fileCandidates 端口零调用，file 分组来自缓存', async () => {
    const deps = makeDeps()
    deps.fileSearchStore.set('s1', [fileNode('src/cached.ts')])
    // 注册应用命令，确保命令源非空（query 走非空分支）
    deps.commandStore.registerApp([{ id: 'n', name: '新建', action: vi.fn() }])

    const { query } = useSearch(ref<string | null>('s1'), deps)
    const sections = await query('cached', { activeSessionId: 's1' })

    expect(deps.ports.fileCandidates).not.toHaveBeenCalled()
    const fileSection = findSection(sections, 'file')
    expect(fileSection!.items[0]?.title).toBe('cached.ts')
  })
})

describe('TC-5: 双源 reject 静默（MR-4.2）', () => {
  it('fileCandidates reject + sessionList reject → file/session 分组空，命令分组仍工作，不抛', async () => {
    const deps = makeDeps()
    ;(deps.ports.fileCandidates as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('file down'))
    ;(deps.ports.sessionList as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('session down'))
    deps.commandStore.registerApp([{ id: 'n', name: '新建', action: vi.fn() }])

    const { query } = useSearch(ref<string | null>('s1'), deps)
    const sections = await query('新', { activeSessionId: 's1' })

    const fileSection = findSection(sections, 'file')
    expect(fileSection).toBeUndefined() // file 分组空（被过滤）
    expect(findSection(sections, 'session')).toBeUndefined()
    expect(findSection(sections, 'command')).toBeTruthy() // 命令仍工作
  })
})

describe('TC-6: WS 超时 race 不挂死', () => {
  it('fileCandidates 返永不 settle promise → fake timers 推进 10s → file 分组空（不永久 pending）', async () => {
    vi.useFakeTimers()
    try {
      const deps = makeDeps()
      ;(deps.ports.fileCandidates as ReturnType<typeof vi.fn>).mockReturnValue(new Promise<FileNode[]>(() => {}))
      deps.commandStore.registerApp([{ id: 'n', name: '新建', action: vi.fn() }])

      const { query } = useSearch(ref<string | null>('s1'), deps)
      const queryP = query('x', { activeSessionId: 's1' })
      await vi.advanceTimersByTimeAsync(10_000 + 100) // 超时 race 触发

      const sections = await queryP
      expect(sections).toBeDefined()
      expect(findSection(sections, 'file')).toBeUndefined() // 超时 reject → file 分组空
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DTO 映射', () => {
  it('AppCommand 映射无 icon + commandKind:app', async () => {
    const deps = makeDeps()
    deps.commandStore.registerApp([{ id: 'n', name: '新建', shortcut: '⌘N', action: vi.fn() }])

    const { query } = useSearch(ref<string | null>('s1'), deps)
    const sections = await query('新', { activeSessionId: 's1' })
    const cmd = findSection(sections, 'command')!.items[0]
    expect(cmd).toMatchObject({ type: 'command', title: '新建', sub: '⌘N', commandKind: 'app' })
    expect('icon' in cmd ? cmd.icon : undefined).toBeUndefined()
  })

  it('SessionCommand 映射带 icon（star）+ commandKind:slash', async () => {
    const deps = makeDeps()
    const raw = { name: 'review', source: 'skill', description: '代码评审' }
    deps.commandStore.applyCommands('s1', [raw])

    const { query } = useSearch(ref<string | null>('s1'), deps)
    const sections = await query('review', { activeSessionId: 's1' })
    const cmd = findSection(sections, 'command')!.items[0]
    expect(cmd).toMatchObject({
      type: 'command',
      title: 'review',
      sub: '代码评审',
      icon: 'star',
      commandKind: 'slash',
    })
  })

  it('skill 命令（source=skill + sourceInfo.path）→ isSkill:true + location 带出（判据同 buildPanelSlashCandidates）', async () => {
    const deps = makeDeps()
    deps.commandStore.applyCommands('s1', [
      {
        name: 'skill:code-review',
        description: '代码评审',
        source: 'skill',
        sourceInfo: { path: '/skills/code-review/SKILL.md', source: 'skill' },
      },
    ])

    const { query } = useSearch(ref<string | null>('s1'), deps)
    const sections = await query('code', { activeSessionId: 's1' })
    const cmd = findSection(sections, 'command')!.items[0]
    // isSkill 判据 = SessionCommand.kind === 'skill'（applyCommands 把 pi source 归一化进 kind）
    expect(cmd.isSkill).toBe(true)
    // SKILL.md 路径从 sourceInfo.path 带出（搜索注入侧据此落 chip dataset）
    expect(cmd.location).toBe('/skills/code-review/SKILL.md')
  })

  it('非 skill 命令（source=extension）→ isSkill:false 且无 location（命令分支零变化）', async () => {
    const deps = makeDeps()
    deps.commandStore.applyCommands('s1', [
      { name: 'commit', description: '提交', source: 'extension' },
    ])

    const { query } = useSearch(ref<string | null>('s1'), deps)
    const sections = await query('commit', { activeSessionId: 's1' })
    const cmd = findSection(sections, 'command')!.items[0]
    expect(cmd.isSkill).toBe(false)
    expect(cmd.location).toBeUndefined()
  })

  it('AppCommand 映射不带 isSkill/location（应用命令分支零变化）', async () => {
    const deps = makeDeps()
    deps.commandStore.registerApp([{ id: 'n', name: '新建', shortcut: '⌘N', action: vi.fn() }])

    const { query } = useSearch(ref<string | null>('s1'), deps)
    const sections = await query('新', { activeSessionId: 's1' })
    const cmd = findSection(sections, 'command')!.items[0]
    expect(cmd.isSkill).toBeUndefined()
    expect(cmd.location).toBeUndefined()
  })

  it('SessionSummary 无 gitBranch → sub 不含 "undefined"', async () => {
    const deps = makeDeps()
    const groups: SessionGroup[] = [
      {
        cwd: '/tmp/x',
        sessions: [
          { id: 's1', cwd: '/tmp/x', label: '测试会话' } as never,
        ],
      },
    ]
    ;(deps.ports.sessionList as ReturnType<typeof vi.fn>).mockResolvedValue(groups)

    const { query } = useSearch(ref<string | null>('s1'), deps)
    const sections = await query('测试', { activeSessionId: 's1' })
    const session = findSection(sections, 'session')!.items[0]
    expect(session.sub).toBe('/tmp/x')
    expect(session.sub.includes('undefined')).toBe(false)
  })
})

describe('空查询：recents + 建议命令', () => {
  it('空查询返回 recent + suggested 分组（recents 来自 storage）', async () => {
    const deps = makeDeps()
    // 预置 storage recents + 注册 app 命令（suggested 来源）
    deps.storage.set(
      'taiji:search-recents',
      JSON.stringify([{ type: 'file', key: 'file:a', timestamp: 1, title: 'a.ts', sub: 'src' }]),
    )
    deps.commandStore.registerApp([
      { id: 'n1', name: '新建', action: vi.fn() },
      { id: 'n2', name: '概览', action: vi.fn() },
      { id: 'n3', name: '收起侧栏', action: vi.fn() },
      { id: 'n4', name: '预设', action: vi.fn() },
    ])

    const { query } = useSearch(ref<string | null>('s1'), deps)
    const sections = await query('', { activeSessionId: 's1' })

    const recent = findSection(sections, 'recent')
    expect(recent).toBeTruthy()
    expect(recent!.items[0]?.title).toBe('a.ts')
    const suggested = findSection(sections, 'suggested')
    expect(suggested!.items.length).toBeLessThanOrEqual(3) // SUGGESTED_COMMAND_COUNT=3
  })
})

describe('mock 端口守卫（tc u3/D4-②：isMock=true 而未装配 searchMock 显式抛错）', () => {
  it('isMock=true + searchMock 未装配 → reject 并指向恢复动作（不静默返空）', async () => {
    const deps = makeDeps()
    deps.ports.isMock = true
    deps.ports.searchMock = undefined

    const { query } = useSearch(ref<string | null>('s1'), deps)

    await expect(query('a', { activeSessionId: 's1' })).rejects.toThrow('SearchPorts.searchMock 未装配')
  })
})
