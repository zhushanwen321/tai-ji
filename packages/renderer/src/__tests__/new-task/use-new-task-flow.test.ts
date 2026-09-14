/**
 * useNewTaskFlow 状态机单测（#3，需求修正后「统一延迟 create」语义）。
 *
 * 覆盖（纯状态机守卫）：
 * - T1.2 startFlow→不调 create、state=landing、currentSessionId=null（统一延迟 create）
 * - T7.1 gitInfo==null→openBranchPopover 抛错回 idle
 * （T8.3-T8.6 状态机转换用例已删，core flow-state/flow 测试权威覆盖。）
 * - T6.5 openBranchModal 来源守卫：非 branch-popover 来源抛错回 idle
 *
 * 新设计下 landing 态 gitInfo 恒 null（统一延迟 create 后无 session）→
 * branch-popover/branch-modal 不可达。原 overlay 互斥（T8.1）、Esc 优先级（T8.2）、
 * branch-modal 来源正向、Esc 排队（T4.8）等依赖 branch 链路的测试已删（场景不可达）。
 * branch 组件层单测见 create-branch-modal.test.ts。
 *
 * mock 策略：vi.hoisted + vi.mock('@/api')（session.create/remove），真用 useSessionStore + resolveDefaultCwd。
 * beforeEach 重建 pinia + clearAllMocks；每测唯一 sid。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/new-task/use-new-task-flow.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@xyz-agent/shared'
import type { SessionSummary, SessionGroup } from '@xyz-agent/shared'

const apiMock = vi.hoisted(() => ({
  create: vi.fn(
    // 六参签名（D14 projectId 透传断言用，原 session-project-attribution.test.ts 并入）
    (cwd?: string, _label?: string, _presetId?: string, projectId?: string): Promise<SessionSummary> =>
      Promise.resolve({
        id: `s-${Math.random().toString(36).slice(2, 8)}`,
        label: '新会话',
        cwd: cwd ?? '/repo',
        status: 'idle',
        lastActiveAt: Date.now(),
        modelId: 'm',
        tokenCount: 0,
        projectId: projectId || undefined,
      }),
  ),
  remove: vi.fn((): Promise<void> => Promise.resolve()),
  // submitFirstMessage → useChat.send → chatApi.send/streamSubscribe 需要 mock 占位
  chatSend: vi.fn((): Promise<void> => Promise.resolve()),
  streamSubscribe: vi.fn((): (() => void) => () => {}),
  // composer-bash-execute: landing 态 bash 首发 → useChat.sendBash → chatApi.bash
  chatBash: vi.fn((): Promise<void> => Promise.resolve()),
  chatAbortBash: vi.fn((): Promise<void> => Promise.resolve()),
}))

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  session: { create: apiMock.create, remove: apiMock.remove, subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 }), unsubscribe: vi.fn().mockResolvedValue(undefined), migrateImage: vi.fn().mockResolvedValue(undefined), writeSegments: vi.fn().mockResolvedValue(undefined) },
  // submitFirstMessage → useFileTree.loadTree 调 fileApi.tree/gitApi.status（Promise.allSettled）；
  // 给空返回避免 unhandled rejection
  file: { tree: vi.fn().mockResolvedValue([]), expand: vi.fn().mockResolvedValue([]) },
  git: { status: vi.fn().mockResolvedValue({ isRepo: false }) },
  chat: { send: apiMock.chatSend, streamSubscribe: apiMock.streamSubscribe, bash: apiMock.chatBash, abortBash: apiMock.chatAbortBash },
  workspace: { detect: vi.fn().mockResolvedValue({ mode: 'not-repo', isBareMode: false, wsRoot: '', repoRoot: '' }) },
  worktree: { list: vi.fn().mockResolvedValue([]) },
}))

// W3: mock workspaceStore 让 submitFirstMessage 能取到 defaultCwd
const workspaceStoreMock = vi.hoisted(() => ({
  records: [] as Array<{ cwd: string; lastUsedAt: number; label: string }>,
  defaultCwd: undefined as string | undefined,
  load: vi.fn(),
  record: vi.fn(),
}))

// INV-7: mock useToast 捕获 toastError 调用（cwd fallback 通知）
const toastMock = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('@/stores/workspace', () => ({
  useWorkspaceStore: vi.fn(() => workspaceStoreMock),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastMock.error }),
}))

import { useNewTaskFlow, resetNewTaskFlow, __resetNewTaskFlowForTesting } from '@/composables/features/new-task/useNewTaskFlow'
import { useSessionStore } from '@/stores/session'
import { useProjectStore } from '@/stores/project'

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  // renderer 壳 cachedFlow 单例（捕获首次调用时的 pinia store）必须重建，
  // 否则 projectId 读取旧 pinia 的 projectStore（dedup 测试红过）
  __resetNewTaskFlowForTesting()
  vi.clearAllMocks()
  // 重置 workspaceStore mock
  workspaceStoreMock.records = []
  workspaceStoreMock.defaultCwd = undefined
  // project store 持久化隔离（projectId 透传用例需要干净默认态）
  localStorage.removeItem('xyz-agent:projects')
})

/** 构造带 gitBranch 的 session（git 目录） */
function gitSession(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: over.id ?? 'git-s',
    label: over.label ?? 'repo',
    cwd: over.cwd ?? '/repo',
    gitBranch: over.gitBranch ?? 'main',
    status: 'idle',
    lastActiveAt: over.lastActiveAt ?? 100,
    modelId: 'm',
    tokenCount: 0,
  }
}

function setGroups(sessions: SessionSummary[]): void {
  // 同 cwd 归一组（与 store.appendSession 语义一致）
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

describe('useNewTaskFlow 状态机', () => {
  describe('startFlow 首次启动边界（T1.2）', () => {
    it('sessions=[]→cwd=undefined→不调 create、currentSessionId=null、state=landing', async () => {
      setGroups([]) // 首次启动无历史
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(apiMock.create).not.toHaveBeenCalled()
      expect(flow.currentSessionId.value).toBeNull()
      expect(flow.state.value).toBe('landing')
    })
  })

  /**
   * submitFirstMessage label 派生：session 名默认取首条提示词前 10 字符 + 省略号，
   * 取代旧的 basename(cwd)。防护：未来若误把 label 传成 undefined/cwd，侧栏与目录列表
   * 会回退到目录名，与产品诉求「提示词前 10 字」背离，本块立刻红。
   */
  describe('submitFirstMessage label 派生（session 名 = 提示词前 10 字）', () => {
    it('未选目录直接发送 → create 收到 (cwd, label)，label 是提示词前 10 字', async () => {
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      // W3: 设置 workspaceStore.defaultCwd 模拟工作区记录
      workspaceStoreMock.defaultCwd = '/repo'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage(textToSegments('一二三四五六七八九十十一')) // 11 字
      expect(apiMock.create).toHaveBeenCalledTimes(1)
      // cwd 兑底用最近 session 的 /repo；label 截断为前 10 字 + 省略号
      expect(apiMock.create).toHaveBeenCalledWith('/repo', '一二三四五六七八九十…', undefined, undefined, undefined, 'high')
    })

    it('短提示词 → label = 原文（不加省略号），与提示词一致', async () => {
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      // W3: 设置 workspaceStore.defaultCwd 模拟工作区记录
      workspaceStoreMock.defaultCwd = '/repo'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage(textToSegments('修 bug')) // 4 字
      expect(apiMock.create).toHaveBeenCalledWith('/repo', '修 bug', undefined, undefined, undefined, 'high')
    })

    it('selectedWorkspace 选定 cwd 后发送 → create 第 1 参数用选定 cwd 而非兑底', async () => {
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openDirPopover() // landing→dir-popover（selectWorkspace 须从 dir-popover 调用）
      await flow.selectWorkspace('/custom/path') // dir-popover→landing，记 pendingCwd
      await flow.submitFirstMessage(textToSegments('hello world!'))
      expect(apiMock.create).toHaveBeenCalledWith('/custom/path', 'hello worl…', undefined, undefined, undefined, 'high')
    })
  })

  /**
   * INV-7 / D-008: submitFirstMessage create 后比对 cwd 判断 runtime 是否降级 homedir，
   * fallback 则 toastError。真实断言（修正 T4.4 只测 emit 格式的语义偷换）。
   */
  describe('submitFirstMessage cwd fallback toast（INV-7, D-008）', () => {
    it('create 返回 cwd != 请求 cwd（runtime 降级 homedir）→ toastError 被调且文案含原 cwd', async () => {
      // 模拟 runtime create 因 cwd 失效降级：返回的 session.cwd 与请求 cwd 不一致
      apiMock.create.mockResolvedValueOnce({
        id: 'fallback-s', label: 'x', cwd: '/home/user',
        status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0,
      })
      setGroups([gitSession({ id: 'hist', cwd: '/gone', lastActiveAt: 1 })])
      workspaceStoreMock.defaultCwd = '/gone'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage(textToSegments('hello'))
      // create 用兑底 cwd 调用
      expect(apiMock.create).toHaveBeenCalledWith('/gone', expect.any(String), undefined, undefined, undefined, 'high')
      // toast 触发一次，文案含「已不存在」+ 原 cwd
      expect(toastMock.error).toHaveBeenCalledTimes(1)
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('已不存在'))
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('/gone'))
    })

    it('create 返回 cwd == 请求 cwd（目录存在，未降级）→ 不 toast', async () => {
      // apiMock.create 默认实现返回 cwd = 传入 cwd，一致，不触发 toast
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      workspaceStoreMock.defaultCwd = '/repo'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage(textToSegments('hello'))
      expect(toastMock.error).not.toHaveBeenCalled()
    })

    it('两空（未选目录且 defaultCwd=undefined，create(\'\') 落主目录）→ toast E7 专属文案（无 dir 空插值）', async () => {
      // E7（D10）两空提示：runtime create('') 静默落 homedir → actualCwd ≠ reqCwd('')
      // → onCwdFallback('', homedir)。壳侧按 reqCwd 空串发专属文案（cwdFallbackToHome），
      // 不发 dirNotExist（否则用户看到「目录  已不存在…」空插值）。
      apiMock.create.mockResolvedValueOnce({
        id: 'home-s', label: 'x', cwd: '/home/user',
        status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0,
      })
      setGroups([])
      workspaceStoreMock.defaultCwd = undefined
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage(textToSegments('hello'))
      // create 以空串 cwd 调用（两空形态：pendingCwd=null + defaultCwd=''）
      expect(apiMock.create).toHaveBeenCalledTimes(1)
      expect(apiMock.create).toHaveBeenCalledWith('', expect.any(String), undefined, undefined, undefined, 'high')
      // toast 触发一次，文案是 E7 专属文案（不含 dirNotExist 的「已不存在」空插值形态）
      expect(toastMock.error).toHaveBeenCalledTimes(1)
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('未选择目录'))
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('已在主目录创建'))
      expect(toastMock.error).not.toHaveBeenCalledWith(expect.stringContaining('已不存在'))
    })
  })

  /**
   * composer-bash-execute: landing 态 bash 首发（!/!! 前缀）。
   *
   * 防护：landing 态输入 !cmd 不应走 chat.send（当普通消息发给 LLM），应走 chat.sendBash。
   * 事故：原 onSend 分流顺序 landing > bash，landing 分支提前 return，bash 命令被当普通消息发。
   * 修复：landing 分支提取 bashCommand 传给 submitFirstMessage，发送阶段改调 sendBash。
   */
  describe('submitFirstMessage bash 首发（landing 态 !/!! 前缀）', () => {
    beforeEach(() => {
      apiMock.chatSend.mockClear()
      apiMock.chatBash.mockClear()
    })

    it('bashCommand 传入 → 调 chat.bash（sendBash），不调 chat.send', async () => {
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      workspaceStoreMock.defaultCwd = '/repo'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage(
        textToSegments('!echo hi'),
        undefined,
        { command: 'echo hi', excludeFromContext: false },
      )
      expect(apiMock.chatBash).toHaveBeenCalledTimes(1)
      expect(apiMock.chatBash).toHaveBeenCalledWith(expect.any(String), 'echo hi', false)
      // 关键：不调 chat.send（bash 不走 LLM turn）
      expect(apiMock.chatSend).not.toHaveBeenCalled()
    })

    it('bashCommand excludeFromContext=true → chat.bash 第三参数 true', async () => {
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      workspaceStoreMock.defaultCwd = '/repo'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage(
        textToSegments('!!pwd'),
        undefined,
        { command: 'pwd', excludeFromContext: true },
      )
      expect(apiMock.chatBash).toHaveBeenCalledWith(expect.any(String), 'pwd', true)
    })

    /**
     * [S5 PR#116 review] bash 首发 session label 不应带 `!`/`!!` 前缀。
     * 事故：原实现 label 取 firstTextSeg.text（含 `!` 前缀），session 名为「!ls」体验不佳。
     * 修复：bashCommand 传入时 label 用 command 部分（已去前缀）。本用例锁死该行为。
     */
    it('S5: bash 首发 session label 用 command 部分（去 !/!! 前缀）', async () => {
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      workspaceStoreMock.defaultCwd = '/repo'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage(
        textToSegments('!ls -la'),
        undefined,
        { command: 'ls -la', excludeFromContext: false },
      )
      // create 的 label 参数取自 bashCommand.command（"ls -la"），不带 `!` 前缀
      // 第三参数 presetId=undefined（main 的 preset 透传，pendingPreset 为 null 时降级 undefined）
      expect(apiMock.create).toHaveBeenCalledWith('/repo', 'ls -la', undefined, undefined, undefined, 'high')
      // 反向断言：label 绝不以 `!` 开头
      const labelArg = apiMock.create.mock.calls[0]?.[1]
      expect(labelArg).toBeTruthy()
      expect(labelArg!.startsWith('!')).toBe(false)
    })

    it('无 bashCommand → 仍走 chat.send（普通首发，回归防护）', async () => {
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      workspaceStoreMock.defaultCwd = '/repo'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage(textToSegments('hello'))
      expect(apiMock.chatSend).toHaveBeenCalledTimes(1)
      expect(apiMock.chatBash).not.toHaveBeenCalled()
    })
  })

  describe('UC-7 非 git 守卫（T7.1）', () => {
    it('landing 态 currentSession=null→gitInfo 派生 null→openBranchPopover 抛错回 idle', async () => {
      // 统一延迟 create：landing 态无绑定 session → gitInfo 恒 null（与目录是否 git 无关）
      setGroups([
        {
          id: 'git-history',
          label: 'repo',
          cwd: '/repo',
          gitBranch: 'main',
          status: 'idle',
          lastActiveAt: 100,
          modelId: 'm',
          tokenCount: 0,
        },
      ])
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(flow.gitInfo.value).toBeNull()
      expect(() => flow.openBranchPopover()).toThrow()
      expect(flow.state.value).toBe('idle')
    })
  })

  // 新设计下 landing 态 gitInfo 恒 null → branch-popover/branch-modal 不可达，
  // 原 overlay 互斥（T8.1）/ Esc 优先级（T8.2）依赖 branch 链路的测试已删（场景不可达）。

  // （状态机转换 describe T8.3-T8.6 已删：cancelFlow/reenterFlow/completed 重建/非法
  //  转换的状态机本体由 core flow-state.test.ts（TC-1/2/2b/3）与 flow.test.ts
  //  （TC-4c/TC-8b）权威覆盖；renderer 壳侧保留消费面用例。）

  describe('closeOverlay 幂等（worktree 成功回调重复调用回归）', () => {
    // [HISTORICAL] 2026-07-24 事故：worktree 创建成功后 onWorktreeSuccess 先 selectWorkspace
    // （已 transition('landing')）再 closeOverlay，加上 CreateWorktreeModal @close 又触发一次
    // closeOverlay，叠加 landing→landing 非法转换 → state 被打回 idle → 用户在 landing 页提交时撞
    // submitFirstMessage 的 `state !== 'landing'` guard 报「非 landing 态不可首发提交」。closeOverlay
    // 幂等化后：非 overlay 态 noop，不再触发非法转换。本用例锁死该幂等性。
    it('已处于 landing 态再 closeOverlay→noop（保持 landing，不抛错不回 idle）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(flow.state.value).toBe('landing')
      expect(() => flow.closeOverlay()).not.toThrow()
      expect(flow.state.value).toBe('landing') // 关键：未被非法转换打回 idle
    })

    it('overlay 态 closeOverlay→正常回 landing', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openDirPopover()
      expect(flow.state.value).toBe('dir-popover')
      flow.closeOverlay()
      expect(flow.state.value).toBe('landing')
    })

    it('worktree 成功路径（selectWorkspace 后重复 closeOverlay）→保持 landing 可首发提交', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      // 模拟 Landing.onWorktreeSuccess：openWorktreeModal→success 回调里 selectWorkspace + closeOverlay
      flow.openCreateWorktree() // landing→worktree-modal
      expect(flow.state.value).toBe('worktree-modal')
      await flow.selectWorkspace('/ws/feat-x') // worktree-modal→landing（selectWorkspace 内 transition）
      // success emit 后又 closeOverlay（冗余）+ @close 再 closeOverlay（第二次冗余）
      expect(() => {
        flow.closeOverlay()
        flow.closeOverlay()
      }).not.toThrow()
      expect(flow.state.value).toBe('landing') // 幂等保 landing，未被非法转换打回 idle
      // 提交 guard 不再误报
      expect(flow.state.value).toBe('landing')
    })
  })

  describe('overlay 互斥（openOverlay 统一入口，preset↔dir/branch 双向）', () => {
    // [HISTORICAL] 2026-07-27 事故：preset popover 接入 flow.state 时，openPresetPopover 处理了
    // dir/branch→preset 方向的互斥（先归 landing），但 openDirPopover/openBranchPopover 没更新去处理
    // preset-popover 来源 → 用户打开 preset popover 后点 dir chip 撞 preset-popover→dir-popover 非法转换
    // → state 被打回 idle → 后续首发提交撞 guard 报「非 landing 态」。修复：抽 openOverlay(target) 统一
    // 互斥入口（当前在任意 overlay 态时先归 landing 再开 target），用 OVERLAY_STATES 集合判断，新增
    // overlay 态自动生效。本用例锁死 preset↔dir 双向互斥。
    it('preset-popover 打开时点 dir chip → dir-popover 正常切换（不撞非法转换）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(flow.state.value).toBe('landing')

      // 打开 preset popover
      flow.openPresetPopover()
      expect(flow.state.value).toBe('preset-popover')

      // 从 preset-popover 切到 dir-popover（回归点：曾撞非法转换打回 idle）
      expect(() => flow.openDirPopover()).not.toThrow()
      expect(flow.state.value).toBe('dir-popover') // 关键：正常切换，未被非法转换打回 idle
    })

    it('dir-popover 打开时点 preset chip → preset-popover 正常切换', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openDirPopover()
      expect(flow.state.value).toBe('dir-popover')

      // 从 dir-popover 切到 preset-popover（反向也要通）
      expect(() => flow.openPresetPopover()).not.toThrow()
      expect(flow.state.value).toBe('preset-popover')
    })

    it('互斥切换后保持 landing 可首发提交（state 未被打回 idle）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openPresetPopover()
      flow.openDirPopover()
      // 回归点：曾因非法转换 state=idle，导致 submitFirstMessage guard 误报
      expect(flow.state.value).not.toBe('idle')
      expect(flow.state.value).toBe('dir-popover')
      // closeOverlay 回 landing，提交 guard 不报
      flow.closeOverlay()
      expect(flow.state.value).toBe('landing')
    })
  })

  describe('landing 态 branch 不可达（T4.4）', () => {
    it('landing 态 currentSession=null→gitInfo 恒 null→branch chip 隐藏 + openBranchPopover 守卫不可达', async () => {
      // 即便历史 session 是 git 目录，landing 态 currentSession=null → gitInfo 派生 null
      setGroups([
        {
          id: 'git-history',
          label: 'repo',
          cwd: '/repo',
          gitBranch: 'main',
          status: 'idle',
          lastActiveAt: 100,
          modelId: 'm',
          tokenCount: 0,
        },
      ])
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(flow.gitInfo.value).toBeNull()
      // 状态机守卫：branch 相关动作在 landing 态不可达
      expect(() => flow.openBranchPopover()).toThrow()
      expect(flow.state.value).toBe('idle')
    })
  })

  describe('openBranchModal 来源守卫（T6.5）', () => {
    it('非 branch-popover 来源（landing）→抛错回 idle', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow() // state=landing（非 branch-popover）
      expect(() => flow.openBranchModal()).toThrow()
      expect(flow.state.value).toBe('idle')
    })

    // 新设计下 landing→branch-popover 不可达（gitInfo null 守卫），
    // 「branch-popover 来源→正常进 branch-modal」正向用例已删（场景不可达）。
  })

  // 新设计下 landing 态 branch 链路不可达（gitInfo 恒 null），
  // 原 Esc 排队（T4.8）依赖 branch-popover 的测试已删（场景不可达）。

  /**
   * isActive 派生语义锁定：landing + 全部 overlay 态 → true（Workspace 渲染守卫依赖，
   * 延迟 create 下活跃期间 activeId=null 但须保持 Landing 挂载）；idle/completed/cancelled → false。
   * 防护：未来改状态枚举时若误把活跃态从集合移除，Workspace 守卫会静默回退到卸载 Landing，
   * 本块立刻红。
   */
  describe('isActive 派生（Workspace 渲染守卫真相源）', () => {
    it('idle → false（异常兜底态，无 session 无活跃 flow）', () => {
      const flow = useNewTaskFlow()
      expect(flow.state.value).toBe('idle')
      expect(flow.isActive.value).toBe(false)
    })

    it('landing → true（首次启动延迟 create，activeId=null 但须显示 Landing）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      expect(flow.state.value).toBe('landing')
      expect(flow.isActive.value).toBe(true)
    })

    it('dir-popover → true（点 directory chip 进 overlay，Landing 须保持挂载）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openDirPopover()
      expect(flow.state.value).toBe('dir-popover')
      expect(flow.isActive.value).toBe(true)
    })

    it('cancelled → false（overlay 打开时切 session，AC-3.10）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.openDirPopover()
      flow.cancelFlow()
      expect(flow.state.value).toBe('cancelled')
      expect(flow.isActive.value).toBe(false)
    })

    it('cancelled → reenterFlow → landing → isActive 回 true（重选空 session 复活）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.cancelFlow()
      expect(flow.isActive.value).toBe(false)
      flow.reenterFlow()
      expect(flow.state.value).toBe('landing')
      expect(flow.isActive.value).toBe(true)
    })

    it('completed → false（首发成功终态，已绑定 activeId，由 hasSession 接管渲染）', async () => {
      const flow = useNewTaskFlow()
      await flow.startFlow()
      flow.completeFlow()
      expect(flow.state.value).toBe('completed')
      expect(flow.isActive.value).toBe(false)
    })
  })

  /**
   * R1：gitInfo.isBare 数据链路真相源锁定。
   *
   * 此前集成测试 mock 了整个 useNewTaskFlow，直接注入 isBare:true，绕过真实数据路径——
   * 数据链路断裂被掩盖（gitInfo computed 不填 isBare → Landing isBareWorkspace 恒 false）。
   * 本块用真实 useNewTaskFlow（非 mock）+ 真实 SessionSummary.isBareWorkspace 字段，验证：
   *   SessionSummary.isBareWorkspace → gitInfo.isBare → Landing isBareWorkspace → action-create-worktree 渲染
   *
   * submitFirstMessage create 后 controller.bindCurrentSession(created) 绑定 session，
   * gitInfo computed 从 currentSession.value.isBareWorkspace 派生 isBare。
   */
  describe('gitInfo.isBare 数据链路（R1，非 mock 真实 flow）', () => {
    it('create 返回 session.isBareWorkspace=true + gitBranch → gitInfo.isBare 派生 true', async () => {
      // 模拟 runtime create 返回带 isBareWorkspace + gitBranch 的 session（WorkspaceDetector 检测后的摘要）
      apiMock.create.mockResolvedValueOnce({
        id: 'bare-s',
        label: 'repo',
        cwd: '/ws/feat-a',
        gitBranch: 'feat-a',
        isBareWorkspace: true,
        status: 'idle',
        lastActiveAt: 1,
        modelId: 'm',
        tokenCount: 0,
      })
      setGroups([gitSession({ id: 'hist', cwd: '/ws/feat-a', lastActiveAt: 1 })])
      workspaceStoreMock.defaultCwd = '/ws/feat-a'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      // submitFirstMessage create + bindCurrentSession(bare session)
      await flow.submitFirstMessage(textToSegments('bare workspace test'))

      // 真实数据链路：gitInfo.isBare 从 session.isBareWorkspace 派生（非 mock 注入）
      expect(flow.gitInfo.value).not.toBeNull()
      expect(flow.gitInfo.value?.branch).toBe('feat-a')
      expect(flow.gitInfo.value?.isRepo).toBe(true)
      // 关键断言：isBare 经 SessionSummary.isBareWorkspace → gitInfo computed 派生（修复前恒 false）
      expect(flow.gitInfo.value?.isBare).toBe(true)
    })

    it('create 返回 session.isBareWorkspace=false + gitBranch → gitInfo.isBare 派生 false', async () => {
      apiMock.create.mockResolvedValueOnce({
        id: 'normal-s',
        label: 'repo',
        cwd: '/repo',
        gitBranch: 'main',
        isBareWorkspace: false,
        status: 'idle',
        lastActiveAt: 1,
        modelId: 'm',
        tokenCount: 0,
      })
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      workspaceStoreMock.defaultCwd = '/repo'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage(textToSegments('normal repo test'))

      expect(flow.gitInfo.value?.isBare).toBe(false)
    })

    it('create 返回 session 无 isBareWorkspace 字段 → gitInfo.isBare 兜底 false', async () => {
      // isBareWorkspace undefined（旧 runtime / 未检测）→ 兜底 false，动作项不显示
      apiMock.create.mockResolvedValueOnce({
        id: 'no-bare-field-s',
        label: 'repo',
        cwd: '/repo',
        gitBranch: 'main',
        status: 'idle',
        lastActiveAt: 1,
        modelId: 'm',
        tokenCount: 0,
      })
      setGroups([gitSession({ id: 'hist', cwd: '/repo', lastActiveAt: 1 })])
      workspaceStoreMock.defaultCwd = '/repo'
      const flow = useNewTaskFlow()
      await flow.startFlow()
      await flow.submitFirstMessage(textToSegments('no bare field test'))

      expect(flow.gitInfo.value?.isBare).toBe(false)
    })
  })
})

// ── 原 session-project-attribution.test.ts 并入（同 SUT 同 mock 套；保留 2 个核心用例，
//    「切 project 变体」与「空 content guard」分别由本文件 label 派生组 / flow-integration
//    非法态守卫覆盖，不再重复）──
describe('create 透传归属 projectId（D14 语义修正，原 session-project-attribution 并入）', () => {
  function seedHistGroup(cwd: string): void {
    useSessionStore().applySnapshot({ groups: [
      { cwd, sessions: [{ id: 'hist', label: 'hist', cwd, status: 'idle', lastActiveAt: 1, modelId: 'm', tokenCount: 0 }] },
    ] as SessionGroup[] })
  }

  it('命名 project 下新建任务 → create 第 4 参数携带 activeProjectId', async () => {
    const projectStore = useProjectStore()
    projectStore.addProject('Test') // 命名 project 成为 active
    seedHistGroup('/repo')
    workspaceStoreMock.defaultCwd = '/repo'

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('修 bug'))

    expect(apiMock.create).toHaveBeenCalledTimes(1)
    expect(apiMock.create).toHaveBeenCalledWith('/repo', '修 bug', undefined, projectStore.activeProjectId, undefined, 'high')
  })

  it('默认项目下新建任务 → create 第 4 参数为 undefined（未归类，不写 sidecar）', async () => {
    // localStorage 空 → 默认 project name=''
    seedHistGroup('/repo')
    workspaceStoreMock.defaultCwd = '/repo'

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('修 bug'))

    expect(apiMock.create).toHaveBeenCalledTimes(1)
    expect(apiMock.create).toHaveBeenCalledWith('/repo', '修 bug', undefined, undefined, undefined, 'high')
  })
})
