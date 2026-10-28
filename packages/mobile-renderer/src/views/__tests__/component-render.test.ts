import { i18n } from '../../i18n';
import { chatStore } from '../../shell/app-runtime';
import { __testing, errorBarEffects, mobileUiResponseTransport } from '../../shell/companion-bridge';
import ErrorBar from '../ErrorBar.vue';
import MobileFormCard from '../MobileFormCard.vue';
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension';
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

// ======================================================================
// ← mobile-form-card.test.ts
// ======================================================================

const OTHER_TESTID = 'mobile-form-option-__other__'
const INPUT_TESTID = 'mobile-form-other-input'

function choiceRequest(overrides: Record<string, unknown> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sid-other',
    requestId: 'req-1',
    method: 'select',
    form: true,
    formQuestions: [
      {
        type: 'choice',
        header: 'db',
        question: '用哪个数据库？',
        options: [{ label: 'pg' }, { label: 'mysql' }],
        // overrides 值域 unknown，spread 前按 fixture 注入点收窄（缺省 undefined 合法展开）
        ...(overrides.question as Record<string, unknown> | undefined),
      },
    ],
    // overrides 值域 unknown，spread 前按 fixture 注入点收窄（缺省 undefined 合法展开）
    ...(overrides.request as Record<string, unknown> | undefined),
  } as unknown as ExtensionUIRequest
}

function mountCard(request: ExtensionUIRequest) {
  // happy-dom navigator.language 非 zh → detectLocale 落 en-US；文案断言固定 zh-CN
  // （mobile-session-views.test.ts 同式）
  i18n.global.locale.value = 'zh-CN'
  return mount(MobileFormCard, { global: { plugins: [i18n] }, props: { request } })
}

describe('MobileFormCard「其他」合成选项卡（A10）', () => {
  it('allowOther 表单出现「其他」选项卡（合成于选项末尾；allowOther=false 不出现）', () => {
    // 协议缺省 allowOther = true：合成卡在场，文案走 extensionUI.other
    const card = mountCard(choiceRequest())
    const other = card.find(`[data-testid="${OTHER_TESTID}"]`)
    expect(other.exists()).toBe(true)
    expect(other.text()).toContain('其他')
    // allowOther 显式 false：不合成（协议显式收窄）
    const disallowed = mountCard(choiceRequest({ question: { allowOther: false } }))
    expect(disallowed.find(`[data-testid="${OTHER_TESTID}"]`).exists()).toBe(false)
    disallowed.unmount()
    card.unmount()
  })

  it('选中「其他」后输入框可见（显隐绑定选中态），未选中时不渲染', async () => {
    const card = mountCard(choiceRequest())
    expect(card.find(`[data-testid="${INPUT_TESTID}"]`).exists()).toBe(false)

    await card.get(`[data-testid="${OTHER_TESTID}"]`).trigger('click')
    expect(card.find(`[data-testid="${INPUT_TESTID}"]`).exists()).toBe(true)

    // 单选再点同一项 = 取消：输入框随选中态收起
    await card.get(`[data-testid="${OTHER_TESTID}"]`).trigger('click')
    expect(card.find(`[data-testid="${INPUT_TESTID}"]`).exists()).toBe(false)
    card.unmount()
  })

  it('提交含自由文本：Other 文本走 `${key}__other` 独立键（不混进选中项数组）', async () => {
    const card = mountCard(choiceRequest())
    await card.get(`[data-testid="${OTHER_TESTID}"]`).trigger('click')
    await card.get(`[data-testid="${INPUT_TESTID}"]`).setValue('自建 SQLite 分支')

    // 仅选 Other 无普通选项：主 key 不写（selected 过滤占位符后为空），只有 __other 键
    await card.get('[data-testid="mobile-form-submit"]').trigger('click')
    expect(card.emitted('submit')).toEqual([
      [{ requestId: 'req-1', result: JSON.stringify({ db__other: '自建 SQLite 分支' }) }],
    ])
    card.unmount()
  })

  it('多选场景：Other 与普通选项并存提交（主 key JSON 数组 + __other 键同 envelope）', async () => {
    const card = mountCard(
      choiceRequest({ question: { multi: true } }),
    )
    await card.get('[data-testid="mobile-form-option-pg"]').trigger('click')
    await card.get(`[data-testid="${OTHER_TESTID}"]`).trigger('click')
    await card.get(`[data-testid="${INPUT_TESTID}"]`).setValue('加个 redis')

    await card.get('[data-testid="mobile-form-submit"]').trigger('click')
    expect(card.emitted('submit')).toEqual([
      [{ requestId: 'req-1', result: JSON.stringify({ db: JSON.stringify(['pg']), db__other: '加个 redis' }) }],
    ])
    card.unmount()
  })

  it('单选互斥：选普通选项清 Other 文本（已有 toggle 语义，合成卡不破坏）', async () => {
    const card = mountCard(choiceRequest())
    await card.get(`[data-testid="${OTHER_TESTID}"]`).trigger('click')
    await card.get(`[data-testid="${INPUT_TESTID}"]`).setValue('会被清掉')
    await card.get('[data-testid="mobile-form-option-pg"]').trigger('click')

    // 普通选项互斥清 Other：输入框收起；重新展开后文本为空
    expect(card.find(`[data-testid="${INPUT_TESTID}"]`).exists()).toBe(false)
    await card.get(`[data-testid="${OTHER_TESTID}"]`).trigger('click')
    const input = card.get(`[data-testid="${INPUT_TESTID}"]`)
    expect((input.element as HTMLInputElement).value).toBe('')
    card.unmount()
  })
})
