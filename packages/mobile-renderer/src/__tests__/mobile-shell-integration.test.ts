import App from '../App.vue';
import { bootstrap } from '../bootstrap';
import { i18n } from '../i18n';
import { createMobilePlatformAdapter } from '../platform/mobile-platform-adapter';
import TokenInputView from '../shell/TokenInputView.vue';
import { chatStore, sessionStore } from '../shell/app-runtime';
import { __testing } from '../shell/companion-bridge';
import { hasConnectedOnce, shellConnectionState } from '../shell/connection-view';
import { renderMermaidPlaceholder } from '../shell/mermaid-placeholder';
import MobileMessageStream from '../views/MobileMessageStream.vue';
import { __resetPlatformForTesting, chatNoticeText, disconnect, getPlatform, resetChatModuleStateForTest, useConnection } from '@taiji/core';
import { enUS, zhCN } from '@taiji/ui/locale';
import { flushPromises, mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SID = 'sid-ui-test'

function mountStream(sessionId: string) {
  return mount(MobileMessageStream, {
    props: { sessionId },
    global: { plugins: [i18n] },
  })
}
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← chatnotice-injection.test.ts
// ======================================================================

// ChatNoticeKey 闭集（core notice-text.ts，三成员）：类型无运行时枚举，字面登记——
// core 侧增键时此处与 useMessageEffects 注入同裸奔，靠 renderer 壳 locale-key-usage-guard
// 的闭集扫描与 ui locale 结构测试补位（双壳共享同一注入键空间）。
const CHAT_NOTICE_KEYS = ['stoppedBeforeStart', 'truncatedMaxTokens', 'truncatedContentFilter'] as const

const t = i18n.global.t as (key: string) => string

describe('chatNotice i18n 移动壳注入（bootstrap 模块加载期）', () => {
  it('chatNoticeText 全键解析为译文，非键名回退（注入缺失的显式信号）', () => {
    for (const key of CHAT_NOTICE_KEYS) {
      const resolved = chatNoticeText(key)
      expect(resolved).not.toBe(`panel.message.chatNotice.${key}`)
      expect(resolved.trim()).not.toBe('')
    }
  })

  it('解析值与移动壳 i18n 实例逐键一致（注入闭包走本壳 t，非透传键名）', () => {
    for (const key of CHAT_NOTICE_KEYS) {
      expect(chatNoticeText(key)).toBe(t('panel.message.chatNotice.' + key))
    }
  })

  it('ui locale 下沉域双侧词典完备：zh-CN / en-US 各含三键非空文案', () => {
    const zh = (zhCN as { panel: { message: { chatNotice: Record<string, string> } } }).panel.message.chatNotice
    const en = (enUS as { panel: { message: { chatNotice: Record<string, string> } } }).panel.message.chatNotice
    for (const key of CHAT_NOTICE_KEYS) {
      expect(zh[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
    }
  })
})

// ======================================================================
// ← mobile-shell.spec.ts
// ======================================================================

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

// BM5 瞬时断连不换视图：connected 后掉回 connecting 时 connected 布局保持挂载
//（composer/message-stream 不卸载 = 输入草稿保留），仅壳顶部插轻量断线条；
// failed 仍全屏接管；首连（从未 connected）仍是全屏「连接中」。
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

  it('tailwind.config.ts content 覆盖壳源码与 ui 组件（防扫描范围缩窄致工具类缺失）', () => {
    const config = readFileSync(resolve(pkgRoot, 'tailwind.config.ts'), 'utf-8')
    expect(config).toContain("./src/**/*.{vue,ts,tsx}")
    expect(config).toContain("../ui/src/**/*.{vue,ts}")
  })
})

// ======================================================================
// ← safe-area.spec.ts
// ======================================================================

// vitest 运行时 cwd 即包根（vitest.config.ts 所在目录）
const pkgRoot_m2 = process.cwd()

describe('A16: safe-area env() 消费存在（样式源断言，TC-8 形态）', () => {
  it('tokens.css 定义四向 --safe-area-* 变量（env(safe-area-inset-*, 0px) 带 0px 回退）', () => {
    const css = readFileSync(resolve(pkgRoot_m2, 'src/styles/tokens.css'), 'utf-8')
    expect(css).toContain('--safe-area-top: env(safe-area-inset-top, 0px)')
    expect(css).toContain('--safe-area-right: env(safe-area-inset-right, 0px)')
    expect(css).toContain('--safe-area-bottom: env(safe-area-inset-bottom, 0px)')
    expect(css).toContain('--safe-area-left: env(safe-area-inset-left, 0px)')
  })

  it('index.html viewport 含 viewport-fit=cover（env() 非零前提，A16 证据锚点）', () => {
    const html = readFileSync(resolve(pkgRoot_m2, 'index.html'), 'utf-8')
    expect(html).toMatch(/name="viewport"[^>]*viewport-fit=cover/)
  })
})

describe('A16: safe-area 布局类挂载（DOM 断言，TC-1 形态）', () => {
  let wrapper: ReturnType<typeof mountApp> | null = null

  function mountApp() {
    return mount(App, { global: { plugins: [i18n] } })
  }

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

  it('壳根 mobile-shell 挂顶部 + 横向 safe-area 类（顶栏/横向职责，视图态无关）', () => {
    wrapper = mountApp()
    const shell = wrapper.get('[data-testid="mobile-shell"]')
    expect(shell.classes()).toContain('pt-[var(--safe-area-top)]')
    expect(shell.classes()).toContain('pr-[var(--safe-area-right)]')
    expect(shell.classes()).toContain('pl-[var(--safe-area-left)]')
  })

  it('壳根不挂底部 safe-area 类（底部 inset 分治给贴底 chrome，防双倍扣除）', () => {
    wrapper = mountApp()
    const shell = wrapper.get('[data-testid="mobile-shell"]')
    expect(shell.classes()).not.toContain('pb-[var(--safe-area-bottom)]')
  })


})

// ======================================================================
// ← mobile-companion-band.spec.ts
// ======================================================================



describe('ChatViewDeps provide 完整性（全部必需字段由 MobileMessageStream provide）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
    chatStore.disposeSession(SID)
  })

  it('provide 后 ChatView 子树渲染无 inject 抛错（含 Turn 渲染）', async () => {
    chatStore.appendUser(SID, [{ type: 'text', text: 'hello mobile' }])
    const wrapper = mountStream(SID)
    await flushPromises()
    // inject 缺失时 useChatViewDeps() 在 setup 期直接抛错——mount 成功 + 子树锚点在 DOM 即证明 provide 完整
    expect(wrapper.find('[data-testid="chat-view"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('hello mobile')
    wrapper.unmount()
  })

  it('copyLabel 注入：代码块复制按钮 title 来自 ui locale composable.copyLabel（i18n 单源）', async () => {
    const copyLabel = i18n.global.t('composable.copyLabel')
    chatStore.appendUser(SID, [{ type: 'text', text: '```js\nconst a = 1\n```' }])
    const wrapper = mountStream(SID)
    // 渲染链含 shiki 高亮（异步 chunk），轮询等复制按钮（title bake 进代码块 HTML）出现
    await vi.waitFor(() => {
      expect(wrapper.html()).toContain(`title="${copyLabel}"`)
    })
    wrapper.unmount()
  })
})

describe('renderMermaid 占位降级（ChatViewDeps 分派④）', () => {
  it('返回 {svg} 结构，svg 含 i18n 文案「图表在桌面查看」', async () => {
    const result = await renderMermaidPlaceholder('图表在桌面查看')
    expect(typeof result.svg).toBe('string')
    expect(result.svg).toContain('<svg')
    expect(result.svg).toContain('图表在桌面查看')
  })
})

// ======================================================================
// ← token-input-view.test.ts
// ======================================================================

function mountView() {
  return mount(TokenInputView, { global: { plugins: [i18n] } })
}

function mountViewWith(props: { submitting?: boolean; error?: 'invalid' | 'failed' | null }) {
  return mount(TokenInputView, { props, global: { plugins: [i18n] } })
}

describe('TokenInputView（D4/D8 恢复入口）', () => {
  it('渲染视图锚点 / 标题 / 输入框 / 提交按钮', () => {
    const wrapper = mountView()
    expect(wrapper.find('[data-testid="token-input-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="token-input-title"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="token-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="token-submit"]').exists()).toBe(true)
  })

  it('空 token 提交不发 submit 事件；输入后提交 emit("submit", trim 后 token)', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-testid="token-submit"]').trigger('click')
    expect(wrapper.emitted('submit')).toBeUndefined()

    await wrapper.find('[data-testid="token-input"]').setValue('  tok-abc  ')
    await wrapper.find('[data-testid="token-submit"]').trigger('click')
    expect(wrapper.emitted('submit')?.[0]).toEqual(['tok-abc'])
  })

  it('输入框 Enter 键提交（粘贴 token 后回车的典型路径）', async () => {
    const wrapper = mountView()
    await wrapper.find('[data-testid="token-input"]').setValue('tok-enter')
    await wrapper.find('[data-testid="token-input"]').trigger('keyup.enter')
    expect(wrapper.emitted('submit')?.[0]).toEqual(['tok-enter'])
  })

  // i18n 消费断言：四处文案（标题/指引/占位/提交键）随 locale 切换渲染，
  // 拦截硬编码中文回归（check_i18n_cjk.py 只查 CJK，en 侧漏译由本用例检查）
  it('文案走 t() 双语渲染（zh-CN / en-US 随 locale 切换，无硬编码）', async () => {
    i18n.global.locale.value = 'zh-CN'
    const zh = mountView()
    expect(zh.find('[data-testid="token-input-title"]').text()).toBe('需要访问凭据')
    expect(zh.find('[data-testid="token-input-view"]').text()).toContain('回主机「设置 → 远程访问」重新扫码，或在下方粘贴 token')
    expect(zh.find('[data-testid="token-input"]').attributes('placeholder')).toBe('粘贴访问 token')
    expect(zh.find('[data-testid="token-submit"]').text()).toBe('连接')
    zh.unmount()

    i18n.global.locale.value = 'en-US'
    const en = mountView()
    expect(en.find('[data-testid="token-input-title"]').text()).toBe('Credentials required')
    expect(en.find('[data-testid="token-input-view"]').text()).toContain('Re-scan the QR code on your desktop')
    expect(en.find('[data-testid="token-input"]').attributes('placeholder')).toBe('Paste access token')
    expect(en.find('[data-testid="token-submit"]').text()).toBe('Connect')
    en.unmount()
  })
})

describe('TokenInputView 提交中/错误反馈派生视图（submitting/error props，App 呈现 bootstrap tokenSubmit 态）', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh-CN'
  })

  it('submitting=true：提交按钮禁用且文案切「连接中…」（已输入 token 也禁用，防重复触发）；false 时可点显「连接」', async () => {
    const submitting = mountViewWith({ submitting: true })
    const submitBtn = submitting.get('[data-testid="token-submit"]')
    // 输入非空 token：禁用只由 submitting 驱动（空值检查不参与本断言）
    await submitting.find('[data-testid="token-input"]').setValue('tok-abc')
    expect(submitBtn.attributes('disabled')).toBeDefined()
    expect(submitBtn.text()).toBe('连接中…')
    submitting.unmount()

    const idle = mountViewWith({ submitting: false })
    const idleBtn = idle.get('[data-testid="token-submit"]')
    await idle.find('[data-testid="token-input"]').setValue('tok-abc')
    expect(idleBtn.attributes('disabled')).toBeUndefined()
    expect(idleBtn.text()).toBe('连接')
    idle.unmount()
  })

  it('error="invalid"：role=alert 错误行渲染「Token 无效」文案；error 缺省时错误行不渲染', () => {
    const invalid = mountViewWith({ error: 'invalid' })
    const errorRow = invalid.get('[data-testid="token-input-error"]')
    expect(errorRow.attributes('role')).toBe('alert')
    expect(errorRow.text()).toBe('Token 无效或已被轮换，请回主机重新扫码获取')
    invalid.unmount()

    const clean = mountView()
    expect(clean.find('[data-testid="token-input-error"]').exists()).toBe(false)
    clean.unmount()
  })

  it('error="failed"：错误行渲染「连接发起失败」文案（failed 与 invalid 分支文案可区分）', () => {
    const failed = mountViewWith({ error: 'failed' })
    const errorRow = failed.get('[data-testid="token-input-error"]')
    expect(errorRow.attributes('role')).toBe('alert')
    expect(errorRow.text()).toBe('连接发起失败，请检查网络后重试')
    failed.unmount()
  })
})
