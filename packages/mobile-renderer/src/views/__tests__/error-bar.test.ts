// 移动壳轻量错误条三链（remote-use A7/A11 / U14）。
//
// 锁定三个行为面（D5 去留表：错误条是 V5/V18 作答失败反馈的唯一载体）：
//   A7 onSessionError —— 复用 core markSessionError（追加流内 error 消息，持久反馈）+
//                        错误条置顶（瞬态置顶补充；文案对齐桌面 connection.sessionRequestFailed）
//   A7 onGlobalError  —— 无归属 server error 直显错误条（桌面 toast 的移动形态）
//   A11 notifyNotDelivered —— dialog 作答未送达（WS 非 OPEN）经注入回调显示内联错误行
//                        （对齐桌面 useExtensionHostBridge 注入形态；呈现对齐 form 通道
//                        respondFailedId 的内联错误行范式——role=alert 细行）
//
// mock 策略：三条链都在 WS 未连接的测试环境驱动（initConnection 未跑，ws 为 null，
// ws-client send 直接返回 false 无副作用）——A11 链的「未送达」分支由此构造，无需 mock
// 传输层。错误条状态是 error-bar 模块级单例，beforeEach 经 __testing 重置。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/views/__tests__/error-bar.test.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ErrorBar from '../ErrorBar.vue'
import { i18n } from '../../i18n'
import { chatStore } from '../../shell/app-runtime'
import { __testing, errorBarEffects, mobileUiResponseTransport } from '../../shell/companion-bridge'

const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

function mountErrorBar(): VueWrapper {
  return mount(ErrorBar, { global: { plugins: [i18n] } })
}

/** 发一条 bridge 归一后的 dialog 类 ui-request（confirm 形态；mobile-companion-band.spec 同款先例） */
function emitDialogRequest(sessionId: string, requestId: string): void {
  __testing.mobileExtensionBus.emit({
    kind: 'ui-request',
    sessionId,
    request: {
      requestId,
      pluginId: 'tasks',
      kind: 'confirm',
      method: 'confirm',
      title: '确认执行？',
      message: '该操作将应用变更',
    },
  })
}

describe('移动壳轻量错误条（A7/A11）', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    __testing.resetErrorBarForTest()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    __testing.resetErrorBarForTest()
  })

  it('onSessionError：错误条置顶显示请求失败文案 + 流内追加 error 消息（markSessionError 复用）', () => {
    errorBarEffects.onSessionError('sid-a7-session', { message: 'pi client gone' })
    wrapper = mountErrorBar()

    // 用户可见断言：错误条错误行在场，文案 = 桌面同名 key 形态（会话请求失败：{message}）
    const bar = wrapper.find('[data-testid="mobile-error-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('role')).toBe('alert')
    expect(wrapper.find('[data-testid="mobile-error-bar-text"]').text()).toBe(
      t('connection.sessionRequestFailed', { message: 'pi client gone' }),
    )

    // 持久反馈断言：markSessionError 经 chatStore 追加流内 error 消息（切走/关闭错误条后仍可见）
    const messages = chatStore.getMessages('sid-a7-session')
    expect(messages.length).toBe(1)
    expect(messages[0]?.status).toBe('error')
    expect(messages[0]?.error).toContain('pi client gone')
  })

  it('onSessionError：payload 无 message 时文案兜底 Unknown error（对齐桌面形态）', () => {
    errorBarEffects.onSessionError('sid-a7-nomsg', {})
    wrapper = mountErrorBar()

    expect(wrapper.find('[data-testid="mobile-error-bar-text"]').text()).toBe(
      t('connection.sessionRequestFailed', { message: 'Unknown error' }),
    )
  })

  it('onGlobalError：无归属 server error 直显错误条', () => {
    errorBarEffects.onGlobalError('runtime exploded')
    wrapper = mountErrorBar()

    const bar = wrapper.find('[data-testid="mobile-error-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('role')).toBe('alert')
    expect(wrapper.find('[data-testid="mobile-error-bar-text"]').text()).toBe('runtime exploded')
  })

  it('notifyNotDelivered 注入后未送达请求有内联错误行（A11：WS 未送达 → 注入回调 → 错误条）', async () => {
    // 请求先在场（emit 走真实 bus 订阅链，与生产同路）
    emitDialogRequest('sid-a11', 'req-a11-undelivered')
    wrapper = mountErrorBar()
    expect(wrapper.find('[data-testid="mobile-error-bar"]').exists()).toBe(false)

    // 作答未送达（测试环境 WS 未连接 → send 返回 false，真实未送达分支）
    const delivered = mobileUiResponseTransport.sendPiResponse('sid-a11', 'req-a11-undelivered', 'confirm', true)
    expect(delivered).toBe(false)
    await nextTick()

    // 注入回调生效：错误条显示「回复未送达」内联错误行（A11 验收判据）
    const bar = wrapper.find('[data-testid="mobile-error-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('role')).toBe('alert')
    expect(wrapper.find('[data-testid="mobile-error-bar-text"]').text()).toBe(t('mobile.errorBar.responseNotDelivered'))
  })

  it('后到错误覆盖前一条（单槽覆盖式，轻量 v1 形态锚定）', () => {
    errorBarEffects.onGlobalError('first failure')
    errorBarEffects.onGlobalError('second failure')
    wrapper = mountErrorBar()

    const text = wrapper.find('[data-testid="mobile-error-bar-text"]').text()
    expect(text).toBe('second failure')
    // 单槽：整条错误条只有一行错误文本（非累积列表）
    expect(wrapper.findAll('[data-testid="mobile-error-bar-text"]').length).toBe(1)
  })

  it('关闭钮点击后错误条消失（手动 dismiss，无自动消失 timer）', async () => {
    errorBarEffects.onGlobalError('dismissible failure')
    wrapper = mountErrorBar()
    expect(wrapper.find('[data-testid="mobile-error-bar"]').exists()).toBe(true)

    await wrapper.find('[data-testid="mobile-error-bar-dismiss"]').trigger('click')
    expect(wrapper.find('[data-testid="mobile-error-bar"]').exists()).toBe(false)
  })
})
