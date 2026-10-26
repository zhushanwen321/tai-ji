// ModelSheet 组件级单测（remote-use-mobile-v2 §7.2 F9 模型切换呈现面）。
//
// 锁定：liveState 复合串（core 契约 "provider/modelId"，live-state.ts:33）与模型行的
// 比对面——「当前」标记 / 行高亮 / 失效提示三处共用拆段单点（桌面 ModelPickerPanel
// 拆段同构）。附带发现修复的回归锁定：裸 id 直比下复合串恒 miss（「当前」不点亮 +
// 「不在可用清单」误报），修复后复合串命中、同 short-id 双 provider 不双亮、裸 id
// （无 '/'）回退全局匹配、清单外值显式提示。
//
// mock 策略（对齐 chat-screen.test 先例）：app-runtime 部分模块级 mock——模型清单两源
// （subscribeModels/fetchModels）与切换 RPC（switchSessionModel/setSessionThinkingLevel）
// 替换；liveStateStore 真实 store 写入（权威值播种走唯一写入口 applyLiveState）。
// Sheet 内容经 reka portal 渲染到 document.body（permission-sheet.test 同款 document 查询）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import type { ModelInfo, ProviderId } from '@taiji/shared'
import ModelSheet from '../ModelSheet.vue'
import { i18n } from '../../i18n'
import { liveStateStore } from '../../shell/app-runtime'

const { fetchModelsMock, subscribeModelsMock } = vi.hoisted(() => ({
  fetchModelsMock: vi.fn<() => Promise<ModelInfo[]>>(),
  subscribeModelsMock: vi.fn<(cb: (list: ModelInfo[]) => void) => () => void>(),
}))

vi.mock('../../shell/app-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shell/app-runtime')>()
  return {
    ...actual,
    subscribeModels: subscribeModelsMock,
    fetchModels: fetchModelsMock,
    switchSessionModel: vi.fn(),
    setSessionThinkingLevel: vi.fn(),
  }
})

const SID = 'sid-model-sheet'

function model(overrides: Partial<Omit<ModelInfo, 'providerId'>> & { id: string; providerId: string }): ModelInfo {
  return {
    name: overrides.id,
    providerName: overrides.providerId,
    ...overrides,
    // 裸 string → ProviderId 品牌提升（shared provider.ts 先例：磁盘/字面量来源 as 提升）
    providerId: overrides.providerId as ProviderId,
  }
}

const FIXTURE_MODELS: ModelInfo[] = [
  model({ id: 'mock-a', providerId: 'prov-alpha', providerName: 'Alpha', name: 'Model A' }),
  model({ id: 'mock-b', providerId: 'prov-beta', providerName: 'Beta', name: 'Model B' }),
]

function bodyEl(testid: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testid}"]`)
}

function tOf(key: string): string {
  return (i18n.global.t as (key: string) => string)(key)
}

async function mountSheet(): Promise<VueWrapper> {
  const wrapper = mount(ModelSheet, {
    props: { open: true, sessionId: SID },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  fetchModelsMock.mockReset().mockResolvedValue(FIXTURE_MODELS)
  subscribeModelsMock.mockReset().mockImplementation(() => () => {})
  liveStateStore.removeLiveState(SID)
})

afterEach(() => {
  document.body.innerHTML = ''
  liveStateStore.removeLiveState(SID)
})

describe('ModelSheet（§7.2 F9：liveState 复合串比对呈现面）', () => {
  it('复合串权威值命中清单行：「当前」标记点亮 + 行高亮 + 无失效提示（裸 id 直比下的恒 miss 缺陷锁定）', async () => {
    liveStateStore.applyLiveState(SID, { modelId: 'prov-alpha/mock-a' })
    const wrapper = await mountSheet()

    const row = bodyEl('model-sheet-model-mock-a')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain(tOf('mobile.model.current'))
    expect(row!.className).toContain('bg-accent-soft')
    // 命中清单 → 失效提示分支不在场
    expect(bodyEl('model-sheet-current-invalid')).toBeNull()
    wrapper.unmount()
  })

  it('同 short-id 双 provider：仅 provider 归属匹配的行点亮（拆段双匹配，不双行同亮）', async () => {
    fetchModelsMock.mockResolvedValue([
      model({ id: 'mock-a', providerId: 'prov-alpha', providerName: 'Alpha', name: 'Model A' }),
      model({ id: 'mock-a', providerId: 'prov-beta', providerName: 'Beta', name: 'Model A (beta)' }),
    ])
    liveStateStore.applyLiveState(SID, { modelId: 'prov-beta/mock-a' })
    const wrapper = await mountSheet()

    const rows = Array.from(document.body.querySelectorAll('[data-testid="model-sheet-model-mock-a"]'))
    expect(rows).toHaveLength(2)
    const lit = rows.filter((r) => r.textContent?.includes(tOf('mobile.model.current')))
    expect(lit).toHaveLength(1)
    expect(lit[0]!.textContent).toContain('Beta')
    wrapper.unmount()
  })

  it('裸 id 权威值（无 \'/\'，拆段回退分支）：按裸 id 全局匹配点亮（桌面 ModelPickerPanel 同构先例）', async () => {
    liveStateStore.applyLiveState(SID, { modelId: 'mock-a' })
    const wrapper = await mountSheet()

    expect(bodyEl('model-sheet-model-mock-a')!.textContent).toContain(tOf('mobile.model.current'))
    wrapper.unmount()
  })

  it('权威值不在清单：失效提示分支在场（原值 + 提示切换），清单行无「当前」标记', async () => {
    liveStateStore.applyLiveState(SID, { modelId: 'prov-alpha/gone-model' })
    const wrapper = await mountSheet()

    const invalid = bodyEl('model-sheet-current-invalid')
    expect(invalid).not.toBeNull()
    expect(invalid!.textContent).toContain('gone-model')
    expect(bodyEl('model-sheet-model-mock-a')!.textContent).not.toContain(tOf('mobile.model.current'))
    wrapper.unmount()
  })
})

describe('ModelSheet 思考档段控（§7.2：非段值不点亮段选中态）', () => {
  function segments(): HTMLElement[] {
    return Array.from(document.body.querySelectorAll('[data-testid="model-sheet-thinking-segments"] [role="tab"]'))
  }

  it('段值权威值：对应段 aria-selected=true + 选中底（tab 型），他段不点亮', async () => {
    liveStateStore.applyLiveState(SID, { thinkingLevel: 'low' })
    const wrapper = await mountSheet()

    const tabs = segments()
    expect(tabs).toHaveLength(4)
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(tabs[0].className).toContain('bg-bg-elevated')
    expect(tabs[1].getAttribute('aria-selected')).toBe('false')
    // 段值形态无段外提示行
    expect(bodyEl('model-sheet-thinking-offsegment')).toBeNull()
    wrapper.unmount()
  })

  it('非段值 off：四段全不点亮（aria-selected 全 false、无选中底），段外提示行在场，就近段无键盘锁死', async () => {
    liveStateStore.applyLiveState(SID, { thinkingLevel: 'off' })
    const wrapper = await mountSheet()

    const tabs = segments()
    for (const tab of tabs) {
      expect(tab.getAttribute('aria-selected')).toBe('false')
      expect(tab.className).not.toContain('bg-bg-elevated')
      expect(tab.className).not.toContain('shadow-1')
    }
    // 段外原值提示行在场（原值短词标注；就近段不进段控——无段级视觉呈现）
    const hint = bodyEl('model-sheet-thinking-offsegment')
    expect(hint).not.toBeNull()
    // roving tabindex 锚点落首段（无选中不锁键盘）
    expect(tabs[0].getAttribute('tabindex')).toBe('0')
    expect(tabs[1].getAttribute('tabindex')).toBe('-1')
    wrapper.unmount()
  })
})
