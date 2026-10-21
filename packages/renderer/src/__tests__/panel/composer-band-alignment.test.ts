/**
 * composer band（带壳）同缘契约测试（2026-10-11 缺陷修复防回归）。
 *
 * 契约：composer 带壳（Panel.vue 主面板 / BtwPanel.vue 旁路提问共用 COMPOSER_BAND_CLASS）
 * 左右内距必须与 MessageStream 滚动容器 px-[30px] 一致——履约 Composer.vue 宽度契约
 * 「composer 与消息流同宽同缘」：内容列未触及 720px 封顶的面板宽度下，composer 左右缘
 * 与消息列对齐。曾因 band px-3.5 与流 px-[30px] 漂移，窄面板下 composer 每侧外扩
 * ~18px（用户报告的「一圈额外宽度」）；旁路提问曾无带壳（composer 贴边满宽），与主
 * 面板几何关系分叉（demo 权威 specs/drawers.md .btw-composer 亦为带外距浮框）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者（白盒）：水平内距 token 同源断言——MessageStream.vue 滚动容器 class 从源码
 *   提取（readFileSync + 正则，btw-panel-contract-invisible.test.ts 在册先例），
 *   COMPOSER_BAND_CLASS 直接 import，两者 px token 必须相等
 * - 使用者（黑盒 DOM）：两个表面的 composer 都渲染在 .composer-band 带壳内
 * - 观察者（形态）：带壳挂 token class；主面板 band 是 section 直子级；旁路提问无
 *   选中线时带壳不渲染（与 composer 同生命周期，无空壳占位）
 *
 * mock 策略：Panel 复用 panel-mount-mocks 三连 + chat/session 窄 mock（同
 * Panel.inbound-frame-notice.test.ts 装配方）；BtwPanel 复用 btw-panel.test.ts 范式
 * （@/api 局部替换 btw 域 + MessageStream/Composer 占位 stub）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-band-alignment.test.ts
 */
// helper import 必须先于项目内模块（@/api mock factory 在模块图加载期执行，TDZ 约束同 composer-mount 各消费文件）
import { composerApiModuleActualWithBtw, composerBtwApiMock } from '../helpers/composer-mount'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils'
import { ref, nextTick } from 'vue'
import type { Ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { bindDrawerSessionId, _resetDrawerForTest } from '@taiji/core/domain/drawer'
import { COMPOSER_BAND_CLASS } from '@/components/panel/composer-band'
import Panel from '@/components/panel/Panel.vue'
import BtwPanel from '@/components/panel/BtwPanel.vue'
import {
  MessageStreamStub,
  panelChatMock,
  panelSessionMock,
} from '@/__tests__/helpers/panel-mount-mocks'

// ── 共享：从 MessageStream.vue 源码提取滚动容器水平内距 token ──

function resolveStreamSource(): string {
  const rel = 'components/panel/MessageStream.vue'
  const here = dirname(fileURLToPath(import.meta.url)) // …/src/__tests__/panel
  const candidates = [
    resolve(here, `../../${rel}`),
    resolve(process.cwd(), `src/${rel}`), // cwd = 包根
    resolve(process.cwd(), `packages/renderer/src/${rel}`), // cwd = 仓根
  ]
  const hit = candidates.find((p) => existsSync(p))
  if (!hit) throw new Error(`MessageStream.vue not found in candidates: ${candidates.join(', ')}`)
  return hit
}

/** 滚动容器 class 串（class="message-stream …"）内声明的全部 px token。 */
function streamHorizontalTokens(): string[] {
  const src = readFileSync(resolveStreamSource(), 'utf8')
  const m = /class="message-stream [^"]*"/.exec(src)
  if (!m) throw new Error('message-stream scroll container class not found — extraction regex drifted')
  return m[0].match(/px-\[[^\]]+\]/g) ?? []
}

function bandHorizontalTokens(): string[] {
  return COMPOSER_BAND_CLASS.match(/px-\[[^\]]+\]/g) ?? []
}

describe('同缘契约：band 与 MessageStream 水平内距 token 相等（构建者白盒）', () => {
  it('COMPOSER_BAND_CLASS 持有 .composer-band 钩子与水平 token，且与流滚动容器 px token 一致', () => {
    expect(COMPOSER_BAND_CLASS).toContain('composer-band')
    const stream = streamHorizontalTokens()
    const band = bandHorizontalTokens()
    expect(stream.length, '流滚动容器应声明水平内距 token（提取面有效）').toBeGreaterThan(0)
    expect(band.length, 'band 应声明水平内距 token').toBeGreaterThan(0)
    expect(band).toEqual(stream)
  })
})

// ── 主面板：band 结构位 + token 落地 ──

const coreMock = vi.hoisted(() => ({
  onInboundFrameDropped: vi.fn(),
  retryInboundDroppedSession: vi.fn(),
  subscribeSession: vi.fn(),
}))

vi.mock('@taiji/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taiji/core')>()),
  onInboundFrameDropped: coreMock.onInboundFrameDropped,
  retryInboundDroppedSession: coreMock.retryInboundDroppedSession,
  subscribeSession: coreMock.subscribeSession,
}))

/** Panel 挂载（空会话态 → band 渲染 composer；子组件全 stub，本文件只看结构位）。 */
function mountPanel(sessionId: string) {
  return mount(Panel, {
    props: { panelId: 'p1', sessionId, sessionDir: '/tmp/x' },
    global: {
      plugins: [createPinia()],
      stubs: {
        MessageStream: MessageStreamStub,
        Composer: { name: 'Composer', template: '<div data-testid="panel-composer-stub" />' },
        Landing: true,
        FormOverlay: true,
        PlanModeBar: true,
      },
    },
  })
}

describe('主面板：composer 渲染在 band 带壳内（使用者黑盒 + 观察者形态）', () => {
  beforeEach(() => {
    coreMock.onInboundFrameDropped.mockReset()
    coreMock.retryInboundDroppedSession.mockReset().mockReturnValue(false)
    coreMock.subscribeSession.mockReset().mockResolvedValue(undefined)
    panelChatMock.getMessages.mockReturnValue([])
    panelChatMock.failedHistory.clear()
    panelSessionMock.list = []
  })

  it('band 是 section 直子级、持有同缘 token、composer 渲染在带内', async () => {
    const wrapper = mountPanel('s1')
    await nextTick()
    const band = wrapper.find('.composer-band')
    expect(band.exists()).toBe(true)
    expect(band.element.parentElement?.tagName).toBe('SECTION')
    expect(band.classes().join(' ')).toContain(bandHorizontalTokens()[0])
    expect(band.find('[data-testid="panel-composer-stub"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

// ── 旁路提问：composer 在 band 带壳内 ──

vi.mock('@/api', (importActual) => composerApiModuleActualWithBtw(importActual))
// 断言锚点：btw 域 spy 单例（helper 持有，播种/断言经别名）
const apiMock = composerBtwApiMock
vi.mock('@/components/panel/MessageStream.vue', async () => {
  const { defineComponent: dc, h: hs } = await import('vue')
  return { default: dc({ name: 'MessageStream', setup: () => () => hs('div') }) }
})
vi.mock('@/components/panel/Composer.vue', async () => {
  const { defineComponent: dc, h: hs } = await import('vue')
  return { default: dc({ name: 'Composer', setup: () => () => hs('div') }) }
})

const MAIN_A = 's-band-a'
let boundSid: Ref<string | null>

function mountBtw(sessionId: string | null) {
  return mount(BtwPanel, { props: { sessionId } })
}

async function settle(wrapper: Awaited<ReturnType<typeof mountBtw>>) {
  await flushPromises()
  await nextTick()
  await nextTick()
}

enableAutoUnmount(afterEach)

describe('旁路提问：composer 与交互降档行同带（使用者黑盒）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    boundSid = ref<string | null>(MAIN_A)
    bindDrawerSessionId(boundSid)
    _resetDrawerForTest()
  })

  it('选中线时 composer 在 band 内、band 持同缘 token；无选中线时 band 不渲染（无空壳占位）', async () => {
    apiMock.list.mockResolvedValue([{ vid: 'btw:pi-1' }])
    const wrapper = mountBtw(MAIN_A)
    await settle(wrapper)

    const composer = wrapper.find('[data-testid="btw-composer"]')
    expect(composer.exists()).toBe(true)
    const band = wrapper.find('.composer-band')
    expect(band.exists()).toBe(true)
    expect(band.find('[data-testid="btw-composer"]').exists()).toBe(true)
    expect(band.classes().join(' ')).toContain(bandHorizontalTokens()[0])
    wrapper.unmount()

    // 无线（空态）：band 与 composer 同生命周期，不渲染空壳
    apiMock.list.mockResolvedValue([])
    const empty = mountBtw(MAIN_A)
    await settle(empty)
    expect(empty.find('[data-testid="btw-empty"]').exists()).toBe(true)
    expect(empty.find('.composer-band').exists()).toBe(false)
  })
})
