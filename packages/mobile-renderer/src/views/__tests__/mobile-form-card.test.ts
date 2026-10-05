// MobileFormCard「其他」合成选项卡（remote-use A10：allowOther 表单自由作答）。
//
// 修复面：组件此前只渲染 options 数组循环，无合成 Other 选项卡 → 输入框显隐条件恒假 →
// allowOther 表单在手机不可自由作答。对齐桌面 ChoiceQuestion.vue 合成语义：
// - 选项末尾追加 Other 卡片（allowOther !== false），toggle 交互与普通选项同构
// - Other 选中后输入框展开（显隐绑定选中态），文本经 otherText 状态承载
// - 提交编码走 form-protocol 既有契约：Other 文本写 `${key}__other` 独立键，不混进选中项
//
// 组件级 prop 渲染断言（无 App 装配依赖；链路级装配断言在 __tests__/mobile-form.spec.ts）。
//
// 运行：cd packages/mobile-renderer && npx vitest run src/views/__tests__/mobile-form-card.test.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MobileFormCard from '../MobileFormCard.vue'
import { i18n } from '../../i18n'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

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
        // overrides 值域 unknown，spread 前按 fixture 注入面收窄（缺省 undefined 合法展开）
        ...(overrides.question as Record<string, unknown> | undefined),
      },
    ],
    // overrides 值域 unknown，spread 前按 fixture 注入面收窄（缺省 undefined 合法展开）
    ...(overrides.request as Record<string, unknown> | undefined),
  } as unknown as ExtensionUIRequest
}

function mountCard(request: ExtensionUIRequest) {
  // happy-dom navigator.language 非 zh → detectLocale 落 en-US；文案断言固定 zh-CN
  // （mobile-session-list.spec.ts 同式）
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
