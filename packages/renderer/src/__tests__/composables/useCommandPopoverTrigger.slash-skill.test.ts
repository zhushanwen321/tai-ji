/**
 * useCommandPopoverTrigger slash/skill 触发分支单测。
 *
 * 覆盖（测试舰队审查登记缺口：slash/skill 触发分支零覆盖——attach.test 锁 + 菜单
 * 分支、session-subagent.test 锁 #/@ 分支，本文件补行首 / 与行中空白后 / 两条路径）：
 *   - onSlashTrigger({query}) → cmdType='slash' 开浮层记 query；再 trigger(null) → 关闭
 *   - onSkillTrigger({query}) → cmdType='skill' 开浮层记 query；再 trigger(null) → 关闭
 *   - 未触发路径：初始关闭态下 trigger(null) 无副作用（不开浮层、状态不变）
 *   - 触发域互斥：slash 浮层开着再遇 skill 触发 → cmdType 切换、浮层保持开（同刻单浮层）
 *   - + 菜单 slash 路径（onAddSelect('slash')）：开浮层但**不设**触发态——后续
 *     onSlashTrigger(null) 不关闭浮层（防普通键误关 + 菜单浮层的核心契约）
 *
 * mock 策略：对齐 useCommandPopoverTrigger.attach.test.ts（effectScope + inputRef spy 对象）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useCommandPopoverTrigger.slash-skill.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, ref } from 'vue'

import { useCommandPopoverTrigger } from '@/composables/panel/useCommandPopoverTrigger'

/** inputRef mock：spy 覆盖本测试触达的插入/清除/焦点方法 */
function createInputMock() {
  return {
    focus: vi.fn(),
    saveSelection: vi.fn(),
    clearSlashQueryText: vi.fn(),
    insertSlashChip: vi.fn(),
    clearSkillQueryText: vi.fn(),
    insertSkillChip: vi.fn(),
  }
}

/** 在独立 effectScope 内运行 composable（watch 等需 scope） */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

describe('useCommandPopoverTrigger slash/skill 触发（/ 两触发域路径）', () => {
  let dispose: (() => void) | undefined

  beforeEach(() => {
    setActivePinia(createPinia())
  })
  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  function setup() {
    const inputMock = createInputMock()
    const { result, dispose: d } = runWithScope(() =>
      useCommandPopoverTrigger(ref(inputMock) as never, ref('sid') as never),
    )
    dispose = d
    return { result, inputMock }
  }

  it('onSlashTrigger({query}) → cmdType=slash 开浮层记 query；trigger(null) → 关闭', () => {
    const { result } = setup()
    expect(result.cmdOpen.value).toBe(false)

    result.onSlashTrigger({ query: 'he' })
    expect(result.cmdOpen.value).toBe(true)
    expect(result.cmdType.value).toBe('slash')
    expect(result.slashQuery.value).toBe('he')

    // 触发路径打开的浮层：trigger(null) 关闭（符号后遇空格等终止场景）
    result.onSlashTrigger(null)
    expect(result.cmdOpen.value).toBe(false)
  })

  it('onSkillTrigger({query}) → cmdType=skill 开浮层记 query；trigger(null) → 关闭', () => {
    const { result } = setup()

    result.onSkillTrigger({ query: 're' })
    expect(result.cmdOpen.value).toBe(true)
    expect(result.cmdType.value).toBe('skill')
    expect(result.skillQuery.value).toBe('re')

    result.onSkillTrigger(null)
    expect(result.cmdOpen.value).toBe(false)
  })

  it('未触发路径：初始关闭态下 trigger(null) 无副作用（不开浮层、状态保持）', () => {
    const { result } = setup()

    result.onSlashTrigger(null)
    expect(result.cmdOpen.value).toBe(false)
    expect(result.cmdType.value).toBe('file') // 默认类型不变

    result.onSkillTrigger(null)
    expect(result.cmdOpen.value).toBe(false)
  })

  it('触发域互斥：slash 浮层开着再遇 skill 触发 → cmdType 切 skill、浮层保持开（同刻单浮层）', () => {
    const { result } = setup()

    result.onSlashTrigger({ query: 'he' })
    expect(result.cmdOpen.value).toBe(true)
    expect(result.cmdType.value).toBe('slash')

    result.onSkillTrigger({ query: 're' })
    expect(result.cmdOpen.value).toBe(true) // 浮层不闪关
    expect(result.cmdType.value).toBe('skill')
    expect(result.skillQuery.value).toBe('re')
    // slash 触发态被 skill 接管后，slash 路 null 不再关浮层（触发态各路独立）
    result.onSkillTrigger(null)
    expect(result.cmdOpen.value).toBe(false)
  })

  it('+ 菜单 slash 路径：开浮层但不设触发态 → 后续 onSlashTrigger(null) 不误关浮层', async () => {
    const { result, inputMock } = setup()

    await result.onAddSelect('slash')
    expect(inputMock.saveSelection).toHaveBeenCalledTimes(1)
    expect(inputMock.focus).toHaveBeenCalledTimes(1)
    expect(result.cmdOpen.value).toBe(true)
    expect(result.cmdType.value).toBe('slash')

    // + 菜单路径未设触发态：输入区 slash 触发终止信号（null）不得误关浮层
    result.onSlashTrigger(null)
    expect(result.cmdOpen.value).toBe(true)
  })
})
