/**
 * composables/panel mock 域合并产物（round 6 renderer 测试压缩）：五文件同产物。
 *
 * 并入来源（基名）：
 *  - useLoadMoreHistory（慢网细线 + 防重入，12 例）
 *  - useSessionRespawnRetry（respawn 重试链，2 例；toastErrorMock 别名指共享 toastMock.error）
 *  - use-queue-edit-anchor（队列编辑锚定 + delivery RPC，17 例）
 *  - composer-shell-model-toast（壳层模型切换 toast，4 例；composer-mount 单源骨架）
 *  - composer-keydown（键盘路由 + open-fetch，43 例；原 colocated 于
 *    composables/panel/ 根，'./composer-keydown' './composer-shell' 已改 '../'）
 *
 * mock 注册与互斥核查（五源归一）：
 *  - '@/composables/features/chat/useChat'：shell-model 的 composerChatModule 七键与
 *    loadMoreHistory 的 {loadMoreHistory, hasMoreHistory} → 统一为七键 + 两键并集
 *    （chatApiMock hoisted，多余键对各消费方无害）。
 *  - '@/api'：shell-model 的 composerApiModule 五组 / respawn 的 session.restoreSession /
 *    keydown 的 session.getCommands → 统一 composerApiModule + session 三成员并集。
 *  - '@/stores/session'：shell-model 的 composerSessionStoreModule 与 respawn 的
 *    {revive} → 统一四键并集（active/list/applySnapshot + revive）。
 *  - '@/composables/useToast'：三源 {error[,info,warning]} → 统一共享 toastMock；
 *    respawn 节内以 `const toastErrorMock = toastMock.error` 别名承接原断言引用。
 *  - '@/api/domains/delivery'（queue-anchor 独占）、'@taiji/core/transport/api/domains/composer'
 *    （keydown 独占 partial）、'@taiji/core/domain/composer'（shell-model 独占 partial，
 *    startQueueEdit 等真实成员经 spread actual 保留——queue-edit 纯函数族在
 *    composables-panel-pure-bundle 已覆盖）、'@/stores/chat'（shell-model）、
 *    useNewTaskFlow（shell-model）各自独占，无互斥。
 *  - 各文件级 beforeEach/enableAutoUnmount 已随正文包进各自 describe（mock 重置语义保留）。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/composables/panel/__tests__/composables-panel-mock-bundle.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises, enableAutoUnmount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { getDeliveryProjectionRef } from '@taiji/core'
import { composerApiModule, composerChatStoreModule, composerFlowModule } from '@/__tests__/helpers/composer-mount'
import { useQueueEditAnchor, type QueueEditAnchorDeps } from '@/composables/panel/useQueueEditAnchor'
import { useComposerShell, type ComposerShellParams, type ComposerShellReturn } from '@/composables/panel/composer-shell'
import { useLoadMoreHistory, TOP_AUTO_LOAD_THRESHOLD_PX, SLOW_LINE_DELAY_MS } from '../useLoadMoreHistory'
import { useSessionRespawnRetry } from '../useSessionRespawnRetry'
import { useComposerKeydown, type ComposerKeydownDeps } from '../composer-keydown'
import type { ShellInputInstance } from '../composer-shell'
import CommandPopover from '@/components/panel/CommandPopover.vue'
import type { ProviderId, DeliveryFrameEntry, Segment } from '@taiji/shared'
import type { StagingAction } from '@taiji/core/domain/composer'

// enableAutoUnmount 全模块仅可注册一次（@vue/test-utils 单例约束）：queue-anchor 与
// shell-model 两节原各自的文件级注册合并为本顶层一次（对全部节生效，节内 afterEach 语义不变）
enableAutoUnmount(afterEach)

// ── loadMoreHistory 节可控 mock（useChat 并集工厂成员）──
const { loadMoreHistoryMock, hasMoreRef } = vi.hoisted(() => ({
  loadMoreHistoryMock: vi.fn<() => Promise<boolean>>(),
  hasMoreRef: { value: true },
}))
// ── shell-model 节 useChat 七键面（与 loadMore 两键并集进统一工厂）──
const chatApiMock = vi.hoisted(() => ({
  send: vi.fn(),
  steer: vi.fn(),
  followUp: vi.fn(),
  abort: vi.fn(),
  compact: vi.fn(),
  editAndResend: vi.fn(),
  hydrateHistory: vi.fn(),
}))
// ── respawn 节可控 mock（restoreSession 经 '@/api' 统一工厂转发）──
const { restoreSessionMock, reviveMock } = vi.hoisted(() => ({
  restoreSessionMock: vi.fn<(id: string) => Promise<unknown>>(),
  reviveMock: vi.fn<(id: string) => void>(),
}))
// ── 共享 toast spy（三源 {error[,info,warning]} 并集；respawn 节内别名 toastErrorMock）──
const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toastMock }))
// ── queue-anchor 节 delivery RPC 可控注入 ──
const deliveryMock = vi.hoisted(() => ({
  peekDelivery: vi.fn((_sid: string, _clientUuid: string) => Promise.resolve({ found: false })),
  editDelivery: vi.fn((_sid: string, _clientUuid: string, _prompt: string) =>
    Promise.resolve({ clientUuid: _clientUuid, edited: true }),
  ),
}))
vi.mock('@/api/domains/delivery', () => ({ delivery: deliveryMock }))
// ── keydown 节 open-fetch 隔离（partial：其余成员保真）──
const getFileCandidatesByCwdMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/composer')>()
  return {
    ...actual,
    getFileCandidatesByCwd: (...args: unknown[]) => getFileCandidatesByCwdMock(...args),
  }
})
// ── shell-model 节 useComposerModelThinking 可控注入（reject 源；其余导出清单保持实装）──
const modelThinking = vi.hoisted(() => ({
  onModelSelect: vi.fn((_payload: { modelId: string; provider: ProviderId }) => Promise.resolve()),
  onThinkingSelect: vi.fn((_level: string) => Promise.resolve()),
}))
vi.mock('@taiji/core/domain/composer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { ref } = await import('vue')
  return {
    ...actual,
    useComposerModelThinking: () => ({
      currentModelId: ref('prov/a'),
      currentThinkingLevel: ref('medium'),
      currentThinkingLevelMap: ref<string | undefined>(undefined),
      currentSupportedLevels: ref<string[] | undefined>(undefined),
      localThinkingLevel: ref<string | undefined>(undefined),
      switching: ref<unknown>(null),
      onModelSelect: modelThinking.onModelSelect,
      onThinkingSelect: modelThinking.onThinkingSelect,
      enterStagingMode: vi.fn(),
      exitStagingMode: vi.fn(),
      getStagingConfig: vi.fn(() => null),
    }),
  }
})
// ── useChat 统一工厂（七键 + loadMoreHistory 两键并集）──
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    ...chatApiMock,
    loadMoreHistory: loadMoreHistoryMock,
    hasMoreHistory: () => hasMoreRef.value,
  }),
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => composerFlowModule())
// ── '@/api' 统一工厂：composerApiModule 五组 + session 域三成员并集 ──
vi.mock('@/api', () => {
  const api = composerApiModule()
  return {
    ...api,
    session: {
      ...api.session,
      // keydown 节：CommandPopover 内 useCommandSync 挂载即拉
      getCommands: vi.fn().mockResolvedValue({ sessionId: '', commands: [] }),
      // respawn 节：restoreSession RPC 可控
      restoreSession: (id: string) => restoreSessionMock(id),
    },
  }
})
vi.mock('@/stores/chat', () => composerChatStoreModule())
// ── '@/stores/session' 统一工厂：composerSessionStoreModule + revive 并集 ──
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn(), revive: reviveMock }),
}))

// ═══════════ 来源节：useLoadMoreHistory ═══════════

describe('useLoadMoreHistory', () => {
/** 可控 resolve 的 deferred（验证加载中防重入 + isPrepend 生命周期）。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function setup(): ReturnType<typeof useLoadMoreHistory> {
  const sessionId = ref('s1')
  return useLoadMoreHistory(() => sessionId.value)
}

describe('onScrollOffset（触顶自动续载）', () => {
  beforeEach(() => {
    loadMoreHistoryMock.mockReset()
    loadMoreHistoryMock.mockResolvedValue(true)
    hasMoreRef.value = true
  })

  it('触顶 + 已脱离锚定 → 自动加载一页', () => {
    const loadMore = setup()
    loadMore.onScrollOffset(0, true)
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(1)
    expect(loadMoreHistoryMock).toHaveBeenCalledWith('s1')
  })

  it('阈值边界：≤ 阈值触发、> 阈值不触发', () => {
    const loadMore = setup()
    loadMore.onScrollOffset(TOP_AUTO_LOAD_THRESHOLD_PX, true)
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(1)
    loadMore.onScrollOffset(TOP_AUTO_LOAD_THRESHOLD_PX + 1, true)
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(1)
  })

  it('未脱离锚定（贴底 / session 切换回声）不触发', () => {
    const loadMore = setup()
    loadMore.onScrollOffset(0, false)
    expect(loadMoreHistoryMock).not.toHaveBeenCalled()
  })

  it('无更早历史（truncated=false）不触发', () => {
    hasMoreRef.value = false
    const loadMore = setup()
    loadMore.onScrollOffset(0, true)
    expect(loadMoreHistoryMock).not.toHaveBeenCalled()
  })

  it('加载中不重入（同一检查源），完成后可再次触发', async () => {
    const d = deferred()
    loadMoreHistoryMock.mockReturnValueOnce(d.promise)
    const loadMore = setup()

    loadMore.onScrollOffset(0, true)
    loadMore.onScrollOffset(0, true)
    loadMore.onScrollOffset(10, true)
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(1)

    d.resolve()
    await d.promise
    await Promise.resolve() // 让 handleLoadMore 的 finally 落地
    loadMore.onScrollOffset(0, true)
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(2)
  })
})

describe('slowLine（慢网兜底细线，OpenDesign spec §2.2）', () => {
  beforeEach(() => {
    loadMoreHistoryMock.mockReset()
    loadMoreHistoryMock.mockResolvedValue(true)
    hasMoreRef.value = true
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('快载（<150ms 完成）全程不显示细线（零指示防闪烁）', async () => {
    const loadMore = setup()
    await loadMore.handleLoadMore()
    vi.advanceTimersByTime(SLOW_LINE_DELAY_MS + 200)
    expect(loadMore.slowLine.value).toBe(false)
  })

  it('慢载（>150ms 未完成）显示细线；完成后立即复位（160ms 淡出由 CSS 承担）', async () => {
    const d = deferred()
    loadMoreHistoryMock.mockReturnValueOnce(d.promise)
    const loadMore = setup()

    void loadMore.handleLoadMore()
    vi.advanceTimersByTime(SLOW_LINE_DELAY_MS - 1)
    expect(loadMore.slowLine.value).toBe(false)
    vi.advanceTimersByTime(1)
    expect(loadMore.slowLine.value).toBe(true)

    d.resolve()
    await d.promise
    await Promise.resolve() // 让 handleLoadMore 的 finally 落地
    expect(loadMore.slowLine.value).toBe(false)
  })

  it('加载失败同样收敛细线（失败态由 loadMoreError 错误行显形，细线不残留）', async () => {
    loadMoreHistoryMock.mockResolvedValueOnce(false)
    const loadMore = setup()

    void loadMore.handleLoadMore()
    vi.advanceTimersByTime(SLOW_LINE_DELAY_MS + 1)
    expect(loadMore.slowLine.value).toBe(true)

    await Promise.resolve() // 加载 promise 链落地
    await Promise.resolve() // handleLoadMore 的 await nextTick + finally 落地
    expect(loadMore.slowLine.value).toBe(false)
    expect(loadMore.loadMoreError.value).toBe(true)
  })

  it('切 session 分区隔离：新会话不为在途加载背书，迟到收敛写回原分区（ADR-0049）', async () => {
    const d = deferred()
    loadMoreHistoryMock.mockReturnValueOnce(d.promise)
    const sessionId = ref('s1')
    const loadMore = useLoadMoreHistory(() => sessionId.value)

    void loadMore.handleLoadMore()
    vi.advanceTimersByTime(SLOW_LINE_DELAY_MS + 1)
    expect(loadMore.slowLine.value).toBe(true)

    // 切 sid：消费方 computed 读新分区（全新态）——s1 的在途加载与细线对 s2 不可见
    sessionId.value = 's2'
    await nextTick()
    expect(loadMore.slowLine.value).toBe(false)

    d.resolve()
    await d.promise
    await Promise.resolve() // handleLoadMore 的 finally（updateFor('s1')）落地
    // 迟到收敛写回 s1 分区：s2 视图仍干净
    expect(loadMore.slowLine.value).toBe(false)

    // 切回 s1：分区已被迟到收敛复位（无细线残留）
    sessionId.value = 's1'
    await nextTick()
    expect(loadMore.slowLine.value).toBe(false)
  })
})

describe('handleLoadMore（载荷与 isPrepend 生命周期）', () => {
  beforeEach(() => {
    loadMoreHistoryMock.mockReset()
    loadMoreHistoryMock.mockResolvedValue(true)
    hasMoreRef.value = true
  })

  it('加载期间 isPrepend=true（virtua :shift 保位），完成后回落 false', async () => {
    const d = deferred()
    loadMoreHistoryMock.mockReturnValueOnce(d.promise)
    const loadMore = setup()

    loadMore.onScrollOffset(0, true)
    expect(loadMore.isPrepend.value).toBe(true)
    expect(loadMore.loadingMore.value).toBe(true)

    d.resolve()
    await d.promise
    await Promise.resolve()
    expect(loadMore.isPrepend.value).toBe(false)
    expect(loadMore.loadingMore.value).toBe(false)
  })

  it('手动点击（按钮兜底路径）与自动续载共用同一加载通路', async () => {
    const loadMore = setup()
    await loadMore.handleLoadMore()
    expect(loadMoreHistoryMock).toHaveBeenCalledTimes(1)
    expect(loadMoreHistoryMock).toHaveBeenCalledWith('s1')
  })

  it('失败态按分区归属：切走再切回仍见本 session 的失败行，不跨 session 泄漏（ADR-0049）', async () => {
    loadMoreHistoryMock.mockResolvedValueOnce(false)
    const sessionId = ref('s1')
    const loadMore = useLoadMoreHistory(() => sessionId.value)

    await loadMore.handleLoadMore()
    expect(loadMore.loadMoreError.value).toBe(true)

    sessionId.value = 's2'
    await nextTick()
    expect(loadMore.loadMoreError.value).toBe(false) // s2 分区无失败

    sessionId.value = 's1'
    await nextTick()
    expect(loadMore.loadMoreError.value).toBe(true) // s1 自己的失败仍在（顶部条可重试）
  })
})
})

// ═══════════ 来源节：useSessionRespawnRetry ═══════════

describe('useSessionRespawnRetry', () => {
const toastErrorMock = toastMock.error // respawn 节断言锚点：共享 toastMock.error 的原名单例
describe('useSessionRespawnRetry', () => {
  beforeEach(() => {
    restoreSessionMock.mockReset()
    reviveMock.mockReset()
    toastErrorMock.mockReset()
  })

  it('成功链：restore RPC 成功 → revive 同 sid 复位 dead 态，无错误 toast', async () => {
    restoreSessionMock.mockResolvedValue(undefined)
    const { onRespawnRetry } = useSessionRespawnRetry(() => 's1')

    await onRespawnRetry()

    expect(restoreSessionMock).toHaveBeenCalledTimes(1)
    expect(restoreSessionMock).toHaveBeenCalledWith('s1')
    expect(reviveMock).toHaveBeenCalledTimes(1)
    expect(reviveMock).toHaveBeenCalledWith('s1')
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('失败链：restore RPC reject → 不 revive + toast 指引，异常不外抛', async () => {
    restoreSessionMock.mockRejectedValue(new Error('spawn failed'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { onRespawnRetry } = useSessionRespawnRetry(() => 's1')

    await expect(onRespawnRetry()).resolves.toBeUndefined()

    expect(reviveMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledWith('恢复失败，请稍后重试或新建会话')
    warnSpy.mockRestore()
  })
})
})

// ═══════════ 来源节：use-queue-edit-anchor ═══════════

describe('use-queue-edit-anchor', () => {
/** 队列帧条目工厂（谓词可见态：lane ≠ direct 且 state ≠ delivered） */
function entry(clientUuid: string): DeliveryFrameEntry {
  return { clientUuid, preview: `p-${clientUuid}`, state: 'queued', lane: 'queued' }
}

/** 宿主装配：deps 各 ref 暴露给测试驱动（sid / draft / subagent 开关可控）。
 *  形状经 mountHost 返回值推导（测试文件内不再声明单实现接口）。 */
const liveWrappers: VueWrapper[] = []
function mountHost(initialSid: string | null = 's1') {
  const sid = ref(initialSid)
  const draft = ref('')
  const isSubagentLane = ref(false)
  const restoreToDraft = vi.fn()
  const laneSend = vi.fn((_sid: string, _segments: Segment[]) => Promise.resolve(true))
  const deps: QueueEditAnchorDeps = {
    sessionIdRef: sid,
    draft,
    attachedItems: ref([]),
    restoreToDraft,
    isSubagentLane,
    laneSend,
  }
  let api!: ReturnType<typeof useQueueEditAnchor>
  const Host = defineComponent({
    setup() {
      api = useQueueEditAnchor(deps)
      return () => h('div')
    },
  })
  liveWrappers.push(mount(Host))
  return { api, sid, draft, isSubagentLane, restoreToDraft, laneSend }
}

beforeEach(() => {
  vi.clearAllMocks()
  // 派生视图单例隔离：置空 Map（resetDeliveryProjectionForTest 未过 barrel 导出，
  // 置空 ref 与其对本 composable 可见状态等价）
  getDeliveryProjectionRef().value = new Map()
})

describe('beginQueueEntryEdit · 编辑入口三裁决接线（Q4）', () => {
  it('无 sid 早退：peek 不被调', () => {
    const host = mountHost(null)
    host.api.beginQueueEntryEdit('u-1')
    expect(deliveryMock.peekDelivery).not.toHaveBeenCalled()
  })

  it('started → peek 命中 → restoreToDraft 预填（text + segments）', async () => {
    deliveryMock.peekDelivery.mockResolvedValue({
      clientUuid: 'u-1',
      found: true,
      content: 'queued text',
      segments: [{ type: 'text', text: 'queued text' }],
    })
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    expect(host.api.editingQueueClientUuid.value).toBe('u-1')
    await nextTick()
    await Promise.resolve()
    expect(host.restoreToDraft).toHaveBeenCalledWith({
      text: 'queued text',
      segments: [{ type: 'text', text: 'queued text' }],
    })
  })

  it('同行再点 already-editing-same：幂等 no-op，peek 不重发', async () => {
    deliveryMock.peekDelivery.mockResolvedValue({ clientUuid: 'u-1', found: true, content: 'x' })
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    await nextTick()
    await Promise.resolve()
    expect(deliveryMock.peekDelivery).toHaveBeenCalledTimes(1)
    host.api.beginQueueEntryEdit('u-1')
    expect(deliveryMock.peekDelivery).toHaveBeenCalledTimes(1)
  })

  it('编辑 A 中点 B → conflict：toast 拦截，锚定保持 A，不 peek B', () => {
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1'), entry('u-2')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    host.api.beginQueueEntryEdit('u-2')
    expect(toastMock.info).toHaveBeenCalledTimes(1)
    expect(toastMock.info).toHaveBeenCalledWith('正在编辑另一条消息，请先放弃编辑')
    expect(host.api.editingQueueClientUuid.value).toBe('u-1')
    expect(deliveryMock.peekDelivery).toHaveBeenCalledTimes(1)
    expect(deliveryMock.peekDelivery).toHaveBeenCalledWith('s1', 'u-1')
  })

  it('peek found=false → 清锚定 + gone toast（条目已不在内核活跃集）', async () => {
    deliveryMock.peekDelivery.mockResolvedValue({ clientUuid: 'u-1', found: false })
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    await nextTick()
    await Promise.resolve()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    expect(toastMock.info).toHaveBeenCalledWith('原消息已不在队列')
  })

  it('peek content 空白 → 同 gone 口径（清锚定 + toast）', async () => {
    deliveryMock.peekDelivery.mockResolvedValue({ clientUuid: 'u-1', found: true, content: '  ' })
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    await nextTick()
    await Promise.resolve()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    expect(toastMock.info).toHaveBeenCalledWith('原消息已不在队列')
  })

  it('peek reject → 清锚定 + peekFailed toast（错误不外抛）', async () => {
    deliveryMock.peekDelivery.mockRejectedValue(new Error('rpc boom'))
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    expect(toastMock.error).toHaveBeenCalledWith('取回原文失败：rpc boom')
  })

  it('往返期间已放弃 → 不预填不复活锚定（以现值为准）', async () => {
    let resolvePeek: (v: { clientUuid: string; found: boolean; content: string }) => void
    deliveryMock.peekDelivery.mockReturnValue(
      new Promise((res) => {
        resolvePeek = res
      }),
    )
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    host.api.abandonQueueEdit()
    resolvePeek!({ clientUuid: 'u-1', found: true, content: 'late' })
    await nextTick()
    await Promise.resolve()
    expect(host.restoreToDraft).not.toHaveBeenCalled()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
  })
})

describe('abandonQueueEdit · 放弃编辑', () => {
  it('解除锚定（草稿文本保留由壳层语义，锚定归 null）', () => {
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    expect(host.api.editingQueueClientUuid.value).toBe('u-1')
    host.api.abandonQueueEdit()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
  })
})

describe('sendWithQueueEdit · 发送分流（D6）', () => {
  it('subagent 通道：同步透传 laneSend（同一 promise，不进 edit 流程）', async () => {
    const host = mountHost()
    host.isSubagentLane.value = true
    const segments: Segment[] = [{ type: 'text', text: 'hi' }]
    const returned = host.api.sendWithQueueEdit('s1', segments)
    expect(host.laneSend).toHaveBeenCalledWith('s1', segments)
    await expect(returned).resolves.toBe(true)
    expect(deliveryMock.editDelivery).not.toHaveBeenCalled()
  })

  it('无锚定：同步透传 laneSend', async () => {
    const host = mountHost()
    const segments: Segment[] = [{ type: 'text', text: 'hi' }]
    await host.api.sendWithQueueEdit('s1', segments)
    expect(host.laneSend).toHaveBeenCalledTimes(1)
    expect(deliveryMock.editDelivery).not.toHaveBeenCalled()
  })

  it('锚定已离场：顺手解除锚定 + 透传 laneSend（活性窄缝兜底同步点）', async () => {
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    // 锚定后条目离场（delivered 被谓词滤除）
    getDeliveryProjectionRef().value = new Map()
    const segments: Segment[] = [{ type: 'text', text: 'hi' }]
    await host.api.sendWithQueueEdit('s1', segments)
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    expect(host.laneSend).toHaveBeenCalledTimes(1)
    expect(deliveryMock.editDelivery).not.toHaveBeenCalled()
  })

  it('锚定活 → delivery.edit 原位替换：edited=true 直接收尾（无 laneSend、锚定解除）', async () => {
    deliveryMock.editDelivery.mockResolvedValue({ clientUuid: 'u-1', edited: true })
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    const segments: Segment[] = [{ type: 'text', text: 'edited' }]
    await expect(host.api.sendWithQueueEdit('s1', segments)).resolves.toBe(true)
    expect(deliveryMock.editDelivery).toHaveBeenCalledWith('s1', 'u-1', 'edited', segments)
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    expect(host.laneSend).not.toHaveBeenCalled()
    expect(toastMock.info).not.toHaveBeenCalled()
  })

  it('edited=false 四值降级：toast 分型 + 内容按普通新消息发出（不丢）', async () => {
    deliveryMock.editDelivery.mockResolvedValue({ clientUuid: 'u-1', edited: false, reason: 'cancelled' })
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    const segments: Segment[] = [{ type: 'text', text: 'still here' }]
    await expect(host.api.sendWithQueueEdit('s1', segments)).resolves.toBe(true)
    expect(toastMock.info).toHaveBeenCalledWith('原消息已撤销，修改内容已作为新消息发送')
    expect(host.laneSend).toHaveBeenCalledWith('s1', segments)
  })
})

describe('watch 帧驱动 · 离场自动解除与清空草稿边沿（Q3/Q4）', () => {
  it('锚定条目离场（帧更新滤除）→ 自动清锚定，不发 toast', async () => {
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    expect(host.api.editingQueueClientUuid.value).toBe('u-1')
    // 先 flush 一次：begin（锚定 null→'u-1'）与离场帧若在同一同步块，watcher job 去重合并、
    // 边沿回调不触发（Vue watch 语义；生产两事件恒跨任务）——先落定 'u-1' 边沿再模拟离场帧
    await nextTick()
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-9')]]])
    await nextTick()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    expect(toastMock.info).not.toHaveBeenCalled()
  })

  it('同会话清空草稿边沿（有内容 → 空）→ 清锚定', async () => {
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    host.draft.value = 'typing'
    await nextTick()
    expect(host.api.editingQueueClientUuid.value).toBe('u-1')
    host.draft.value = ''
    await nextTick()
    expect(host.api.editingQueueClientUuid.value).toBeNull()
  })

  it('跨会话切换不清源分区锚定（Q4 穷举 3：切走留在分区、切回恢复）', async () => {
    getDeliveryProjectionRef().value = new Map([['s1', [entry('u-1')]], ['s2', []]])
    const host = mountHost()
    host.api.beginQueueEntryEdit('u-1')
    host.draft.value = 'kept'
    host.sid.value = 's2'
    await nextTick()
    // 新会话分区无锚定
    expect(host.api.editingQueueClientUuid.value).toBeNull()
    host.sid.value = 's1'
    await nextTick()
    // 切回源分区：锚定随分区恢复
    expect(host.api.editingQueueClientUuid.value).toBe('u-1')
  })
})
})

// ═══════════ 来源节：composer-shell-model-toast ═══════════

describe('composer-shell-model-toast', () => {
/** 最小壳层参数（Composer.vue 局部状态的同构 stub；input/box ref 恒 null——不触发输入范围） */
function shellParams(): ComposerShellParams {
  return {
    sessionIdRef: computed(() => 's1'),
    variantRef: computed(() => 'panel' as const),
    inputRef: ref(null),
    composerBoxRef: ref(null),
    draft: ref(''),
    isSending: ref(false),
    drafts: { getDraft: () => [], saveDraft: vi.fn(), deleteDraft: vi.fn() },
    isActive: computed(() => false),
    cmdOpen: ref(false),
  }
}

/** 宿主组件内装配壳层（真实组件实例：lifecycle/warn 干净），登记 wrapper 供 afterEach 统一卸载 */
const liveWrappers: VueWrapper[] = []
function mountShell(): ComposerShellReturn {
  let shell: ComposerShellReturn | null = null
  const Host = defineComponent({
    setup() {
      shell = useComposerShell(shellParams())
      return () => h('div')
    },
  })
  liveWrappers.push(mount(Host))
  return shell!
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('onModelSelectUi / onThinkingSelectUi 错误→toast 包装（U4 三纪律）', () => {
  it('模型切换 reject（已知专用码 MODEL_NOT_FOUND）→ 专用文案 toast，且不外抛（await resolve）', async () => {
    modelThinking.onModelSelect.mockRejectedValueOnce(
      Object.assign(new Error('model gone'), { code: 'MODEL_NOT_FOUND' }),
    )
    const shell = mountShell()

    // 「不外抛」纪律：包装吞错 resolve，模板绑定不产生 unhandled rejection
    await expect(
      shell.onModelSelect({ modelId: 'prov/b', provider: 'prov' as ProviderId }),
    ).resolves.toBeUndefined()

    expect(toastMock.error).toHaveBeenCalledTimes(1)
    // modelSwitchToastKey 单点映射：MODEL_NOT_FOUND → 专用文案（zh-CN 实文）
    expect(toastMock.error).toHaveBeenCalledWith('该模型已不存在，请重新选择')
  })

  it('模型切换 reject（未知码）→ general 兜底文案 + 后端 message 插值', async () => {
    modelThinking.onModelSelect.mockRejectedValueOnce(
      Object.assign(new Error('rpc boom'), { code: 'SOMETHING_ELSE' }),
    )
    const shell = mountShell()

    await expect(
      shell.onModelSelect({ modelId: 'prov/b', provider: 'prov' as ProviderId }),
    ).resolves.toBeUndefined()

    expect(toastMock.error).toHaveBeenCalledTimes(1)
    // 未知码落 general：'切换失败：{error}'，{error} = modelSwitchErrorMessage 提取的 message
    expect(toastMock.error).toHaveBeenCalledWith('切换失败：rpc boom')
  })

  it('档位切换 reject → 同款 toast 映射（onThinkingSelectUi 与 onModelSelectUi 同构）', async () => {
    modelThinking.onThinkingSelect.mockRejectedValueOnce(
      Object.assign(new Error('level boom'), { code: 'SESSION_ACTIVATE_FAILED' }),
    )
    const shell = mountShell()

    await expect(shell.onThinkingSelect('high')).resolves.toBeUndefined()

    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error).toHaveBeenCalledWith('会话无法恢复，请在侧栏重新打开')
  })

  it('成功路径零 toast（不误报）', async () => {
    modelThinking.onModelSelect.mockResolvedValueOnce(undefined)
    modelThinking.onThinkingSelect.mockResolvedValueOnce(undefined)
    const shell = mountShell()

    await shell.onModelSelect({ modelId: 'prov/b', provider: 'prov' as ProviderId })
    await shell.onThinkingSelect('high')

    expect(toastMock.error).not.toHaveBeenCalled()
  })
})
})

// ═══════════ 来源节：composer-keydown ═══════════

describe('composer-keydown', () => {
type KeyMods = { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean }

/** 构造带 preventDefault spy 的键盘事件（happy-dom KeyboardEvent，isComposing 默认 false） */
function makeKeyEvent(key: string, mods: KeyMods = {}) {
  const e = new KeyboardEvent('keydown', {
    key,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    cancelable: true,
  })
  const preventDefault = vi.fn()
  e.preventDefault = preventDefault
  return { e, preventDefault }
}

/** fake deps：仅覆盖 keydown 分发路径实际消费的契约范围（多余方法对测试无意义） */
function makeDeps(overrides: {
  /** moveCaretVertical 返回值（默认 at-edge → 触发翻历史路径） */
  caret?: 'moved' | 'at-edge'
  /** 回合进行中判定（chat-flow-consistency D1 判定集合读口；默认 false = 空闲） */
  activeTurn?: boolean
  stagingActive?: boolean
  /** 命令动作表返回值（composer-pi-shortcuts U1②；默认 false = 未命中放行） */
  shortcutConsumed?: boolean
  /** 命令浮层 open 态（接线矩阵用） */
  cmdOpen?: boolean
  /** 浮层 handleKeydown 返回值（null = 不接浮层实例；默认 null） */
  popoverConsumes?: boolean | null
} = {}) {
  const moveCaretVertical = vi.fn(() => overrides.caret ?? 'at-edge')
  const handleArrowUp = vi.fn()
  const handleArrowDown = vi.fn()
  const onFollowUp = vi.fn()
  const onSend = vi.fn()
  const shortcutActions = vi.fn(() => overrides.shortcutConsumed ?? false)
  const staging = {
    // Esc 路由默认不消费（消费与否属于 staging.action 自身测试，不在本矩阵）
    handleEsc: vi.fn(() => false),
    // 分派器只读 activeStaging.value 真值；staging action 行为契约由 staging 域测试覆盖
    activeStaging: computed(() =>
      overrides.stagingActive ? ({ type: 'fork' } as unknown as StagingAction) : null,
    ),
  }
  const popoverHandle =
    overrides.popoverConsumes === null || overrides.popoverConsumes === undefined
      ? null
      : { handleKeydown: vi.fn(() => overrides.popoverConsumes) }
  const deps: ComposerKeydownDeps = {
    cmdOpen: ref(overrides.cmdOpen ?? false),
    commandPopoverRef: ref(popoverHandle) as ComposerKeydownDeps['commandPopoverRef'],
    inputRef: ref({ moveCaretVertical } as unknown as ShellInputInstance),
    staging,
    activeTurn: computed(() => overrides.activeTurn ?? false),
    shortcutActions,
    handleArrowUp,
    handleArrowDown,
    onFollowUp,
    onSend,
  }
  return {
    deps,
    moveCaretVertical,
    handleArrowUp,
    handleArrowDown,
    onFollowUp,
    onSend,
    shortcutActions,
    staging,
    popoverHandle,
  }
}

describe('useComposerKeydown', () => {
  describe('bare-arrow 导航矩阵', () => {
    it('裸 ↑：preventDefault + moveCaretVertical(up)；caret moved 不翻历史', () => {
      const { deps, moveCaretVertical, handleArrowUp, handleArrowDown } = makeDeps({ caret: 'moved' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('ArrowUp')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(moveCaretVertical).toHaveBeenCalledWith('up')
      expect(handleArrowUp).not.toHaveBeenCalled()
      expect(handleArrowDown).not.toHaveBeenCalled()
    })

    it('裸 ↓：preventDefault + moveCaretVertical(down)；caret moved 不翻历史', () => {
      const { deps, moveCaretVertical, handleArrowUp, handleArrowDown } = makeDeps({ caret: 'moved' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('ArrowDown')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(moveCaretVertical).toHaveBeenCalledWith('down')
      expect(handleArrowUp).not.toHaveBeenCalled()
      expect(handleArrowDown).not.toHaveBeenCalled()
    })

    it('裸 ↑：caret at-edge → 翻上一条历史（handleArrowUp），不走下一条', () => {
      const { deps, moveCaretVertical, handleArrowUp, handleArrowDown } = makeDeps({ caret: 'at-edge' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('ArrowUp')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(moveCaretVertical).toHaveBeenCalledTimes(1)
      expect(handleArrowUp).toHaveBeenCalledTimes(1)
      expect(handleArrowDown).not.toHaveBeenCalled()
    })

    it('裸 ↓：caret at-edge → 翻下一条历史（handleArrowDown），不走上一条', () => {
      const { deps, handleArrowUp, handleArrowDown } = makeDeps({ caret: 'at-edge' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('ArrowDown')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(handleArrowDown).toHaveBeenCalledTimes(1)
      expect(handleArrowUp).not.toHaveBeenCalled()
    })

    it('修饰键 + ↑/↓ 放行原生（选区扩展/按词移动/段首段尾跳转）：不拦截不分派', () => {
      const cases: Array<{ key: string; mods: KeyMods }> = [
        { key: 'ArrowUp', mods: { shift: true } },
        { key: 'ArrowUp', mods: { alt: true } },
        { key: 'ArrowUp', mods: { ctrl: true } },
        { key: 'ArrowUp', mods: { meta: true } },
        { key: 'ArrowDown', mods: { shift: true } },
      ]
      for (const { key, mods } of cases) {
        const { deps, moveCaretVertical, handleArrowUp, handleArrowDown } = makeDeps()
        const onKeydown = useComposerKeydown(deps)
        const { e, preventDefault } = makeKeyEvent(key, mods)

        onKeydown(e)

        expect(preventDefault, `${key} + ${JSON.stringify(mods)} 应放行`).not.toHaveBeenCalled()
        expect(moveCaretVertical, `${key} + ${JSON.stringify(mods)} 应放行`).not.toHaveBeenCalled()
        expect(handleArrowUp).not.toHaveBeenCalled()
        expect(handleArrowDown).not.toHaveBeenCalled()
      }
    })
  })

  describe('Enter 分发矩阵（chat-flow-consistency D5：Alt 分流读 D1 判定集合，裸 ⏎ 恒统一提交）', () => {
    it('staging 活跃：裸 Enter → onSend（staging 提交优先）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ stagingActive: true, activeTurn: true })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('staging 活跃：Alt+Enter → onSend（staging 优先于 followUp）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ stagingActive: true })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('Alt+Enter + 回合进行中（activeTurn，判定集合成员）→ onFollowUp（下一轮语义保留），不走 onSend', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ activeTurn: true })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onFollowUp).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled()
    })

    it('Alt+Enter + 非集合成员（compacting/bash 忙，activeTurn=false）→ onSend（统一分发器提交；排队去向由内核裁定）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ activeTurn: false })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('Alt+Enter + 空闲（activeTurn=false）→ onSend（followUp 非活跃退化路径的语义收尾）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ activeTurn: false })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('裸 Enter + 回合进行中 → onSend（统一分发器：去向由内核裁定，[HISTORICAL] isActive→onSteer 直调退役）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ activeTurn: true })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('裸 Enter + idle → onSend', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ activeTurn: false })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('⇧⏎ 放行原生换行：不 preventDefault、不分派任何动作', () => {
      const { deps, onFollowUp, onSend } = makeDeps()
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { shift: true })

      onKeydown(e)

      expect(preventDefault).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(onFollowUp).not.toHaveBeenCalled()
    })
  })

  /**
   * 分发链接线（composer-pi-shortcuts U1②）：命令动作表分支插在 IME 之后、staging Esc 之前。
   * 本矩阵只锁链序与短路语义（动作表消费 → 链终止；未消费 → 链继续），动作表内部
   * 键位判定/检查/编排由 composer-shortcut-actions.test.ts 全量覆盖。
   */
  describe('分发链接线：命令动作表分支（composer-pi-shortcuts）', () => {
    it('动作表消费（shift+tab 命中返回 true）：链短路——staging Esc / 裸箭头 / Enter 均不触达', () => {
      const { deps, moveCaretVertical, onSend, shortcutActions, staging } = makeDeps({
        shortcutConsumed: true,
        caret: 'at-edge',
      })
      const onKeydown = useComposerKeydown(deps)
      const { e } = makeKeyEvent('Tab', { shift: true })

      onKeydown(e)

      expect(shortcutActions).toHaveBeenCalledTimes(1)
      expect(shortcutActions).toHaveBeenCalledWith(e)
      expect(staging.handleEsc).not.toHaveBeenCalled()
      expect(moveCaretVertical).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
    })

    it('动作表未命中（返回 false）：链继续——裸箭头导航照常触达（既有段行为不变）', () => {
      const { deps, moveCaretVertical, handleArrowUp, shortcutActions } = makeDeps({
        shortcutConsumed: false,
        caret: 'at-edge',
      })
      const onKeydown = useComposerKeydown(deps)
      const { e } = makeKeyEvent('ArrowUp')

      onKeydown(e)

      expect(shortcutActions).toHaveBeenCalledTimes(1)
      expect(moveCaretVertical).toHaveBeenCalledTimes(1)
      expect(handleArrowUp).toHaveBeenCalledTimes(1)
    })

    it('链序：动作表先于 staging Esc（同键 Esc 未命中时 handleEsc 在其后被咨询）', () => {
      const { deps, shortcutActions, staging } = makeDeps({ shortcutConsumed: false })
      const onKeydown = useComposerKeydown(deps)
      const { e } = makeKeyEvent('Escape')

      onKeydown(e)

      expect(shortcutActions).toHaveBeenCalledTimes(1)
      expect(staging.handleEsc).toHaveBeenCalledTimes(1)
      expect(shortcutActions.mock.invocationCallOrder[0]).toBeLessThan(
        staging.handleEsc.mock.invocationCallOrder[0],
      )
    })

    it('IME 组合中动作表不被咨询（IME 段先于动作表放行——§3.4 插序约束）', () => {
      const { deps, shortcutActions, onSend } = makeDeps()
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Tab', { shift: true })
      Object.defineProperty(e, 'isComposing', { value: true })

      onKeydown(e)

      expect(shortcutActions).not.toHaveBeenCalled()
      expect(preventDefault).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
    })

    it('浮层 open 且浮层未消费该键：动作表仍被咨询（消费与否由其 cmdOpen 入口检查自判）', () => {
      const { deps, shortcutActions, onSend, popoverHandle } = makeDeps({
        cmdOpen: true,
        popoverConsumes: false,
      })
      const onKeydown = useComposerKeydown(deps)
      const { e } = makeKeyEvent('a')

      onKeydown(e)

      expect(popoverHandle!.handleKeydown).toHaveBeenCalledTimes(1)
      expect(shortcutActions).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled() // 'a' 非 Enter，正常落空
    })
  })

  /**
   * D2 时序锁（composer-chip-insertion-semantics 设计 §3.3 D2 + P5）：浮层 open 时 Enter
   * 经 CommandPopover window capture 消费（preventDefault + stopPropagation 截断）后，
   * 事件不得到达 composer 的 onKeydown/onSend——这是删除 defaultPrevented 防御层后的
   * 唯一防线，用真实 DOM 事件派发锁 capture/bubble 全链路（happy-dom 支持传播 + stopPropagation
   * 语义；真机链路另有设计 §4 场景表签收）。
   *
   * 链路模拟与产线同构：window（capture，CommandPopover onWindowKeydown）→ target
   * （bubble，useComposerKeydown 产物 onKeydown，cmdOpen/commandPopoverRef 按产线接线）。
   *
   * 消费条件（缺陷 B 修复后）= 「浮层 open 即消费」：PopoverContent 的 v-if 只看 open，
   * 每个 open 态都有可见行（候选列表 / 通用空态 / 加载中 / 加载失败），不再存在「open 但
   * 什么都不渲染」的态。[HISTORICAL] RC-A-1 曾把消费条件收紧为「浮层实际可见」（唯一边界 =
   * file 错误/空结果态），理由是「不可见态吞键 = 消息发不出且无提示」；反馈行补齐后该理由
   * 消失 ⇒ 判据删除（不是与旧判据并存）。仅「浮层未 open」仍全部键放行（末条用例锁定
   * Enter 正常发送）。
   *
   * D4 三态细化（command-enter-exact-send §3.3 D4）：非精确匹配锁 = 现状断言（首条 + 前缀条）；
   * 精确匹配锁 = select-and-send 同步直调 composer 分发链，onSend 恰一次（双发回归锁——
   * 实现若走合成事件二次派发，计数变 2 而红）；Tab 锁 = 恒 onSelect（补参通道不因完整名关闭）。
   * 精确锁前置 = 显式 focus（环境 activeElement 默认 body → D1 前置② fail-closed 恒拦，
   * 见 setupExactChain）。
   */
  describe('D2 时序锁三态（command-enter-exact-send D4）：前缀/门失败恒选中不发送、精确直发恰一次、Tab 恒选中（capture/bubble 全链路）', () => {
    let target: HTMLElement
    let removeTarget: () => void
    let popoverWrapper: ReturnType<typeof mount> | null = null
    let onSelect: ReturnType<typeof vi.fn>
    let onSelectAndSend: ReturnType<typeof vi.fn>
    let onSend: ReturnType<typeof vi.fn>
    /** select-and-send → composer 分发链直调通道（镜像产线 useCommandPopoverTrigger.onSelectAndSend
     *  的 onComposerKeydown 晚绑定闭包）；由 wireComposerKeydown 赋值，beforeEach 复位 */
    let composerKeydownHandler: ((e: KeyboardEvent) => void) | null

    beforeEach(() => {
      setActivePinia(createPinia())
      onSelect = vi.fn()
      onSend = vi.fn()
      composerKeydownHandler = null
      // select-and-send 消费端 = 产线直调镜像（传原事件，零合成零 DOM 派发）。
      // onSend 恰一次断言的作用面盖三处：①键盘层分流只调一次 ②原事件被 capture 截断不到
      // target 冒泡（到则 composer 分发器二次 dispatchEnter）③CommandPopover 未合成再派发
      // KeyboardEvent（再派发会重进 window capture → 第二次 select-and-send → 第二次直调）。
      onSelectAndSend = vi.fn((payload: { originalEvent: KeyboardEvent }) => {
        composerKeydownHandler?.(payload.originalEvent)
      })
      // target 模拟 composer contenteditable：keydown 冒泡链上挂 useComposerKeydown 产物
      target = document.createElement('div')
      target.setAttribute('contenteditable', 'true')
      document.body.appendChild(target)
      removeTarget = () => target.remove()
    })

    afterEach(() => {
      vi.useRealTimers()
      // landing `$` 拉取 mock 逐用例复位：mockImplementationOnce 若未被消费（理论上不会——
      // 每次挂载新实例、1s 节流窗口随实例从 0 起）不留到下一用例
      getFileCandidatesByCwdMock.mockReset()
      popoverWrapper?.unmount()
      popoverWrapper = null
      removeTarget()
      document.body.innerHTML = ''
    })

    /** target（composer contenteditable）挂 composer keydown 分发器，cmdOpen/commandPopoverRef
     *  按产线接线指向已挂载的浮层实例。 */
    function wireComposerKeydown(open: boolean): void {
      const deps: ComposerKeydownDeps = {
        cmdOpen: ref(open),
        commandPopoverRef: ref(popoverWrapper!.vm as never),
        inputRef: ref(null),
        staging: { handleEsc: vi.fn(() => false), activeStaging: computed(() => null) },
        activeTurn: computed(() => false),
        shortcutActions: vi.fn(() => false),
        handleArrowUp: vi.fn(),
        handleArrowDown: vi.fn(),
        onFollowUp: vi.fn(),
        onSend,
      }
      composerKeydownHandler = useComposerKeydown(deps)
      target.addEventListener('keydown', composerKeydownHandler)
    }

    /** 挂真 CommandPopover（panel 态无 sid → compact 一项保底非空）+ 接线 composer keydown。
     *  propsOverride 供可见性矩阵用例换 type/query/variant（query 无匹配即可造「open 但空候选」）。
     *  onSelectAndSend 按产线 `@select-and-send="onSelectAndSend"` 接线（消费端见 beforeEach）。 */
    function setupChain(open: boolean, propsOverride: Record<string, unknown> = {}): void {
      popoverWrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open, type: 'slash', variant: 'panel', onSelect, onSelectAndSend, ...propsOverride } as never,
      })
      wireComposerKeydown(open)
    }

    /**
     * 浮层「可见但候选为空」的生产形态：landing `$` 空结果态——fileNoResultsVisible 为真
     * ⇒ 模板渲染 file-no-results 行，但 items 为空。
     * 必须走真实链路造态：挂载时 open=false，再 setProps 打开触发 open false→true 边沿拉取
     * （getFileCandidatesByCwd 回空 files 且 truncated=false）+ flush 回写 success。
     * 1s 节流窗口是组件实例级（useCommandPopoverOpenFetch 内的局部量，每次挂载从 0 起），
     * 用例间不互相撞窗口；fake Date 冻结时间派生读数（flushPromises 依赖的
     * setImmediate/setTimeout 保持真实）。
     */
    async function setupLandingFileEmptyChain(): Promise<void> {
      vi.useFakeTimers({ toFake: ['Date'] })
      getFileCandidatesByCwdMock.mockResolvedValueOnce({ files: [], truncated: false })
      popoverWrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open: false, type: 'file', variant: 'landing', cwd: '/tmp/empty-dir', onSelect } as never,
      })
      wireComposerKeydown(true)
      await nextTick()
      await popoverWrapper.setProps({ open: true })
      await flushPromises()
      await nextTick()
      // 造态自检：浮层确实渲染（空态行在 DOM 中），否则下方「可见态消费」断言会假绿
      expect(document.body.querySelector('[data-testid="cmd-file-empty"]')).not.toBeNull()
    }

    /** 真实 DOM 派发（cancelable 保证 preventDefault 生效；bubbles 走完整 capture→target→bubble） */
    function dispatchEnter(isComposing = false): KeyboardEvent {
      const e = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing,
      })
      target.dispatchEvent(e)
      return e
    }

    /** 精确锁链前置（D1 前置② focus 门，设计 §5 U3「测试态显式 focus composer」）：
     *  环境 activeElement 默认 body → activeElement 门恒 fail-closed 拦截，精确锁进直发
     *  分支前必须显式 focus。产线 shellInputRef = Composer shellInputHolder.ref（识别源 =
     *  ComposerInput expose 的 getInputElement）；本组用例的「composer 输入区」= target
     *  （contenteditable div，E-1 activeElementInInput 按该 expose 判据裁决），fake 实例
     *  getInputElement 指向 target。withShellRef=false = 通道缺省 → 门 fail-closed（D1
     *  降级态造法，focus 照做以证明拦截来自通道缺省而非焦点缺失）。 */
    function setupExactChain(query: string, withShellRef = true): void {
      const shellInputRef = withShellRef
        ? ref<ShellInputInstance | null>({ getInputElement: () => target } as unknown as ShellInputInstance)
        : undefined
      setupChain(true, { query, shellInputRef })
      target.focus()
      expect(document.activeElement).toBe(target) // 造态自检：focus 门前置确已生效
    }

    it('浮层 open：Enter 被浮层 capture 消费（onSelect 一次）且 stopPropagation 截断——onSend 不触发、事件 defaultPrevented', () => {
      setupChain(true)

      const e = dispatchEnter()

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'slash', name: '/compact' }))
      expect(onSend).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    // ── D4 三态细化（command-enter-exact-send §3.3 D4 + §4 场景 5）────────────────
    // 非精确锁 = 上方既有用例（query 空 → 非精确，现状断言零改动）+ 下方前缀用例
    // （前缀 + 焦点门通过 → 精确谓词为假 → 仍恒选中——设计场景 2「前缀插 chip 不回归」）。
    it('非精确锁（前缀）：query=com + 输入区 focus → Enter 仍恒选中（onSelect 一次、不直发）', () => {
      setupExactChain('com')

      const e = dispatchEnter()

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'slash', name: '/compact' }))
      expect(onSelectAndSend).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    it('精确锁：完整名 /compact + 输入区 focus + Enter → 直发——select-and-send 恰一次且 onSend 恰一次（双发回归锁）', () => {
      setupExactChain('compact')

      const e = dispatchEnter()

      expect(onSelectAndSend).toHaveBeenCalledTimes(1)
      expect(onSelectAndSend).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'slash', name: '/compact', originalEvent: e }),
      )
      // D2 双发回归锁：唯一发送来源 = select-and-send 同步直调 composer 分发链（传原事件）。
      // 实现若走合成事件二次派发（重进 window capture 或落 target 冒泡）→ 第二次
      // dispatchEnter → 计数变 2 而红；=0 则直调链断（fail-closed 通道亦红）。
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onSelect).not.toHaveBeenCalled() // 直发不经 select 通路（插 chip 前置态在产线 onCmdSelect 侧）
      expect(e.defaultPrevented).toBe(true) // capture 截断：原事件不到 target 冒泡（到则第二次 onSend）
    })

    it('Tab 锁：完整名 + 输入区 focus + Tab → 恒选中插 chip（onSelect 一次、select-and-send/onSend 零次）', () => {
      setupExactChain('compact')

      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      target.dispatchEvent(tab)

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'slash', name: '/compact' }))
      // exactMatch 直发仅 Enter；Tab 恒 onSelect（补参通道不因完整名关闭——设计场景 3）
      expect(onSelectAndSend).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(tab.defaultPrevented).toBe(true)
    })

    it('门失败降级：shellInputRef 缺省（D1 前置② fail-closed）+ 精确形 query → 不直发走选中', () => {
      setupExactChain('compact', false)

      const e = dispatchEnter()

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'slash', name: '/compact' }))
      expect(onSelectAndSend).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    // ── F-1 回归锁（W1 验收 P1）：门识别源 = getInputElement，不读实例 $el ──────────────
    // 缺陷形态：dev 构建保留 ComposerInput 模板 HTML 注释 → subTree 根为 Fragment → 实例
    // $el 是注释节点（nodeType 8）→ 旧实现 root.contains(activeElement) 恒 false →
    // 精确直发在 dev 全变体静默退化插 chip（prod 剥离注释才正常）。两用例反向锁死 $el
    // 通道不得复活：①$el 是注释 + expose 正确 → 门必须通过；②expose 缺失 + $el 正确 →
    // 门必须 fail-closed（实现若回退 $el，②的 onSelectAndSend 会被调而红）。
    it('F-1 锁：$el 为注释节点（dev 构建形态）+ getInputElement 正确 → 门通过，精确直发照常', () => {
      setupChain(true, {
        query: 'compact',
        shellInputRef: ref<ShellInputInstance | null>({
          $el: document.createComment(' 富文本输入区（contenteditable）'),
          getInputElement: () => target,
        } as unknown as ShellInputInstance),
      })
      target.focus()
      expect(document.activeElement).toBe(target) // 造态自检：焦点门前置确已生效

      const e = dispatchEnter()

      expect(onSelectAndSend).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onSelect).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    it('F-1 锁：expose 缺失（$el 正确且 focus 在内）→ 门 fail-closed 不直发（禁回退 $el）', () => {
      setupChain(true, {
        query: 'compact',
        shellInputRef: ref<ShellInputInstance | null>({ $el: target } as unknown as ShellInputInstance),
      })
      target.focus()
      expect(document.activeElement).toBe(target) // 造态自检：焦点在位，拦截只能来自 expose 缺失

      const e = dispatchEnter()

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'slash', name: '/compact' }))
      expect(onSelectAndSend).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    // ── 缺陷 B：open 即渲染反馈行 + open 即消费 ──────────────────────────────
    // 修复前这些 open 态什么都不渲染（旧 v-if = items 非空 || fileFallbackVisible），按
    // RC-A-1「实际可见才消费」放行 Enter ⇒ landing 首发会把 `@query` 这类触发符字面量发出去。
    // 反馈行补齐后消费条件回到「open 即消费」（因果见 command-popover-keyboard.ts 头部）。
    it('open 但无候选（行首 `/zzz` 无匹配命令）→ 渲染「无匹配项」行 + Enter 被消费：onSend 不触发', async () => {
      setupChain(true, { query: 'zzz' })
      // reka PopoverContent 经 Presence 渲染（open=true 后下一拍进 DOM）——DOM 断言前先 flush
      await flushPromises()
      await nextTick()

      const emptyRow = document.body.querySelector('[data-testid="cmd-popover-empty"]')
      expect(emptyRow).not.toBeNull()
      expect(emptyRow!.textContent).toContain('无匹配项')
      expect(document.body.querySelectorAll('.pop-item')).toHaveLength(0) // 确无候选（自检）

      const e = dispatchEnter()

      expect(onSelect).not.toHaveBeenCalled() // 无项可选中
      expect(onSend).not.toHaveBeenCalled() // stopPropagation 截断：未落到 composer 分发器
      expect(e.defaultPrevented).toBe(true)
    })

    it('open 但无候选：Tab 同口径被消费（不再按可见性分叉键位）', () => {
      setupChain(true, { query: 'zzz' })

      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      target.dispatchEvent(tab)

      expect(tab.defaultPrevented).toBe(true)
      expect(onSend).not.toHaveBeenCalled()
    })

    // 此前不可见态矩阵（缺陷 B）：四路空候选源 + landing `@` 无 sessionId + landing `$` 无 cwd。
    // 共同后果 = Enter 直达 onSend（landing 首发会创建 session 并发出 `@query` 字面量）。
    it.each([
      { label: 'slash 空候选（/zzz 无匹配）', props: { type: 'slash', query: 'zzz' } },
      { label: 'session 空候选', props: { type: 'session', query: 'zzz' } },
      { label: 'landing `@` 无 sessionId', props: { type: 'subagent', variant: 'landing' } },
      { label: 'skill 空候选', props: { type: 'skill', query: 'zzz' } },
      { label: 'landing `$` 无 cwd', props: { type: 'file', variant: 'landing' } },
    ])('open 但无候选（$label）→ 反馈行渲染 + Enter 被消费（不再放行）', async ({ props }) => {
      setupChain(true, props)
      await flushPromises() // reka PopoverContent 进 DOM 需下一拍（见上条注释）
      await nextTick()
      const handleKeydown = popoverWrapper!.vm.handleKeydown as (e: KeyboardEvent) => boolean

      const row = document.body.querySelector('[data-testid="cmd-popover-empty"]')
      expect(row).not.toBeNull()
      expect(row!.textContent).toContain('无匹配项')
      expect(document.body.querySelectorAll('.pop-item')).toHaveLength(0)
      expect(document.body.querySelector('[data-testid="cmd-popover-loading"]')).toBeNull()

      const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
      expect(handleKeydown(enter)).toBe(true)
      expect(enter.defaultPrevented).toBe(true) // 已消费 ⇒ 不再冒泡到发送链路
    })

    it('landing `$` 有 cwd 但候选未到（open-fetch 在途）→ 渲染「加载中」行 + Enter 被消费、不发送', async () => {
      // 在途：mock 永不 settle ⇒ cwdFileStatus 停在 idle（与「本次 open 因 1s 节流跳过」同态，
      // 两者都是「结果稍后会到」）。修复前该 open 态无任何渲染 ⇒ Enter 直达 onSend。
      getFileCandidatesByCwdMock.mockImplementationOnce(() => new Promise(() => {}))
      popoverWrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open: false, type: 'file', variant: 'landing', cwd: '/tmp/in-flight', onSelect } as never,
      })
      wireComposerKeydown(true)
      await popoverWrapper.setProps({ open: true })
      await flushPromises()
      await nextTick()

      const row = document.body.querySelector('[data-testid="cmd-popover-loading"]')
      expect(row).not.toBeNull()
      expect(row!.textContent).toContain('加载中')
      expect(document.body.querySelector('[data-testid="cmd-popover-empty"]')).toBeNull() // 两态互斥

      const e = dispatchEnter()

      expect(onSend).not.toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    it('landing `$` 候选源非空但 query 无匹配 → 渲染「无匹配项」行（非加载中/非 file-no-results）+ Enter 被消费', async () => {
      getFileCandidatesByCwdMock.mockImplementationOnce(() =>
        Promise.resolve({ files: [{ path: 'a.ts', name: 'a.ts', type: 'file' }], truncated: false }),
      )
      popoverWrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open: false, type: 'file', variant: 'landing', cwd: '/tmp/proj', onSelect } as never,
      })
      wireComposerKeydown(true)
      await popoverWrapper.setProps({ open: true })
      await flushPromises()
      await nextTick()
      expect(document.body.querySelectorAll('.pop-item')).toHaveLength(1) // 造态自检：候选已到位

      await popoverWrapper.setProps({ query: 'zzz' })
      await nextTick()

      expect(document.body.querySelectorAll('.pop-item')).toHaveLength(0)
      const row = document.body.querySelector('[data-testid="cmd-popover-empty"]')
      expect(row).not.toBeNull()
      expect(row!.textContent).toContain('无匹配项')
      // 候选源非空 ⇒ 既不是「加载中」也不是「当前目录无匹配文件」（那两态各有专属文案）
      expect(document.body.querySelector('[data-testid="cmd-popover-loading"]')).toBeNull()
      expect(document.body.querySelector('[data-testid="cmd-file-empty"]')).toBeNull()

      const e = dispatchEnter()

      expect(onSend).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    it('浮层可见但候选为空（landing `$` 空结果态）：Enter 仍被消费——defaultPrevented、不选中、不得到达 onSend、不自动关闭浮层', async () => {
      await setupLandingFileEmptyChain()

      const e = dispatchEnter()

      expect(e.defaultPrevented).toBe(true) // 事件被浮层消费（preventDefault），未被放行
      expect(onSend).not.toHaveBeenCalled() // 未落到 composer 分发器（stopPropagation 截断）
      expect(onSelect).not.toHaveBeenCalled() // 无候选可选中
      // 不改变 open 状态：不自动关闭（否则用户下一次 Enter 会在无浮层可感知下意外发送）
      expect(popoverWrapper!.emitted('update:open')).toBeFalsy()
    })

    it('浮层可见但候选为空：↑↓ 仍无害放行（现状行为不变），仅 Enter/Tab 被消费', async () => {
      await setupLandingFileEmptyChain()
      const handleKeydown = popoverWrapper!.vm.handleKeydown as (e: KeyboardEvent) => boolean

      // 方向键无项可移 → 返回 false 且不 preventDefault（行为与修复前一致，未被本次重排改变）
      const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true })
      expect(handleKeydown(down)).toBe(false)
      expect(down.defaultPrevented).toBe(false)

      const up = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true })
      expect(handleKeydown(up)).toBe(false)
      expect(up.defaultPrevented).toBe(false)

      // Enter/Tab 例外：可见空态也消费（返回 true + preventDefault），但不选中任何项
      const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
      expect(handleKeydown(enter)).toBe(true)
      expect(enter.defaultPrevented).toBe(true)

      const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
      expect(handleKeydown(tab)).toBe(true)
      expect(tab.defaultPrevented).toBe(true)

      expect(onSelect).not.toHaveBeenCalled()
    })

    // ── ↑↓ 截断回归锁（缺陷：浮层 open 时 ↑/↓ 穿透到 composer 方向键导航）─────────────
    // 只 preventDefault 不 stopPropagation 时：window capture 消费后事件继续到 contenteditable
    // 的冒泡监听 → composer handleBareArrowNav 二次消费（defaultPrevented 幂等检查只挡
    // activeIndex 二次变更，不挡 composer 的方向键导航）→ dom-core 单视觉行 at-edge →
    // history setText 用上一条历史消息替换当前草稿。下方用例用真实 DOM 派发锁 capture/bubble
    // 全链路（window capture 注册 = useCommandPopoverKeyboard，target 冒泡 = useComposerKeydown）。
    it.each(['ArrowUp', 'ArrowDown'])(
      '浮层 open 且候选非空：%s 被完全消费（preventDefault + stopPropagation），事件不传到 contenteditable 冒泡监听',
      async (key) => {
        setupChain(true)
        await flushPromises()
        await nextTick()
        expect(document.body.querySelectorAll('.pop-item').length).toBeGreaterThan(0) // 造态自检：候选非空

        const bubbleSpy = vi.fn()
        target.addEventListener('keydown', bubbleSpy) // 注册在 composer 分发器之后：不截断则必被调用

        const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        target.dispatchEvent(e)

        expect(e.defaultPrevented).toBe(true) // window capture 侧已消费
        expect(e.cancelBubble).toBe(true) // stopPropagation 已截断
        expect(bubbleSpy).not.toHaveBeenCalled() // 事件未到达 contenteditable 冒泡监听（防穿透）
        expect(onSend).not.toHaveBeenCalled()
      },
    )

    it('对照：浮层空态行（候选为空）时 ↑ 仍放行——事件到达 contenteditable 冒泡监听（放行行为不变）', async () => {
      setupChain(true, { query: 'zzz' })
      await flushPromises()
      await nextTick()
      expect(document.body.querySelectorAll('.pop-item')).toHaveLength(0) // 造态自检：确为空候选

      const bubbleSpy = vi.fn()
      target.addEventListener('keydown', bubbleSpy)

      const e = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
      target.dispatchEvent(e)

      expect(e.defaultPrevented).toBe(true) // 被 composer 侧裸箭头导航消费（非浮层）
      expect(e.cancelBubble).toBe(false) // 浮层未截断
      expect(bubbleSpy).toHaveBeenCalledTimes(1) // 事件确实到达冒泡监听（放行）
    })

    it('浮层可见但候选为空：Escape 由浮层 DismissableLayer 兜底关闭（不被提前返回拦死）', async () => {
      await setupLandingFileEmptyChain()
      const handleKeydown = popoverWrapper!.vm.handleKeydown as (e: KeyboardEvent) => boolean

      const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      // 本层不消费（方向键/其他键在无候选项时放行）——浮层已渲染，Escape 交 reka DismissableLayer
      expect(handleKeydown(esc)).toBe(false)
      expect(esc.defaultPrevented).toBe(false)
    })

    it('IME composing 态（compositionstart 置 composingRef）：Enter 不选中浮层候选（只锁「浮层不选中」）', () => {
      // 本用例只锁浮层侧行为（composingRef 真值时 handleKeydown 不消费 Enter → 不选中候选）。
      // 不加 onSend 断言的原因：本用例的 target 是纯 div 直挂 composer 分发器，绕过产线上
      // 真正的 IME 防线——dom-core contenteditable.ts:242 的元素级 composing 检查（事件根本
      // 不会转发到 composer-keydown）。「IME 场景不发送」的有效锁在 dom-core contenteditable.test.ts
      // 「onKeydown IME 检查」用例；事件属性路径（e.isComposing=true）见下方用例。
      setupChain(true)
      // 组合发生在 composer 输入区（target），compositionstart 冒泡到 window capture 置 composingRef
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))

      dispatchEnter()

      expect(onSelect).not.toHaveBeenCalled()
    })

    it('IME composing 态（事件属性 isComposing）：Enter 不选中浮层候选、到达 composer 被 IME 检查放行不发送', () => {
      setupChain(true)

      dispatchEnter(true)

      expect(onSelect).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
    })

    it('浮层关闭：Enter 正常到达 composer → onSend（防截断误伤正常发送）', () => {
      setupChain(false)

      dispatchEnter()

      expect(onSelect).not.toHaveBeenCalled()
      expect(onSend).toHaveBeenCalledTimes(1)
    })
  })
})
})

