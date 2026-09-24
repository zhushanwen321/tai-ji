/**
 * ModelThinkingAggregate 测试 —— W3a 模型+思考聚合按钮（D2：click 出弹层，hover 行即切换）。
 *
 * 三视角：
 * - 使用者黑盒：click 触发器出弹层（body portal 内可见模型列表 + 思考档位行），
 *   hover / click 行为后的弹层开合状态以用户可见 DOM 断言；
 * - 观察者形态：emit 面（selectModel 同形 payload / selectThinking 发 runtime 实际值）；
 * - 构建者白盒：同值 hover 不 emit（去抖）——空 emit 断言（not.toBeDefined）。
 *
 * 数据注入：setActivePinia + 直赋 getSettingsStore().models（与 model-select-popover.test.ts 同模式）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/model-thinking-aggregate.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { ModelInfo } from '@taiji/shared'
import { getSettingsStore, __resetSettingsStoreForTesting } from '@taiji/core'

import ModelThinkingAggregate from '@/components/panel/ModelThinkingAggregate.vue'

const MODELS: ModelInfo[] = [
  { id: 'claude-4', name: 'Claude 4', providerId: 'anthropic', providerName: 'Anthropic' },
  { id: 'gpt-4', name: 'GPT-4', providerId: 'openai', providerName: 'OpenAI' },
] as unknown as ModelInfo[]

/** 高低两档映射（max 发 xhigh，与 ThinkingLevelPopover 测试同款 fixture） */
const LEVEL_MAP = { off: 'off', high: 'high', max: 'xhigh' }

let wrapper: VueWrapper | null = null

function mountAggregate(props: Record<string, unknown> = {}): VueWrapper {
  wrapper = mount(ModelThinkingAggregate, {
    props: {
      selected: 'anthropic/claude-4',
      level: 'high',
      levelMap: LEVEL_MAP,
      supportedLevels: ['off', 'high', 'max'],
      ...props,
    },
    attachTo: document.body,
  })
  return wrapper
}

/** click 触发器开弹层（reka Popover click 语义；打开后内容进 body portal） */
async function openAggregate(w: VueWrapper): Promise<void> {
  await w.find('[data-testid="composer-model-thinking-aggregate"]').trigger('click')
  await flushPromises()
}

function pickerPanel(): Element | null {
  return document.body.querySelector('[data-testid="model-picker-panel"]')
}

/** 对 portal 内元素派发 pointerenter（teleport 到 body，wrapper.find 够不到） */
async function hover(el: Element): Promise<void> {
  el.dispatchEvent(new Event('pointerenter'))
  await nextTick()
}

/** 对 portal 内元素派发 click（bubbles 模拟真实指针点击） */
async function click(el: Element): Promise<void> {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  __resetSettingsStoreForTesting()
  getSettingsStore().models.value = MODELS
  document.body.innerHTML = ''
  wrapper = null
})

describe('触发器与弹层（使用者黑盒）', () => {
  it('触发器：单图标 Boxes 按钮，title「模型 · 思考等级」（用户可见 DOM）', () => {
    const w = mountAggregate()
    const btn = w.find('[data-testid="composer-model-thinking-aggregate"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('模型 · 思考等级')
    expect(btn.findAll('svg')).toHaveLength(1)
  })

  it('click 触发器 → 弹层打开：模型列表 + 思考档位行同屏可见', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    // 模型段（用户可见 DOM）
    expect(pickerPanel()).not.toBeNull()
    expect(document.body.textContent ?? '').toContain('Claude 4')
    expect(document.body.textContent ?? '').toContain('GPT-4')
    // 思考段：三档行（off/high/max）+ 当前档（high）带选中态文案可见
    expect(document.body.querySelector('[data-testid="thinking-level-row-off"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="thinking-level-row-high"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="thinking-level-row-max"]')).not.toBeNull()
  })
})

describe('hover 切换（D2：hover 即切，不关弹层；同值不 emit）', () => {
  it('hover 模型行（值有变化）→ emit selectModel（同形 payload），弹层保持打开', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    const gptRow = document.body.querySelector('[data-testid="model-picker-item-gpt-4"]')
    expect(gptRow).not.toBeNull()
    await hover(gptRow!)

    const emitted = w.emitted('selectModel')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toEqual({ modelId: 'gpt-4', provider: 'openai' })
    // hover 切换不关弹层（用户还要继续瞄别的行）
    expect(pickerPanel()).not.toBeNull()
  })

  it('hover 当前选中模型行（裸 id 同值）→ 不 emit（天然去抖）', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    const claudeRow = document.body.querySelector('[data-testid="model-picker-item-claude-4"]')
    expect(claudeRow).not.toBeNull()
    await hover(claudeRow!)

    expect(w.emitted('selectModel')).toBeUndefined()
    expect(pickerPanel()).not.toBeNull()
  })

  it('hover 思考行（档位有变化）→ emit selectThinking（map 映射后的实际值 xhigh），弹层保持打开', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    const maxRow = document.body.querySelector('[data-testid="thinking-level-row-max"]')
    expect(maxRow).not.toBeNull()
    await hover(maxRow!)

    const emitted = w.emitted('selectThinking')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('xhigh')
    expect(pickerPanel()).not.toBeNull()
  })

  it('hover 当前思考档行（同值）→ 不 emit（天然去抖）', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    const highRow = document.body.querySelector('[data-testid="thinking-level-row-high"]')
    expect(highRow).not.toBeNull()
    await hover(highRow!)

    expect(w.emitted('selectThinking')).toBeUndefined()
  })
})

describe('click 选中（关弹层）', () => {
  it('click 模型行 → emit selectModel 后弹层关闭', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    const gptRow = document.body.querySelector('[data-testid="model-picker-item-gpt-4"]')
    expect(gptRow).not.toBeNull()
    await click(gptRow!)

    const emitted = w.emitted('selectModel')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toEqual({ modelId: 'gpt-4', provider: 'openai' })
    expect(pickerPanel()).toBeNull()
  })

  it('click 思考行 → emit selectThinking（实际值）后弹层关闭', async () => {
    const w = mountAggregate()
    await openAggregate(w)

    const maxRow = document.body.querySelector('[data-testid="thinking-level-row-max"]')
    expect(maxRow).not.toBeNull()
    await click(maxRow!)

    const emitted = w.emitted('selectThinking')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('xhigh')
    expect(pickerPanel()).toBeNull()
  })
})

describe('数据面与 ModelSelectPopover 同源（model-picker-data）', () => {
  it('enabled===false 的模型不进聚合列表（双保险过滤同源）', async () => {
    const mixed: ModelInfo[] = [
      ...MODELS,
      { id: 'claude-haiku', name: 'Claude Haiku', providerId: 'anthropic', providerName: 'Anthropic', enabled: false },
    ] as unknown as ModelInfo[]
    getSettingsStore().models.value = mixed

    const w = mountAggregate()
    await openAggregate(w)

    expect(document.body.querySelector('[data-testid="model-picker-item-claude-4"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="model-picker-item-claude-haiku"]')).toBeNull()
  })

  it('selected 带 provider 前缀时按裸 id 高亮（复合串拆段，同值判定同源）', async () => {
    // selected 已是 'anthropic/claude-4'（fixture 默认）——hover claude-4 不 emit 即反证裸 id 对齐；
    // 此处补 DOM 侧选中态断言（选中行带 SELECTED_ITEM_CLASS）
    const w = mountAggregate()
    await openAggregate(w)

    const claudeRow = document.body.querySelector('[data-testid="model-picker-item-claude-4"]')
    // 选中行带 SELECTED_ITEM_CLASS（bg-accent-soft），非选中行不带——裸 id 反查对齐的 DOM 侧证
    expect(claudeRow?.className ?? '').toContain('bg-accent-soft')
    const gptRow = document.body.querySelector('[data-testid="model-picker-item-gpt-4"]')
    expect(gptRow?.className ?? '').not.toContain('bg-accent-soft')
  })
})
