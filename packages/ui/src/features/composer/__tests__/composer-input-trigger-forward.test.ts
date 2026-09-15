/**
 * ComposerInput 四符号触发转发层单测（composer-symbol-system 四符号换绑，PR #191）。
 *
 * 组件层契约（转发映射 + bash 豁免短路 D6）：
 * - dom-core onFileTrigger 回调绑 # 检测 → 转发 emit 'session-trigger'（# session 语义）
 * - dom-core onDollarFileTrigger 绑 $ 检测 → 转发 emit 'file-trigger'（浮层链路复用，只换符号）
 * - dom-core onSubagentTrigger 绑 @ 检测 → 转发 emit 'subagent-trigger'
 * - suppressTriggers=true（bash 态 !/!! 前缀）→ 四路 trigger 统一发 null（关闭浮层语义），
 *   draft 同步（input emit）与 DOM 内容不受影响
 *
 * mock 策略：happy-dom 支持 Selection.addRange 定位光标（触发检测依赖光标位置）。
 * 设 textContent → focus → Range collapse 到 offset → trigger('input')。
 * deps（pasteImage/renderIcon/t）经 ComposerInputDeps provide 注入（W4 迁移契约）。
 * renderer 侧同名场景测试（composer-hash-trigger.test.ts）在 renderer 包跑 coverage，
 * 本文件落 ui 包内，补 ui 包对 ComposerInput.vue 的行覆盖。
 *
 * 运行：cd packages/ui && npx vitest run src/features/composer/__tests__/composer-input-trigger-forward.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { HandleImagePasteResult } from '@taiji/dom-core/composer/input'
import ComposerInput from '../ComposerInput.vue'
import { ComposerInputDepsKey } from '../composer-input-deps'
import type { ComposerInputDeps } from '../composer-input-deps'

const deps: ComposerInputDeps = {
  pasteImage: async (): Promise<HandleImagePasteResult> => ({ kind: 'text', text: '[测试环境]' }),
  renderIcon: () => false,
  t: (key: string) => key,
}

beforeEach(() => {
  // 清掉前一个用例残留的 selection range（指向已卸载节点会污染检测前置判定）
  window.getSelection()?.removeAllRanges()
})

function mountInput(extraProps: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ComposerInput, {
    props: extraProps,
    global: { provide: { [ComposerInputDepsKey as symbol]: deps } },
  })
}

/**
 * 在 contenteditable div 内键入文本并把光标定位到 offset（触发检测读光标前文本）。
 * @param cursorOffset 光标在文本中的字符偏移，默认文本末尾（真实输入路径）
 */
async function typeWithCursor(
  wrapper: ReturnType<typeof mount>,
  text: string,
  cursorOffset = text.length,
): Promise<void> {
  const div = wrapper.find('[role="textbox"]')
  const el = div.element as HTMLDivElement
  el.textContent = text
  el.focus()
  const sel = window.getSelection()
  if (sel && el.firstChild) {
    const range = document.createRange()
    range.setStart(el.firstChild, Math.min(cursorOffset, text.length))
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }
  await div.trigger('input')
}

/** 最后一次某事件的 payload（无事件返回 undefined） */
function lastEmit(wrapper: ReturnType<typeof mount>, event: string): unknown {
  const emitted = wrapper.emitted(event)
  return emitted?.at(-1)?.[0]
}

describe('ComposerInput 四符号触发转发（suppressTriggers=false 默认）', () => {
  it('T1 # → emit session-trigger {query}（dom-core onFileTrigger 换绑转发，非 file-trigger 命中）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '查 #auth', 7)
    expect(lastEmit(wrapper, 'session-trigger')).toEqual({ query: 'auth' })
    // 同轮 $ 检测不命中 → file-trigger 发 null（# 与 $ 路由互斥）
    expect(lastEmit(wrapper, 'file-trigger')).toBeNull()
  })

  it('T2 $ → emit file-trigger {query}（$ 文件语义，emit 名保留 file-trigger）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '读 $src/to', 10)
    expect(lastEmit(wrapper, 'file-trigger')).toEqual({ query: 'src/to' })
    // # 检测同轮不命中
    expect(lastEmit(wrapper, 'session-trigger')).toBeNull()
  })

  it('T3 @ → emit subagent-trigger {query}（四符号新增）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '@build', 6)
    expect(lastEmit(wrapper, 'subagent-trigger')).toEqual({ query: 'build' })
    expect(lastEmit(wrapper, 'file-trigger')).toBeNull()
    expect(lastEmit(wrapper, 'session-trigger')).toBeNull()
  })

  it('T4 符号后空格 → 对应 trigger 发 null（终止语义，浮层关闭）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '#auth ', 6)
    expect(lastEmit(wrapper, 'session-trigger')).toBeNull()
    await typeWithCursor(wrapper, '$auth ', 6)
    expect(lastEmit(wrapper, 'file-trigger')).toBeNull()
    await typeWithCursor(wrapper, '@build ', 7)
    expect(lastEmit(wrapper, 'subagent-trigger')).toBeNull()
  })
})

describe('ComposerInput bash 豁免短路（D6：suppressTriggers=true）', () => {
  it('B1 bash 态输入 !echo $HOME → 三路 trigger 全 null（不出现非 null payload）', async () => {
    const wrapper = mountInput({ suppressTriggers: true })
    // 「!echo $HOME」：$ 前有空格，若未短路会命中 file-trigger {query:'HOME'}
    await typeWithCursor(wrapper, '!echo $HOME', 11)
    for (const event of ['session-trigger', 'file-trigger', 'subagent-trigger', 'slash-trigger']) {
      const emitted = wrapper.emitted(event)
      // 短路 = 检测回调统一发 null（关闭浮层语义）；未发或全 null 均可，绝不非 null
      expect(emitted?.every((args) => args[0] === null) ?? true).toBe(true)
    }
  })

  it('B2 bash 态 draft 同步不受影响：input emit 照常携带全文 + DOM 文本保留', async () => {
    const wrapper = mountInput({ suppressTriggers: true })
    await typeWithCursor(wrapper, '!echo $HOME', 11)
    expect(lastEmit(wrapper, 'input')).toBe('!echo $HOME')
    expect((wrapper.find('[role="textbox"]').element as HTMLDivElement).textContent).toBe('!echo $HOME')
  })

  it('B3 对照：suppressTriggers=false 时同输入 $ 照常触发 file-trigger（短路仅 bash 态生效）', async () => {
    const wrapper = mountInput()
    await typeWithCursor(wrapper, '!echo $HOME', 11)
    expect(lastEmit(wrapper, 'file-trigger')).toEqual({ query: 'HOME' })
  })

  it('B4 bash 态 # / @ 同样被短路（一致豁免：# 是注释、@ 是语法成分）', async () => {
    const wrapper = mountInput({ suppressTriggers: true })
    await typeWithCursor(wrapper, '!cmd #tag', 9)
    expect(lastEmit(wrapper, 'session-trigger')).toBeNull()
    await typeWithCursor(wrapper, '!run @arg', 9)
    expect(lastEmit(wrapper, 'subagent-trigger')).toBeNull()
  })
})
