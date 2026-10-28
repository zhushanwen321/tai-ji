// 首屏三态单测（remote-use-mobile-v2 §6.6 验收条款 1：bootstrap 先挂载后连接，mount 后
// 任意时点 #app 非空——连接慢 / 验身失败注入两个时点采样）。
//
// 注入形态：StubWebSocket 阻断真实连接（连接慢 = 握手永不回，连接编排悬挂在 connecting）；
// 验身失败 = 连接视图信号入口③注入（notifyTokenInputRequired，生产由 profile 处置尾部
// 触发）。TC-5 同款装配（__resetPlatformForTesting + stubGlobal + #app 节点 + teardown）。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { disconnect, useConnection, __resetPlatformForTesting } from '@taiji/core'
import { bootstrap } from '../bootstrap'
import { notifyTokenInputRequired, shellConnectionState } from '../shell/connection-view'
import { resetRouteForTesting } from '../shell/route'

class StubWebSocket {
  readyState = 0
  onopen: unknown = null
  onclose: unknown = null
  onmessage: unknown = null
  onerror: unknown = null
  send(): void {}
  close(): void {}
}

describe('首屏三态（§6.6 先挂载后连接）：mount 后任意时点 #app 非空', () => {
  beforeEach(() => {
    resetRouteForTesting()
    shellConnectionState.value = 'connecting'
    __resetPlatformForTesting()
    localStorage.clear()
    vi.stubGlobal('WebSocket', StubWebSocket)
    const app = document.createElement('div')
    app.id = 'app'
    document.body.appendChild(app)
  })

  afterEach(() => {
    useConnection().teardown()
    disconnect()
    __resetPlatformForTesting()
    document.getElementById('app')?.remove()
    vi.unstubAllGlobals()
    resetRouteForTesting()
    shellConnectionState.value = 'connecting'
  })

  it('连接慢（握手不回）：挂载完成即有骨架屏，#app 非空且非白屏', async () => {
    const pending = bootstrap()
    // 挂载先于连接编排（§6.6 重排）：bootstrap 未 resolve（连接悬挂）时 #app 已有骨架态
    expect(document.getElementById('app')!.children.length).toBeGreaterThan(0)
    expect(document.querySelector('[data-testid="mobile-shell"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="shell-boot-skeleton"]')).not.toBeNull()
    // 连接中文案在场（文案语言随测试环境 navigator.language，断言可见非空文本）
    expect(document.querySelector('[data-testid="shell-connecting-label"]')?.textContent?.trim()).not.toBe('')
    await pending
    // 连接编排提交后（连接仍慢）#app 持续非空
    expect(document.getElementById('app')!.children.length).toBeGreaterThan(0)
    expect(document.querySelector('[data-testid="shell-boot-skeleton"]')).not.toBeNull()
  })

  it('验身失败（凭据缺失信号）：#app 切验身入口呈现，期间非空', async () => {
    const pending = bootstrap()
    await pending
    expect(document.getElementById('app')!.children.length).toBeGreaterThan(0)

    // 验身失败注入：profile 处置尾部的信号入口③（token-input 视图态）
    notifyTokenInputRequired()
    await Promise.resolve()
    expect(document.querySelector('[data-testid="token-input-view"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="token-input"]')).not.toBeNull()
    expect(document.getElementById('app')!.children.length).toBeGreaterThan(0)
  })

  it('验身成功（connected 信号）：#app 切初始目的域，期间非空', async () => {
    const pending = bootstrap()
    await pending

    // connected 注入（connection-view watch 同款置位序：connected 蕴含 hasConnectedOnce）
    const { hasConnectedOnce } = await import('../shell/connection-view')
    hasConnectedOnce.value = true
    shellConnectionState.value = 'connected'
    await Promise.resolve()
    expect(document.querySelector('[data-testid="screen-sessions"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="bottom-nav"]')).not.toBeNull()
    expect(document.getElementById('app')!.children.length).toBeGreaterThan(0)
  })
})
