import { expectLandingShellDom, composerApiModule, composerChatApiSpy } from '@/__tests__/helpers/composer-mount';
import { makeSkillsReloadTransportStub, skillCacheInvalidatedBridge } from '@/__tests__/helpers/settings-transport-stub';
import Composer from '@/components/panel/Composer.vue';
import { buildStreamViewItems } from '@/components/panel/message-stream/stream-view-items';
import type { SkillNoticeEntry, SkillNoticeStreamItem } from '@/composables/panel/useSkillNoticeStream';
import { provideSettingsTransport } from '@taiji/core';
import type { MessageTurn } from '@taiji/core/domain/chat';
import * as events from '@taiji/core/transport/api';
import type { ServerMessage, SkillInfo, Message } from '@taiji/shared';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defineComponent, nextTick, type DeepReadonly } from 'vue';

// wave3 簇 [renderer/happy-dom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/panel/composer-landing-skill-reload.test.ts
 * - components/panel/message-stream/__tests__/stream-view-items.test.ts
 */

// ======================================================================
// ← __tests__/panel/composer-landing-skill-reload.test.ts
// ======================================================================

// ── getGlobalSkills 可控 mock（hoisted：vi.mock 工厂早于 import 求值）──
// TC5-Composer 中途改返回值模拟 runtime 重扫 globalCache 后缓存更新。
const getGlobalSkillsMock = vi.hoisted(() => vi.fn().mockResolvedValue([]))

// ── onSkillCacheInvalidated 接真实 events.onGlobalType：让 dispatchGlobal 广播能端到端触达
// useGlobalSkills 的订阅回调（loadGlobal(true) force 重新拉取）。这是「真实订阅链路」验证的关键。
// api 骨架单源 helpers/composer-mount.ts；config 域换受控 getGlobalSkills + events 桥。
vi.mock('@/api', async () => {
  const realEvents = await import('@taiji/core/transport/api')
  const api = composerApiModule()
  return {
    ...api,
    config: { ...api.config, getGlobalSkills: getGlobalSkillsMock, onSkillCacheInvalidated: skillCacheInvalidatedBridge(realEvents) },
  }
})

// ── mock useChat（spy 化，landing 首发不应触发 send；composerChatApiSpy 单例转发，
//    断言直接引用同一批 vi.fn）──
vi.mock('@/composables/features/chat/useChat', () => ({ useChat: () => composerChatApiSpy }))

// ── mock useNewTaskFlow：currentCwd=null（真 ref）使 useProjectSkills 早退不 RPC，聚焦 global 链路 ──
vi.mock('@/composables/features/new-task/useNewTaskFlow', async () => {
  const { ref } = await import('vue')
  return {
    useNewTaskFlow: () => ({
      submitFirstMessage: vi.fn(() => Promise.resolve()),
      currentModel: { value: null },
      setPendingModel: vi.fn(),
      // currentCwd 必须是真 ref：Composer.vue line 191 传给 useProjectSkills，其内部 watch(currentCwd)
      // 要求 watch source 是 ref/getter。null cwd 使 useProjectSkills 早退（不 RPC）。
      currentCwd: ref(null),
      // landing 态 launchConfigView 解析消费（model-thinking 单一解析层输入）
      pendingPreset: ref(null),
    }),
    resetNewTaskFlow: vi.fn(),
  }
})
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))

// ── ComposerInput mock：渲染 data-testid="composer-input"（AGENTS.md 冒烟模板 + 01-chat-panel-composer spec（demo） §2（Composer）§3
//    改进建议；真实 ComposerInput.vue 暂无此 testid，按既有 Composer-mount 测试惯例注入）+ emit
//    slash-trigger 开 slash 浮层。expose Composer.vue 需要的 instance 方法（clear/setText/insertSlashChip/
//    getSegments/moveCaretVertical/getText）。──
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  emits: ['input', 'keydown', 'slash-trigger', 'file-trigger'],
  setup(_, { expose }) {
    expose({
      clear: vi.fn(),
      setText: vi.fn(),
      insertSlashChip: vi.fn(),
      getSegments: () => [],
      getText: () => '',
      moveCaretVertical: () => 'noop' as const,
    })
    return {}
  },
  template: '<div data-testid="composer-input" />',
})

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
// 注意：CommandPopover 不在 stubs 中——保留真实组件，验证 skill 列表 DOM 刷新（本用例核心）。
// 其余非浮层子组件 stub，降低 mount noise。
const otherStubs = {
  ComposerInput: ComposerInputMock,
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

beforeEach(async () => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 默认空数组；TC5-Composer 用例内覆盖为具体 skill 列表
  getGlobalSkillsMock.mockResolvedValue([])
  // [C3] 打 seam：getGlobalSkills 可控 mock + onSkillCacheInvalidated 桥真实 events
  //（桥实现单源 helpers/settings-transport-stub.ts——广播端到端触达 useGlobalSkills 订阅）
  provideSettingsTransport(await makeSkillsReloadTransportStub(getGlobalSkillsMock))
  // 清 body（reka-ui Popover portal 到 body，跨用例残留会污染断言）
  document.body.innerHTML = ''
})

/** reka-ui PopoverContent portal 到 body：在 body 内找命令项行（v-for 渲染为 .pop-item div）。
 *  按 item 列表容器（.max-h-[180px]）定位——**不回退到 document.body**：mount Composer 时工具栏
 *  也会渲染 Button（发送位等 svg-only 按钮文案为空），回退会误抓工具栏按钮污染断言。列表未渲染
 *  （items.length===0）时返回 []，让 vi.waitFor 继续轮询直到 skill 加载、列表出现。
 *  行 = 纯 div（demo .pop-item 行），选择器 '.pop-item'。 */
function bodyItemButtons(): HTMLElement[] {
  const list = document.body.querySelector('.max-h-\\[180px\\]')
  if (!list) return []
  return Array.from(list.querySelectorAll('.pop-item'))
}

describe('Composer.vue landing 态 skill reload 集成（PR#123 reviewer-D WARNING-2/3）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  /** mount 真实 Composer.vue（landing 态：variant=landing + sessionId=null，对齐 Landing.vue 的 composerSid 真实态）。 */
  async function mountLandingComposer(): Promise<ReturnType<typeof mount>> {
    const w = mount(Composer, {
      attachTo: document.body,
      props: { sessionId: null, variant: 'landing' },
      global: { stubs: otherStubs },
    })
    await flushPromises()
    await nextTick()
    return w
  }

  /** 触发输入区 slash-trigger 事件 → Composer.onSlashTrigger → cmdOpen=true 打开 CommandPopover slash 浮层。 */
  async function openSlashPopover(w: ReturnType<typeof mount>): Promise<void> {
    w.findComponent(ComposerInputMock).vm.$emit('slash-trigger', { query: '' })
    await flushPromises()
    await nextTick()
  }

  // ── 用例声明顺序约定（singleton 隔离）──
  // useGlobalSkills 是模块级 singleton（globalSkillsCache / globalLoaded / globalInvalidateSubscribed 跨
  // 用例共享）。TC5-Composer 必须是首个 mount Composer 的用例，拿到干净的 singleton 完成首次拉取 +
  // force reload 验证（首次拉取 SKILL_A → 广播 force 重新拉取 SKILL_A_B）。首屏冒烟用例不检查 skill 列表内容
  // （只断言 composer-box / composer-input testid 存在），对 singleton 状态不敏感，故放后面无副作用。
  // 与 command-popover-landing.test.ts 同范式（依赖文件级首次拉取拿到干净 singleton）。

  // ── WARNING-2：mount 文档入口 Composer.vue，验证 skill reload 生产连线（AGENTS.md #6 MANDATORY）──
  // 端到端链路：dispatchGlobal {scope:'global'} → useGlobalSkills 订阅回调（Composer.vue line 192 真实
  // 调用）→ loadGlobal(true) force 重新拉取 → landingGlobalSkills ref 刷新 → :global-skills prop 透传 →
  // CommandPopover DOM 反映新 skill 列表。若 Composer.vue 删了 useGlobalSkills 调用或改了 prop 传递，
  // 本用例红（区别于 command-popover-landing.test.ts TC5 的 GlobalSkillsHarness 复制品）。
  it('TC5-Composer: mount Composer.vue → dispatchGlobal skillCacheInvalidated → CommandPopover DOM 反映 globalSkills 刷新（文档入口集成）', async () => {
    const SKILL_A: SkillInfo[] = [
      { id: 'sk-a', name: 'skill-a', description: 'alpha', enabled: true, source: 'agents', effective: true },
    ]
    const SKILL_A_B: SkillInfo[] = [
      { id: 'sk-a', name: 'skill-a', description: 'alpha', enabled: true, source: 'agents', effective: true },
      { id: 'sk-b', name: 'skill-b', description: 'beta', enabled: true, source: 'agents', effective: true },
    ]

    // 初始 getGlobalSkills resolve([skill-a]) → useGlobalSkills 首次拉取缓存 skill-a
    getGlobalSkillsMock.mockResolvedValue(SKILL_A)
    wrapper = await mountLandingComposer()
    await openSlashPopover(wrapper)

    // 浮层应显示 skill-a（1 项）
    await vi.waitFor(() => {
      const btns = bodyItemButtons()
      expect(btns).toHaveLength(1)
      expect(btns[0].textContent).toContain('skill-a')
    }, { interval: 1 })

    // mock 改返回 [skill-a, skill-b]（模拟 runtime 重扫 globalCache 后缓存更新）
    getGlobalSkillsMock.mockResolvedValue(SKILL_A_B)
    // 派发 global scope 失效信号 → Composer.vue line 192 的 useGlobalSkills 订阅回调 → loadGlobal(true)
    // force 重新拉取 → landingGlobalSkills ref 刷新 → :global-skills prop 更新 → CommandPopover DOM 刷新
    events.dispatchGlobal({
      type: 'config.skillCacheInvalidated',
      payload: { scope: 'global' },
    } as ServerMessage<'config.skillCacheInvalidated'>)

    // 浮层现在应显示 skill-a + skill-b（2 项，DOM 文案反映刷新）
    await vi.waitFor(() => {
      const btns = bodyItemButtons()
      expect(btns).toHaveLength(2)
      expect(btns.some((b) => b.textContent?.includes('skill-a'))).toBe(true)
      expect(btns.some((b) => b.textContent?.includes('skill-b'))).toBe(true)
    }, { interval: 1 })

    // 反向断言：landing 首发未被触发（仅验证 skill 刷新，不应误发消息）
    expect(composerChatApiSpy.send).not.toHaveBeenCalled()
  })

  // ── WARNING-3：首屏冒烟 gate（AGENTS.md 行 415-423 MANDATORY 模板）──
  // 防「77 单测全绿但 Landing 态无 composer 输入区」事故重演：mount 真实 Composer.vue landing 态，
  // 断言 composer 输入区 + composer-box 容器存在于 DOM。放 TC5-Composer 之后（singleton 已被首用例
  // 拉取填充 SKILL_A_B，但本用例不检查 skill 内容，不受影响）。
  it('首屏冒烟：Landing 态 Composer DOM 含 composer 输入区 + composer-box（AGENTS.md MANDATORY 渲染 gate）', async () => {
    wrapper = await mountLandingComposer()
    expectLandingShellDom(wrapper)
  })
})

// ======================================================================
// ← components/panel/message-stream/__tests__/stream-view-items.test.ts
// ======================================================================

function makeUserMsg(id: string, content: string): Message {
  return { id, role: 'user', content, status: 'complete', timestamp: 0 } as Message
}

function turnFixture(index: number, userId: string, content: string, over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    index,
    user: makeUserMsg(userId, content),
    assistants: [],
    isStreaming: false,
    ...over,
  } as MessageTurn
}

function turnItem(turn: MessageTurn): SkillNoticeStreamItem {
  return { kind: 'turn', turn }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildStreamViewItems — 逐项恒等缓存（streaming perf）', () => {
  it('同输入二次构建：同数组引用 + 同 view item 对象引用（缓存命中，preview 不重算）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const items = [
      turnItem(turnFixture(0, 'u1', 'first question')),
      turnItem(turnFixture(1, 'u2', 'second question')),
    ]
    const first = buildStreamViewItems(items, 1, items[1]!.turn)
    const second = buildStreamViewItems(items, 1, items[1]!.turn)

    expect(second).toBe(first)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    // 内容仍逐字节正确（引用复用不改变派生视图值）
    expect(second[1]).toMatchObject({ kind: 'turn', key: 't-u2', preview: 'second question', canEdit: true, isLastTurn: true })
  })

  it('streaming 末位 turn 引用替换（同内容新对象）：仅末位重建，历史项对象引用逐位复用', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const historyTurn = turnFixture(0, 'u1', 'history question')
    const lastTurn = turnFixture(1, 'u2', 'streaming question')
    const items = [turnItem(historyTurn), turnItem(lastTurn)]
    const first = buildStreamViewItems(items, 1, lastTurn)

    // 模拟 toRenderItemsIncremental 每 delta 重建末位 turn（新对象，同内容）
    const rebuiltLast = turnFixture(1, 'u2', 'streaming question')
    const second = buildStreamViewItems([turnItem(historyTurn), turnItem(rebuiltLast)], 1, rebuiltLast)

    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0]) // 历史项复用（preview 不重算的核心收益）
    expect(second[1]).not.toBe(first[1]) // 末位重建
    expect(second[1]).toMatchObject({ key: 't-u2', preview: 'streaming question', isLastTurn: true })
  })

  it('lastRenderTurn 变化（isLastTurn 翻转）→ 只重建受影响项，其余项对象引用复用', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const turnA = turnFixture(0, 'u1', 'a')
    const turnB = turnFixture(1, 'u2', 'b')
    const items = [turnItem(turnA), turnItem(turnB)]
    const first = buildStreamViewItems(items, 1, turnB)
    expect(first[1]).toMatchObject({ isLastTurn: true })

    // 末位判定目标换成不在 items 里的 turn：turnB 的 isLastTurn true → false（重建），
    // turnA 仍 false（显式比对通过 → 复用）
    const outsider = turnFixture(9, 'u9', 'later')
    const second = buildStreamViewItems(items, 1, outsider)

    expect(second).not.toBe(first)
    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
    expect(second[1]).toMatchObject({ isLastTurn: false })
  })

  it('尾部 append（长度变化）→ 新增位重建，派生字段未变的既有位引用复用', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const turnA = turnFixture(0, 'u1', 'a')
    const items = [turnItem(turnA)]
    // 首帧 lastUserTurnIdx=-1 / lastRenderTurn=null：turnA 的 canEdit/isLastTurn 均为 false
    const first = buildStreamViewItems(items, -1, null)

    // append 后 turnA 的派生字段不变（lastUserTurnIdx=1 不落 turnA，末位是 turnB）→ 复用
    const turnB = turnFixture(1, 'u2', 'b')
    const second = buildStreamViewItems([turnItem(turnA), turnItem(turnB)], 1, turnB)

    expect(second).toHaveLength(2)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toMatchObject({ kind: 'turn', key: 't-u2', canEdit: true })
  })

  it('broken 项不缓存复用：同位置下一帧重试正常构建（瞬时故障不固化）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const brokenItems = [{ kind: 'turn', turn: undefined } as unknown as SkillNoticeStreamItem]
    const first = buildStreamViewItems(brokenItems, -1, null)
    expect(first[0]).toMatchObject({ kind: 'broken', key: 'broken-0' })

    // 数据修复（同位置换成可正常求值的项）→ 重新构建成功，不固化 broken
    const okTurn = turnFixture(0, 'u1', 'recovered')
    const second = buildStreamViewItems([turnItem(okTurn)], -1, okTurn)
    expect(second[0]).toMatchObject({ kind: 'turn', key: 't-u1' })

    // broken 位置维持 broken 输入 → 每帧重试（warn 逐帧记录，与旧行为一致）
    buildStreamViewItems(brokenItems, -1, null)
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  it('[索引一致性硬约束] 各形态下返回数组与入参 1:1（同长度同顺序，broken 占位不删位）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const okTurn = turnFixture(0, 'u1', 'ok')
    const items = [
      { kind: 'turn', turn: undefined } as unknown as SkillNoticeStreamItem,
      turnItem(okTurn),
      { kind: 'bashExecution', message: makeUserMsg('b1', 'bash line') } as unknown as SkillNoticeStreamItem,
      { kind: 'systemNotice', message: makeUserMsg('s1', 'system line') } as unknown as SkillNoticeStreamItem,
    ]
    const views = buildStreamViewItems(items, 1, okTurn)
    expect(views).toHaveLength(items.length)
    expect(views.map((v) => v.key)).toEqual(['broken-0', 't-u1', 's-b1', 's-s1'])
  })

  it('skillNotice 项按 entry 引用恒等复用', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entry = { id: 'n-sig', reason: 'skill_missing', skills: ['a', 'b'] } as DeepReadonly<SkillNoticeEntry>
    const item: SkillNoticeStreamItem = { kind: 'skillNotice', entry }
    const first = buildStreamViewItems([item], -1, null)
    const second = buildStreamViewItems([item], -1, null)
    expect(second[0]).toBe(first[0])
    expect(first[0]).toMatchObject({ kind: 'skillNotice', key: 'n-sig', preview: 'a, b' })
  })

  it('空输入不返回旧缓存：非空构建后切空数组 → 空结果（防跨会话渲染项串台）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // session A：非空渲染项进入模块级单槽缓存
    const turnA = turnFixture(0, 'u1', 'session a content')
    const noticeA = { kind: 'systemNotice', message: makeUserMsg('s-a', 'session a notice') } as unknown as SkillNoticeStreamItem
    const viewsA = buildStreamViewItems([turnItem(turnA), noticeA], 0, turnA)
    expect(viewsA).toHaveLength(2)

    // session B：空输入（无消息的新会话）→ 必须返回空数组，禁止 0===0 误判复用 A 的结果
    const viewsB = buildStreamViewItems([], -1, null)
    expect(viewsB).toHaveLength(0)

    // 空输入后重建非空：缓存已随空输入覆盖，新会话内容正确构建
    const turnB = turnFixture(0, 'u2', 'session b content')
    const viewsC = buildStreamViewItems([turnItem(turnB)], 0, turnB)
    expect(viewsC).toHaveLength(1)
    expect(viewsC[0]).toMatchObject({ kind: 'turn', key: 't-u2', preview: 'session b content' })
  })
})
