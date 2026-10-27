/**
 * panel 混合组件合并测试（单文件多源合并：6 个源文件同目录、mock 相容、共同装载
 * lucide-vue / vue / reka-ui-slim / shared / extension-protocol）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——单文件让全部用例共享一份组件树装载
 * 与环境初始化；拆文件会让每个文件各付一次装载（每份秒级 CPU，6 文件合计约 3.4s
 * 装载 CPU，合并后只装一份）。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动；各节以裸块隔离节内 helper/mock 实例）：
 *  - composer-file-popover.test.ts（CommandPopover file 分支 + AddMenuPopover 入口）
 *  - fork-entry-behavior.test.ts（fork 入口 + 行为 U7-U11）
 *  - tool-expand-restructure.test.ts（tool 展开体重构 W3）
 *  - gen-stats-triggers-visibility.test.ts（GenStatsTriggers 空值不占位）
 *  - context-usage-journeys.test.ts（context 用量 journey J1/J2）
 *  - block-working.test.ts（Block working 态折叠）
 *
 * mock 并集（模块图级，全节共享）：
 *  - useFileSearch（file-popover：可控 nodes）/ @taiji/core/transport/api/domains/composer
 *    （file-popover：landing cwd 通道）/ useChat + useSideDrawer（fork-entry：手写形态）
 *  - @taiji/core/transport/api（gen-stats：仅替换 command，events 面走 actual）
 *  - @taiji/core/transport/api/domains/session（context-usage：getContext 受控 deferred）
 *  - @/api：context-usage 原为「session 整体重指 mock domain」——合并文件改为仅重指
 *    getContext、保留 actual.session 其余成员（fork-entry 节 vi.spyOn(session,
 *    'fork'/'getCommands' 等) 需属性存在；CommandPopover 挂载即拉 getCommands），对
 *    context-usage 节「组件与断言共用同一 vi.fn」的诉求不变（session.getContext 即
 *    getContextMock）。
 *
 * 公共 afterEach：fork-entry 节的 vi.spyOn 会覆写 @/api.session 成员且原文件不做
 * restore（跨用例泄漏，独立文件时无下游消费者），合并后泄漏的 getContext spy 会让
 * context-usage 节拿到 U8 的 mockResolvedValue 而非受控 deferred——故每用例末把
 * session.getContext 复位为 getContextMock。
 *
 * [说明] gen-stats-triggers-visibility 源文件的 `@vitest-environment happy-dom`
 * pragma 与包默认环境（vitest.config.ts environment: 'happy-dom'）一致，合并后不保留。
 *
 * hook 处理：各源顶层 beforeEach/afterEach 均保留在各节裸块内叠加执行（pinia 重建 /
 * clearAllMocks / 节私有 mock 状态复位均为幂等操作，重复执行无副作用差异）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-file-popover.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { nextTick, ref, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import fs from 'node:fs'
import path from 'node:path'
import * as events from '@taiji/core/transport/api'
import { Turn, Block } from '@taiji/ui'
import type { Message, ToolCall, FileNode, GenStatsFrame } from '@taiji/shared'
import { useChatStore } from '@/stores/chat'
import { useToast } from '@/composables/useToast'
import type { MessageTurn } from '@/composables/logic/messageTurns'
import { mockChatProvide } from '@/__tests__/helpers/chat-view-deps'
import { useGenStats, __clearInFlightGenStatsForTest } from '@/composables/features/model/useGenStats'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { __clearInFlightContextFetchForTest } from '@/composables/features/model/useContextUsage'
import ForkNotice from '@/components/panel/ForkNotice.vue'
import GenStatsTriggers from '@/components/panel/GenStatsTriggers.vue'
import ContextCapacityCard from '@/components/panel/ContextCapacityCard.vue'
import CommandPopover from '@/components/panel/CommandPopover.vue'
import AddMenuPopover from '@/components/panel/AddMenuPopover.vue'
import { session as apiSessionFacade } from '@/api'

// ── mock：useFileSearch（file-popover 节：返回可控 FileNode[]，绕过真实 file.search）──
const mockLoad = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/search/useFileSearch', () => ({
  useFileSearch: () => ({ load: (...args: unknown[]) => mockLoad(...args) }),
}))

// ── mock：composer domain（file-popover 节：landing cwd 通道）──
// u5 re-anchor（e79ba3647/8ca21226f）后实现 import 的是 core 子路径，mock 必须对齐同一
// specifier（旧 '@/api/domains/composer' bridge 已删，mock 指旧路径 = mock 失效）
const getFileCandidatesByCwdMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/composer')>()
  return {
    ...actual,
    getFileCandidatesByCwd: (...args: unknown[]) => getFileCandidatesByCwdMock(...args),
  }
})

// ── mock：useChat / useSideDrawer（fork-entry 节）──
// useChat mock（Turn 编辑路径依赖；forkSessionAsk 复用其 ensureStreamSubscription/disposeSession）。
// disposeSession 用模块级 spy，让 U9 W7 断言可断言「回滚时被调」（拆流式订阅 + 清 store per-session 状态）。
// ensureStreamSubscription 导出作 no-op stub：U9 测回滚编排，不验真实流式订阅。
const disposeSessionMock = vi.hoisted(() => vi.fn())
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({ editAndResend: vi.fn(), disposeSession: disposeSessionMock }),
  ensureStreamSubscription: vi.fn(),
}))
vi.mock('@/composables/features/drawer/useSideDrawer', () => ({
  useSideDrawer: () => ({ open: vi.fn() }),
}))

// ── mock：transport api command 面（gen-stats 节：按 sid 出帧 / 挂起；events 面走 actual）──
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock }
})

// ── mock：session domain getContext（context-usage 节：受控 deferred）──
const getContextMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/session', () => ({ getContext: getContextMock }))
// 门面 '@/api' 重指 getContext（合并形态：仅覆写 getContext、保留 actual.session 其余
// 成员——见文件头「mock 并集」说明）
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  return { ...actual, session: { ...actual.session, getContext: getContextMock } }
})

// ── 公共 afterEach：复位 fork-entry 节 spyOn 泄漏的 getContext 覆写（见文件头说明）──
afterEach(() => {
  ;(apiSessionFacade as { getContext: unknown }).getContext = getContextMock
})

// ══════════ 来源：composer-file-popover.test.ts ══════════
{
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  /** CommandPopover file 分支 mount 单源（attachTo body + open=true 驱动 + flush）。 */
  async function mountFilePopover(nodes: FileNode[]) {
    mockLoad.mockResolvedValueOnce(nodes)
    const wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'file', sessionId: 's1' },
    })
    await flushPromises()
    await nextTick()
    return wrapper
  }

  /** pop-item 行文本包含判定（浮层渲染在 body，querySelectorAll 走 body 级）。 */
  function popItemTextIncludes(text: string): boolean {
    return Array.from(document.body.querySelectorAll('.pop-item')).some((b) =>
      b.textContent?.includes(text),
    ) ?? false
  }

  describe('CommandPopover file 分支', () => {
    it('U27 type=file 渲染候选：DOM body 含文件名 button', async () => {
      const wrapper = await mountFilePopover([{ path: 'a.ts', name: 'a.ts', type: 'file' }])

      const btns = Array.from(document.body.querySelectorAll('.pop-item'))
      const fileBtn = btns.find((b) => b.textContent?.includes('a.ts'))
      expect(fileBtn).toBeDefined()
      wrapper.unmount()
    })

    it('U28 type=file 候选空 → PopoverContent 不渲染', async () => {
      await mountFilePopover([])

      // PopoverContent v-if="items.length > 0"，空候选不渲染浮层（无 .pop-item 行）
      expect(popItemTextIncludes('a.ts')).toBe(false)
      expect(document.body.querySelectorAll('.pop-item').length).toBe(0)
    })

    it('U29 候选含目录项 → 图标用 folder（G16 映射）', async () => {
      const wrapper = await mountFilePopover([
        { path: 'src', name: 'src', type: 'dir' },
        { path: 'a.ts', name: 'a.ts', type: 'file' },
      ])

      // 目录项 name 补斜杠（src/），验证 G16 映射后目录正确识别
      const dirBtn = Array.from(document.body.querySelectorAll('.pop-item')).find((b) =>
        b.textContent?.includes('src/'),
      )
      expect(dirBtn).toBeDefined()
      wrapper.unmount()
    })
  })

  // ADR-0049 回归：同组件实例 sid A→B 切换后 B 的文件候选不显示 A 残留。
  // 验证 watch(sessionId) 触发 loadCandidates 从 store 缓存重新填充，
  // fileCandidates ref 被 B 的数据覆盖（而非保留 A 的旧值）。
  it('U33 sid A→B 切换后 B 的候选不显示 A 残留（ADR-0049 回归）', async () => {
    // mock 按 sessionId 返回不同候选
    mockLoad.mockImplementation(async (sid: string) => {
      if (sid === 's-a') return [{ path: 'a.ts', name: 'a.ts', type: 'file' as const }]
      if (sid === 's-b') return [{ path: 'b.ts', name: 'b.ts', type: 'file' as const }]
      return []
    })

    const wrapper = mount(CommandPopover, {
      attachTo: document.body,
      props: { open: true, type: 'file', sessionId: 's-a' },
    })
    await flushPromises()
    await nextTick()

    // A 的候选可见
    const btnsA = Array.from(document.body.querySelectorAll('.pop-item'))
    expect(btnsA.some((b) => b.textContent?.includes('a.ts'))).toBe(true)
    expect(btnsA.some((b) => b.textContent?.includes('b.ts'))).toBe(false)

    // 切到 B
    await wrapper.setProps({ sessionId: 's-b' })
    await flushPromises()
    await nextTick()

    // B 的候选可见，A 的残留不可见
    const btnsB = Array.from(document.body.querySelectorAll('.pop-item'))
    expect(btnsB.some((b) => b.textContent?.includes('b.ts'))).toBe(true)
    expect(btnsB.some((b) => b.textContent?.includes('a.ts'))).toBe(false)

    // 切回 A（验证 store 缓存恢复）
    await wrapper.setProps({ sessionId: 's-a' })
    await flushPromises()
    await nextTick()

    const btnsA2 = Array.from(document.body.querySelectorAll('.pop-item'))
    expect(btnsA2.some((b) => b.textContent?.includes('a.ts'))).toBe(true)
    expect(btnsA2.some((b) => b.textContent?.includes('b.ts'))).toBe(false)

    wrapper.unmount()
  })

  // ── landing cwd 路（u5：无 sessionId + cwd 有值，$ 候选边沿拉） ──────────────────────

  describe('landing cwd 路（LP 组，u5 G1/D2）', () => {
    let wrapper: ReturnType<typeof mount> | null = null

    beforeEach(() => {
      // open-fetch 的 1s 节流是模块级真实时钟（跨用例共享）——只 fake Date（flushPromises
      // 依赖的 setImmediate/setTimeout 保持真实），用例间推进时钟跳出节流窗口
      vi.useFakeTimers({ toFake: ['Date'] })
    })

    afterEach(() => {
      vi.useRealTimers()
      wrapper?.unmount()
      wrapper = null
      document.body.innerHTML = ''
    })

    it('LP1 无 sessionId + cwd 有值 → open 边沿按 cwd 拉取，浮层渲染文件候选行', async () => {
      getFileCandidatesByCwdMock.mockResolvedValueOnce({
        files: [{ path: 'landing-main.ts', name: 'landing-main.ts', type: 'file' }],
        truncated: false,
      })
      wrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open: false, type: 'file', cwd: '/tmp/landing-proj' },
      })
      await nextTick()
      // 关闭态不预拉（open-fetch 仅 false→true 边沿触发）
      expect(getFileCandidatesByCwdMock).not.toHaveBeenCalled()
      await wrapper.setProps({ open: true })
      await flushPromises()
      expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(1)
      expect(getFileCandidatesByCwdMock).toHaveBeenCalledWith('/tmp/landing-proj')
      // 拉取结果渲染进浮层（用户可见 DOM）
      const btn = Array.from(document.body.querySelectorAll('.pop-item')).find((b) =>
        b.textContent?.includes('landing-main.ts'),
      )
      expect(btn).toBeDefined()
    })

    it('LP2 拉取失败（D7）→ 错误态浮层「加载失败，点击重试」；点击行重试绕节流重发拉取，成功后恢复', async () => {
      // 跳出 LP1 拉取留下的 1s 节流窗口（模块级节流，不推进时钟则本用例边沿被节流命中）
      vi.advanceTimersByTime(1001)
      getFileCandidatesByCwdMock.mockRejectedValueOnce(
        Object.assign(new Error('cwd not found'), { code: 'not_found' }),
      )
      wrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open: false, type: 'file', cwd: '/deleted-dir' },
      })
      await nextTick()
      await wrapper.setProps({ open: true })
      await flushPromises()
      expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(1)
      // D7：失败回写错误态（不采用的「降级空数组」不再适用）——浮层渲染错误行；
      // rejection 被 open-fetch catch，不冒泡 unhandled（vitest 对 unhandled 判失败，用例通过即无）
      const errRow = document.body.querySelector('[data-testid="cmd-file-error"]')
      expect(errRow).not.toBeNull()
      expect(document.body.querySelector('[data-testid="cmd-file-empty"]')).toBeNull()
      expect(document.body.querySelectorAll('.pop-item')).toHaveLength(0)

      // 点击错误行 → 重试（force 绕过 1s 节流，仍在窗口内即重发）；成功后错误态消失、候选渲染
      getFileCandidatesByCwdMock.mockResolvedValueOnce({
        files: [{ path: 'recovered.ts', name: 'recovered.ts', type: 'file' }],
        truncated: false,
      })
      errRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()
      await nextTick()
      expect(getFileCandidatesByCwdMock).toHaveBeenCalledTimes(2)
      expect(document.body.querySelector('[data-testid="cmd-file-error"]')).toBeNull()
      expect(
        Array.from(document.body.querySelectorAll('.pop-item')).some((b) => b.textContent?.includes('recovered.ts')),
      ).toBe(true)
    })

    it('LP3 成功且 truncated=true（D7）→ 候选列表底部渲染「已截断」提示行', async () => {
      vi.advanceTimersByTime(1001)
      getFileCandidatesByCwdMock.mockResolvedValueOnce({
        files: [{ path: 'big-repo-file.ts', name: 'big-repo-file.ts', type: 'file' }],
        truncated: true,
      })
      wrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open: false, type: 'file', cwd: '/tmp/huge-monorepo' },
      })
      await nextTick()
      await wrapper.setProps({ open: true })
      await flushPromises()
      await nextTick()

      expect(
        Array.from(document.body.querySelectorAll('.pop-item')).some((b) => b.textContent?.includes('big-repo-file.ts')),
      ).toBe(true)
      expect(document.body.querySelector('[data-testid="cmd-file-truncated"]')).not.toBeNull()
    })

    it('LP4 成功但空结果（D7）→ 空态浮层「当前目录无匹配文件」（与加载失败错误态两因区分）', async () => {
      vi.advanceTimersByTime(1001)
      getFileCandidatesByCwdMock.mockResolvedValueOnce({ files: [], truncated: false })
      wrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open: false, type: 'file', cwd: '/tmp/empty-dir' },
      })
      await nextTick()
      await wrapper.setProps({ open: true })
      await flushPromises()
      await nextTick()

      expect(document.body.querySelector('[data-testid="cmd-file-empty"]')).not.toBeNull()
      expect(document.body.querySelector('[data-testid="cmd-file-error"]')).toBeNull()
    })

    it('LP5 cwd 快照检查（B5/#10）：open 边沿清上一 cwd 陈旧候选；在途回执按发起时 cwd 归属、失配丢弃', async () => {
      vi.advanceTimersByTime(1001)
      // 第一拍：cwd A 拉到候选 a.ts
      getFileCandidatesByCwdMock.mockResolvedValueOnce({
        files: [{ path: 'a.ts', name: 'a.ts', type: 'file' }],
        truncated: false,
      })
      wrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open: false, type: 'file', cwd: '/dir-a' },
      })
      await nextTick()
      await wrapper.setProps({ open: true })
      await flushPromises()
      expect(popItemTextIncludes('a.ts')).toBe(true)

      // 第二拍：切 cwd B 重开（推进时钟出节流）——B 拉取挂起期间，open 边沿已清 A 的陈旧候选
      vi.advanceTimersByTime(1001)
      let resolveB: (v: { files: FileNode[]; truncated: boolean }) => void = () => {}
      getFileCandidatesByCwdMock.mockImplementationOnce(
        () => new Promise<{ files: FileNode[]; truncated: boolean }>((res) => { resolveB = res }),
      )
      await wrapper.setProps({ open: false })
      await nextTick()
      await wrapper.setProps({ cwd: '/dir-b', open: true })
      await flushPromises()
      expect(popItemTextIncludes('a.ts')).toBe(false) // 陈旧候选已清（FileNode.path 相对旧 cwd，跨目录显示是事实错误）

      // 在途期间再切 cwd → C：B 的回执到达时快照失配（cwd ≠ 发起时 /dir-b）→ 丢弃
      await wrapper.setProps({ cwd: '/dir-c' })
      await nextTick()
      resolveB({ files: [{ path: 'b-only.ts', name: 'b-only.ts', type: 'file' }], truncated: false })
      await flushPromises()
      await nextTick()
      expect(document.body.querySelectorAll('.pop-item')).toHaveLength(0)
    })
  })

  // ── AddMenuPopover ──────────────────────────────────────────────────

  describe('AddMenuPopover 入口（# 文件改走 inline 触发，+菜单只剩 附件/命令）', () => {
    it('U30 +菜单含「附件」「命令」，不含「文件」「引用」', async () => {
      const wrapper = mount(AddMenuPopover, {
        attachTo: document.body,
      })
      // 触发 Popover 打开（click trigger）
      await wrapper.find('button').trigger('click')
      await nextTick()

      const texts = Array.from(document.body.querySelectorAll('button')).map((b) => b.textContent ?? '')
      expect(texts.some((t) => t.includes('附件'))).toBe(true)
      expect(texts.some((t) => t.includes('命令'))).toBe(true)
      // # 文件已移除入口（改走 inline 触发）；@ 引用早已废弃
      expect(texts.some((t) => t.includes('文件'))).toBe(false)
      expect(texts.some((t) => t.includes('引用'))).toBe(false)
      wrapper.unmount()
    })
  })
}

// ══════════ 来源：fork-entry-behavior.test.ts ══════════
{
  /** 构造 assistant message（content 是 string，status 可控） */
  function makeAssistant(over: Partial<Message> = {}): Message {
    return {
      id: over.id ?? 'a1',
      role: 'assistant',
      content: over.content ?? 'AI 回复内容',
      status: over.status ?? 'complete',
      timestamp: over.timestamp ?? Date.now(),
      ...over,
    } as Message
  }

  function makeTurn(assistants: Message[]): MessageTurn {
    return {
      index: 1,
      user: {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: '问题' }],
        status: 'complete',
        timestamp: Date.now(),
      },
      assistants,
      isStreaming: false,
      hasFoldable: false,
    }
  }

  const onForkMock = vi.fn()
  const onForkAskMock = vi.fn()

  /**
   * mount Turn —— provide mock ChatViewDeps（fork 回调经 deps 注入，编排逻辑在 renderer 壳）。
   * 不新建 pinia：组件内 chat.isActive(sessionId) 必须读到 beforeEach 设置的同一 store。
   */
  function mountTurn(turn: MessageTurn, sessionId = 's1') {
    return mount(Turn, {
      props: { turn, sessionId },
      global: {
        provide: mockChatProvide({ onFork: onForkMock, onForkAsk: onForkAskMock }),
        stubs: {
          // Block 不 stub：[actions-anchor] 起 TurnSummary 经 Block 的 #turn-actions 具名插槽
          // 挂载，stub 不渲染具名插槽会连操作栏一起丢掉
          ChangeSetCard: true,
          MarkdownRenderer: true,
        },
      },
    })
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    // 模块级 mock（disposeSessionMock）需跨用例清调用记录，避免 U9 断言被先前用例污染。
    vi.clearAllMocks()
    // useToast 是模块级单例，跨用例共享 → 清空残留 toast（U9-fail 断言 toasts 内容）。
    const { toasts } = useToast()
    toasts.value = []
  })

  // ── U7：首屏冒烟 —— summary action 行恒有 fork 按钮（W2 门控已放宽，ui 版无条件渲染） ────────
  describe('U7 首屏冒烟：fork 按钮恒渲染（门控已放宽）', () => {
    it('每条 assistant 的 summary action 行有 fork 按钮（ui TurnSummary 无 isSessionActive 门控）', () => {
      const turn = makeTurn([makeAssistant({ id: 'a1', status: 'streaming' })])
      const wrapper = mountTurn(turn, 's-stream')
      // W2 放宽门控后 streaming 态也应有 fork 按钮（ui 版 fork 按钮恒在 summary action 行）
      const forkBtns = wrapper.findAll('button').filter((b) =>
        b.attributes('title')?.includes('分叉') || b.attributes('title')?.includes('fork'),
      )
      expect(forkBtns.length).toBeGreaterThan(0)
      // fork 统一为 fork-ask-btn（进 composer 模式），不再有独立的 fork-background-btn
      expect(wrapper.find('[data-testid="fork-background-btn"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="fork-ask-btn"]').exists()).toBe(true)
    })

    it('多条 assistant 消息时，summary action 行有 fork 提问按钮（与复制同行）', () => {
      const turn = makeTurn([
        makeAssistant({ id: 'a1', content: '第一条回复' }),
        makeAssistant({ id: 'a2', content: '第二条回复' }),
      ])
      const wrapper = mountTurn(turn, 's-idle')
      // fork 统一为 fork-ask-btn（与复制正文/朗读/handoff 并列同行）
      expect(wrapper.findAll('[data-testid="fork-background-btn"]').length).toBe(0)
      expect(wrapper.findAll('[data-testid="fork-ask-btn"]').length).toBe(1)
      // fork 按钮与复制按钮在同一容器（action 行，4 个并列按钮：纯文本复制已退役，
      // 2026-10-15 裁决；[actions-anchor] 起 .turn-summary = 操作栏行本体，定位与显隐在
      // Block 的插槽包装层）
      const actionRow = wrapper.find('.turn-summary')
      expect(actionRow.exists()).toBe(true)
      expect(actionRow.find('[data-testid="fork-ask-btn"]').exists()).toBe(true)
      expect(actionRow.findAll('button').length).toBe(4)
    })
  })

  // ── U8：forkSession 后台 fork 不切焦点（W2 fast-fork） ──────────────────────
  describe('U8：forkSession 后台 fork 不切焦点（不切 activeId）', () => {
    it('fork 后台后焦点留在原 session（不切焦点）', async () => {
      // 直接对真实 useSidebar 行为做断言：forkSession 后 activeId 应保持不变。
      const { useSidebar } = await import('@/composables/features/sidebar/useSidebar')
      const sidebar = useSidebar()

      const sessionStore = (await import('@/stores/session')).useSessionStore()
      const sessionApi = (await import('@/api')).session

      // 准备一条可被 fork 的消息
      const chatStore = useChatStore()
      const sid = 's-fork-src'
      chatStore.hydrate(sid, [makeAssistant({ id: 'm1', piEntryId: 'e1' })])

      // mock fork RPC 返回新 session；先 append 进 sessionStore 让 selectSession 不炸
      const forked = { id: 'new-fork', label: 'fork', cwd: '/tmp' }
      vi.spyOn(sessionApi, 'fork').mockResolvedValue(forked)
      // 预注册新 session 到 store（appendSession 入组），并 mock switchSession 避免命中 mock runtime
      sessionStore.appendSession(forked)
      vi.spyOn(sessionApi, 'switchSession').mockResolvedValue(undefined)
      vi.spyOn(sessionApi, 'getCommands').mockResolvedValue({ sessionId: 'new-fork', commands: [] })
      vi.spyOn(sessionApi, 'getContext').mockResolvedValue({ sessionId: 'new-fork' })

      const beforeActive = sessionStore.activeId

      await sidebar.forkSession(sid, 'm1', { includeFrom: true })

      // activeId 不应变（后台 fork 不切焦点，W2 fast-fork）
      expect(sessionStore.activeId).toBe(beforeActive)
    })
  })

  // ── U9：forkSessionAsk send 失败自动回滚 ─────────────────────────────────
  describe('U9：forkSessionAsk send 失败自动回滚（disposeSession + sessionApi.remove + removeFromList）', () => {
    it('fork 提问发送失败后不留空白分支（回滚清理）', async () => {
      const { useSidebar } = await import('@/composables/features/sidebar/useSidebar')
      const sidebar = useSidebar()

      const sessionApi = (await import('@/api')).session
      const sessionStore = (await import('@/stores/session')).useSessionStore()
      const removeSpy = vi.spyOn(sessionApi, 'remove').mockResolvedValue(undefined)
      const removeFromListSpy = vi.spyOn(sessionStore, 'removeFromList')

      // fork 成功（创建占位 session），但随后 send reject
      vi.spyOn(sessionApi, 'fork').mockResolvedValue({
        id: 'fork-placeholder',
        label: 'fork',
        cwd: '/tmp',
      })
      const chatApi = (await import('@/api')).chat
      // [u3c/D1] fork 首发走统一提交（delivery.submit）——失败注入点随之迁移
      vi.spyOn(chatApi, 'submitDelivery').mockRejectedValue(new Error('send failed'))

      // [W1] forkSessionAsk 现在 rethrow 而非吞错 resolve（错误反馈职责上移到调用方）。
      // 资源清理（disposeSession + remove + removeFromList）仍在 catch 内 rethrow 前执行。
      await expect(sidebar.forkSessionAsk('s-src', 'm1', '追问内容')).rejects.toThrow('send failed')

      // 回滚三件套均被调（W7 补 disposeSession 断言：拆流式订阅 + 清 chat store per-session 状态）
      expect(disposeSessionMock).toHaveBeenCalledWith('fork-placeholder')
      expect(removeSpy).toHaveBeenCalledWith('fork-placeholder')
      expect(removeFromListSpy).toHaveBeenCalledWith('fork-placeholder')
    })
  })

  // ── U10：ForkNotice 反馈行 transient 渲染 + 查看降级 ─────────────────────
  describe('U10：ForkNotice 反馈行（transient，非 banner）+ 查看降级', () => {
    it('ForkNotice 渲染为反馈行（fork-notice class），含查看链接', async () => {
      const wrapper = mount(ForkNotice, {
        props: { sessionDeleted: false },
        global: { plugins: [createPinia()] },
      })
      // 反馈行 class（区别于 banner）
      expect(wrapper.find('.fork-notice').exists()).toBe(true)
      expect(wrapper.find('.banner').exists()).toBe(false)
      // 含查看链接（可点击，session 未删）
      const viewLink = wrapper.find('[data-testid="fork-notice-view"]')
      expect(viewLink.exists()).toBe(true)
      expect(viewLink.attributes('disabled')).toBeFalsy()
    })

    it('sessionDeleted=true 时查看降级为纯文本不可点', async () => {
      const wrapper = mount(ForkNotice, {
        props: { sessionDeleted: true },
        global: { plugins: [createPinia()] },
      })
      const viewLink = wrapper.find('[data-testid="fork-notice-view"]')
      // session 已删 → 查看降级为纯文本，不可点（无 role=button / disabled 或非 <a>/<button>）
      expect(viewLink.exists()).toBe(true)
      // 降级态：不应是可交互元素（无 role=button，或 aria-disabled）
      const interactive =
        viewLink.attributes('role') === 'button' ||
        viewLink.element.tagName === 'A' ||
        viewLink.element.tagName === 'BUTTON'
      expect(interactive).toBe(false)
    })
  })

  // ── U11：ForkConfirmModal 已删除 ─────────────────────────────────────────
  describe('U11：ForkConfirmModal 已删除（文件不存在 + Turn.vue 无 import）', () => {
    it('ForkConfirmModal.vue 文件已不存在', () => {
      const modalPath = path.resolve(
        __dirname,
        '../../components/panel/message-stream/ForkConfirmModal.vue',
      )
      // 红灯：当前文件存在 → existsSync 返回 true → 断言 false 失败
      expect(fs.existsSync(modalPath)).toBe(false)
    })

    it('Turn.vue 源码不再 import ForkConfirmModal', () => {
      // [w6] Turn 已迁 ui 包（renderer 旧目录删除），检查 ui 包源码
      const turnPath = path.resolve(
        __dirname,
        '../../../../ui/src/features/chat/Turn.vue',
      )
      const source = fs.readFileSync(turnPath, 'utf-8')
      expect(source).not.toContain('ForkConfirmModal')
    })
  })

  // ── 盲区 2（renderer）：fork 触发回调契约（编排 + toast 反馈已迁 renderer 壳 useChatViewDeps） ──────────────────
  describe('盲区 2：fork 按钮点击 → deps.onForkAsk 回调（编排在 renderer 壳）', () => {
    it('点 fork 按钮 → deps.onForkAsk(sessionId, message) 被调（统一进 composer 模式）', async () => {
      onForkAskMock.mockClear()
      const turn = makeTurn([makeAssistant({ id: 'a1', piEntryId: 'pi-a1' })])
      const wrapper = mountTurn(turn, 's-fork-ask')

      // fork 按钮统一为 fork-ask（进 composer 模式，可输入或空提交；空提交=后台 fork）
      await wrapper.find('[data-testid="fork-ask-btn"]').trigger('click')

      expect(onForkAskMock).toHaveBeenCalledWith('s-fork-ask', expect.objectContaining({ id: 'a1' }))
    })
  })
}

// ══════════ 来源：tool-expand-restructure.test.ts ══════════
{
  function makeTool(over: Partial<ToolCall> = {}): ToolCall {
    return {
      id: 'tc-1',
      toolName: 'edit',
      input: { path: 'src/App.vue' },
      output: 'done',
      status: 'completed',
      startTime: 1000,
      endTime: 2500, // 耗时 1.5s
      ...over,
    }
  }

  describe('W3: 普通 tool 展开体去重复 + 加补充细节条', () => {
    it('展开后不重复打印 toolName(args) 行（header 已有）', async () => {
      const wrapper = mount(Block, {
        props: { type: 'tool', tool: makeTool(), working: false },
        global: { provide: mockChatProvide() },
      })
      await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
      // 关键断言：展开体内不应再有 "edit(src/App.vue)" 这样的重复行
      // 当前实现 :103-106 会打印 <span>edit</span><span>(src/App.vue)</span>（红灯）
      // 展开 body 的文本里，toolName + ( + argPath 组合不应出现
      const expandText = wrapper.text()
      // "edit(src/App.vue)" 或 "edit (src/App.vue)" 是重复行的特征
      expect(expandText).not.toMatch(/edit\s*\(src\/App\.vue\)/)
    })

    it('展开后 result 区无 Check/XCircle 图标（header 状态指示已覆盖）', async () => {
      const wrapper = mount(Block, {
        props: { type: 'tool', tool: makeTool({ output: 'success result' }), working: false },
        global: { provide: mockChatProvide() },
      })
      await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
      // 当前实现 :112-113 在 result 前放 Check/XCircle（红灯——改后应移除）
      // 展开 body 内的 svg 图标：header 的 svg 是状态指示（保留），result 区的 svg 是重复（应删）
      // 验证方式：header 外不应有额外的 Check 图标
      const header = wrapper.find('[data-testid="tool-block-header"]')
      const headerSvgs = header.findAll('svg')
      const allSvgs = wrapper.findAll('svg')
      // header 自带 chevron + wrench + status = 3 个 svg
      // result 区有 1 个 copy 按钮的 CopyIcon svg（hover overlay，始终在 DOM）
      expect(allSvgs.length).toBe(headerSvgs.length + 1)
    })

    it('展开后显示补充细节条（耗时，从 startTime+endTime 计算）', async () => {
      const wrapper = mount(Block, {
        props: { type: 'tool', tool: makeTool({ startTime: 1000, endTime: 3000 }), working: false },
        global: { provide: mockChatProvide() },
      })
      await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
      // 关键断言：展开后显示耗时（diff=2000ms → formatDuration "2s"）
      // 当前展开体无耗时信息（红灯）
      const expandText = wrapper.text()
      expect(expandText).toContain('2s')
    })

    it('展开后结果文本仍可见（去重复不影响结果展示）', async () => {
      const wrapper = mount(Block, {
        props: { type: 'tool', tool: makeTool({ output: 'file content here' }), working: false },
        global: { provide: mockChatProvide() },
      })
      await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
      // 结果仍可见
      expect(wrapper.text()).toContain('file content here')
    })

    it('失败 tool 终态挂载默认展开 error 直显（584869378 §3.3.1 选项 A），无鲜红框——Demo H 去鲜红', async () => {
      const wrapper = mount(Block, {
        props: {
          type: 'tool',
          tool: makeTool({ status: 'error', output: 'old_string not found', startTime: 1000, endTime: 1200 }),
          working: false,
        },
        global: { provide: mockChatProvide() },
      })
      // failed 终态挂载默认展开（错误输出立即可见），error text 通过 displayContent 兜底显示
      expect(wrapper.text()).toContain('old_string not found')
      // Demo H：鲜红框已删（无 border-danger / bg-danger-soft）
      expect(wrapper.find('.border-danger').exists()).toBe(false)
      expect(wrapper.find('.bg-danger-soft').exists()).toBe(false)
      // 无重复 toolName(args) 行
      expect(wrapper.text()).not.toMatch(/edit\s*\(src\/App\.vue\)/)
      // 手动点击可收起
      await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
      expect(wrapper.text()).not.toContain('old_string not found')
    })
  })

  describe('W3 补充：read/bash 工具特化 meta（行数/字符数自算）', () => {
    it('read 工具展开后细节条含行数 + 字符数 + 耗时', async () => {
      const fileContent = 'line1\nline2\nline3' // 3 行 17 字符
      const wrapper = mount(Block, {
        props: {
          type: 'tool',
          tool: makeTool({ toolName: 'read', output: fileContent, startTime: 1000, endTime: 3000 }),
          working: false,
        },
        global: { provide: mockChatProvide() },
      })
      await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
      const text = wrapper.text()
      // 3 行（output.split('\n').length = 3）
      expect(text).toContain('3 行')
      // 字符数 17（< 1000，显示原值；单位词走 i18n 键 panel.message.metaChars）
      expect(text).toContain('17 字符')
      // 耗时（diff 2000ms → formatDuration "2s"）
      expect(text).toContain('2s')
    })

    it('bash 工具展开后细节条不含行数统计（filteredMetaItems 已过滤），只有耗时', async () => {
      const output = 'stdout line1\nstdout line2\nstdout line3\nstdout line4'
      const wrapper = mount(Block, {
        props: {
          type: 'tool',
          tool: makeTool({ toolName: 'bash', output, startTime: 1000, endTime: 5200 }),
          working: false,
        },
        global: { provide: mockChatProvide() },
      })
      await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
      const text = wrapper.text()
      // bash filteredMetaItems 过滤掉了行数统计（命令+output 已完整展示，行数无参考价值）
      expect(text).not.toContain('4 行')
      // bash 不显示字符数（read/cat 才显示）
      expect(text).not.toContain('字符')
      // 耗时（diff=4200ms → formatDuration toFixed(0) → "4s"）
      expect(text).toContain('4s')
    })

    it('read 大文件字符数格式化为 XK 字符（>1000 字符）', async () => {
      const bigContent = 'x'.repeat(2500) // 1 行 2500 字符
      const wrapper = mount(Block, {
        props: {
          type: 'tool',
          tool: makeTool({ toolName: 'read', output: bigContent, startTime: 1000, endTime: 2000 }),
          working: false,
        },
        global: { provide: mockChatProvide() },
      })
      await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
      // 2500 字符 → 2.5K 字符（panel.message.metaCharsK）
      expect(wrapper.text()).toContain('2.5K 字符')
    })

    it('edit 工具细节条只有耗时（output 是简短确认，行数无意义）', async () => {
      const wrapper = mount(Block, {
        props: {
          type: 'tool',
          tool: makeTool({ toolName: 'edit', output: 'done', startTime: 1000, endTime: 1500 }),
          working: false,
        },
        global: { provide: mockChatProvide() },
      })
      await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
      const text = wrapper.text()
      // edit 不在 OUTPUT_META_TOOLS，无行数
      expect(text).not.toContain('行')
      // 只有耗时（500ms → formatDuration "500ms"）
      expect(text).toContain('500ms')
    })

    it('read 失败时错误移至内容区（displayContent 兜底 tool.error，终态挂载默认展开），meta 不含错误摘要', async () => {
      const wrapper = mount(Block, {
        props: {
          type: 'tool',
          tool: makeTool({
            toolName: 'read',
            status: 'error',
            output: 'File not found: src/missing.ts',
            startTime: 1000,
            endTime: 1100,
          }),
          working: false,
        },
        global: { provide: mockChatProvide() },
      })
      // failed 终态挂载默认展开（584869378）：错误文本通过 displayContent（兜底 tool.error）在内容区可见
      expect(wrapper.text()).toContain('File not found: src/missing.ts')
      // meta 不含错误摘要（已移至内容区），无 text-neutral-mid.font-semibold meta 项
      expect(wrapper.find('.text-neutral-mid.font-semibold').exists()).toBe(false)
      // M1 T1（584869378）：failed tool header 状态色染 danger（唯一 text-danger 来源），不含错误摘要文本
      const danger = wrapper.find('.text-danger')
      expect(danger.exists()).toBe(true)
      expect(danger.text()).not.toContain('File not found')
    })
  })
}

// ══════════ 来源：gen-stats-triggers-visibility.test.ts ══════════
{
  const SID = 's-stats'
  const PENDING_SID = 's-pending'

  function frameOf(over: {
    ttft?: number | null
    speed?: number | null
    cache?: number | null
  }): GenStatsFrame {
    return {
      sessionId: SID,
      speed: { current: over.speed ?? null, day: null, d7: null, d30: null },
      cacheRatio: { current: over.cache ?? null, day: null },
      ttft: { current: over.ttft ?? null, day: null, d7: null, d30: null },
    } as GenStatsFrame
  }

  /** 组合式挂载壳：GenStatsTriggers 必须在 setup 同步消费 useGenStats（getCurrentInstance 检查）。 */
  function mountTriggers(sessionId?: string) {
    return mount({
      components: { GenStatsTriggers },
      setup() {
        // 真 ref（useGenStats 内部 watch 对源形态有契约，假 {value} 对象会触发 Invalid watch source）
        const sidRef = ref<string | null | undefined>(sessionId ?? undefined)
        useGenStats(sidRef, ref(undefined))
        return { sid: sidRef }
      },
      template: `<GenStatsTriggers :session-id="sid" />`,
    })
  }

  const valueTestids = [
    'genstats-ttft-value',
    'genstats-speed-value',
    'genstats-cache-value',
  ] as const

  enableAutoUnmount(afterEach)

  beforeEach(() => {
    commandMock.mockReset()
    __clearInFlightGenStatsForTest()
    commandMock.mockImplementation((_method: string, payload: { sessionId?: string }) =>
      payload?.sessionId === PENDING_SID ? new Promise(() => {}) : Promise.resolve(frameOf({})),
    )
  })

  describe('GenStatsTriggers 空值不占位（使用者黑盒 DOM）', () => {
    it('无帧（挂起恢复路径）→ 三触发器值节点全不渲染，根容器仍在', () => {
      const wrapper = mountTriggers(PENDING_SID)
      for (const id of valueTestids) {
        expect(wrapper.find(`[data-testid="${id}"]`).exists(), id).toBe(false)
      }
      expect(wrapper.find('div.flex.items-center.gap-0').exists()).toBe(true)
    })

    it('全有值帧 → 三触发器照常渲染（0 是真值也渲染）', async () => {
      commandMock.mockResolvedValue(frameOf({ ttft: 0, speed: 0, cache: 0 }))
      const wrapper = mountTriggers(SID)
      await vi.waitFor(() => {
        for (const id of valueTestids) {
          expect(wrapper.find(`[data-testid="${id}"]`).exists(), id).toBe(true)
        }
      }, { interval: 1 })
    })

    it('部分无值帧 → 无值维不渲染、有值维照常（维度级独立）', async () => {
      commandMock.mockResolvedValue(frameOf({ ttft: null, speed: 12.5, cache: null }))
      const wrapper = mountTriggers(SID)
      await vi.waitFor(() => {
        expect(wrapper.find('[data-testid="genstats-speed-value"]').exists()).toBe(true)
      }, { interval: 1 })
      expect(wrapper.find('[data-testid="genstats-ttft-value"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="genstats-cache-value"]').exists()).toBe(false)
    })
  })
}

// ══════════ 来源：context-usage-journeys.test.ts ══════════
{
  /** getContext reply / context.update 载荷形状（D1：字段缺失 = 无值）。 */
  interface CtxReply {
    sessionId: string
    inputTokens?: number
    contextLimit?: number
    usagePercent?: number
  }

  /** 在途 RPC 的受控 deferred（mock 发起时登记，测试按编排 resolve）。 */
  interface PendingRpc {
    sid: string
    resolve: (v: CtxReply) => void
    reject: (e: unknown) => void
  }

  let pendingRpcs: PendingRpc[] = []
  const mountedWrappers: VueWrapper[] = []

  /** mount 容量卡组件（挂载即触发恢复路径 getContext(sid)，在途受控）。 */
  function mountCard(sid: string): VueWrapper {
    const wrapper = mount(ContextCapacityCard, { props: { sessionId: sid } })
    mountedWrappers.push(wrapper)
    return wrapper
  }

  /**
   * 排空在途异步链：setTimeout(0) 是 macrotask，回调执行前所有已排队微任务（resolve →
   * applyReply 写分区 → Vue 调度 flush）全部跑完（与 use-context-usage.test.ts 同款）。
   */
  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()
  }

  /** resolve 指定 sid 的最早已登记在途 RPC（无则测试编排错误）。 */
  function resolveForSid(sid: string, reply: CtxReply): void {
    const idx = pendingRpcs.findIndex((e) => e.sid === sid)
    if (idx < 0) throw new Error(`测试编排错误：sid ${sid} 无在途 RPC`)
    const [entry] = pendingRpcs.splice(idx, 1)
    entry.resolve(reply)
  }

  /** 真实通道派发 context.update ok 帧（stateSnapshot 回放 / live 帧共用形态）。 */
  function pushOkFrame(sid: string, used: number, total: number, percent: number): void {
    events.dispatchSession(sid, {
      type: 'context.update',
      payload: { sessionId: sid, inputTokens: used, contextLimit: total, usagePercent: percent },
    })
  }

  /** 用户可见断言锚点：容量卡全文（used「{used}K」/ 使用率「{percent}%」/「—」）。 */
  function capacityText(wrapper: VueWrapper): string {
    return wrapper.text()
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    pendingRpcs = []
    getContextMock.mockReset()
    getContextMock.mockImplementation(
      (sid: string) =>
        new Promise<CtxReply>((resolve, reject) => {
          pendingRpcs.push({ sid, resolve, reject })
        }),
    )
    __clearSessionCleanupRegistryForTest()
    __clearInFlightContextFetchForTest()
  })

  afterEach(() => {
    while (mountedWrappers.length) mountedWrappers.pop()?.unmount()
  })

  describe('J1: 切走再切回——分区缓存无闪横线，恢复路径收敛新值（G1/G2/G3）', () => {
    it('A 真值 → B 无值 → 切回 A 显示缓存 → getContext resolve 后更新（父文档 A1+A7）', async () => {
      const wrapper = mountCard('A')
      await settle()
      // 首次拉取在途，分区 unknown → 「—」（无假数字）
      expect(capacityText(wrapper)).toContain('—')

      // A 的 stateSnapshot 回放 ok 帧 → 按钮显示 A 的用量（21000 → 21K，formatTokens 实际输出）
      pushOkFrame('A', 21000, 600000, 3.5)
      await settle()
      expect(capacityText(wrapper)).toContain('21K')
      expect(capacityText(wrapper)).toContain('3.5%')

      // A 首次拉取 resolve（与帧同值）：显示不变
      resolveForSid('A', { sessionId: 'A', inputTokens: 21000, contextLimit: 600000, usagePercent: 3.5 })
      await settle()
      expect(capacityText(wrapper)).toContain('21K')

      // 切到 B：B 的快照含无值占位帧 + reply 无值 → 「—」（合法无值诚实显示，G2）
      await wrapper.setProps({ sessionId: 'B' })
      await settle()
      events.dispatchSession('B', { type: 'context.update', payload: { sessionId: 'B' } })
      resolveForSid('B', { sessionId: 'B' })
      await settle()
      expect(capacityText(wrapper)).toContain('—')

      // 切回 A：RPC 往返期间即显示分区缓存值「21K · 3.5%」（无闪横线，G1）
      await wrapper.setProps({ sessionId: 'A' })
      await settle()
      expect(capacityText(wrapper)).toContain('21K')
      expect(capacityText(wrapper)).toContain('3.5%')

      // getContext(A) resolve 后台 turn 产生的新值（30000 → 30K，A7 无条件恢复路径）
      resolveForSid('A', { sessionId: 'A', inputTokens: 30000, contextLimit: 600000, usagePercent: 5 })
      await settle()
      expect(capacityText(wrapper)).toContain('30K')
      expect(capacityText(wrapper)).toContain('5%')

      // 恢复路径无条件触发：A 首次拉取 + A 切回重新拉取各一次（B 同理），非「有缓存不拉」
      const callsForA = getContextMock.mock.calls.filter((c) => c[0] === 'A')
      expect(callsForA).toHaveLength(2)
    })
  })

  describe('J2: 0 帧防御哨兵——全 0 残帧不清显示（D4 journey 级）', () => {
    it('A 视图下喂全 0 帧 → 显示不变 + 哨兵 warn', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const wrapper = mountCard('A')
      await settle()
      pushOkFrame('A', 21000, 600000, 3.5)
      await settle()
      expect(capacityText(wrapper)).toContain('21K')

      // 全 0 基线残帧（物理上不可能是真值）→ 哨兵丢弃，不把显示清成「—」
      events.dispatchSession('A', {
        type: 'context.update',
        payload: { sessionId: 'A', inputTokens: 0, contextLimit: 0, usagePercent: 0 },
      })
      await settle()
      expect(capacityText(wrapper)).toContain('21K')
      expect(capacityText(wrapper)).toContain('3.5%')
      expect(warnSpy).toHaveBeenCalledWith('[context-usage] dropping impossible all-zero frame', 'A')
      warnSpy.mockRestore()
    })
  })
}

// ══════════ 来源：block-working.test.ts ══════════
{
  /**
   * thinking 块现在走 MarkdownRenderer（W2），测试环境 stub 掉它避免依赖
   * shiki/markdown-it/useFileSearch 等。stub 渲染 content prop 文本即可验证展开/收起态。
   * tool 块不依赖 MarkdownRenderer，但统一 stub 无副作用。
   */
  const mdStub = {
    name: 'MarkdownRenderer',
    props: { content: { type: String, default: '' }, variant: { type: String, default: undefined } },
    setup(props: { content: string }) {
      return () => h('div', { class: 'stub-md-render' }, props.content)
    },
  }

  const LONG_THINKING = '这是一段很长的推理内容需要展开才能完整阅读'.repeat(3)

  function makeTool(over: Partial<ToolCall> = {}): ToolCall {
    return {
      id: 'tc-1',
      toolName: 'edit',
      input: { path: 'src/App.vue' },
      output: 'done',
      status: 'completed',
      startTime: Date.now(),
      ...over,
    }
  }

  /** thinking 块 mount 单源（working/collapsed 差异经参数；MarkdownRenderer 走 mdStub）。 */
  function mountThinkingBlock(over: { working?: boolean; collapsed?: boolean } = {}) {
    return mount(Block, {
      props: { type: 'thinking', content: LONG_THINKING, ...over },
      global: { provide: mockChatProvide(), stubs: { MarkdownRenderer: mdStub } },
    })
  }

  /** tool 块 mount 单源（tool 对象 + working 差异经参数）。 */
  function mountToolBlock(tool: ReturnType<typeof makeTool>, working: boolean) {
    return mount(Block, {
      props: { type: 'tool', tool, working },
      global: { provide: mockChatProvide() },
    })
  }

  /** tool header 行断言单源（N1 basename chip：工具名/basename 在文本，完整路径在 chip title 悬停）。 */
  function expectToolHeaderBasenames(wrapper: { text: () => string; find: (s: string) => { attributes: (a: string) => string | undefined } }) {
    expect(wrapper.text()).toContain('edit')
    expect(wrapper.text()).toContain('App.vue')
    expect(wrapper.find('[data-testid="tool-file-chip"]').attributes('title')).toBe('src/App.vue')
  }

  describe('Block working 态 · thinking 块', () => {
    it('U1: working=true → 内容在 header 行内联显示（plain text，非 .trace-think-body）', () => {
      const wrapper = mountThinkingBlock({ working: true })
      // streaming 进行中：内容在 header 行内联显示（截断预览），无独立 body div
      expect(wrapper.find('.stub-md-render').exists()).toBe(false)
      // 内容以截断形式出现在 header 行（previewText 截断到 60 字符）
      expect(wrapper.text()).toContain(LONG_THINKING.slice(0, 60))
      // 分隔点 · 常驻（M3b demo 复刻：demo 思考行运行/完成两态都是「思考(中) · <预览>」句式）
      expect(wrapper.text()).toContain('·')
    })

    it('U2: working=false → 仅预览行（截断 60 字符）', () => {
      const wrapper = mountThinkingBlock({ working: false, collapsed: true })
      // 展开态容器不存在 = 收起
      expect(wrapper.find('.stub-md-render').exists()).toBe(false)
      // 预览截断标志出现
      expect(wrapper.text()).toContain('…')
    })

    it('U3: working=true 点击 header 不切换折叠态（内容仍在 header 行内联）', async () => {
      const wrapper = mountThinkingBlock({ working: true })
      const header = wrapper.find('.cursor-pointer')
      expect(header.exists()).toBe(true)
      await header.trigger('click')
      // working 态点击无效：.trace-think-body 仍不存在，内容仍在 header 行内联
      expect(wrapper.find('.stub-md-render').exists()).toBe(false)
      expect(wrapper.text()).toContain(LONG_THINKING.slice(0, 60))
    })

    it('U4: working=false 点击 header 可 toggle', async () => {
      const wrapper = mount(Block, {
        props: { type: 'thinking', content: '短推理', working: false, collapsed: true },
        global: { provide: mockChatProvide(), stubs: { MarkdownRenderer: mdStub } },
      })
      const header = wrapper.find('.cursor-pointer')
      expect(wrapper.find('.stub-md-render').exists()).toBe(false) // 初始收起
      await header.trigger('click')
      expect(wrapper.find('.stub-md-render').exists()).toBe(true) // 展开后正文出现
      await header.trigger('click')
      expect(wrapper.find('.stub-md-render').exists()).toBe(false) // 再收起
    })
  })

  describe('Block working 态 · tool 块', () => {
    it('U5: working=true completed 默认 1 行收起（header 含 toolName+argPath，详情点击展开）', () => {
      const wrapper = mountToolBlock(makeTool({ status: 'completed' }), true)
      // header 行含工具名 + 参数路径（N1 basename chip：文本=basename，完整路径在 chip title 悬停）
      expectToolHeaderBasenames(wrapper)
      // 详情区 output 默认收起（不在 DOM）
      expect(wrapper.text()).not.toContain('done')
      // 点击展开
      const header = wrapper.find('.cursor-pointer')
      return header.trigger('click').then(() => {
        expect(wrapper.text()).toContain('done')
      })
    })

    it('U6: working=false completed 默认收起，点击展开', async () => {
      const wrapper = mountToolBlock(makeTool({ status: 'completed' }), false)
      // 初始收起：output 不在 DOM
      expect(wrapper.text()).not.toContain('done')
      const header = wrapper.find('.cursor-pointer')
      await header.trigger('click')
      // 展开后 output 出现
      expect(wrapper.text()).toContain('done')
    })

    it('U7: working=false running 默认 1 行收起，header 含专属动效图标（RunningBlockIcon）', () => {
      const wrapper = mountToolBlock(makeTool({ status: 'running', output: undefined }), false)
      // header 行含工具名 + 参数（N1 basename chip）+ 专属动效图标（1 行即可观察进度）
      expectToolHeaderBasenames(wrapper)
      // running 态专属动效图标（RunningBlockIcon，不再用全类型共用 loader），无旧脉冲点
      expect(wrapper.find('[data-running-icon]').exists()).toBe(true)
      expect(wrapper.find('.animate-working-pulse').exists()).toBe(false)
      // 详情区默认收起（running 不再强制展开）
      // output undefined 不会渲染 result 区，验证 argPath 详情行不在 DOM（mt-1.font-mono 是展开体）
      const detailLines = wrapper.findAll('.mt-1.font-mono')
      expect(detailLines.length).toBe(0)
    })

    it('U8: 失败 tool 终态挂载默认展开（error-visibility M1 §3.3.1 选项 A），点击可收起（Demo H：无鲜红框，AlertTriangle ICON）', async () => {
      const wrapper = mountToolBlock(makeTool({ status: 'error', output: 'command failed' }), false)
      // Demo H：鲜红框已删（无 border-danger / bg-danger-soft）
      expect(wrapper.find('.border-danger').exists()).toBe(false)
      expect(wrapper.find('.bg-danger-soft').exists()).toBe(false)
      // header 含 svg 图标（AlertTriangle ICON，lucide 渲染为 svg）
      const alertIcon = wrapper.find('[data-lucide="alert-triangle"], svg')
      expect(alertIcon.exists()).toBe(true)
      // 584869378（error-visibility M1）：failed 终态挂载默认展开，错误输出立即可见
      expect(wrapper.text()).toContain('command failed')
      // 手动点击可收起
      const header = wrapper.find('.cursor-pointer')
      await header.trigger('click')
      expect(wrapper.text()).not.toContain('command failed')
    })
  })

  describe('Block working 态 · end_not_received（未收到结果）', () => {
    it('U12: end_not_received header 显工具名（subtle 色），不走红框，不强制展开', () => {
      const wrapper = mountToolBlock(makeTool({ status: 'end_not_received', output: undefined }), false)
      // header 含工具名 + 参数路径（N1 basename chip：文本=basename，完整路径在 chip title 悬停）
      expectToolHeaderBasenames(wrapper)
      // 不走红框（border-danger 不存在）
      expect(wrapper.find('.border-danger').exists()).toBe(false)
      // 详情区默认收起（mt-1.font-mono 是展开体，end_not_received 不强制展开）
      const detailLines = wrapper.findAll('.mt-1.font-mono')
      expect(detailLines.length).toBe(0)
    })

    it('U13: end_not_received 初始收起，点击 header 可 toggle（不像 running 锁死）', async () => {
      // 给 output + endTime 让展开体有内容可验证 toggle（W3 重构后展开体无重复 toolName 行，
      // 改用 result 文本的可见性验证展开/收起，比依赖具体展开体结构更稳定）
      const wrapper = mount(Block, {
        props: {
          type: 'tool',
          tool: makeTool({ status: 'end_not_received', output: 'partial output', startTime: 1000, endTime: 2000 }),
          working: false,
        },
        global: { provide: mockChatProvide() },
      })
      const header = wrapper.find('.cursor-pointer')
      // 初始收起：output 不在 DOM
      expect(header.exists()).toBe(true)
      expect(wrapper.text()).not.toContain('partial output')
      await header.trigger('click')
      // 展开后 output 出现
      expect(wrapper.text()).toContain('partial output')
      await header.trigger('click')
      // 收起后 output 消失
      expect(wrapper.text()).not.toContain('partial output')
    })
  })
}
