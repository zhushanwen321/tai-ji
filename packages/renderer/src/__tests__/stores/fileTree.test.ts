// @vitest-environment node

/**
 * stores 域测试合并文件（波 2a 簇 4-18）。
 *
 * 节 1 — fileTree：useFileTreeStore 结构/缓存复用/git overlay/invalidate/徽章/展开态/
 *        detail 多文件 tab。
 * 节 2 — chat-bash-review-fix：B1/M1/M2 streaming 与 bash 收尾互斥 + B2 abortBash
 *        RPC 失败 markBashError 写回（chat-bash 事故回归）。
 * 节 3 — quota-store：useQuotaStore 配额行归一化。
 *
 * 合并说明：全 node 环境；节 2 的 '@/api' 窄化 mock（project/chat/session 三域）与
 * useToast mock 经波 1 读码核实对节 1/3 零泄漏（fileTree/quota store 不 import '@/api'
 * 不消费 toast）；节 1/3 的文件级 beforeEach（均 setActivePinia）合并为一份。
 * describe/it 名零改动。波 1 死于拼装残留重复 import（esbuild 单文件 parse 不查
 * 重复绑定、vitest 实跑才红）——本轮 header 手工去重。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/stores/fileTree.test.ts --pool=threads
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFileTreeStore } from '@/stores/fileTree'
import type { GitFileStatus } from '@taiji/shared'
import { apiProjectMock } from '../helpers/api-facade-mock'
import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'
import { getExecutingBash } from '@taiji/core'
import type { Message, ServerMessage } from '@taiji/shared'
import { useQuotaStore } from '@/stores/quota'
import type { NormalizedQuotaRow } from '@taiji/shared'

beforeEach(() => setActivePinia(createPinia()))

// ══════════ 节 1/3 — 来源: fileTree.test.ts ══════════

beforeEach(() => setActivePinia(createPinia()))

describe('fileTreeStore D-021 结构', () => {
  it('nodeStates 是 Map<sid, Map<path, NodeState>>（对象化 + per-session）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loading' })
    store.setNodeState('s1', 'src', { status: 'loaded' })
    store.setNodeState('s2', 'lib', { status: 'error', reason: 'out_of_cwd' })

    // per-session 分桶
    expect(store.nodeStates.get('s1')?.get('src')).toEqual({ status: 'loaded' })
    expect(store.nodeStates.get('s2')?.get('lib')).toEqual({ status: 'error', reason: 'out_of_cwd' })
    // session 隔离
    expect(store.nodeStates.get('s1')?.get('lib')).toBeUndefined()
    expect(store.nodeStates.get('s2')?.get('src')).toBeUndefined()
  })

  it('getNodeState 无记录默认 unloaded', () => {
    const store = useFileTreeStore()
    expect(store.getNodeState('s1', 'any')).toEqual({ status: 'unloaded' })
  })

  it('setNodeState loaded + children 原子 merge（消除双源不一致）', () => {
    const store = useFileTreeStore()
    // 顶层 setTree 先建树
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    // setNodeState loaded 同 step merge children
    const children = [{ path: 'src/index.ts', name: 'index.ts', type: 'file' }]
    store.setNodeState('s1', 'src', { status: 'loaded' }, children)

    // tree 中 src 的 children 已 merge（不是 undefined）
    const tree = store.getTree('s1')!
    expect(tree[0].children).toEqual(children)
    // nodeStates 同步 loaded
    expect(store.getNodeState('s1', 'src').status).toBe('loaded')
  })

  it('setNodeState error 带 reason（来自 WS error code）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'secret', { status: 'error', reason: 'permission_denied' })
    expect(store.getNodeState('s1', 'secret')).toEqual({ status: 'error', reason: 'permission_denied' })
  })
})

describe('fileTreeStore T2.2 缓存复用', () => {
  it('setTree 后 getTree 返回缓存', () => {
    const store = useFileTreeStore()
    const nodes = [{ path: 'a.ts', name: 'a.ts', type: 'file' }]
    store.setTree('s1', nodes)
    expect(store.getTree('s1')).toEqual(nodes)
  })

  it('未缓存的 session getTree 返回 undefined', () => {
    const store = useFileTreeStore()
    expect(store.getTree('nope')).toBeUndefined()
  })
})

describe('fileTreeStore T2.6/T2.7/T2.8/T2.9 git overlay', () => {
  it('T2.6 setGitOverlay 独立于 tree（overlay 先到后挂载）', () => {
    const store = useFileTreeStore()
    // overlay 先设，tree 未设
    store.setGitOverlay('s1', [{ path: 'src/x.ts', xyCode: ' M', status: 'modified' }])
    expect(store.getGitStatus('s1', 'src/x.ts')?.status).toBe('modified')
    // tree 后设，overlay 不丢
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    expect(store.getGitStatus('s1', 'src/x.ts')?.status).toBe('modified')
  })

  it('T2.8/T2.8b 角标全态（M/A/D/U/untracked）', () => {
    const store = useFileTreeStore()
    const statuses: GitFileStatus[] = [
      { path: 'm.ts', xyCode: ' M', status: 'modified' },
      { path: 'a.ts', xyCode: 'A ', status: 'added' },
      { path: 'd.ts', xyCode: ' D', status: 'deleted' },
      { path: 'u.ts', xyCode: 'UU', status: 'unmerged' },
      { path: 'untracked.ts', xyCode: '??', status: 'untracked' },
    ]
    store.setGitOverlay('s1', statuses)
    for (const s of statuses) {
      expect(store.getGitStatus('s1', s.path)?.status).toBe(s.status)
    }
  })

  it('T2.7/T2.9 非 git 仓库 → 不调 setGitOverlay，getGitStatus 返回 undefined', () => {
    const store = useFileTreeStore()
    // 模拟 git.status isRepo=false → composable 不调 setGitOverlay
    store.setTree('s1', [{ path: 'x.ts', name: 'x.ts', type: 'file' }])
    expect(store.getGitStatus('s1', 'x.ts')).toBeUndefined()
    // 树仍渲染
    expect(store.getTree('s1')).toHaveLength(1)
  })

  it('gitOverlay per-session 分桶', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [{ path: 'a.ts', xyCode: ' M', status: 'modified' }])
    store.setGitOverlay('s2', [{ path: 'b.ts', xyCode: 'A ', status: 'added' }])
    expect(store.getGitStatus('s1', 'a.ts')?.status).toBe('modified')
    expect(store.getGitStatus('s2', 'a.ts')).toBeUndefined()
  })
})

describe('fileTreeStore T4.6 invalidate graceful', () => {
  it('invalidate loaded → invalidated（不报错）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loaded' })
    store.invalidate('s1', ['src'])
    expect(store.getNodeState('s1', 'src').status).toBe('invalidated')
  })

  it('invalidate 未 loaded 的节点不变（只标 loaded→invalidated）', () => {
    const store = useFileTreeStore()
    store.setNodeState('s1', 'src', { status: 'loading' })
    store.invalidate('s1', ['src'])
    expect(store.getNodeState('s1', 'src').status).toBe('loading')
  })

  it('invalidate 不存在的 session graceful（不报错）', () => {
    const store = useFileTreeStore()
    expect(() => store.invalidate('nope', ['any'])).not.toThrow()
  })
})

describe('fileTreeStore W2 getDirChangeCount（目录改动文件数徽章）', () => {
  it('统计 dirPath 子树内改动文件数（path 以 dirPath/ 开头）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/b.ts', xyCode: 'A ', status: 'added' },
      { path: 'README.md', xyCode: 'M ', status: 'modified' },
    ])
    // dirPath='src' → 'src/a.ts' + 'src/b.ts' = 2
    expect(store.getDirChangeCount('s1', 'src')).toBe(2)
  })

  it('空 overlay / 不存在的 session → 0', () => {
    const store = useFileTreeStore()
    expect(store.getDirChangeCount('s1', 'src')).toBe(0)
  })

  it('嵌套子树也算（前缀匹配 dirPath/，含深层路径）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/utils/c.ts', xyCode: ' M', status: 'modified' },
      { path: 'README.md', xyCode: 'M ', status: 'modified' },
    ])
    // dirPath='src' → 'src/a.ts' + 'src/utils/c.ts' = 2（深层也匹配 'src/' 前缀）
    expect(store.getDirChangeCount('s1', 'src')).toBe(2)
  })

  it('兄弟同名前缀不误算（只算精确 dirPath/ 前缀，不算 src-other/）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src-other/b.ts', xyCode: ' M', status: 'modified' },
    ])
    // 'src-other/b.ts' 不应算进 'src/' 前缀（兄弟目录，非子树）
    expect(store.getDirChangeCount('s1', 'src')).toBe(1)
  })

  it('无改动 → 0（dirPath 子树下无匹配条目）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'README.md', xyCode: 'M ', status: 'modified' },
    ])
    expect(store.getDirChangeCount('s1', 'src')).toBe(0)
  })
})

describe('fileTreeStore W15/D-7.1 徽章预聚合', () => {
  /**
   * reference 实现 = 旧算法（setGitOverlay 前 per-row O(n) 前缀扫描），
   * 用于行为等价断言：预聚合后各目录计数与旧算法一致。
   */
  function legacyDirChangeCount(paths: string[], dirPath: string): number {
    const prefix = `${dirPath}/`
    return paths.filter((p) => p.startsWith(prefix)).length
  }

  it('行为等价：同 overlay 下各目录计数与旧前缀扫描算法一致', () => {
    const store = useFileTreeStore()
    const paths = [
      'src/a.ts',
      'src/b.ts',
      'src/utils/c.ts',
      'src/utils/deep/d.ts',
      'src-other/e.ts',
      'README.md',
      'docs/legacy/x.md',
      // [W15 审查] git status porcelain 默认把 untracked 目录折叠为带尾斜杠一条（'newdir/'），
      // 两种算法都应把目录自身计入 newdir（legacy：startsWith('newdir/') 命中自身；
      // 预聚合：首个 '/' 前缀即 'newdir'），父链无额外影响。
      'newdir/',
    ]
    store.setGitOverlay('s1', paths.map((p) => ({ path: p, xyCode: ' M', status: 'modified' })))

    // 覆盖：命中目录 / 嵌套目录 / 深层链 / 兄弟前缀 / 根（''）/ 无命中目录 / 文件路径入参 / 尾斜杠目录
    const dirs = [
      '',
      'src',
      'src/utils',
      'src/utils/deep',
      'src-other',
      'docs',
      'docs/legacy',
      'nonexistent',
      'README.md',
      'newdir',
    ]
    for (const dir of dirs) {
      expect(store.getDirChangeCount('s1', dir)).toBe(legacyDirChangeCount(paths, dir))
    }
  })

  it('O(1) 读取：getDirChangeCount 不触发 overlay 遍历（keys spy 零调用）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/utils/b.ts', xyCode: ' M', status: 'modified' },
    ])

    // spy 预聚合完成后 overlay Map 的迭代入口——O(1) 路径不应触发任何遍历
    const overlayMap = store.gitOverlay.get('s1')!
    const keysSpy = vi.spyOn(overlayMap, 'keys')
    const valuesSpy = vi.spyOn(overlayMap, 'values')
    const entriesSpy = vi.spyOn(overlayMap, 'entries')
    const forEachSpy = vi.spyOn(overlayMap, 'forEach')

    // 多次行级读取（模拟多个目录行渲染）
    for (let i = 0; i < 10; i++) {
      store.getDirChangeCount('s1', 'src')
      store.getDirChangeCount('s1', 'src/utils')
    }
    expect(store.getDirChangeCount('s1', 'src')).toBe(2)

    expect(keysSpy).not.toHaveBeenCalled()
    expect(valuesSpy).not.toHaveBeenCalled()
    expect(entriesSpy).not.toHaveBeenCalled()
    expect(forEachSpy).not.toHaveBeenCalled()
  })

  it('setGitOverlay 覆盖更新 → 预聚合重建（新计数替换旧计数）', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/b.ts', xyCode: ' M', status: 'modified' },
    ])
    expect(store.getDirChangeCount('s1', 'src')).toBe(2)

    // overlay 被新状态覆盖（如 ready 回写 / 重新拉取），计数跟随重建而非累加
    store.setGitOverlay('s1', [{ path: 'lib/c.ts', xyCode: ' M', status: 'modified' }])
    expect(store.getDirChangeCount('s1', 'src')).toBe(0)
    expect(store.getDirChangeCount('s1', 'lib')).toBe(1)
  })

  it('clearSession 清理预聚合分桶', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [{ path: 'src/a.ts', xyCode: ' M', status: 'modified' }])
    expect(store.getDirChangeCount('s1', 'src')).toBe(1)
    store.clearSession('s1')
    expect(store.getDirChangeCount('s1', 'src')).toBe(0)
  })

  it('预聚合 per-session 分桶互不串扰', () => {
    const store = useFileTreeStore()
    store.setGitOverlay('s1', [{ path: 'src/a.ts', xyCode: ' M', status: 'modified' }])
    store.setGitOverlay('s2', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/b.ts', xyCode: ' M', status: 'modified' },
    ])
    expect(store.getDirChangeCount('s1', 'src')).toBe(1)
    expect(store.getDirChangeCount('s2', 'src')).toBe(2)
  })
})

describe('fileTreeStore 展开态 rehydrate', () => {
  it('addExpanded/getExpanded per-session', () => {
    const store = useFileTreeStore()
    store.addExpanded('s1', 'src')
    store.addExpanded('s1', 'lib')
    expect(store.getExpanded('s1')).toEqual(new Set(['src', 'lib']))
    expect(store.getExpanded('s2')).toEqual(new Set())
  })

  it('removeExpanded 折叠', () => {
    const store = useFileTreeStore()
    store.addExpanded('s1', 'src')
    store.removeExpanded('s1', 'src')
    expect(store.getExpanded('s1').has('src')).toBe(false)
  })

  it('clearSession 清理所有状态', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [])
    store.setNodeState('s1', 'x', { status: 'loaded' })
    store.setGitOverlay('s1', [])
    store.addExpanded('s1', 'x')
    store.clearSession('s1')
    expect(store.getTree('s1')).toBeUndefined()
    expect(store.nodeStates.has('s1')).toBe(false)
  })
})

describe('fileTreeStore detail 多文件 tab（display-containers W3 §6.3）', () => {
  it('selectFile：per-session 选中态 + 注入 tab（未开新增并激活）', () => {
    const store = useFileTreeStore()
    store.selectFile('s1', 'a.ts')
    store.selectFile('s1', 'b.ts')
    store.selectFile('s2', 'x.ts')

    // per-session 选中态（旧全局单值跨会话串线的终局解）
    expect(store.getSelectedPath('s1')).toBe('b.ts')
    expect(store.getSelectedPath('s2')).toBe('x.ts')
    // tab 注入（开序 + 激活）
    expect(store.getDetailTabs('s1').map((t) => t.path)).toEqual(['a.ts', 'b.ts'])
    expect(store.getDetailActivePath('s1')).toBe('b.ts')
    expect(store.getDetailTabs('s2').map((t) => t.path)).toEqual(['x.ts'])
  })

  it('注入语义：已开仅激活（不新增不重载）；forceDiff 升级未加载实例、已加载不改模式', () => {
    const store = useFileTreeStore()
    store.openDetailTab('s1', 'a.ts')
    store.updateDetailTab('s1', 'a.ts', { status: 'content', viewMode: 'preview' })

    // 已开已加载 → 仅激活（模式保持）
    store.openDetailTab('s1', 'a.ts', { forceDiff: true })
    expect(store.getDetailTabs('s1').length).toBe(1)
    expect(store.getDetailActivePath('s1')).toBe('a.ts')
    expect(store.getDetailTab('s1', 'a.ts')?.viewMode).toBe('preview')

    // 已开未加载（idle）→ forceDiff 升级为 diff（双通道同 tick 注入的修正式）
    store.openDetailTab('s1', 'b.ts')
    store.openDetailTab('s1', 'b.ts', { forceDiff: true })
    expect(store.getDetailTabs('s1').length).toBe(2)
    expect(store.getDetailTab('s1', 'b.ts')?.viewMode).toBe('diff')
    expect(store.getDetailTab('s1', 'b.ts')?.forceDiff).toBe(true)
  })

  it('closeDetailTab：激活者关闭激活右邻（无则左邻）；关闭选中文件清选中态', () => {
    const store = useFileTreeStore()
    store.selectFile('s1', 'a.ts')
    store.selectFile('s1', 'b.ts')
    store.selectFile('s1', 'c.ts')
    expect(store.getDetailActivePath('s1')).toBe('c.ts')

    // 关激活 c → 右邻不存在 → 左邻 b；c 是选中文件 → 选中态清
    store.closeDetailTab('s1', 'c.ts')
    expect(store.getDetailTabs('s1').map((t) => t.path)).toEqual(['a.ts', 'b.ts'])
    expect(store.getDetailActivePath('s1')).toBe('b.ts')
    expect(store.getSelectedPath('s1')).toBeNull()

    // 关非激活 a → 激活不变
    store.closeDetailTab('s1', 'a.ts')
    expect(store.getDetailActivePath('s1')).toBe('b.ts')

    // 关最后一个 → 空态
    store.closeDetailTab('s1', 'b.ts')
    expect(store.getDetailTabs('s1')).toEqual([])
    expect(store.getDetailActivePath('s1')).toBeNull()
  })

  it('selectFile(null sid) no-op；updateDetailTab 不复活已清分区', () => {
    const store = useFileTreeStore()
    store.selectFile(null, 'a.ts')
    expect(store.getDetailTabs('s1')).toEqual([])

    store.selectFile('s1', 'a.ts')
    store.clearSession('s1')
    // 迟到 RPC 回写不得复活已删 session 的分区（D-B2-1 同口径）
    store.updateDetailTab('s1', 'a.ts', { status: 'content' })
    expect(store.getDetailTabs('s1')).toEqual([])
    expect(store.getSelectedPath('s1')).toBeNull()
  })
})

// ══════════ 节 2/3 — 来源: chat-bash-review-fix.test.ts ══════════

// ── api mock（B2 用：abortBash reject 触发 catch）──
const apiMock = vi.hoisted(() => ({
  // bash 回执契约（dmg-r1-2）：默认 = 已执行并收尾
  bash: vi.fn(() => Promise.resolve({ status: 'settled' as const })),
  abortBash: vi.fn(() => Promise.resolve()),
  streamSubscribe: vi.fn((_sid: string, _handler: (msg: ServerMessage) => void) => () => {}),
}))
vi.mock('@/api', () => ({ project: apiProjectMock(),
  chat: {
    bash: apiMock.bash,
    abortBash: apiMock.abortBash,
    streamSubscribe: apiMock.streamSubscribe,
  },
  // w5：useChat 薄包装 import session.writeSegments（写 segments sidecar），mock 补全
  session: {
    writeSegments: vi.fn(() => Promise.resolve()),
  },
}))

// ── useToast mock：捕获 error 调用 ──
const toastError = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError }),
}))


describe('B1: streamingSessionIds 仅扫 role:assistant —— 纯 bash 不阻塞', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('纯 bash 执行（streaming bash 消息，无 assistant streaming）→ isGenerating=false / isActive=false', () => {
    const store = useChatStore()
    const sid = 's-b1'
    // [W1 fix-chat-flow-order] bashStart 只写 ephemeral executingBash，不建消息项
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 30', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)

    const msgs = store.getMessages(sid)
    expect(msgs).toHaveLength(0)

    // 核心断言：纯 bash 执行期间不应被当作 assistant 生成态
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.isActive(sid)).toBe(false)
  })

  it('bash 完成后 isGenerating 仍为 false（无回归）', () => {
    const store = useChatStore()
    const sid = 's-b1-done'
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'echo hi', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: { sessionId: sid, command: 'echo hi', output: 'hi', exitCode: 0, cancelled: false, truncated: false, timestamp: 2000 },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.isActive(sid)).toBe(false)
  })

  it('assistant streaming 仍被正确识别（回归防护：assistant 不被 bash 改动误伤）', () => {
    const store = useChatStore()
    const sid = 's-b1-assistant'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(true)
    expect(store.isActive(sid)).toBe(true)
  })
})

describe('M1: finalizeMessagesImpl 跳过 bash —— assistant error 不误杀共存 streaming bash', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('assistant 与 bash 并发 → assistant error 收尾后，bash 仍 streaming，后续 bashResult 可正常收尾', () => {
    const store = useChatStore()
    const sid = 's-m1'
    // assistant turn streaming
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-streaming' },
    } as ServerMessage)
    // [W1 fix-chat-flow-order] bashStart 不建消息项——streaming bash 消息手动种子
    // （防御场景：entry 化后正常流转不产生，仅手动注入可验证 finalizeMessages 的跳过语义）
    store.setMessages(sid, [...store.getMessages(sid), {
      id: 'bash-m1',
      role: 'system',
      content: '',
      status: 'streaming',
      bashExecution: { command: 'longcmd', output: '', exitCode: null, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1000 },
    } as Message])

    const before = store.getMessages(sid)
    expect(before[0].status).toBe('streaming') // assistant
    expect(before[1].status).toBe('streaming') // bash

    // assistant error 收尾（finalizeSession('error') 走 finalizeMessagesImpl）
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: 'assistant boom' },
    } as ServerMessage)

    const after = store.getMessages(sid)
    // assistant 被收尾为 error
    expect(after[0].status).toBe('error')
    // 核心断言：bash 仍 streaming（不被 finalizeMessagesImpl 误杀）
    expect(after[1].status).toBe('streaming')
    expect(after[1].bashExecution?.cancelled).toBe(false)
  })

  it('entry 化形态：assistant streaming 中执行 bash → assistant error 后 bash 延迟帧照常 entry 入流', () => {
    const store = useChatStore()
    const sid = 's-m1b'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a-streaming' },
    } as ServerMessage)
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'longcmd', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)

    // assistant error 收尾（run 崩溃），bash 执行态仍 ephemeral 存在
    store.applyMessageEvent(sid, {
      type: 'message.error',
      payload: { sessionId: sid, message: 'assistant boom' },
    } as ServerMessage)
    expect(getExecutingBash(sid)).toBeDefined()

    // 后续 bashResult 延迟帧到达（级联结束 flush）→ entry 入流 append（不依赖 streaming bash 消息）
    store.applyMessageEvent(sid, {
      type: 'message.bashResult',
      payload: { sessionId: sid, command: 'longcmd', output: 'real output', exitCode: 0, cancelled: false, truncated: false, timestamp: 2000 },
    } as ServerMessage)
    const final = store.getMessages(sid)
    expect(final).toHaveLength(2)
    expect(final[1].bashExecution?.output).toBe('real output')
    expect(final[1].status).toBe('complete')
    expect(getExecutingBash(sid)).toBeUndefined()
  })
})

describe('M2: message.complete 正常收尾 —— 状态复位且推进 10min 无二次收尾', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })
  afterEach(() => vi.useRealTimers())

  it('message.complete 收尾后状态复位，推进 10min 无二次收尾', () => {
    const store = useChatStore()
    const sid = 's-m2'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(true)

    // 正常 complete 收尾（reason='normal'）
    store.applyMessageEvent(sid, {
      type: 'message.complete',
      payload: { sessionId: sid, stopReason: 'end_turn' },
    } as ServerMessage)
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.getMessages(sid)[0].status).toBe('complete')

    // spy console.warn：finalizeSession 异常 reason 会打 dev warn（timeout 会命中此分支）。
    // message.complete 走 normal，不打 warn。断言推进 10min 后无任何异常收尾 warn（无二次收尾）。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 推进 10min + 1s（远超正常收尾所需时间）
    vi.advanceTimersByTime(600_000 + 1_000)

    // 核心断言：推进 10min 后无 timeout 收尾，消息保持 complete（未被二次收尾为 error）
    const timeoutWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('reason=timeout'))
    expect(timeoutWarns).toHaveLength(0)
    // 消息仍 complete（未被二次收尾为 error）
    expect(store.getMessages(sid)[0].status).toBe('complete')

    warnSpy.mockRestore()
  })
})

describe('B2: useChat.abortBash RPC 失败 → markBashError 写回 store 真 ref', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetChatModuleState()
    vi.clearAllMocks()
  })

  it('abortBash RPC reject → executingBash 被清（markBashError 兜底），手动种子消息写回真 ref', async () => {
    apiMock.abortBash.mockRejectedValueOnce(new Error('rpc boom'))

    const { abortBash } = useChat()
    const store = useChatStore()
    const sid = 's-b2'

    // bashStart 写 ephemeral 执行态（模拟 bash 正在执行）+ 手动种子 streaming bash 消息
    //（防御路径：验证 markBashError 对真 ref 的写回在新形态下仍有效）
    store.applyMessageEvent(sid, {
      type: 'message.bashStart',
      payload: { sessionId: sid, command: 'sleep 999', excludeFromContext: false, timestamp: 1000 },
    } as ServerMessage)
    expect(getExecutingBash(sid)).toBeDefined()
    store.setMessages(sid, [{
      id: 'bash-b2',
      role: 'system',
      content: '',
      status: 'streaming',
      bashExecution: { command: 'sleep 999', output: '', exitCode: null, cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1000 },
    } as Message])

    // abortBash RPC 失败 → catch 调 markBashError（B2 修复后写回 store 真 ref）
    await expect(abortBash(sid)).resolves.toBeUndefined()

    // 核心断言 1：executingBash 被清（abortBash RPC 失败时无 bashResult 帧到达的唯一兜底清点）
    expect(getExecutingBash(sid)).toBeUndefined()
    // 核心断言 2：手动种子消息被标 error（旧实现 { value: chat.messages } 写入丢失，
    // store 不会更新，消息会仍 streaming）。cancelled=true。
    const after = store.getMessages(sid)
    expect(after[0].status).toBe('error')
    expect(after[0].bashExecution?.cancelled).toBe(true)
    expect(after[0].error).toBe('rpc boom')
    // [chat-flow R4] 停止失败 toast 已删：错误文本经 markBashError 写入 bash 消息 error 字段
    // （上方断言 2 已覆盖），不再弹 toast
    expect(toastError).not.toHaveBeenCalled()
  })
})

// ══════════ 节 3/3 — 来源: quota-store.test.ts ══════════

describe('useQuotaStore', () => {
  const mockRow: NormalizedQuotaRow = {
    label: '智谱 GLM Coding Plan',
    wins: [
      { pct: 68, resetSec: 4980 },
      { pct: 42, resetSec: 266400 },
      { pct: null, resetSec: null },
    ],
  }

  it('setCache + getEntry：写入后可读取', () => {
    const store = useQuotaStore()
    store.setCache('zhipu', mockRow, 1000)

    const entry = store.getEntry('zhipu')
    expect(entry).toBeDefined()
    expect(entry!.data).toEqual(mockRow)
    expect(entry!.lastFetchAt).toBe(1000)
  })

  it('getEntry：不存在的 key 返回 undefined', () => {
    const store = useQuotaStore()
    expect(store.getEntry('nonexistent')).toBeUndefined()
  })

  it('setCache：覆盖写入', () => {
    const store = useQuotaStore()
    store.setCache('zhipu', mockRow, 1000)
    store.setCache('zhipu', null, 2000)

    const entry = store.getEntry('zhipu')
    expect(entry!.data).toBeNull()
    expect(entry!.lastFetchAt).toBe(2000)
  })

  it('markPending：首次标记返回 true，重复标记返回 false', () => {
    const store = useQuotaStore()
    expect(store.markPending('zhipu')).toBe(true)
    expect(store.markPending('zhipu')).toBe(false)
    expect(store.isPending('zhipu')).toBe(true)
  })

  it('unmarkPending：取消后可重新标记', () => {
    const store = useQuotaStore()
    store.markPending('zhipu')
    store.unmarkPending('zhipu')
    expect(store.isPending('zhipu')).toBe(false)
    expect(store.markPending('zhipu')).toBe(true)
  })

  it('isPending：未标记的 key 返回 false', () => {
    const store = useQuotaStore()
    expect(store.isPending('zhipu')).toBe(false)
  })

  it('clearCache：清除指定 provider 缓存', () => {
    const store = useQuotaStore()
    store.setCache('zhipu', mockRow, 1000)
    store.clearCache('zhipu')
    expect(store.getEntry('zhipu')).toBeUndefined()
  })

  it('clearCache：不影响其他 provider', () => {
    const store = useQuotaStore()
    store.setCache('zhipu', mockRow, 1000)
    store.setCache('kimi', mockRow, 2000)
    store.clearCache('zhipu')
    expect(store.getEntry('zhipu')).toBeUndefined()
    expect(store.getEntry('kimi')).toBeDefined()
  })

  it('多 provider 隔离：pending 和 cache 互不干扰', () => {
    const store = useQuotaStore()
    store.markPending('zhipu')
    store.setCache('kimi', mockRow, 1000)

    expect(store.isPending('zhipu')).toBe(true)
    expect(store.isPending('kimi')).toBe(false)
    expect(store.getEntry('zhipu')).toBeUndefined()
    expect(store.getEntry('kimi')).toBeDefined()
  })
})
