/**
 * ProviderTestDiscoverSection（「模型发现」区）组件契约测试。
 *
 * 2026-10-21（用户拍板）：「测试连接」按钮与本组件原按协议分组结果区退役——测试入口下沉到
 * 每个模型行（ModelTestButton，编排契约见 provider-edit-body.test.ts 的 per-model 接线组）。
 * 本组件现只承载「模型发现」（GET /v1/models，只对 custom provider 渲染）。
 *
 * 组件契约：零内部状态——discovering/discoverResult/providerKind 全部 props 注入，
 * @discover 事件上抛由父组件（useProviderEdit.autoDiscover）消费。
 *
 * 覆盖：
 * - custom 渲染「模型发现」按钮、点击上抛 discover；discovering=true → disabled + 防重复
 * - catalog（providerKind='catalog'）不渲染按钮（pi 无 fetchModels，清单编译期权威）
 * - discoverResult 非空 → 渲染结果文案
 *
 * 测试框架：vitest。i18n 经 ui vitest.setup mock（t 返回 key + 命名参数追加），断言用 key 与参数值。
 * 运行：cd packages/ui && npx vitest run src/features/settings/__tests__/provider-test-discover-section.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ProviderTestDiscoverSection from '../provider/ProviderTestDiscoverSection.vue'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

function mountSection(props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ProviderTestDiscoverSection, {
    props: {
      discovering: false,
      discoverResult: '',
      ...props,
    },
    attachTo: document.body,
  })
}

/** 按 i18n key 文本定位按钮（mock t 返回 key） */
function findButtonByKey(w: ReturnType<typeof mount>, key: string) {
  return w.findAll('button').find((b) => b.text().includes(key))
}

describe('模型发现按钮（custom 体系）', () => {
  it('渲染按钮，点击上抛 discover 事件', async () => {
    wrapper = mountSection()
    const btn = findButtonByKey(wrapper, 'settings.providerEdit.autoDiscover')
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    expect(wrapper.emitted('discover')).toBeTruthy()
  })

  it('discovering=true → 按钮 disabled + 文案切换（进行中防重复点击）', async () => {
    wrapper = mountSection({ discovering: true })
    const btn = findButtonByKey(wrapper, 'settings.providerEdit.discovering')
    expect(btn).toBeTruthy()
    expect(btn!.attributes('disabled')).toBeDefined()
  })

  it('discoverResult 非空 → 渲染结果文案', () => {
    wrapper = mountSection({ discoverResult: '已发现 3 个模型' })
    expect(wrapper.text()).toContain('已发现 3 个模型')
  })
})

describe('catalog 门控（providerKind=catalog 不渲染发现按钮）', () => {
  it('providerKind=catalog → 无「模型发现」按钮（pi 无 fetchModels，清单编译期权威）', () => {
    wrapper = mountSection({ providerKind: 'catalog' })
    expect(findButtonByKey(wrapper, 'settings.providerEdit.autoDiscover')).toBeUndefined()
  })

  it('providerKind 缺省 → 按 custom 渲染（向后兼容既有调用方）', () => {
    wrapper = mountSection()
    expect(findButtonByKey(wrapper, 'settings.providerEdit.autoDiscover')).toBeTruthy()
  })
})
