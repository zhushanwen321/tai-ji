/**
 * useNewTaskFlow 主流程 + 选目录 + submitFirstMessage 集成测试
 * （#1+#3+#4+#5，需求修正后「统一延迟 create」语义）。
 *
 * 集成边界：mock 最外层 @/api（session.create/remove）+ lib/ipc（pickDirectory）+
 * @/composables/features/chat/useChat（chat.send），真用 useSessionStore/usePanelStore/
 * useNavigationStore/resolveDefaultCwd。验证跨层数据流。
 *
 * 需求修正后的新语义（真相源）：
 * - startFlow 统一延迟 create：所有场景点新建只 transition('landing')+currentSession=null+pendingCwd=null，不调 create
 * - selectWorkspace/openDirDialog 只记 pendingCwd（不 delete/create session），首发提交才建 session
 * - submitFirstMessage（landing 态首发）：create+appendSession+activeId+loadSession+navigation.push+send+completed
 *
 * 覆盖（选目录 #5）：
 * - T3.1 selectWorkspace：cwd 变→只记 pendingCwd（延迟 create）；cwd 未变→noop
 * - T3.3 openDirDialog：pickDirectory canceled=false→只记 pendingCwd（延迟 create）
 * - T3.4 openDirDialog：canceled=true→落回 dir-popover，cwd 不变，不 create
 * - T3.5 E5 IPC 抛错：pickDirectory reject→openDirDialog reject 显错不崩、state 落回不卡死
 * 覆盖（submitFirstMessage 延迟 create）：
 * - 首发提交→create+载入 panel+push 导航+send+completed
 * - cwd 来源：pendingCwd 优先 / 否则 resolveDefaultCwd
 * - 重试场景（currentSession 已存在）→跳过 create 直接 send
 * - create reject→错误向上抛、不留僵尸 session
 * - 非法态（非 landing）提交→抛错
 * - 双击并发→in-flight 守卫 create 只调一次
 *
 * 新设计下 landing 态 gitInfo 恒 null（无 session）→ branch 链路不可达，
 * 原 selectBranch/confirmDirtySwitch/submitCreateBranch 集成测试已删（组件层单测见 create-branch-modal.test.ts）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/new-task/flow-integration.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'
import type { Segment, SessionSummary, SessionGroup } from '@taiji/shared'

// 可控依赖：测试按需让 create/pickDirectory/chat.send pending/resolve/reject
const createCtrl = vi.hoisted(() => ({
  // submitFirstMessage（延迟 create）会调 create，需返回有效值
  create: vi.fn<(cwd?: string) => Promise<SessionSummary>>().mockImplementation((cwd) =>
    Promise.resolve({
      id: `s-${Math.random().toString(36).slice(2, 8)}`,
      label: '新会话',
      cwd: cwd ?? '/repo',
      status: 'idle',
      lastActiveAt: Date.now(),
      modelId: 'm',
      tokenCount: 0,
    }),
  ),
  remove: vi.fn<(sessionId: string) => Promise<void>>().mockResolvedValue(undefined),
}))
const pickCtrl = vi.hoisted(() => ({
  pickDirectory: vi.fn<() => Promise<{ canceled: boolean; path: string | null }>>(),
}))
const chatMock = vi.hoisted(() => ({
  send: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
}))
// migrateSessionImage：默认 resolve(undefined)（非迁移路径不更新 path）；迁移用例按需替换
const migrateCtrl = vi.hoisted(() => ({
  migrateSessionImage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  session: {
    create: createCtrl.create,
    remove: createCtrl.remove,
    // PR #87：submitFirstMessage 现调 sessionApi.getCommands（兜底拉取 slash 命令）；
    // loadSubagents/loadWorkflows 也在首发路径内。给空返回避免 unhandled rejection。
    getCommands: vi.fn().mockResolvedValue({ commands: [] }),
    getSubagents: vi.fn().mockResolvedValue([]),
    getWorkflows: vi.fn().mockResolvedValue([]),
    // wave:runtime-patch W2：migrateImage 走 @/api（从 @/lib/ipc 迁来）。默认 resolve(undefined)（非迁移路径）。
    migrateImage: migrateCtrl.migrateSessionImage,
  },
  // submitFirstMessage → useFileTree.loadTree 调 fileApi.tree/gitApi.status（Promise.allSettled）；
  // 给空返回避免 unhandled rejection
  file: { tree: vi.fn().mockResolvedValue([]), expand: vi.fn().mockResolvedValue([]) },
  git: { status: vi.fn().mockResolvedValue({ isRepo: false }) },
  workspace: { detect: vi.fn().mockResolvedValue({ mode: 'not-repo', isBareMode: false, wsRoot: '', repoRoot: '' }) },
  worktree: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/lib/ipc', () => ({
  pickDirectory: pickCtrl.pickDirectory,
}))
// submitFirstMessage 终端调用 useChat.send；mock 掉避免拖入 chat 订阅机制（useChat 自有单测）
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => chatMock,
}))

// W3: mock workspaceStore 让 submitFirstMessage 能取到 defaultCwd
const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as Array<{ cwd: string; lastUsedAt: number; label: string }>,
  defaultCwd: undefined as string | undefined,
  load: vi.fn(),
  record: vi.fn(),
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

import { useNewTaskFlow, resetNewTaskFlow, __resetNewTaskFlowForTesting } from '@/composables/features/new-task/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'
import { usePanelStore } from '@/stores/panel'
import { useNavigationStore } from '@/stores/navigation'

beforeEach(() => {
  setActivePinia(createPinia())
  __resetNewTaskFlowForTesting() // 壳单例捕获的 store 引用随 pinia 重建失效
  resetNewTaskFlow()
  vi.clearAllMocks()
  createCtrl.remove.mockResolvedValue(undefined)
  chatMock.send.mockResolvedValue(undefined)
  // 默认非迁移路径：migrateSessionImage resolve(undefined)（不更新 path）
  migrateCtrl.migrateSessionImage.mockResolvedValue(undefined)
  // 重置 workspaceStore mock
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
  workspaceStoreMock.record.mockResolvedValue(undefined)
})

function setGroups(sessions: SessionSummary[]): void {
  const byCwd = new Map<string, SessionSummary[]>()
  for (const s of sessions) {
    const arr = byCwd.get(s.cwd) ?? []
    arr.push(s)
    byCwd.set(s.cwd, arr)
  }
  useSessionStore().applySnapshot({ groups: 
    Array.from(byCwd, ([cwd, ss]): SessionGroup => ({ cwd, sessions: ss })),
   })
}

function mkSession(over: Partial<SessionSummary>): SessionSummary {
  return {
    id: over.id ?? 's',
    label: over.label ?? 'label',
    cwd: over.cwd ?? '/repo',
    status: 'idle',
    lastActiveAt: over.lastActiveAt ?? 0,
    modelId: 'm',
    tokenCount: 0,
    ...over,
  }
}

describe('⌘N 主流程（startFlow 统一延迟 create）', () => {
  it('T1.1 startFlow→不 create→state=landing，currentSessionId=null，currentCwd=null（空 chip 态）', async () => {
    setGroups([
      mkSession({ id: 'old', cwd: '/last-repo', lastActiveAt: 100 }),
      mkSession({ id: 'recent', cwd: '/recent-repo', lastActiveAt: 900 }),
    ])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    // 统一延迟 create：点新建不立即建 session（推翻原「触发即创建」+「非首次沿用上次 cwd」）
    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentSessionId.value).toBeNull()
    expect(flow.currentCwd.value).toBeNull() // pendingCwd 清空 → 空 chip 态
  })
})

describe('选目录链路（selectWorkspace / openDirDialog，#5）', () => {
  it('T3.1 cwd 变→只记 pendingCwd（延迟 create，不建 session），chip 回灌新 cwd', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover() // landing→dir-popover

    createCtrl.remove.mockClear()
    createCtrl.create.mockClear()
    await flow.selectWorkspace('/other-repo')

    // 延迟 create：选目录不建 session（首发提交才建），只记 pendingCwd
    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(createCtrl.remove).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentCwd.value).toBe('/other-repo') // chip 回灌 pendingCwd
    expect(flow.currentSessionId.value).toBeNull() // 恒 null
  })

  it('T3.1 cwd 未变→noop（不重复操作，仅关 popover）', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    await flow.selectWorkspace('/repo') // 首次记 pendingCwd
    expect(flow.currentCwd.value).toBe('/repo')

    flow.openDirPopover()
    createCtrl.create.mockClear()
    createCtrl.remove.mockClear()
    await flow.selectWorkspace('/repo') // 同值→noop
    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(createCtrl.remove).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('landing') // 仅关 popover
    expect(flow.currentCwd.value).toBe('/repo')
  })
})

describe('worktree 创建回灌（adoptWorktreeCwd，fix-new-worktree-not-switch）', () => {
  it('T-WT.1 创建成功即回灌：worktree-modal 态写 pendingCwd 不 transition（成功屏期间 state 不变），record 热更新，关 overlay 后保持', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/ws', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openCreateWorktree() // landing→worktree-modal
    expect(flow.state.value).toBe('worktree-modal')

    flow.adoptWorktreeCwd('/ws/new-wt') // CreateWorktreeModal success emit

    // chip 同刻切换 + state 保持 worktree-modal（不 transition，modal 成功屏仍在展示）
    expect(flow.currentCwd.value).toBe('/ws/new-wt')
    expect(flow.state.value).toBe('worktree-modal')
    expect(workspaceStoreMock.record).toHaveBeenCalledWith('/ws/new-wt') // 热更新最近工作区
    // 关闭（2s 定时器/用户提前关）→ landing，cwd 保持
    flow.closeOverlay()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentCwd.value).toBe('/ws/new-wt')
  })

  it('T-WT.2 守卫：非 worktree-modal 态 noop；同值 noop（不重复 record）', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/ws', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.adoptWorktreeCwd('/ws/other') // landing 态 → noop
    expect(flow.currentCwd.value).toBeNull()

    flow.openCreateWorktree()
    flow.adoptWorktreeCwd('/ws/new-wt')
    flow.adoptWorktreeCwd('/ws/new-wt') // 同值 → noop
    expect(flow.currentCwd.value).toBe('/ws/new-wt')
    expect(workspaceStoreMock.record).toHaveBeenCalledTimes(1)
  })

  it('T-WT.3 adopt 后首发提交：session 建在 adopted cwd（防旧链路「切换丢失→create 落旧目录」回归）', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/ws', lastActiveAt: 900 })])
    workspaceStoreMock.defaultCwd = '/ws'
    createCtrl.create.mockResolvedValue(mkSession({ id: 's-wt', cwd: '/ws/new-wt' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openCreateWorktree()
    flow.adoptWorktreeCwd('/ws/new-wt')
    flow.closeOverlay() // modal 关闭（定时器或用户提前关）

    await flow.submitFirstMessage(textToSegments('go'))

    // create 用 adopted pendingCwd（/ws/new-wt），而非 defaultCwd（/ws）
    expect(createCtrl.create).toHaveBeenCalledWith('/ws/new-wt', 'go', undefined, undefined, undefined, 'high')
  })
})

describe('OS dialog 分支（openDirDialog，#5）', () => {
  it('T3.3 pickDirectory canceled=false→只记 pendingCwd（延迟 create，不建 session），chip 回灌新 cwd', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    pickCtrl.pickDirectory.mockResolvedValue({ canceled: false, path: '/picked-dir' })

    createCtrl.remove.mockClear()
    createCtrl.create.mockClear()
    await flow.openDirDialog()

    // 延迟 create：选中目录不建 session，只记 pendingCwd
    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(createCtrl.remove).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentCwd.value).toBe('/picked-dir') // chip 回灌 pendingCwd
    expect(flow.currentSessionId.value).toBeNull()
  })

  it('T3.4 pickDirectory canceled=true→落回 dir-popover，cwd 不变，不 create', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    await flow.selectWorkspace('/preselected') // 先记 pendingCwd（currentCwd=/preselected）
    flow.openDirPopover()
    pickCtrl.pickDirectory.mockResolvedValue({ canceled: true, path: null })

    createCtrl.create.mockClear()
    await flow.openDirDialog()

    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('dir-popover') // 落回
    expect(flow.currentCwd.value).toBe('/preselected') // cwd 不变
  })

  it('T3.5 E5 pickDirectory reject→openDirDialog reject 显错不崩、state 落回不卡死', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    pickCtrl.pickDirectory.mockRejectedValue(new Error('getFocusedWindow null'))
    await expect(flow.openDirDialog()).rejects.toThrow('getFocusedWindow null')
    // 显错向上抛（调用方接 toast），state 不卡在 dir-dialog
    expect(flow.state.value).toBe('dir-popover') // 落回
  })
})

describe('submitFirstMessage（landing 态首发提交：延迟 create+载入+发送）', () => {
  it('首发提交→create session + appendSession + activeId + loadSession + navigation.push + send + transition completed', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    // W3: 设置 workspaceStore.defaultCwd 模拟工作区记录
    workspaceStoreMock.defaultCwd = '/repo'
    createCtrl.create.mockResolvedValue(mkSession({ id: 'new-1', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    const session = useSessionStore()
    const panel = usePanelStore()
    const navigation = useNavigationStore()
    await flow.startFlow()
    expect(session.activeId).toBeNull()

    await flow.submitFirstMessage(textToSegments('hello world'))

    // create 用 workspaceStore.defaultCwd（最近工作区 cwd=/repo）；label=提示词前10字（'hello world' 11 字符 → 截断+省略号）
    expect(createCtrl.create).toHaveBeenCalledWith('/repo', 'hello worl…', undefined, undefined, undefined, 'high')
    expect(session.activeId).toBe('new-1') // activeId 绑定
    expect(session.list.map((s) => s.id)).toContain('new-1') // appendSession 入组
    // panel 载入 active panel
    expect(panel.findPanelBySession('new-1')).not.toBeNull()
    // navigation push chat view
    expect(navigation.current.view).toBe('chat')
    expect(navigation.current.sessionId).toBe('new-1')
    // chat.send 被调用（显式 sid + segments 原样透传，ADR-0043）
    expect(chatMock.send).toHaveBeenCalledWith('new-1', textToSegments('hello world'))
    expect(flow.state.value).toBe('completed')
  })

  it('cwd 来源：pendingCwd 优先于 workspaceStore.defaultCwd', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/last-repo', lastActiveAt: 900 })])
    // W3: 设置 workspaceStore.defaultCwd 模拟工作区记录
    workspaceStoreMock.defaultCwd = '/last-repo'
    createCtrl.create.mockResolvedValue(mkSession({ id: 's-pending', cwd: '/picked' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.openDirPopover()
    await flow.selectWorkspace('/picked') // 记 pendingCwd=/picked

    await flow.submitFirstMessage(textToSegments('go'))

    // create 用 pendingCwd（/picked），而非 workspaceStore.defaultCwd（/last-repo）；label='go'（≤10 原文）
    expect(createCtrl.create).toHaveBeenCalledWith('/picked', 'go', undefined, undefined, undefined, 'high')
  })

  it('cwd 来源：无 pendingCwd 时用 workspaceStore.defaultCwd', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/last-repo', lastActiveAt: 900 })])
    // W3: 设置 workspaceStore.defaultCwd 模拟工作区记录
    workspaceStoreMock.defaultCwd = '/last-repo'
    createCtrl.create.mockResolvedValue(mkSession({ id: 's-default', cwd: '/last-repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow() // 未选目录 → pendingCwd=null

    await flow.submitFirstMessage(textToSegments('go'))

    // create 用 workspaceStore.defaultCwd（最近活跃 cwd=/last-repo）；label='go'（≤10 原文）
    expect(createCtrl.create).toHaveBeenCalledWith('/last-repo', 'go', undefined, undefined, undefined, 'high')
  })

  it('重试场景（currentSession 已存在）→跳过 create 直接 send', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    createCtrl.create.mockResolvedValueOnce(mkSession({ id: 'retry-s', cwd: '/repo' }))
    // 首次提交：create 成功但 send 失败（模拟重试场景）
    chatMock.send.mockRejectedValueOnce(new Error('network down'))
    const flow = useNewTaskFlow()
    await flow.startFlow()
    await expect(flow.submitFirstMessage(textToSegments('first'))).rejects.toThrow('network down')
    expect(createCtrl.create).toHaveBeenCalledTimes(1)
    expect(flow.currentSessionId.value).toBe('retry-s') // session 已绑定
    // T2 交接原子化（设计 panel-view-derivation-and-flow-lifecycle.md §3.3 D3）：
    // 交接（setActiveSession+loadPanel+pushChat）完成即终态定格，send 失败属 session
    // 错误通道（toast），flow 终态不回退 landing
    expect(flow.state.value).toBe('completed')

    // 新语义推论：send 失败后 flow 已终结（completed），再次 submitFirstMessage 撞
    // 「非 landing」守卫抛错——重发走对话视图 composer（session 错误通道），不再经
    // new-task flow。「跳过 create 直接 send」的 retry 分支覆盖由 core flow.test.ts
    // TC-7（bindSession 构造 landing+currentSession）承接，本文件此路径已不可达。
    await expect(flow.submitFirstMessage(textToSegments('first'))).rejects.toThrow('非 landing')
    expect(createCtrl.create).toHaveBeenCalledTimes(1) // 未重复 create
    expect(chatMock.send).toHaveBeenCalledTimes(1) // 守卫先于 send，未重发
  })

  it('E2/E3 create reject→错误向上抛，不留僵尸 session（state 留 landing，currentSession=null）', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/etc/nonexistent', lastActiveAt: 1 })])
    createCtrl.create.mockRejectedValue(new Error('invalid cwd'))
    const flow = useNewTaskFlow()
    await flow.startFlow()

    await expect(flow.submitFirstMessage(textToSegments('hi'))).rejects.toThrow('invalid cwd')

    expect(createCtrl.create).toHaveBeenCalledTimes(1)
    expect(flow.currentSessionId.value).toBeNull() // 不绑定僵尸 session
    expect(flow.state.value).toBe('landing') // 留 landing 可重试（未进 completed）
    expect(chatMock.send).not.toHaveBeenCalled() // create 失败未发消息
  })

  it('非 landing 态提交→抛错', async () => {
    const flow = useNewTaskFlow()
    // state=idle（未 startFlow），非 landing
    await expect(flow.submitFirstMessage(textToSegments('hi'))).rejects.toThrow('非 landing')
    expect(createCtrl.create).not.toHaveBeenCalled()
  })

  it('双击并发→in-flight 守卫，create 只调一次', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    let resolveCreate!: (s: SessionSummary) => void
    createCtrl.create.mockReturnValueOnce(
      new Promise<SessionSummary>((r) => {
        resolveCreate = r
      }),
    )
    const flow = useNewTaskFlow()
    await flow.startFlow()
    const p1 = flow.submitFirstMessage(textToSegments('one'))
    const p2 = flow.submitFirstMessage(textToSegments('two')) // in-flight 守卫→直接 return
    resolveCreate(mkSession({ id: 'solo', cwd: '/repo' }))
    await p1
    await p2
    expect(createCtrl.create).toHaveBeenCalledTimes(1)
  })

  it('纯图（无 text 段）也允许发送——含 image 但无 text 不被入参校验拦截', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    workspaceStoreMock.defaultCwd = '/repo'
    createCtrl.create.mockResolvedValue(mkSession({ id: 'img-only', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()

    const imageSegments: Segment[] = [
      { type: 'image', id: 'i1', path: '/var/folders/xx/tmp-img.png', fileName: 'tmp-img.png', displayName: '截图.png' },
    ]
    // migrateSessionImage 默认 resolve(undefined)（非迁移）→ finalSegments 不变
    await flow.submitFirstMessage(imageSegments)

    // 纯图无 text：label 走 deriveSessionLabel('') 兜底为「无提示词」
    expect(createCtrl.create).toHaveBeenCalledWith('/repo', '无提示词', undefined, undefined, undefined, 'high')
    expect(chatMock.send).toHaveBeenCalledWith('img-only', imageSegments)
    expect(flow.state.value).toBe('completed')
  })

  it('tmpdir 迁移成功：needsMigrate=true 的 image → migrateSessionImage 后 path 更新为 attachments/<sid>/', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    workspaceStoreMock.defaultCwd = '/repo'
    createCtrl.create.mockResolvedValue(mkSession({ id: 'mig-1', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()

    migrateCtrl.migrateSessionImage.mockResolvedValue({ path: '/dataDir/attachments/mig-1/abc-image.png' })
    const segments: Segment[] = [
      { type: 'text', text: '看这张图' },
      // M1：needsMigrate=true（landing 态 writeSessionImage 落 tmpdir 的图）。迁移判断用此字段，不猜路径。
      { type: 'image', id: 'i1', path: '/var/folders/xx/abc-image.png', fileName: 'abc-image.png', displayName: '照片.png', needsMigrate: true },
    ]
    await flow.submitFirstMessage(segments)

    // migrateSessionImage 被调一次（needsMigrate=true 触发迁移）
    expect(migrateCtrl.migrateSessionImage).toHaveBeenCalledTimes(1)
    expect(migrateCtrl.migrateSessionImage).toHaveBeenCalledWith({
      fromPath: '/var/folders/xx/abc-image.png',
      sessionId: 'mig-1',
      fileName: 'abc-image.png',
    })
    // chat.send 收到迁移后的 path（text 段原样保留）
    const sentSegments = chatMock.send.mock.calls[0][1] as Segment[]
    expect(sentSegments).toHaveLength(2)
    expect(sentSegments[0]).toEqual({ type: 'text', text: '看这张图' })
    expect(sentSegments[1]).toMatchObject({
      type: 'image',
      path: '/dataDir/attachments/mig-1/abc-image.png',
      fileName: 'abc-image.png',
      displayName: '照片.png',
    })
  })

  it('tmpdir 迁移部分失败（migrateSessionImage reject）→不阻断发送，path 保留 tmpdir', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    workspaceStoreMock.defaultCwd = '/repo'
    createCtrl.create.mockResolvedValue(mkSession({ id: 'mig-fail', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()

    // 第一张迁移 reject（OS 已清理 tmpdir），第二张成功
    migrateCtrl.migrateSessionImage
      .mockRejectedValueOnce(new Error('ENOENT: no such file'))
      .mockResolvedValueOnce({ path: '/dataDir/attachments/mig-fail/img2.png' })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const segments: Segment[] = [
      // M1：两张图都 needsMigrate=true（landing 态落 tmpdir）
      { type: 'image', id: 'i1', path: '/tmp/img1.png', fileName: 'img1.png', displayName: '1.png', needsMigrate: true },
      { type: 'image', id: 'i2', path: '/tmp/img2.png', fileName: 'img2.png', displayName: '2.png', needsMigrate: true },
    ]
    await flow.submitFirstMessage(segments)

    // 发送未被阻断（state 进 completed），send 被调用
    expect(flow.state.value).toBe('completed')
    expect(chatMock.send).toHaveBeenCalledTimes(1)
    // 第一张保留原 tmpdir path（迁移失败），第二张更新为新 path
    const sentSegments = chatMock.send.mock.calls[0][1] as Segment[]
    expect(sentSegments[0]).toMatchObject({ type: 'image', path: '/tmp/img1.png' })
    expect(sentSegments[1]).toMatchObject({ type: 'image', path: '/dataDir/attachments/mig-fail/img2.png' })
    // 失败项 console.warn（allSettled 硬规则不阻断）。
    // w5（C-W5-2）：创建分支的迁移下沉 core createSessionFlow，warn 前缀从 [useNewTaskFlow] 改 [createSessionFlow]。
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[createSessionFlow] image migrate failed: /tmp/img1.png'),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })

  it('已持久化图片（needsMigrate 不设）→不触发迁移，原样发送', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    workspaceStoreMock.defaultCwd = '/repo'
    createCtrl.create.mockResolvedValue(mkSession({ id: 'persist-1', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()

    const segments: Segment[] = [
      { type: 'text', text: '历史图' },
      // M1：needsMigrate 不设（等同 false）。path 在 attachments 目录（normal 态 writeSessionImage 落地）
      { type: 'image', id: 'i1', path: '/dataDir/attachments/other-sess/x.png', fileName: 'x.png', displayName: 'x.png' },
    ]
    await flow.submitFirstMessage(segments)

    // needsMigrate 不为 true → 不调 migrateSessionImage
    expect(migrateCtrl.migrateSessionImage).not.toHaveBeenCalled()
    expect(chatMock.send).toHaveBeenCalledWith('persist-1', segments)
  })

  it('M3（+菜单用户磁盘文件）：path 非 tmpdir 非 attachments 且 needsMigrate=false → 不触发迁移，path 原样保留', async () => {
    // 修复 M1 critical：+菜单选的用户磁盘文件（如 /Users/alice/Pictures/photo.png）needsMigrate 不设，
    // 不应被 migrateSessionImage 的 renameSync 移走（数据丢失）。原 bug：isTmpdirPath 用路径猜测
    // （!includes('/attachments/')）把用户磁盘路径误判为 tmpdir 文件并迁移。
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    workspaceStoreMock.defaultCwd = '/repo'
    createCtrl.create.mockResolvedValue(mkSession({ id: 'plus-menu-1', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()

    const diskPath = '/Users/alice/Pictures/photo.png'
    const segments: Segment[] = [
      { type: 'text', text: '看这张磁盘图' },
      // +菜单选的磁盘文件：needsMigrate 不设（undefined，等同 false）——模拟 useCommandPopoverTrigger 的 needsMigrate=false
      { type: 'image', id: 'i1', path: diskPath, fileName: 'photo.png', displayName: 'photo.png', needsMigrate: false },
    ]
    await flow.submitFirstMessage(segments)

    // needsMigrate=false（非 true）→ 不调 migrateSessionImage（用户磁盘文件不被移走）
    expect(migrateCtrl.migrateSessionImage).not.toHaveBeenCalled()
    // chat.send 收到原样 segments（path 未被改写）
    const sentSegments = chatMock.send.mock.calls[0][1] as Segment[]
    expect(sentSegments[1]).toMatchObject({ type: 'image', path: diskPath })
  })

  it('M3（+菜单用户磁盘文件，needsMigrate 不设）：undefined 等同 false → 不触发迁移', async () => {
    // 覆盖 needsMigrate 可选字段省略的语义（undefined === false）。
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    workspaceStoreMock.defaultCwd = '/repo'
    createCtrl.create.mockResolvedValue(mkSession({ id: 'plus-menu-2', cwd: '/repo' }))
    const flow = useNewTaskFlow()
    await flow.startFlow()

    const segments: Segment[] = [
      // needsMigrate 字段完全省略（旧 segment 数据 / 历史消息回放）
      { type: 'image', id: 'i1', path: '/Users/alice/Pictures/vacation.jpg', fileName: 'vacation.jpg', displayName: 'vacation.jpg' },
    ]
    await flow.submitFirstMessage(segments)

    expect(migrateCtrl.migrateSessionImage).not.toHaveBeenCalled()
    const sentSegments = chatMock.send.mock.calls[0][1] as Segment[]
    expect(sentSegments[0]).toMatchObject({ type: 'image', path: '/Users/alice/Pictures/vacation.jpg' })
  })
})

describe('sessionStore 同步（延迟 create：startFlow 不联动 store）', () => {
  it('startFlow 不 create：无论有无历史 session，activeId 不变（null）+ currentSessionId=null', async () => {
    setGroups([mkSession({ id: 'old', cwd: '/repo', lastActiveAt: 1 })])
    const store = useSessionStore()
    expect(store.activeId).toBeNull()

    const flow = useNewTaskFlow()
    await flow.startFlow()

    // startFlow 延迟 create：不同步 sessionStore（首发提交 submitFirstMessage 才绑定）
    expect(createCtrl.create).not.toHaveBeenCalled()
    expect(flow.state.value).toBe('landing')
    expect(flow.currentSessionId.value).toBeNull()
    expect(store.activeId).toBeNull() // 未被同步
  })
})
