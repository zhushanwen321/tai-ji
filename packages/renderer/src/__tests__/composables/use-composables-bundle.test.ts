/**
 * 合并产物（round5-f S6，簇 3-6 拆对子集）。
 *
 * 来源五文件（describe/it 原样搬运）：
 * - useUrlBar.test.ts（21 例）
 * - useBrowserZoom.test.ts（11 例）
 * - useChat-submit-segments.test.ts（4 例，子目录 features/）
 * - useAppUpdate.pending.test.ts（9 例）
 * - modal-surface-event-order.test.ts（4 例，子目录 modal-surface-registry/）
 * 环境全默认（vitest.config happy-dom）。三组节 mock 互异（@/lib/ipc 两键桩 / @/api
 * project+chat+session 三域门面 / @taiji/ui markdown 桩），复筛已核互不入对方 SUT
 * 消费链（useUrlBar/useToast 仅依赖 vue + @taiji/shared；useChat 链无 @/lib/ipc 与
 * markdown；registry 仅 vue + type-only import）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, onBeforeUnmount, ref } from 'vue'
import type { LatestReleaseInfo, ServerMessage } from '@taiji/shared'
import { useUrlBar } from '@/composables/features/url-bar/useUrlBar'
import { useToast, setToastLimiter } from '@/composables/useToast'
import { useBrowserZoom } from '@/composables/features/browser/useBrowserZoom'
import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'

// ── useBrowserZoom 节 mock：@/lib/ipc 桩（避免 renderer 测试环境无 preload）──
const hoisted = vi.hoisted(() => ({
  browserGetZoom: vi.fn(() => Promise.resolve(1)),
  browserSetZoom: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/lib/ipc', () => ({
  browserGetZoom: hoisted.browserGetZoom,
  browserSetZoom: hoisted.browserSetZoom,
}))

// ── useChat-submit-segments 节 mock：@/api 部分门面（chatApi.submitDelivery/streamSubscribe 等）──
const apiMock = vi.hoisted(() => {
  const holder: { handler: ((msg: ServerMessage) => void) | null } = { handler: null }
  return {
    holder,
    streamSubscribe: vi.fn((_sid: string, handler: (msg: ServerMessage) => void) => {
      holder.handler = handler
      return () => {
        holder.handler = null
      }
    }),
    send: vi.fn(() => Promise.resolve()),
    // [u3c/D1] 统一提交入口（core submitSegments → delivery.submit）
    submitDelivery: vi.fn(() =>
      Promise.resolve({ clientUuid: 'u-mock', state: 'in-flight' as const, lane: 'direct' as const }),
    ),
    getHistory: vi.fn(() => Promise.resolve([])),
    abort: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: {
    streamSubscribe: apiMock.streamSubscribe,
    send: apiMock.send,
    submitDelivery: apiMock.submitDelivery,
    getHistory: apiMock.getHistory,
    abort: apiMock.abort,
    compact: apiMock.compact,
    followUp: apiMock.followUp,
  },
  session: {
    writeSegments: sessionDomainMock.writeSegments,
  },
}))

// ── useAppUpdate.pending 节：markdown 桩（stub import 必须先于 app-update-mount import）──
import { markdownStubModule } from '../helpers/app-update-markdown-stub'
import {
  ipc,
  controller,
  makeUpdateRelease,
  setupAppUpdate,
  setupAppUpdateLifecycle,
  type AppUpdateControllerInternal,
} from '../helpers/app-update-mount'

vi.mock('@taiji/ui/features/chat/markdown', () => markdownStubModule())

setupAppUpdateLifecycle({ primeIpc: true, markdownHtml: '<h2>新特性</h2>' })

// ── modal-surface-event-order 节（真实 registry，零 mock）──
import {
  registerModalSurface,
  anyModalSurfaceYieldsEsc,
  otherSurfaceYieldsEsc,
  resetModalSurfaceRegistry,
} from '@/composables/features/app/modal-surface-registry'
describe('useUrlBar', () => {
  let displayUrl: ReturnType<typeof ref<string>>
  let navigateFn: ReturnType<typeof vi.fn>
  let result: ReturnType<typeof useUrlBar>

  beforeEach(() => {
    displayUrl = ref('https://example.com')
    navigateFn = vi.fn()
    result = useUrlBar(displayUrl, navigateFn)
  })

  it('初始 urlInput = displayUrl', () => {
    expect(result.urlInput.value).toBe('https://example.com')
  })

  it('非编辑态：displayUrl 变化 → urlInput 同步', async () => {
    displayUrl.value = 'https://redirected.com'
    await Promise.resolve()
    expect(result.urlInput.value).toBe('https://redirected.com')
  })

  it('编辑态：displayUrl 变化 → urlInput 不覆盖', async () => {
    result.isEditingUrl.value = true
    result.urlInput.value = '用户正在输入'
    displayUrl.value = 'https://redirected.com'
    await Promise.resolve()
    expect(result.urlInput.value).toBe('用户正在输入')
  })

  it('回车裸域名 → 补全 https:// + 触发 navigate', () => {
    result.urlInput.value = 'github.com'
    result.onUrlEnter()
    expect(navigateFn).toHaveBeenCalledWith('https://github.com')
    expect(result.isEditingUrl.value).toBe(false)
  })

  it('回车完整 URL → 不重复补全', () => {
    result.urlInput.value = 'http://foo.bar/baz'
    result.onUrlEnter()
    expect(navigateFn).toHaveBeenCalledWith('http://foo.bar/baz')
  })

  it('回车 https URL → 不重复补全', () => {
    result.urlInput.value = 'HTTPS://UPPER.COM'
    result.onUrlEnter()
    expect(navigateFn).toHaveBeenCalledWith('HTTPS://UPPER.COM')
  })

  it('回车空输入 → 不触发 navigate', () => {
    result.urlInput.value = '   '
    result.onUrlEnter()
    expect(navigateFn).not.toHaveBeenCalled()
  })

  it('Escape → 回填 displayUrl + 不触发 navigate + preventDefault（§6.7 先行档契约）', () => {
    // 进入编辑态：与真实使用路径一致（聚焦后输入，Esc 在编辑态被消费）
    result.isEditingUrl.value = true
    result.urlInput.value = '未确认的输入'
    const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    result.onUrlEscape(evt)
    // §6.7 先行档：消费即 preventDefault（阻断编排器双动作——弃编辑 + 关浮层）
    expect(evt.defaultPrevented).toBe(true)
    expect(result.urlInput.value).toBe('https://example.com')
    expect(navigateFn).not.toHaveBeenCalled()
    expect(result.isEditingUrl.value).toBe(false)
  })

  it('非编辑态 Esc 不拦（§6.7 行为分界）：不 preventDefault，Esc 归编排器层级序', () => {
    // 未聚焦（isEditingUrl=false）：处理器不消费——结构上元素级监听仅在聚焦时收到真实按键，
    // 此处直调验证显式检查：不置位 defaultPrevented（编排器照常走层级序关浮层）
    const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    result.onUrlEscape(evt)
    expect(evt.defaultPrevented).toBe(false)
    expect(result.isEditingUrl.value).toBe(false)
  })

  it('聚焦 → 进入编辑态', () => {
    const fakeInput = { select: vi.fn() }
    const fakeEvent = { target: fakeInput } as unknown as FocusEvent
    result.onUrlFocus(fakeEvent)
    expect(result.isEditingUrl.value).toBe(true)
    expect(fakeInput.select).toHaveBeenCalled()
  })
})

/**
 * PR #100 S2：危险协议黑名单测试（renderer 第一层防御）。
 *
 * 三视角断言：
 * - 黑盒（行为）：navigateFn 不被调
 * - 状态：urlInput 保留 + isEditingUrl 保持 true（用户输入不被擦掉，便于修正）
 * - 形态：toast 推送（useToast 模块级 toasts ref 含对应 message）
 *
 * 黑名单：javascript:/data:/file:/blob:/chrome:/devtools:/about:/vbscript:
 * （与主进程 url-scheme-validators DANGEROUS_SCHEMES 对齐，独立函数不互相依赖）
 */
describe('useUrlBar — 危险协议拦截（PR #100 S2）', () => {
  let displayUrl: ReturnType<typeof ref<string>>
  let navigateFn: ReturnType<typeof vi.fn>
  let result: ReturnType<typeof useUrlBar>

  beforeEach(() => {
    displayUrl = ref('https://example.com')
    navigateFn = vi.fn()
    result = useUrlBar(displayUrl, navigateFn)
    // 进入编辑态：与真实使用路径一致（聚焦后输入）
    result.isEditingUrl.value = true
    // 禁用限流：8 个 dangerous scheme 用例共享 toast 状态，需要每个都能创建 toast
    setToastLimiter(() => false)
  })

  // 恢复默认限流
  afterEach(() => {
    setToastLimiter(null)
  })

  // 危险 scheme 表格：[scheme, sample-url]
  const dangerousCases: Array<[string, string]> = [
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['file:', 'file:///etc/passwd'],
    ['blob:', 'blob:https://example.com/abc-123'],
    ['chrome:', 'chrome://settings'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['devtools:', 'devtools://devtools/bundled/inspector.html'],
    ['about:', 'about:blank'],
  ]

  for (const [scheme, url] of dangerousCases) {
    it(`${scheme} 协议被拒：navigateFn 不调、urlInput 保留、isEditingUrl=true、toast 推送`, () => {
      // 注入用户输入
      result.urlInput.value = url

      // 记录 toast 数（beforeEach 无清理，跨测试累积）
      const { toasts } = useToast()
      const toastsBefore = toasts.value.length

      // 触发回车
      result.onUrlEnter()

      // 黑盒：navigateFn 未被调
      expect(navigateFn).not.toHaveBeenCalled()
      // 状态：urlInput 保留用户输入（便于修正）
      expect(result.urlInput.value).toBe(url)
      // 状态：保持编辑态
      expect(result.isEditingUrl.value).toBe(true)
      // 形态：toast 推送（toasts 数 +1，新 toast.message 含 scheme 提示）
      expect(toasts.value.length).toBe(toastsBefore + 1)
      const latest = toasts.value[toasts.value.length - 1]!
      expect(latest.type).toBe('error')
      expect(latest.message).toContain(scheme.toUpperCase())
    })
  }

  it('大小写不敏感：JAVASCRIPT: 大写变体被拒', () => {
    result.urlInput.value = 'JavaScript:alert(1)'
    result.onUrlEnter()

    expect(navigateFn).not.toHaveBeenCalled()
    expect(result.urlInput.value).toBe('JavaScript:alert(1)')
    expect(result.isEditingUrl.value).toBe(true)
  })

  it('危险 scheme 后接空格被拒（trim 后检测）', () => {
    result.urlInput.value = '  javascript:alert(1)  '
    result.onUrlEnter()

    expect(navigateFn).not.toHaveBeenCalled()
    expect(result.urlInput.value).toBe('  javascript:alert(1)  ')
  })

  it('普通 http URL 仍能通过（不被误拦截）', () => {
    result.urlInput.value = 'http://safe.example.com/page?q=1'
    result.onUrlEnter()

    expect(navigateFn).toHaveBeenCalledWith('http://safe.example.com/page?q=1')
  })
})

// ═══ 来源：useBrowserZoom.test.ts ═══
describe('useBrowserZoom', () => {
  beforeEach(() => {
    hoisted.browserGetZoom.mockClear()
    hoisted.browserSetZoom.mockClear()
    hoisted.browserGetZoom.mockResolvedValue(1)
  })

  it('初始 zoomFactor = 1.0（ZOOM_DEFAULT）', async () => {
    const { zoomFactor } = useBrowserZoom(ref('sess-1'))
    // watch immediate 会调 browserGetZoom，flush 后可能更新。先验初始值。
    expect(zoomFactor.value).toBe(1.0)
  })

  it('zoomIn 按 ZOOM_STEP(0.1) 增加并调 browserSetZoom', () => {
    const { zoomFactor, zoomIn } = useBrowserZoom(ref('sess-1'))
    const before = zoomFactor.value
    zoomIn()
    expect(zoomFactor.value).toBe(before + 0.1)
    expect(hoisted.browserSetZoom).toHaveBeenCalledWith('sess-1', zoomFactor.value)
  })

  it('zoomOut 按 ZOOM_STEP(0.1) 减少并调 browserSetZoom', () => {
    const { zoomFactor, zoomOut } = useBrowserZoom(ref('sess-1'))
    const before = zoomFactor.value
    zoomOut()
    expect(zoomFactor.value).toBe(before - 0.1)
    expect(hoisted.browserSetZoom).toHaveBeenCalledWith('sess-1', zoomFactor.value)
  })

  it('zoomReset 回到 1.0 并调 browserSetZoom', () => {
    const { zoomFactor, zoomIn, zoomReset } = useBrowserZoom(ref('sess-1'))
    zoomIn()
    zoomIn()
    expect(zoomFactor.value).toBeGreaterThan(1.0)
    zoomReset()
    expect(zoomFactor.value).toBe(1.0)
    expect(hoisted.browserSetZoom).toHaveBeenLastCalledWith('sess-1', 1.0)
  })

  it('zoomOut 不低于 ZOOM_MIN(0.25)', () => {
    const { zoomFactor, zoomOut } = useBrowserZoom(ref('sess-1'))
    // 连续缩 20 次，应被钳制在 0.25
    for (let i = 0; i < 20; i++) zoomOut()
    expect(zoomFactor.value).toBe(0.25)
  })

  it('zoomIn 不超过 ZOOM_MAX(5.0)', () => {
    const { zoomFactor, zoomIn } = useBrowserZoom(ref('sess-1'))
    // 连续放大 50 次，应被钳制在 5.0
    for (let i = 0; i < 50; i++) zoomIn()
    expect(zoomFactor.value).toBe(5.0)
  })

  it('setZoomFromRemote：更新本地 ref 但不调 browserSetZoom（避免循环）', () => {
    const { zoomFactor, setZoomFromRemote } = useBrowserZoom(ref('sess-1'))
    hoisted.browserSetZoom.mockClear()
    // 模拟主进程 autoFit 回推 0.75（百度在窄 panel 里）
    setZoomFromRemote(0.75)
    expect(zoomFactor.value).toBe(0.75)
    // 关键：不调 browserSetZoom（否则 renderer→主进程→renderer 死循环）
    expect(hoisted.browserSetZoom).not.toHaveBeenCalled()
  })

  it('setZoomFromRemote 也钳制到 ZOOM_MIN~ZOOM_MAX', () => {
    const { zoomFactor, setZoomFromRemote } = useBrowserZoom(ref('sess-1'))
    setZoomFromRemote(0.1)
    expect(zoomFactor.value).toBe(0.25)
    setZoomFromRemote(10)
    expect(zoomFactor.value).toBe(5.0)
  })

  it('setZoomFromRemote 后用户 zoomIn 在新基准上递增', () => {
    const { zoomFactor, setZoomFromRemote, zoomIn } = useBrowserZoom(ref('sess-1'))
    // autoFit 缩到 0.75，用户在此基础上放大
    setZoomFromRemote(0.75)
    zoomIn()
    expect(zoomFactor.value).toBe(0.85) // 0.75 + 0.1
  })

  it('sessionId 变化时 watch 触发 browserGetZoom 读回主进程 zoom', async () => {
    hoisted.browserGetZoom.mockResolvedValue(0.6)
    const sid = ref('sess-1')
    const { zoomFactor } = useBrowserZoom(sid)
    await Promise.resolve()
    // 初始 immediate watch 已读 sess-1 的 zoom
    expect(hoisted.browserGetZoom).toHaveBeenCalledWith('sess-1')

    // 切 session
    sid.value = 'sess-2'
    await Promise.resolve()
    await Promise.resolve()
    expect(hoisted.browserGetZoom).toHaveBeenCalledWith('sess-2')
    expect(zoomFactor.value).toBe(0.6)
  })

  it('onZoomKeydown：Cmd+= / Cmd+- / Cmd+0 触发对应缩放，其他键不消费', () => {
    const { zoomFactor, onZoomKeydown } = useBrowserZoom(ref('sess-1'))
    const before = zoomFactor.value

    // 非 Cmd 组合 → 不消费
    expect(onZoomKeydown({ metaKey: false, ctrlKey: false, key: '=', preventDefault: () => {} } as KeyboardEvent)).toBe(false)
    expect(zoomFactor.value).toBe(before)

    // Cmd+= → zoomIn（消费）
    const e1 = { metaKey: true, ctrlKey: false, key: '=', preventDefault: vi.fn() } as unknown as KeyboardEvent
    expect(onZoomKeydown(e1)).toBe(true)
    expect(e1.preventDefault).toHaveBeenCalled()
    expect(zoomFactor.value).toBe(before + 0.1)

    // Cmd+- → zoomOut（消费）
    const before2 = zoomFactor.value
    const e2 = { metaKey: true, ctrlKey: false, key: '-', preventDefault: vi.fn() } as unknown as KeyboardEvent
    expect(onZoomKeydown(e2)).toBe(true)
    expect(zoomFactor.value).toBe(before2 - 0.1)

    // Cmd+0 → zoomReset（消费）
    const e3 = { metaKey: true, ctrlKey: false, key: '0', preventDefault: vi.fn() } as unknown as KeyboardEvent
    expect(onZoomKeydown(e3)).toBe(true)
    expect(zoomFactor.value).toBe(1.0)
  })
})

// ═══ 来源：features/useChat-submit-segments.test.ts ═══
// ── session domain mock：writeSegments 捕获 sidecar 写入（clientUuid + segments 回填用）──
const sessionDomainMock = vi.hoisted(() => ({
  writeSegments: vi.fn(() => Promise.resolve()),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
  apiMock.holder.handler = null
  sessionDomainMock.writeSegments.mockResolvedValue(undefined)
})

// ── SS1: send(含 image) → submitSegments → chatApi.submitDelivery 路径模式 ──

describe('submitSegments 统一通路：send', () => {
  it('SS1: send(含 image) → submitDelivery(sessionId, promptText, clientUuid)，promptText 含裸路径 + clientUuid 标记', async () => {
    const { send } = useChat()
    await send('ss-send', [
      { type: 'text', text: 'look' },
      { type: 'image', id: 'img-x', path: '/tmp/x.png', fileName: 'x-uuid.png', displayName: 'x.png' },
    ])

    expect(apiMock.submitDelivery).toHaveBeenCalledTimes(1)
    const call = apiMock.submitDelivery.mock.calls[0]!
    expect(call[0]).toBe('ss-send')
    // promptText 含裸路径（图片走路径模式，对齐 pi TUI）
    expect(call[1]).toContain('/tmp/x.png')
    // 不含匿名占位 [图片 N]（已弃用）
    expect(call[1]).not.toContain('[图片')
    // promptText 末尾含 clientUuid 标记（pi extension input hook 剥离 + 写 custom entry）
    // 标记格式严格：<!--taiji:msg:u-<uuid>-->，clientUuid 是 appendUser 生成的 message id
    expect(call[1]).toMatch(/\n<!--taiji:msg:u-[0-9a-fA-F-]{36}-->$/)
    // 第 3 参 = clientUuid（[u3c/D1] delivery.submit 条目 id，与标记同源）；images 位不传（路径模式）
    expect(call[2]).toEqual(expect.stringMatching(/^u-[0-9a-fA-F-]{36}$/))
    expect(call[3]).toBeUndefined()
    // 第 3 参与 prompt 标记里的 uuid 一致（同一 user message 的双通路标识）
    const ss1MarkerUuid = (call[1] as string).match(/<!--taiji:msg:(u-[0-9a-fA-F-]{36})-->/)![1]
    expect(call[2]).toBe(ss1MarkerUuid)

    // writeSegmentsMetadata 被调（写 segments.json sidecar，clientUuid 关联回填用）
    expect(sessionDomainMock.writeSegments).toHaveBeenCalledTimes(1)
    const sidecarCall = sessionDomainMock.writeSegments.mock.calls[0]![0]
    expect(sidecarCall.sessionId).toBe('ss-send')
    expect(sidecarCall.entry.clientUuid).toMatch(/^u-[0-9a-fA-F-]{36}$/)
    // sidecar 的 clientUuid 必须与 prompt 标记里的 uuid 一致（同一 user message 的映射键）
    const markerUuid = (call[1] as string).match(/<!--taiji:msg:(u-[0-9a-fA-F-]{36})-->/)![1]
    expect(sidecarCall.entry.clientUuid).toBe(markerUuid)
    expect(sidecarCall.entry.segments).toHaveLength(2)
    expect(sidecarCall.entry.timestamp).toBeTypeOf('number')
  })

  it('SS4: send(text-only) → promptText 无 clientUuid 标记 + 不写 sidecar（最小写入，clientUuid 仍透传）', async () => {
    const { send } = useChat()
    await send('ss-send-text', [{ type: 'text', text: '纯文本消息' }])

    expect(apiMock.submitDelivery).toHaveBeenCalledTimes(1)
    const call = apiMock.submitDelivery.mock.calls[0]!
    expect(call[0]).toBe('ss-send-text')
    // 纯文本轮不加标记（textToSegments 降级与结构化回填渲染等价，无需映射）
    expect(call[1]).toBe('纯文本消息')
    expect(call[1]).not.toMatch(/<!--taiji:msg:/)
    // clientUuid 恒透传（delivery.submit 条目 id / 回执锚，纯文本轮同样必需）
    expect(call[2]).toEqual(expect.stringMatching(/^u-[0-9a-fA-F-]{36}$/))
    // 纯文本轮不写 sidecar（不变式：sidecar 条目存在 ⟺ 映射 custom entry 存在）
    expect(sessionDomainMock.writeSegments).not.toHaveBeenCalled()
  })
})

// ── SS2/SS3: editAndResend 委托 submitSegments ──

describe('submitSegments 统一通路：editAndResend', () => {
  it('SS2: editAndResend(含 image) → 委托 submitSegments → promptText 路径进 promptText（不丢）', async () => {
    const chat = useChatStore()
    // 先注入原 user message（供 truncateFrom 操作）
    chat.appendUser('ss-edit', [{ type: 'text', text: '原问题' }])
    const userMsg = chat.getMessages('ss-edit').find((m) => m.role === 'user')!

    const { editAndResend } = useChat()
    // 阶段 3a：editAndResend 接收 segments（不再是 text 字符串），保留 image segments
    await editAndResend('ss-edit', userMsg.id, [
      { type: 'text', text: 'edited text' },
      { type: 'image', id: 'img-edit', path: '/tmp/edit.png', fileName: 'edit-uuid.png', displayName: 'edit.png' },
    ])

    expect(apiMock.submitDelivery).toHaveBeenCalledTimes(1)
    const call = apiMock.submitDelivery.mock.calls[0]!
    expect(call[0]).toBe('ss-edit')
    // promptText 含编辑后文本 + 裸路径
    expect(call[1]).toContain('edited text')
    expect(call[1]).toContain('/tmp/edit.png')
    // 第 3 参 = clientUuid（D2/D1 透传）；images 位不传（路径模式）
    expect(call[2]).toEqual(expect.stringMatching(/^u-[0-9a-fA-F-]{36}$/))
    expect(call[3]).toBeUndefined()
  })

  it('SS3: editAndResend(text-only) → promptText（与 send 对齐）', async () => {
    const chat = useChatStore()
    chat.appendUser('ss-edit-text', [{ type: 'text', text: '原问题' }])
    const userMsg = chat.getMessages('ss-edit-text').find((m) => m.role === 'user')!

    const { editAndResend } = useChat()
    await editAndResend('ss-edit-text', userMsg.id, [{ type: 'text', text: 'edited' }])

    expect(apiMock.submitDelivery).toHaveBeenCalledTimes(1)
    const call = apiMock.submitDelivery.mock.calls[0]!
    expect(call[0]).toBe('ss-edit-text')
    // promptText 含编辑后文本；纯文本轮不加 clientUuid 标记后缀（最小写入，与 send 同通路）
    expect(call[1]).toContain('edited')
    expect(call[1]).not.toMatch(/<!--taiji:msg:/)
    // 纯文本轮不写 sidecar（不变式：sidecar 条目存在 ⟺ 映射 custom entry 存在）
    expect(sessionDomainMock.writeSegments).not.toHaveBeenCalled()
    // clientUuid 恒透传（与 send 同通路）；images 位不传
    expect(call[2]).toEqual(expect.stringMatching(/^u-[0-9a-fA-F-]{36}$/))
    expect(call[3]).toBeUndefined()
  })
})

// 引用 useChatStore 避免 ts unused
void useChatStore

// ═══ 来源：useAppUpdate.pending.test.ts ═══
/** 恢复 pending 前置：mock getPendingUpdate 返回值 → 订阅 → 执行 restore（断言留在用例） */
async function restorePendingRelease(release: LatestReleaseInfo | null): Promise<{
  result: AppUpdateControllerInternal
  stop: () => void
}> {
  ipc.getPendingUpdate.mockResolvedValue(release)
  const handle = setupAppUpdate()
  await controller.restorePendingUpdate()
  return handle
}

describe('useAppUpdate 功能1：持久化升级提醒标志', () => {
  it('PENDING-TC1：restorePendingUpdate 从 getPendingUpdate 恢复「可升级」提醒', async () => {
    const { result, stop } = await restorePendingRelease(makeUpdateRelease('0.9.0'))

    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    // releaseNotes 异步渲染，waitFor 等 html 填充
    await vi.waitFor(() => {
      expect(result.state.releaseNotesHtml).toBe('<h2>新特性</h2>')
    })
    expect(ipc.getPendingUpdate).toHaveBeenCalledOnce()
    stop()
  })

  it('PENDING-TC2：getPendingUpdate 返回 null → 不恢复提醒，state 保持 idle', async () => {
    const { result, stop } = await restorePendingRelease(null)

    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    stop()
  })

  it('PENDING-TC3：防覆盖检查——pending 恢复后 checkForUpdate 失败不回退 idle', async () => {
    const { result, stop } = await restorePendingRelease(makeUpdateRelease('0.9.0'))
    expect(result.state.state).toBe('available')

    // 模拟 30s 后联网检测失败（网络断开）
    ipc.checkForUpdate.mockRejectedValue(new Error('network error'))
    await result.checkForUpdate()

    // 防覆盖检查：pendingRestored=true 时检测失败不回退 idle，保持 available
    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    stop()
  })

  it('PENDING-TC4：防覆盖检查——pending 恢复后 checkForUpdate 返回 null 不回退 idle', async () => {
    const { result, stop } = await restorePendingRelease(makeUpdateRelease('0.9.0'))
    expect(result.state.state).toBe('available')

    // 模拟 30s 后联网检测无新版（null）
    ipc.checkForUpdate.mockResolvedValue({ info: null, rateLimited: false })
    await result.checkForUpdate()

    // 防覆盖检查：pendingRestored=true 时无新版不回退 idle（pending 标志证明曾检测到更新）
    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.0')
    stop()
  })

  it('PENDING-TC5：pending 恢复后 checkForUpdate 确认有新版 → 正常刷新 latestRelease', async () => {
    // 恢复的 pending 是 v0.9.0
    const { result, stop } = await restorePendingRelease(makeUpdateRelease('0.9.0'))
    expect(result.state.latestRelease?.version).toBe('0.9.0')

    // 联网检测到更新的 v0.9.5
    ipc.checkForUpdate.mockResolvedValue({ info: makeUpdateRelease('0.9.5'), rateLimited: false })
    await result.checkForUpdate()

    // 确认有新版 → 正常刷新（latestRelease 更新为 v0.9.5）
    expect(result.state.state).toBe('available')
    expect(result.state.latestRelease?.version).toBe('0.9.5')
    stop()
  })

  it('PENDING-TC6：无 pending 恢复时，checkForUpdate 失败正常回退 idle（检查不影响正常流程）', async () => {
    // 无 pending → pendingRestored 保持 false
    const { result, stop } = await restorePendingRelease(null)
    expect(result.state.state).toBe('idle')

    // 联网检测失败
    ipc.checkForUpdate.mockRejectedValue(new Error('network error'))
    await result.checkForUpdate()

    // 正常流程（非 pending 恢复）：检测失败 → 回退 idle（检查只在 pendingRestored 时生效）
    expect(result.state.state).toBe('idle')
    stop()
  })

  it('PENDING-TC7（I#8）：getPendingUpdate reject（IPC 异常）→ restorePendingUpdate catch 分支：state 保持 idle、不抛错', async () => {
    // 模拟 IPC 通道异常（如 preload 桥未就绪 / ipcRenderer.invoke reject）
    ipc.getPendingUpdate.mockRejectedValue(new Error('ipc fail'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result, stop } = setupAppUpdate()

    // restorePendingUpdate 是 best-effort：catch 后不 re-throw，state 不变
    await expect(controller.restorePendingUpdate()).resolves.toBeUndefined()

    // state 保持初始 idle，latestRelease 未被污染
    expect(result.state.state).toBe('idle')
    expect(result.state.latestRelease).toBeNull()
    // 失败信息经 console.warn 诊断（不进 errorMessage，避免 idle 态残留）
    expect(warnSpy).toHaveBeenCalledWith(
      '[useAppUpdate] restorePendingUpdate failed:',
      expect.any(Error),
    )
    warnSpy.mockRestore()
    stop()
  })

  it('PENDING-TC8（I#9）：initAutoCheck 完整启动序列——先同步触发 restorePendingUpdate，30s 后触发 checkForUpdate', async () => {
    // AUTO_CHECK_DELAY_MS = 30_000（use-app-update-autocheck.ts 未导出常量，用字面量并注明）
    const AUTO_CHECK_DELAY_MS = 30_000
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // pending 恢复成功（立即触发，不等 30s）
    ipc.getPendingUpdate.mockResolvedValue(makeUpdateRelease('0.9.0'))
    // 30s 后联网检测确认有更新版本
    ipc.checkForUpdate.mockResolvedValue({ info: makeUpdateRelease('0.9.5'), rateLimited: false })
    const { result, stop } = setupAppUpdate()

    // initAutoCheck 必须在活跃 effect scope 内调（onScopeDispose 注册 timer 清理）
    result.initAutoCheck()

    // 1. 启动序列先触发 restorePreloadedUpdate（getPreloaded），无预下载产物后再
    //    restorePendingUpdate（getPendingUpdate）。两者都是 async，需 flush 微任务
    await vi.waitFor(() => {
      expect(ipc.getPreloaded).toHaveBeenCalledOnce()
    })
    await vi.waitFor(() => {
      expect(ipc.getPendingUpdate).toHaveBeenCalledOnce()
    })
    await vi.waitFor(() => {
      expect(result.state.state).toBe('available')
      expect(result.state.latestRelease?.version).toBe('0.9.0')
    })
    // 此时 30s 定时器尚未到期，checkForUpdate 不应被调
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()

    // 2. 推进 30s：联网检测被触发（刷新 release info）
    vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS)
    await vi.waitFor(() => {
      expect(ipc.checkForUpdate).toHaveBeenCalledOnce()
    })
    // 联网检测确认 v0.9.5 → latestRelease 被刷新
    await vi.waitFor(() => {
      expect(result.state.latestRelease?.version).toBe('0.9.5')
    })
    expect(result.state.state).toBe('available')

    warnSpy.mockRestore()
    vi.useRealTimers()
    stop()
  })

  it('PENDING-TC9（I#9 补充）：initAutoCheck 在 30s 内不触发 checkForUpdate（定时器语义正确，不提前检测）', async () => {
    const AUTO_CHECK_DELAY_MS = 30_000
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    ipc.getPendingUpdate.mockResolvedValue(null)
    ipc.checkForUpdate.mockResolvedValue({ info: makeUpdateRelease('0.9.0'), rateLimited: false })
    const { result, stop } = setupAppUpdate()

    result.initAutoCheck()
    await vi.waitFor(() => {
      expect(ipc.getPendingUpdate).toHaveBeenCalledOnce()
    })

    // 推进 29s（差 1s 到期）→ checkForUpdate 仍不应被调
    vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS - 1_000)
    expect(ipc.checkForUpdate).not.toHaveBeenCalled()
    // pending 为 null → state 保持 idle
    expect(result.state.state).toBe('idle')

    // 再推进 1s 达到 30s → checkForUpdate 触发
    vi.advanceTimersByTime(1_000)
    await vi.waitFor(() => {
      expect(ipc.checkForUpdate).toHaveBeenCalledOnce()
    })

    warnSpy.mockRestore()
    vi.useRealTimers()
    stop()
  })
})

// ═══ 来源：modal-surface-registry/modal-surface-event-order.test.ts ═══
/** 编排器模拟（§6.7 检查两重：defaultPrevented 先检 → 聚合让位 → 层级序剥层） */
type Decision = 'skip-prevented' | 'yield' | 'act'
const decisions: Decision[] = []
function onOrchestratorKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (e.defaultPrevented) {
    decisions.push('skip-prevented')
    return
  }
  if (anyModalSurfaceYieldsEsc()) {
    decisions.push('yield')
    return
  }
  decisions.push('act')
}

function esc(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
}

beforeEach(() => {
  resetModalSurfaceRegistry()
  decisions.length = 0
})

afterEach(() => {
  window.removeEventListener('keydown', onOrchestratorKeydown)
  document.body.innerHTML = ''
})

describe('A. 编排器先行 + flush 翻新（reka 弹出层族形态）', () => {
  it('第一次 Esc 让位（弹层还开着）→ flush 后聚合已关 → 第二次 Esc 才走层级序', async () => {
    // 编排器先注册（AppShell 根 setup 位次），FIFO 同相位先于弹层挂载后的任何监听
    window.addEventListener('keydown', onOrchestratorKeydown)

    const surfaceOpen = ref(true)
    const dismisses = ref(0)
    // 弹层成员：挂载⇔开（注册随挂载、注销随卸载——开合态翻新走 flush 的实装形态）；
    // 自带 dismiss 监听（后行注册，reka DismissableLayer 同款：只关自己、不 preventDefault）
    const Surface = defineComponent({
      setup() {
        const dispose = registerModalSurface({
          surface: 'popover-content',
          key: 'evt-popover',
          isOpen: () => true,
        })
        onBeforeUnmount(dispose)
        const onDismiss = (): void => {
          dismisses.value += 1
          surfaceOpen.value = false
        }
        window.addEventListener('keydown', onDismiss)
        onBeforeUnmount(() => window.removeEventListener('keydown', onDismiss))
        return () => h('div', { 'data-testid': 'surface' }, '弹层开着')
      },
    })
    const Host = defineComponent({
      setup() {
        return () => h('div', surfaceOpen.value ? h(Surface) : h('span', { 'data-testid': 'surface-gone' }, '弹层已关'))
      },
    })
    const wrapper = mount(Host, { attachTo: document.body })

    // 用户可见 DOM：弹层在场
    expect(document.querySelector('[data-testid="surface"]')).not.toBeNull()
    expect(anyModalSurfaceYieldsEsc()).toBe(true)

    // 第一次 Esc（真实事件）
    window.dispatchEvent(esc())
    expect(decisions).toEqual(['yield'])
    expect(dismisses.value).toBe(1)
    expect(surfaceOpen.value, 'dismiss 已置关（更新在 flush）').toBe(false)

    // flush（微任务）：卸载 + 注销完成——真实输入的相邻按键跨宏任务，此间必收敛
    await nextTick()
    expect(document.querySelector('[data-testid="surface"]'), '弹层 DOM 已卸').toBeNull()
    expect(document.querySelector('[data-testid="surface-gone"]')).not.toBeNull()
    expect(anyModalSurfaceYieldsEsc(), '第二次按键前聚合已是已关').toBe(false)

    // 第二次 Esc：让位不再发生，层级序剥层
    window.dispatchEvent(esc())
    expect(decisions).toEqual(['yield', 'act'])
    expect(dismisses.value, '弹层已关后不再消费 Esc').toBe(1)

    wrapper.unmount()
  })
})

describe('B. document 先行消费方同步清态（PlanCommentPopover 形态反例）', () => {
  const onBeforeUnmountCleanup: Array<() => void> = []

  afterEach(() => {
    while (onBeforeUnmountCleanup.length > 0) onBeforeUnmountCleanup.pop()!()
  })

  /** 文档级消费方模拟：先行于 window bubble 执行；withPreventDefault=真=先行档契约，假=退化形态 */
  function mountDocConsumer(withPreventDefault: boolean): { selOpen: () => boolean } {
    const selOpen = ref(true)
    registerModalSurface({
      surface: 'form-overlay',
      key: 'evt-doc-surface',
      isOpen: () => selOpen.value,
    })
    const onDocKeydown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !selOpen.value) return
      if (withPreventDefault) e.preventDefault()
      selOpen.value = false // 同步清状态本体（dismiss 同款）
    }
    document.addEventListener('keydown', onDocKeydown)
    onBeforeUnmountCleanup.push(() => document.removeEventListener('keydown', onDocKeydown))
    return { selOpen: () => selOpen.value }
  }

  it('不 preventDefault（退化形态）：编排器读到「已关」进层级序——同一 Esc 双动作击穿', () => {
    window.addEventListener('keydown', onOrchestratorKeydown)
    const consumer = mountDocConsumer(false)

    // 事件派发到 document（传播路径 document → window bubble：document 监听先执行）
    document.dispatchEvent(esc())
    expect(consumer.selOpen(), '文档级消费方已同步清态').toBe(false)
    // 退化形态断言：聚合直读已关 ⇒ 编排器在**同一 Esc** 上再剥一层容器（双动作）
    expect(decisions).toEqual(['act'])
  })

  it('preventDefault（先行档契约）：编排器检查一跳过——一次 Esc 单动作', () => {
    window.addEventListener('keydown', onOrchestratorKeydown)
    const consumer = mountDocConsumer(true)

    document.dispatchEvent(esc())
    expect(consumer.selOpen(), '浮条/浮层已关').toBe(false)
    expect(decisions, 'defaultPrevented 已置位 ⇒ 编排器不动作').toEqual(['skip-prevented'])
  })
})

// ── C. otherSurfaceYieldsEsc（settings 壳内层让位，demo settings spec §3.2 三段分流）──
// 复合容器壳（SettingsModal）的自身 Esc 通路在「内层确认弹层 / 下拉 / popover 开着」时
// 须让位（reka DismissableLayer 自行 dismiss 且不 preventDefault，事件必然冒泡到壳监听）。
// exclude = 壳自身（settings-modal 也持 yieldsEsc 旗标，不排除则恒真）。
describe('C. otherSurfaceYieldsEsc（容器壳内层让位）', () => {
  function mountFlagSurface(surface: 'settings-modal' | 'dialog-confirm' | 'select-content', open: () => boolean): void {
    const Host = defineComponent({
      setup(_, { expose }) {
        const dispose = registerModalSurface({ surface, key: `k-${surface}`, isOpen: open })
        onBeforeUnmount(dispose)
        expose({})
        return () => h('div')
      },
    })
    mount(Host)
  }

  it('内层 dialog-confirm / select-content 开着 ⇒ 壳（settings-modal）让位；全关 ⇒ 不让位', () => {
    // 壳自身开着（exclude 生效性前提）：仅自身 ⇒ 不让位
    mountFlagSurface('settings-modal', () => true)
    expect(otherSurfaceYieldsEsc('settings-modal')).toBe(false)

    // 内层确认弹层开着 ⇒ 让位
    mountFlagSurface('dialog-confirm', () => true)
    expect(otherSurfaceYieldsEsc('settings-modal')).toBe(true)

    // 确认弹层关、下拉开 ⇒ 仍让位（Esc 归下拉——demo spec §3.2 第二段，防 Esc 死区反面）
    mountFlagSurface('dialog-confirm', () => false)
    mountFlagSurface('select-content', () => true)
    expect(otherSurfaceYieldsEsc('settings-modal')).toBe(true)

    // 全关 ⇒ 不让位（壳自关通道恢复）
    mountFlagSurface('select-content', () => false)
    expect(otherSurfaceYieldsEsc('settings-modal')).toBe(false)
  })
})
