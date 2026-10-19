/**
 * RetryIndicator（auto_retry 指示位）单测。
 *
 * 锁定轻行形态（对齐 QueueBubble 瞬态行同族语言）：
 * 1. state=undefined 不渲染（v-if）；有 state 渲染单行。
 * 2. 形态断言：根行**无横幅底色/边框**（瞬态过程指示不抢视觉权重、六主题中性灰调通用），
 *    warn 语义只上旋转图标与「重试中」chip（bg-warn-soft 小胶囊）。
 * 3. 内容断言：尝试次数 mono（N/M，缺 maxAttempts 时无斜杠）、errorMessage 缩略尾、hover title。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/retry-indicator.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RetryIndicator from '@/components/panel/RetryIndicator.vue'
import type { RetryState } from '@/stores/chat'

function mountIndicator(state: RetryState | undefined) {
  return mount(RetryIndicator, { props: { state } })
}

const fullState: RetryState = {
  attempt: 1,
  maxAttempts: 3,
  delayMs: 800,
  errorMessage: 'The operation timed out.',
}

describe('RetryIndicator', () => {
  it('state=undefined 不渲染（store 清态后 v-if 消失）', () => {
    const w = mountIndicator(undefined)
    expect(w.find('div').exists()).toBe(false)
  })

  it('渲染轻行：根行无横幅底色与边框（去 bg-warn-soft / border 大色块）', () => {
    const w = mountIndicator(fullState)
    const root = w.get('div')
    expect(root.classes()).not.toContain('bg-warn-soft')
    expect(root.classes().some((c) => c.startsWith('border'))).toBe(false)
  })

  it('warn 语义只上图标与「重试中」chip（bg-warn-soft 小胶囊）', () => {
    const w = mountIndicator(fullState)
    const icon = w.get('svg')
    expect(icon.classes()).toContain('animate-spin')
    expect(icon.classes()).toContain('text-warn')
    const chip = w.findAll('span').find((s) => s.text() === '重试中')
    expect(chip).toBeDefined()
    expect(chip!.classes()).toContain('bg-warn-soft')
    expect(chip!.classes()).toContain('text-warn')
  })

  it('尝试次数 mono 文本 N/M；errorMessage 缩略尾展示', () => {
    const w = mountIndicator(fullState)
    const counter = w.findAll('span').find((s) => s.text() === '1/3')
    expect(counter).toBeDefined()
    expect(counter!.classes()).toContain('font-mono')
    const err = w.findAll('span').find((s) => s.text() === 'The operation timed out.')
    expect(err).toBeDefined()
    expect(err!.classes()).toContain('truncate')
  })

  it('缺 maxAttempts 时只显 attempt 数字；缺 errorMessage 时无缩略尾', () => {
    const w = mountIndicator({ attempt: 2 })
    expect(w.findAll('span').some((s) => s.text() === '2')).toBe(true)
    expect(w.text()).not.toContain('/')
    const chip = w.findAll('span').find((s) => s.text() === '重试中')
    expect(chip).toBeDefined()
    // 仅 chip + 计数两个 span（无错误消息缩略尾）
    expect(w.findAll('span')).toHaveLength(2)
  })

  it('hover title 携带上一次失败原因', () => {
    const w = mountIndicator(fullState)
    expect(w.get('div').attributes('title')).toContain('The operation timed out.')
  })
})
