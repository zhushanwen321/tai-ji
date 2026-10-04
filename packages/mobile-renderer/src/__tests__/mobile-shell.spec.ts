// AC5 结构断言测试套件（W2 建立 TC-1~TC-5 + TC-7；remote-use U1.4c 多视图重排改写 TC-1/TC-2）。
//
// 覆盖 TC-1~TC-5 + TC-7（TC-6 构建验收由 cw test gate 的 build 步骤单独跑）：
//   TC-1: mount(App) 三视图态断言（列表视图 / 聊天视图 / token 输入视图，U1.4c 改写）
//   TC-2: SlashBarStub 隐藏保留断言（display:none + testid 留 DOM，U1.4c 改写——
//         MessageStreamStub/CompanionStub/BottomTabBarStub 已随真实组件替换删除）
//   TC-3: mount-points.ts 挂载点注册（IF1，§6.3 mobile B+D 子集）
//   TC-4: createMobilePlatformAdapter 满足 core PlatformPort 契约（IF2）
//   TC-5: providePlatform/getPlatform 注入链路通（经 bootstrap）
//   TC-7: main.ts 保留 W1 AC1 依赖边（core + ui import 回归护栏）
//
// 从 vitest 导入（禁 node:test / tsx --test）。运行：npx vitest run。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { disconnect, getPlatform, useConnection, __resetPlatformForTesting } from '@taiji/core'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import App from '../App.vue'
import { i18n } from '../i18n'
import { shellConnectionState } from '../bootstrap'
import { sessionStore } from '../shell/app-runtime'
import {
  MOBILE_MOUNT_POINTS,
  registerMountPoint,
  getRegisteredMountPoints,
  __resetMountPointsForTesting,
} from '../shell/mount-points'
import { createMobilePlatformAdapter } from '../platform/mobile-platform-adapter'
import { bootstrap } from '../bootstrap'

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

describe('TC-1: AC5 三视图态结构断言（U1.4c 多视图重排）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    shellConnectionState.value = 'connecting'
    sessionStore.setActiveId(null)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    shellConnectionState.value = 'connecting'
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
    shellConnectionState.value = 'connected'
    wrapper = mountApp()
    expect(wrapper.find('[data-testid="mobile-session-list"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="bottom-tab-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-tab-sessions"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="mobile-tab-chat"]').exists()).toBe(true)
  })

  it('connected 聊天视图渲染 message-stream + companion + slash 隐藏保留 + 输入条 + bottom-tab-bar', async () => {
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

describe('TC-2: AC5 SlashBarStub 隐藏保留（display:none + testid 留 DOM）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  beforeEach(() => {
    shellConnectionState.value = 'connecting'
    sessionStore.setActiveId(null)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    shellConnectionState.value = 'connecting'
    sessionStore.setActiveId(null)
  })

  it('聊天视图内 stub-slash testid 存在且隐藏（不裸渲染占位文案）', async () => {
    shellConnectionState.value = 'connected'
    sessionStore.setActiveId('sid-tc2')
    wrapper = mountApp()
    await wrapper.get('[data-testid="mobile-tab-chat"]').trigger('click')
    const stub = wrapper.get('[data-testid="stub-slash"]')
    // 隐藏形态 = tailwind hidden class（SSOT `.hidden { display: none }`）；happy-dom 的
    // getComputedStyle 不解析样式表，display:none 以 class + 组件源码双锚定断言
    expect(stub.classes()).toContain('hidden')
    expect(stub.text()).toBe('')
    const stubSrc = readFileSync(resolve(pkgRoot, 'src/shell/stubs/SlashBarStub.vue'), 'utf-8')
    expect(stubSrc).toMatch(/class="stub stub--slash hidden"/)
  })
})

describe('TC-3: AC5 getRegisteredMountPoints 含 mobile B+D 子集三挂载点', () => {
  beforeEach(() => {
    __resetMountPointsForTesting()
  })

  it('MOBILE_MOUNT_POINTS 常量 = [message-stream, slash, companion]', () => {
    expect([...MOBILE_MOUNT_POINTS]).toEqual(['message-stream', 'slash', 'companion'])
  })

  it('注册三挂载点后 getRegisteredMountPoints 含三项', () => {
    registerMountPoint('message-stream', {})
    registerMountPoint('slash', {})
    registerMountPoint('companion', {})
    const points = getRegisteredMountPoints()
    expect(points.size).toBe(3)
    expect(points.has('message-stream')).toBe(true)
    expect(points.has('slash')).toBe(true)
    expect(points.has('companion')).toBe(true)
  })

  it('registerMountPoint 幂等：同名重复注册覆盖，集合 size 不变', () => {
    registerMountPoint('message-stream', {})
    registerMountPoint('message-stream', {})
    expect(getRegisteredMountPoints().size).toBe(1)
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
    __resetMountPointsForTesting()
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
    __resetMountPointsForTesting()
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

  it('bootstrap() 后 getRegisteredMountPoints 含 mobile 三挂载点', async () => {
    await bootstrap()
    const points = getRegisteredMountPoints()
    expect(points.size).toBe(3)
    expect(points.has('message-stream')).toBe(true)
    expect(points.has('slash')).toBe(true)
    expect(points.has('companion')).toBe(true)
  })
})

describe('TC-7: AC1 回归 main.ts 保留 core + ui import（W1 依赖边）', () => {
  const mainSrc = readFileSync(resolve(pkgRoot, 'src/main.ts'), 'utf-8')

  it('main.ts import 自 @taiji/core', () => {
    expect(mainSrc).toMatch(/from '@taiji\/core'/)
  })

  it('main.ts import 自 @taiji/ui', () => {
    expect(mainSrc).toMatch(/from '@taiji\/ui'/)
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
