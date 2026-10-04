// TokenInputView 组件测试（remote-use U1.3 独立交付组件；App.vue 接线归 U1.4c）。
//
// 哑组件契约：渲染锚点 testid + submit 事件（trim 后上抛；空值不发）。
// 重试编排（adoptManualToken → 抑制位 reset → 重连）在 bootstrap.submitRemoteToken，
// 组件零 core import——本文件只测组件自身行为。
//
// 文案走 vue-i18n（mobile.tokenInput 命名空间）：挂 i18n 插件 + 双语渲染断言
//（硬编码中文回归防线，阶段 3 一致性修复）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/__tests__/token-input-view.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import TokenInputView from '../shell/TokenInputView.vue'
import { i18n } from '../i18n'

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
  // 拦截硬编码中文回归（check_i18n_cjk.py 只查 CJK，en 侧漏译由本用例守卫）
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

describe('TokenInputView 提交中/错误反馈投影（submitting/error props，App 投影 bootstrap tokenSubmit 态）', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh-CN'
  })

  it('submitting=true：提交按钮禁用且文案切「连接中…」（已输入 token 也禁用，防重复触发）；false 时可点显「连接」', async () => {
    const submitting = mountViewWith({ submitting: true })
    const submitBtn = submitting.get('[data-testid="token-submit"]')
    // 输入非空 token：禁用只由 submitting 驱动（空值守卫不参与本断言）
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
