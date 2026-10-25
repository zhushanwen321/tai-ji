// AC5 结构断言测试套件（W2 建立；remote-use U1.4c 多视图重排改写 TC-1/TC-2；
// remote-use-mobile-v2 §6.6/§6.7 壳重排再改写——五路由消费（connect/sessions/settings/chat）+
// BottomNav 三目的域 + BM5 断连不换视图语义保留；v1 两 tab 形态断言已随壳重写退役，
// v1 组件已清退，老能力映射逐条对账结论落包根 MIGRATION-RECONCILIATION.md。
//
// 覆盖（TC-6 构建验收由 cw test gate 的 build 步骤单独跑）：
//   TC-1: mount(App) 五路由结构断言（connect 骨架/验身入口/connected 三目的域/settings/chat）
//   TC-4: createMobilePlatformAdapter 满足 core PlatformPort 契约（IF2）
//   TC-5: providePlatform/getPlatform 注入链路通（经 bootstrap；§6.6 先挂载后连接）
//   BM5:  断线重连中保持路由布局 + 顶部断线条（failed/首连走验身页全屏）
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
import { navigateRoute, resetRouteForTesting } from '../shell/route'

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

describe('TC-1: AC5 五路由结构断言（remote-use-mobile-v2 §6.6/§6.7 壳重排）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    resetRouteForTesting()
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    resetRouteForTesting()
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  it('connect 态（首连 connecting）渲染验身页骨架 + 连接中（无 bottom-nav）', () => {
    wrapper = mountApp()
    expect(wrapper.find('[data-testid="connect-screen"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="shell-boot-skeleton"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="shell-connecting-label"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-nav"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="shell-reconnecting-banner"]').exists()).toBe(false)
  })

  it('token-input 态渲染 token 表单（token-input-view testid）', () => {
    shellConnectionState.value = 'token-input'
    wrapper = mountApp()
    expect(wrapper.find('[data-testid="connect-screen"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="token-input-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="token-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="token-submit"]').exists()).toBe(true)
  })

  it('connected 首目的域渲染 sessions 屏 + bottom-nav 三目的域条目', async () => {
    // 直接置态复现 connection-view watch 的置位序（connected 蕴含 hasConnectedOnce，BM5 分支锚点）
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    wrapper = mountApp()
    await nextTick()
    expect(wrapper.find('[data-testid="screen-sessions"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-nav"]').exists()).toBe(true)
    for (const id of ['sessions', 'activity', 'settings']) {
      expect(wrapper.find(`[data-testid="mobile-nav-${id}"]`).exists()).toBe(true)
    }
  })

  it('settings 路由渲染设置屏（bottom-nav 保持在场）', async () => {
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    wrapper = mountApp()
    await nextTick()
    navigateRoute('settings')
    await nextTick()
    expect(wrapper.find('[data-testid="settings-screen"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-nav"]').exists()).toBe(true)
  })

  it('chat 路由渲染聊天屏 v2（返回出口在场 + bottom-nav 隐藏）', async () => {
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    // 播种活跃会话（无 summary 的 sid 合法——标题回落「未命名会话」兜底）→ ChatScreen 全量挂载
    sessionStore.setActiveId('sess-chat-shell-spec')
    wrapper = mountApp()
    await nextTick()
    navigateRoute('chat')
    await nextTick()
    expect(wrapper.find('[data-testid="chat-screen"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-back"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-nav"]').exists()).toBe(false)
  })

  it('chat 路由无活跃会话 → 空态（新建入口在场，不挂 ChatScreen）', async () => {
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    wrapper = mountApp()
    await nextTick()
    navigateRoute('chat')
    await nextTick()
    expect(wrapper.find('[data-testid="screen-chat"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-chat-empty-new"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-screen"]').exists()).toBe(false)
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

// BM5 瞬时断连不换视图：connected 后掉回 connecting 时当前路由布局保持挂载（v2 五路由
// 消费形态——视图保持 = 草稿/滚动保留，u-chat 交付后随 ChatScreen 落位），仅壳顶部插轻量
// 断线条；failed / token-input 经路由回验身页全屏接管；首连（从未 connected）也是验身页
// 骨架态（§6.6 首屏三态：任意时点 #app 非空）。
describe('BM5: 断线重连中保持路由布局 + 壳顶部断线条', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    resetRouteForTesting()
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    resetRouteForTesting()
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    sessionStore.setActiveId(null)
  })

  it('连接成功后掉回 connecting：目的域布局仍在场 + shell-reconnecting-banner 在场（无全屏验身页）', async () => {
    shellConnectionState.value = 'connected'
    hasConnectedOnce.value = true
    sessionStore.setActiveId('sid-bm5')
    wrapper = mountApp()
    await nextTick()
    expect(wrapper.find('[data-testid="screen-sessions"]').exists()).toBe(true)

    // 瞬时断连：connected → connecting（connection-view watch 同款状态流转）
    shellConnectionState.value = 'connecting'
    await nextTick()

    expect(wrapper.find('[data-testid="shell-reconnecting-banner"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="screen-sessions"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-nav"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="connect-screen"]').exists()).toBe(false)
  })

  it('failed 重连预算用尽：路由回验身页全屏接管（shell-failed 在场，无断线条/无目的域/无 bottom-nav）', async () => {
    shellConnectionState.value = 'failed'
    hasConnectedOnce.value = true
    sessionStore.setActiveId('sid-bm5-failed')
    wrapper = mountApp()
    await nextTick()

    expect(wrapper.find('[data-testid="shell-failed"]').exists()).toBe(true)
    // failed 全屏容器独立 testid（不复用首连分支的 shell-boot-skeleton）：负向断言防「failed 态
    // 误渲染连接中视图」回归
    expect(wrapper.find('[data-testid="shell-failed-screen"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="shell-boot-skeleton"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="shell-reconnecting-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="screen-sessions"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="bottom-nav"]').exists()).toBe(false)
  })

  it('首连未 connected：验身页骨架态（无断线条）——§6.6 首屏任意时点 #app 非空', () => {
    shellConnectionState.value = 'connecting'
    hasConnectedOnce.value = false
    wrapper = mountApp()

    expect(wrapper.find('[data-testid="connect-screen"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="shell-boot-skeleton"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="shell-reconnecting-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="screen-sessions"]').exists()).toBe(false)
  })
})

// U1.6 P0 缺陷防回归：src/ 无 @tailwind 指令落点 → tailwindcss postcss 插件零生成工具类，
// 产物 CSS 裸奔（happy-dom 组件测试不验视觉，拦不住该缺陷）。此处机械锚定样式入口与
// content 扫描范围两条前提，缺任一即红。
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

  it('main.ts import shell.css（浮层进出场过渡进构建图，缺失时弹窗出视口）', () => {
    const mainSrc = readFileSync(resolve(pkgRoot, 'src/main.ts'), 'utf-8')
    expect(mainSrc).toMatch(/import '\.\/styles\/shell\.css'/)
  })

  it('main.ts import base.css（壳基础层进构建图：焦点可见性 / reduced-motion 降级）', () => {
    const mainSrc = readFileSync(resolve(pkgRoot, 'src/main.ts'), 'utf-8')
    expect(mainSrc).toMatch(/import '\.\/styles\/base\.css'/)
  })

  it('tailwind.config.ts content 覆盖壳源码与 ui 组件（防扫描范围缩窄致工具类缺失）', () => {
    const config = readFileSync(resolve(pkgRoot, 'tailwind.config.ts'), 'utf-8')
    expect(config).toContain("./src/**/*.{vue,ts,tsx}")
    expect(config).toContain("../ui/src/**/*.{vue,ts}")
  })
})
