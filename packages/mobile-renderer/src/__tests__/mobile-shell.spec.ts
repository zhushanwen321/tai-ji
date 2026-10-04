// AC5 结构断言测试套件（W2 建立；remote-use U1.4c 多视图重排改写 TC-1/TC-2，
// BM5 断连不换视图新增视图分支用例；TC-3 挂载点注册与 TC-7 main.ts 源码文本断言
// 随死模块删除/测试锚点解除移除）。
//
// 覆盖（TC-6 构建验收由 cw test gate 的 build 步骤单独跑）：
//   TC-1: mount(App) 多视图态断言（列表视图 / 聊天视图 / token 输入视图 / 连接中，U1.4c 改写）
//   TC-2: SlashBarStub 隐藏保留断言（DOM 层：hidden class + testid 留 DOM，源码文本正则已删）
//   TC-4: createMobilePlatformAdapter 满足 core PlatformPort 契约（IF2）
//   TC-5: providePlatform/getPlatform 注入链路通（经 bootstrap）
//   BM5:  断线重连中保持 connected 布局 + 顶部断线条（failed 全屏 / 首连全屏连接中）
//   TC-8: Tailwind 样式入口防回归
//
// 从 vitest 导入（禁 node:test / tsx --test）。运行：npx vitest run。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { disconnect, getPlatform, useConnection, __resetPlatformForTesting } from '@taiji/core'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import App from '../App.vue'
import { i18n } from '../i18n'
import { sessionStore } from '../shell/app-runtime'
import { createMobilePlatformAdapter } from '../platform/mobile-platform-adapter'
import { bootstrap } from '../bootstrap'
// 连接视图态（W6 起本体在 shell/connection-view；直改 ref 驱动视图断言的操纵形态不变）
import { hasConnectedOnce, shellConnectionState } from '../shell/connection-view'

// vitest 运行时 cwd 即包根（vitest.config.ts 所在目录）
const pkgRoot = process.cwd()

// TC-5 用：原生 WebSocket 替身（U1.3 起 bootstrap 含连接编排序列，经 adapter 工厂创建
// 原生 WebSocket 实例——替身阻断真实连接尝试；adapter/webSocket 的契约断言在 TC-4）
class StubWebSocket {
  readyState = 0
  onopen: unknown = null
  onclose: unknown = null
  onmessage: unknown = null
  onerror: unknown = null
  send(): void {}
  close(): void {}
}

function mountApp() {
  return mount(App, { global: { plugins: [i18n] } })
}

describe('TC-1: AC5 多视图态结构断言（U1.4c 多视图重排）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  it('connecting 态渲染轻量连接中视图（无 tab bar / 无列表）', () => {
    wrapper = mountApp()
    expect(wrapper.find('[data-testid="shell-connecting"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-tab-bar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-session-list"]').exists()).toBe(false)
  })

  it('token-input 态渲染 token 表单（token-input-view testid）', () => {
    shellConnectionState.value = 'token-input'
    wrapper = mountApp()
    expect(wrapper.find('[data-testid="token-input-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="token-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="token-submit"]').exists()).toBe(true)
  })

  it('connected 列表视图渲染列表容器 + bottom-tab-bar', () => {
    // 直接置态复现 connection-view watch 的置位序（connected 蕴含 hasConnectedOnce，BM5 分支锚点）
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    wrapper = mountApp()
    expect(wrapper.find('[data-testid="mobile-session-list"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-tab-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-tab-sessions"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-tab-chat"]').exists()).toBe(true)
  })

  it('connected 聊天视图渲染 message-stream + companion + slash 隐藏保留 + 输入条 + bottom-tab-bar', async () => {
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    sessionStore.setActiveId('sid-tc1')
    wrapper = mountApp()
    await wrapper.get('[data-testid="mobile-tab-chat"]').trigger('click')
    expect(wrapper.find('[data-testid="zone-message-stream"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-message-stream"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="zone-companion"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="zone-slash"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="stub-slash"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-composer-send"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-tab-bar"]').exists()).toBe(true)
  })
})

describe('TC-2: AC5 SlashBarStub 隐藏保留（DOM 层断言）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  it('聊天视图内 zone-slash 容器 + stub-slash testid 在场且隐藏（不裸渲染占位文案）', async () => {
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    sessionStore.setActiveId('sid-tc2')
    wrapper = mountApp()
    await wrapper.get('[data-testid="mobile-tab-chat"]').trigger('click')
    expect(wrapper.find('[data-testid="zone-slash"]').exists()).toBe(true)
    const stub = wrapper.get('[data-testid="stub-slash"]')
    // 不可见断言走 DOM 属性（class）而非源码文本：项目 SSOT `.hidden { display: none }`；
    // happy-dom 的 getComputedStyle 不解析样式表，computed display 断言不可用
    expect(stub.classes()).toContain('hidden')
    expect(stub.text()).toBe('')
  })
})

describe('TC-4: AC5 createMobilePlatformAdapter 满足 core PlatformPort 契约', () => {
  it('kind === "mobile" 且两端口字段存在（storage/webSocket；ipc 已从契约删除）', () => {
    const adapter = createMobilePlatformAdapter()
    expect(adapter.kind).toBe('mobile')
    expect(adapter.storage).toBeDefined()
    expect(adapter.webSocket).toBeDefined()
    expect('ipc' in adapter).toBe(false)
  })

  it('storage.get 不存在 key 返回 null（非抛错）', async () => {
    const adapter = createMobilePlatformAdapter()
    expect(await adapter.storage.get('missing-key')).toBeNull()
  })

  it('storage.set + get 读写通', async () => {
    const adapter = createMobilePlatformAdapter()
    await adapter.storage.set('k', 'v')
    expect(await adapter.storage.get('k')).toBe('v')
  })

  it('webSocket.create(url) 返回对象含 send/close 函数 + readyState 数字', () => {
    const adapter = createMobilePlatformAdapter()
    const ws = adapter.webSocket.create('ws://localhost/test')
    expect(typeof ws.readyState).toBe('number')
    expect(typeof ws.send).toBe('function')
    expect(typeof ws.close).toBe('function')
  })

  // U1.3 真实化：stub（InMemoryStorage）→ localStorage 桥接，锁真实持久化语义
  it('storage 经 localStorage 真实持久化（adapter 写 → localStorage 可读；localStorage 写 → adapter 可读）', async () => {
    localStorage.clear()
    const adapter = createMobilePlatformAdapter()
    await adapter.storage.set('persist-k', 'persist-v')
    expect(localStorage.getItem('persist-k')).toBe('persist-v')
    localStorage.setItem('persist-k2', 'direct-v')
    expect(await adapter.storage.get('persist-k2')).toBe('direct-v')
    await adapter.storage.remove('persist-k')
    expect(localStorage.getItem('persist-k')).toBeNull()
  })

  // U1.3 真实化：stub（readyState 恒 CLOSED=3）→ 原生 WebSocket 包装，锁真实建连形态
  it('webSocket.create 返回原生 WebSocket 形态（CONNECTING 初态，回调字段可赋值）', () => {
    const adapter = createMobilePlatformAdapter()
    const ws = adapter.webSocket.create('ws://localhost/test')
    expect(ws.readyState).toBe(0) // WS_READY_STATE.CONNECTING —— 原生实例；stub 恒 CLOSED(3)
    expect(ws.onopen).toBeNull()
    expect(ws.onmessage).toBeNull()
    ws.close()
  })
})

describe('TC-5: AC5 providePlatform/getPlatform 注入链路通（经 bootstrap）', () => {
  beforeEach(() => {
    __resetPlatformForTesting()
    // U1.3 起 bootstrap 含连接编排序列（经 adapter 工厂创建原生 WebSocket）——
    // 替身阻断真实连接尝试（测试禁触网络）；连接编排残留态经 teardown 复位（afterEach）
    vi.stubGlobal('WebSocket', StubWebSocket)
    // bootstrap 挂载 #app，happy-dom 需显式提供该节点
    const app = document.createElement('div')
    app.id = 'app'
    document.body.appendChild(app)
  })

  afterEach(() => {
    // 复位 bootstrap 经 setConnectionPorts/init 建立的 core 模块级单例态（连接编排/监听器/WS）
    useConnection().teardown()
    disconnect()
    __resetPlatformForTesting()
    document.getElementById('app')?.remove()
    vi.unstubAllGlobals()
  })

  it('bootstrap 前 getPlatform() 抛错（platform 未注入）', () => {
    expect(() => getPlatform()).toThrow(/platform port not injected/)
  })

  it('bootstrap() 后 getPlatform().kind === "mobile"（adapter 经 providePlatform 注入 core）', async () => {
    await bootstrap()
    expect(getPlatform().kind).toBe('mobile')
  })
})

// BM5 瞬时断连不换视图：connected 后掉回 connecting 时 connected 布局保持挂载
//（composer/message-stream 不卸载 = 输入草稿保留），仅壳顶部插轻量断线条；
// failed 仍全屏接管；首连（从未 connected）仍是全屏「连接中」。
describe('BM5: 断线重连中保持 connected 布局 + 壳顶部断线条', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  it('连接成功后掉回 connecting：聊天视图元素仍在场 + shell-reconnecting-banner 在场（无全屏连接中）', async () => {
    shellConnectionState.value = 'connected'
    hasConnectedOnce.value = true
    sessionStore.setActiveId('sid-bm5')
    wrapper = mountApp()
    await wrapper.get('[data-testid="mobile-tab-chat"]').trigger('click')

    // 瞬时断连：connected → connecting（connection-view watch 同款状态流转）
    shellConnectionState.value = 'connecting'
    await nextTick()

    expect(wrapper.find('[data-testid="shell-reconnecting-banner"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="zone-message-stream"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-composer"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-tab-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="shell-connecting"]').exists()).toBe(false)
  })

  it('failed 重连预算用尽：仍全屏接管（shell-failed 在场，无断线条/无聊天视图/tab bar）', () => {
    shellConnectionState.value = 'failed'
    hasConnectedOnce.value = true
    sessionStore.setActiveId('sid-bm5-failed')
    wrapper = mountApp()

    expect(wrapper.find('[data-testid="shell-failed"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="shell-reconnecting-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="zone-message-stream"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bottom-tab-bar"]').exists()).toBe(false)
  })

  it('首连未 connected：全屏连接中，无断线条', () => {
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    wrapper = mountApp()

    expect(wrapper.find('[data-testid="shell-connecting"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="shell-reconnecting-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-session-list"]').exists()).toBe(false)
  })
})

// U1.6 P0 缺陷防回归：src/ 无 @tailwind 指令落点 → tailwindcss postcss 插件零生成工具类，
// 产物 CSS 裸奔（happy-dom 组件测试不验视觉，拦不住该缺陷）。此处机械锚定样式入口与
// content 扫描面两条前提，缺任一即红。
describe('TC-8: AC5 Tailwind 样式入口（U1.6 P0 防回归）', () => {
  it('样式入口 tokens.css 含 @tailwind 三指令（base/components/utilities）', () => {
    const css = readFileSync(resolve(pkgRoot, 'src/styles/tokens.css'), 'utf-8')
    expect(css).toMatch(/^@tailwind base;/m)
    expect(css).toMatch(/^@tailwind components;/m)
    expect(css).toMatch(/^@tailwind utilities;/m)
  })

  it('main.ts import 样式入口（Tailwind 产物进构建图）', () => {
    const mainSrc = readFileSync(resolve(pkgRoot, 'src/main.ts'), 'utf-8')
    expect(mainSrc).toMatch(/import '\.\/styles\/tokens\.css'/)
  })

  it('tailwind.config.ts content 覆盖壳源码与 ui 组件（防扫描面缩窄致工具类缺失）', () => {
    const config = readFileSync(resolve(pkgRoot, 'tailwind.config.ts'), 'utf-8')
    expect(config).toContain("./src/**/*.{vue,ts,tsx}")
    expect(config).toContain("../ui/src/**/*.{vue,ts}")
  })
})
