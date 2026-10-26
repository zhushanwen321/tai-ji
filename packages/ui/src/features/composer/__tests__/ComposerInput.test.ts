/**
 * ComposerInput 组件合并测试产物（round5-g ui idx0）。
 *
 * 来源节（每来源文件包以基名命名的 describe，同被测对象 ComposerInput.vue）：
 *   composer-input-chip-mousedown / composer-input-get-text / composer-input-trigger-forward
 *
 * 共同 mock 策略：零 vi.mock；deps（pasteImage/renderIcon/t）经 ComposerInputDeps
 * provide 注入（W4 契约）。各节顶层 beforeEach/helper 随节下沉到 describe 内。
 *
 * 运行：cd packages/ui && npx vitest run src/features/composer/__tests__/ComposerInput.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { HandleImagePasteResult } from '@taiji/dom-core/composer/input'
import ComposerInput from '../ComposerInput.vue'
import { ComposerInputDepsKey } from '../composer-input-deps'
import type { ComposerInputDeps } from '../composer-input-deps'

describe('composer-input-chip-mousedown', () => {
/**
 * ComposerInput 徽章 mousedown 防光标 + × 原生按钮 单测（demo 方案 C 行为修复 2/3 组件层验证）。
 *
 * 契约：
 * - mousedown target 落在徽章（.slash-chip / .mention-chip；image-chip 挂在 mention-chip 上
 *   被同一选择器覆盖）内 → preventDefault（浏览器不把光标放进徽章边界，徽章行为原子化）
 * - mousedown 落在纯文本区 → 不拦截（正常光标放置）
 * - × 删除路径不受影响：preventDefault 只阻止光标放置，click 事件照常派发——真实
 *   insertSlashChip 插入的 chip 对 .chip-x 先 mousedown 后 click，chip 被删除且 input
 *   emit（removeChipNode → onChanged → onInput 链路）触发
 * - × 是原生 button[type=button]（demo chipHtml 同款，键盘可达），不另设 role 属性
 *
 * mock 策略：happy-dom 下经 dispatchEvent 派发冒泡 MouseEvent（vue-test-utils 的 trigger
 * 只能在被 find 的元素上派发，无法把 e.target 指到 chip 子元素）。deps 经 ComposerInputDeps
 * provide 注入（W4 契约）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/composer/__tests__/composer-input-chip-mousedown.test.ts
 */

const deps: ComposerInputDeps = {
  pasteImage: async (): Promise<HandleImagePasteResult> => ({ kind: 'text', text: '[测试环境]' }),
  renderIcon: () => false,
  t: (key: string) => key,
}

beforeEach(() => {
  // 清掉前一个用例残留的 selection range（指向已卸载节点会污染链路判定）
  window.getSelection()?.removeAllRanges()
})

function mountInput(): ReturnType<typeof mount> {
  return mount(ComposerInput, {
    global: { provide: { [ComposerInputDepsKey as symbol]: deps } },
  })
}

/** 在指定元素上派发冒泡 mousedown，返回该事件（断言 defaultPrevented 用） */
function dispatchMousedown(target: Element): MouseEvent {
  const e = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

describe('ComposerInput 徽章 mousedown 防光标（demo onEdMouseDown 同款）', () => {
  /** mount 后经 innerHTML 构造静态 chip（无事件监听——本组只测 mousedown 拦截，不测删除） */
  function mountWithChipHtml(html: string): { editor: HTMLDivElement } {
    const wrapper = mountInput()
    const editor = wrapper.find('[role="textbox"]').element as HTMLDivElement
    editor.innerHTML = html
    return { editor }
  }

  it('mousedown 落在 slash-chip 内（chip-label 子树）→ preventDefault（不落光标）', () => {
    const { editor } = mountWithChipHtml(
      '<span class="slash-chip" data-chip-type="slash"><span class="chip-label">/commit</span></span>',
    )
    const chipLabel = editor.querySelector('.chip-label') as Element
    expect(dispatchMousedown(chipLabel).defaultPrevented).toBe(true)
  })

  it('mousedown 落在 mention-chip 本体 → preventDefault（image-chip 挂 mention-chip 同覆盖）', () => {
    const { editor } = mountWithChipHtml(
      '<span class="mention-chip mention-file image-chip" data-chip-type="image"><span class="chip-label">a.png</span></span>',
    )
    const chip = editor.querySelector('.image-chip') as Element
    expect(dispatchMousedown(chip).defaultPrevented).toBe(true)
  })

  it('mousedown 落在纯文本区（编辑器本体）→ 不拦截（正常光标放置）', () => {
    const { editor } = mountWithChipHtml('正文文本')
    expect(dispatchMousedown(editor).defaultPrevented).toBe(false)
  })
})

describe('ComposerInput × 删除路径与 mousedown 拦截共存（修复 2/3 联动）', () => {
  it('真实 insertSlashChip → × 为 button[type=button] 无 role → mousedown 被拦后 click 照常删除并 emit input', () => {
    const wrapper = mountInput()
    const vm = wrapper.vm as unknown as { insertSlashChip: (cmd: string) => void }
    vm.insertSlashChip('/commit')

    const editor = wrapper.find('[role="textbox"]').element as HTMLDivElement
    const chip = editor.querySelector('.slash-chip') as HTMLElement
    expect(chip).not.toBeNull()
    const x = chip.querySelector('.chip-x') as HTMLElement
    // 修复 3：原生 button 键盘可达（type=button 防表单提交语义），原生语义自带故不设 role
    expect(x.tagName).toBe('BUTTON')
    expect((x as HTMLButtonElement).type).toBe('button')
    expect(x.getAttribute('role')).toBeNull()

    // 修复 2 与删除路径共存：mousedown 被 handler 拦截（不落光标），随后 click 照常派发——
    // 真实浏览器序列中 preventDefault 只阻止光标放置，删除监听（dom-core makeXButton）独立生效
    expect(dispatchMousedown(x).defaultPrevented).toBe(true)
    // 插入阶段（insertSlashChip 末尾 onChanged）已产生过 input 事件，须以长度增量才能区分删除路径的新 emit
    const emittedCountBeforeClick = wrapper.emitted('input')?.length ?? 0
    x.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(editor.querySelector('.slash-chip')).toBeNull()
    // removeChipNode → onChanged → onInput → emit('input')：draft 同步链路未断
    expect(wrapper.emitted('input')?.length ?? 0).toBe(emittedCountBeforeClick + 1)
  })
})
})

describe('composer-input-get-text', () => {
/**
 * ComposerInput.getText 单测 —— contenteditable 文本提取（换行保留 + chip 过滤）。
 *
 * 重点回归：Shift+Enter 产生的 <br> 必须提取为 \n，否则发送文本丢失软换行，
 * 用户气泡无法保留换行（whitespace-pre-wrap 容器内 <p>...</p> 里的 \n 不再可见）。
 *
 * mock 策略：happy-dom 支持 TreeWalker + createTreeWalker。直接 mount ui ComposerInput，
 * 设 [role="textbox"] 的 innerHTML 构造 contenteditable DOM，调 vm.getText() 断言。
 * deps（pasteImage/renderIcon/t）经 ComposerInputDeps provide 注入（W4 迁移：ui 包
 * 零 renderer import，deps 注入契约见 composer-input-deps.ts）。
 *
 * [W4 迁移] 自 renderer __tests__/panel/composer-input-get-text.test.ts 迁入 ui 包
 * features/composer/__tests__/（ComposerInput 组件新家）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/composer
 */

function provideDeps(wrapper: ReturnType<typeof mount>): void {
  // ui 包测试直接经 global.provide 注入（无需真实 IPC/i18n）
}

beforeEach(() => {
  vi.restoreAllMocks()
})

const deps: ComposerInputDeps = {
  pasteImage: async (): Promise<HandleImagePasteResult> => ({ kind: 'text', text: '[图片粘贴：需桌面环境]' }),
  renderIcon: () => false,
  t: (key: string) => key,
}

describe('ComposerInput.getText（换行保留 + chip × 过滤）', () => {
  /**
   * 构造 contenteditable 内容：直接写 innerHTML 到 [role="textbox"] div。
   * 返回该 div 的 element（调用方需要时可进一步断言 DOM 结构）。
   */
  function setup(html: string): ReturnType<typeof mount> {
    const wrapper = mount(ComposerInput, {
      global: { provide: { [ComposerInputDepsKey as symbol]: deps } },
    })
    const div = wrapper.find('[role="textbox"]')
    ;(div.element as HTMLDivElement).innerHTML = html
    return wrapper
  }

  /** expose 方法在 vm 上运行时可用，TS 类型需断言（defineExpose 不产生公开类型） */
  function getText(wrapper: ReturnType<typeof mount>): string {
    return (wrapper.vm as unknown as { getText: () => string }).getText()
  }

  it('纯文本：原样返回', () => {
    const wrapper = setup('hello world')
    expect(getText(wrapper)).toBe('hello world')
  })

  it('<br> 保留为 \\n（Shift+Enter 产生的换行不丢失）', () => {
    const wrapper = setup('line1<br>line2')
    expect(getText(wrapper)).toBe('line1\nline2')
  })

  it('多个 <br> 保留多个 \\n', () => {
    const wrapper = setup('a<br><br>b')
    expect(getText(wrapper)).toBe('a\n\nb')
  })

  it('末尾 <br> 保留（用户敲 Shift+Enter 后未输文字，发送时换行应可见）', () => {
    const wrapper = setup('text<br>')
    expect(getText(wrapper)).toBe('text\n')
  })

  it('slash-chip 读入（命令段归位为发送文本前缀，D4-b/D4-c）', () => {
    // 命令 chip 产 slash 段（name 走 dataset.chipName），getText 经 segmentsToText 归位
    // 提首——产物以 /goal 开头，与发送时 composer 扁平化一致
    const wrapper = setup('<span class="slash-chip" data-chip-type="slash" data-chip-name="goal"><span class="chip-label">/goal</span></span> do something')
    expect(getText(wrapper)).toBe('/goal do something')
  })

  it('chip × 按钮文本不混入发送内容', () => {
    // × 按钮在 chip 内，其 "×" 文本必须被 TreeWalker 跳过
    const wrapper = setup('<span class="slash-chip" data-chip-type="slash" data-chip-name="goal"><span class="chip-label">/goal</span><span class="chip-x">×</span></span>')
    expect(getText(wrapper)).toBe('/goal')
  })

  it('chip + 后续 <br> 换行：命令名 + 软换行 + 后续文本（slash→text 边界空格规则，偏差 #4）', () => {
    const wrapper = setup('<span class="slash-chip" data-chip-type="slash" data-chip-name="goal"><span class="chip-label">/goal</span><span class="chip-x">×</span></span><br>详细描述')
    // 归位后 slash 段在前，紧跟的 text 段以 \n 开头不属「自带前导空格」→ needsBoundarySpace 补一格
    expect(getText(wrapper)).toBe('/goal \n详细描述')
  })

  it('nbsp 转普通空格，零宽空格过滤', () => {
    // chip 后插的零宽空格（\u200B）作光标锚点，发送时必须过滤
    // nbsp（\u00A0）转普通空格，与 textarea 行为对齐
    const wrapper = setup('a\u00A0b\u200Bc')
    expect(getText(wrapper)).toBe('a bc')
  })
})
})

describe('composer-input-trigger-forward', () => {
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
})
