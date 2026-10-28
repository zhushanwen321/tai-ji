import { i18n } from '../../i18n';
import { chatStore } from '../../shell/app-runtime';
import { __testing, errorBarEffects, mobileUiResponseTransport } from '../../shell/companion-bridge';
import ErrorBar from '../ErrorBar.vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← error-bar.test.ts
// ======================================================================

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
