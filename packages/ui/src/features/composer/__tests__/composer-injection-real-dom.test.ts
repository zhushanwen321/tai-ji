/**
 * composer 注入真实 DOM chip 端到端测试（R1/R3 补充验证）。
 *
 * W2 的 composer-file-injection.test.ts 用 mock ComposerInput（spy 验证调用）。
 * 本测试验证「真实 DOM chip 出现」：直接组合 core useComposerInjection +
 * core useComposerChipCommands，验证 watch 触发后 contenteditable 内真实 .mention-file chip。
 *
 * 覆盖：
 * - R1: store 写入 target=current → useComposerInjection watch → 真实 insertFileChip
 *   → contenteditable 内出现 .mention-file chip（dataset.chipPath 正确）
 * - R3: target=new → landing composer 消费 → 真实 DOM chip
 *
 * [W4 迁移] 自 renderer __tests__/panel/composer-injection-real-dom.test.ts 迁入 ui 包
 * features/composer/__tests__/——injection 逻辑在 core context 模块，store 用 core factory
 * 本地实例（零 pinia 依赖，替换原 useComposerInjectionStore pinia 单例）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/composer
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref, nextTick, type Ref } from 'vue'
import { createComposerInjectionStore, useComposerInjection } from '@taiji/core/domain/composer/context'
import type { ComposerInputInstance } from '@taiji/core/domain/composer'
import { useComposerChipCommands, useContenteditableInput } from '@taiji/dom-core/composer/input'
import type { ChipCallbacks, ContenteditableCallbacks } from '@taiji/dom-core/composer/input'

beforeEach(() => {
  document.body.innerHTML = ''
})

/**
 * 搭建真实 chip 操作链路：contenteditable div + useComposerChipCommands（真实 DOM）+
 * 一个模拟 ComposerInput 的 expose 对象（含真实 insertFileChip）。
 * useComposerInjection 通过 inputRef.value.insertFileChip 调用，与真实 ComposerInput 行为一致。
 * store 用 core factory 本地实例（每 setup 新建，隔离测试间状态）。
 */
function setupRealChipChain(variant: 'panel' | 'landing', sessionId: string | null, store?: ReturnType<typeof createComposerInjectionStore>) {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  el.setAttribute('data-testid', 'composer-input')
  document.body.appendChild(el)
  // 清掉前一个测试残留的 selection range（指向已移除节点会导致 insertNode 静默失败）
  window.getSelection()?.removeAllRanges()
  const elRef = ref(el) as Ref<HTMLDivElement | null>
  // 真实 restoreSelection 链路（设计 D1 / u2 改写点）：不 mock restoreSelection——
  // 活选区优先 + savedRange blur 回退的真实语义是 chip 落位正确性的被测对象，
  // mock 会掩盖插入位置回归（composer chip bug 存活根因）
  const inputCallbacks = {
    onInput: vi.fn(),
    onSlashTrigger: vi.fn(),
    onFileTrigger: vi.fn(),
    onEnterKeydown: vi.fn(),
    onKeydown: vi.fn(),
    handleBackspaceOnChip: vi.fn(() => false),
    insertImageBadge: vi.fn(),
    getSessionId: vi.fn(() => 's1'),
    pasteImage: vi.fn(),
  } as unknown as ContenteditableCallbacks
  const input = useContenteditableInput(elRef, inputCallbacks)
  const chipCommands = useComposerChipCommands(elRef, {
    onChanged: vi.fn(),
    restoreSelection: input.restoreSelection,
    renderIcon: () => false,
    t: (key: string) => key,
  } as ChipCallbacks)
  // 模拟 ComposerInput 的 defineExpose 对象（useComposerInjection 通过 inputRef.value 访问）。
  // W4：core 统一 ComposerInputInstance 契约（input/types.ts）——mock 只实现注入消费面，
  // 用断言补齐剩余方法（clear/setText 等壳层消费方法在真实组件上有，mock 不需要）。
  const fakeInputRef = ref({
    focus: vi.fn(),
    insertFileChip: chipCommands.insertFileChip,
  }) as unknown as Ref<ComposerInputInstance | null>
  const sessionIdRef = ref(sessionId)
  const variantRef = ref(variant)
  // 双挂载场景传入共享 store（模拟 pinia 单例语义），否则本地新建隔离实例
  const injectionStore = store ?? createComposerInjectionStore()
  useComposerInjection(fakeInputRef, sessionIdRef, variantRef, {
    injectionStore,
    startFlow: vi.fn(async () => {}),
    getSessionCwd: () => undefined,
    getActiveSessionId: () => sessionIdRef.value,
  })
  return { el, store: injectionStore, input }
}

/** 把光标 collapse 到指定文本节点的 offset 处 */
function setCursor(node: Node, offset: number): void {
  const sel = window.getSelection()
  sel?.removeAllRanges()
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  sel?.addRange(range)
}

describe('composer 注入真实 DOM chip（R1/R3）', () => {
  it('R1: target=current → watch → contenteditable 内真实 .mention-file chip', async () => {
    const { el, store } = setupRealChipChain('panel', 's1')
    store.requestInjection({ target: 'current', path: 'src/foo.ts', sessionId: 's1' })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.dataset.chipType).toBe('file')
    expect(chip.dataset.chipPath).toBe('src/foo.ts')
    expect(chip.querySelector('.chip-label')).toBeTruthy()
  })

  it('R1b: target=current 带 lineRange → 真实 chip dataset 含行范围', async () => {
    const { el, store } = setupRealChipChain('panel', 's1')
    store.requestInjection({
      target: 'current',
      path: 'src/foo.ts',
      lineStart: 10,
      lineEnd: 20,
      sessionId: 's1',
    })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip.dataset.chipLineStart).toBe('10')
    expect(chip.dataset.chipLineEnd).toBe('20')
  })

  it('R3: target=new → landing composer 消费 → 真实 DOM chip', async () => {
    const { el, store } = setupRealChipChain('landing', null)
    store.requestInjection({ target: 'new', path: 'bar.ts', sessionId: 's1' })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.dataset.chipPath).toBe('bar.ts')
  })

  it('R1c: 注入后 pendingInjection 清空（消费即清）', async () => {
    const { store } = setupRealChipChain('panel', 's1')
    store.requestInjection({ target: 'current', path: 'a.ts', sessionId: 's1' })
    await nextTick()
    expect(store.pendingInjection.value).toBeNull()
  })

  it('R1d: 真实选区链路——savedRange=头部旧快照 + 活光标在草稿末尾 → 注入 chip 落活光标处（设计 D1）', async () => {
    const { el, store, input } = setupRealChipChain('panel', 's1')
    el.textContent = 'AAA BBB'
    const textNode = el.firstChild as Text
    // savedRange 旧快照 = 头部（模拟点击框后打字推进，savedRange 不随打字更新）
    setCursor(textNode, 0)
    input.saveSelection()
    // 活光标在草稿末尾（键盘路径焦点从未离开）
    setCursor(textNode, 7)
    store.requestInjection({ target: 'current', path: 'cursor.ts', sessionId: 's1' })
    await nextTick()

    const chip = el.querySelector('.mention-file') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.dataset.chipPath).toBe('cursor.ts')
    // chip 不在头部（失败模式 A 回归）：firstChild 仍是正文文本，chip 紧跟其后
    expect(el.firstChild).toBe(textNode)
    expect(chip.previousSibling).toBe(textNode)
  })
})

// ── W18: split / dual panel 多 Composer 实例守护测试 ─────────────────────────────
// 防的 bug：split（panel+landing 同时挂载）/ dual panel 场景下，target=current 且
// sessionId 匹配活跃 session 时，可能被多个 Composer 实例误消费（双重注入）。
// 锁定契约：variant=panel 按 sessionId 精确匹配，variant=landing 仅消费 sessionId=null 的请求。
describe('W18: split / dual panel 多 Composer 实例注入隔离', () => {
  /**
   * 双挂载 setup：panel + landing 两个 Composer 共享同一 composerInjectionStore
   * 与同一 contenteditable 池（用不同 el 模拟两个独立 Composer 实例）。
   */
  function setupDualMount(panelSessionId: string | null) {
    // 共享同一 store（模拟 pinia 单例语义：drawer 写入 + 双 Composer 消费同一通道）
    const sharedStore = createComposerInjectionStore()
    const panelChain = setupRealChipChain('panel', panelSessionId, sharedStore)
    const landingChain = setupRealChipChain('landing', null, sharedStore)
    return {
      panelEl: panelChain.el,
      landingEl: landingChain.el,
      store: sharedStore,
    }
  }

  it('W18-1: panel + landing 双挂载 + target=current + sessionId=活跃 session → 仅 panel 注入，landing 不误消费', async () => {
    // 场景：split 视图（panel 显示活跃 session 的对话流，landing 显示空起始页）。
    // 用户从 drawer 注入到「当前活跃 session」。
    // 期望：panel composer（variant=panel，sessionId 匹配活跃 session）消费；
    //      landing composer（variant=landing，sessionId=null 不匹配 current 的非 null sessionId）不消费。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'current', path: 'main.ts', sessionId: 's-active' })
    await nextTick()

    // panel 注入成功
    const panelChip = panelEl.querySelector('.mention-file') as HTMLElement
    expect(panelChip).toBeTruthy()
    expect(panelChip.dataset.chipPath).toBe('main.ts')

    // landing 未注入（variant=landing 只消费 sessionId=null 的请求）
    expect(landingEl.querySelector('.mention-file')).toBeNull()

    // pendingInjection 被消费后清空（一次注入只对应一个 Composer，无双重消费）
    expect(store.pendingInjection.value).toBeNull()
  })

  it('W18-2: panel + landing 双挂载 + target=current + sessionId=null（routeToLanding 改写后）→ 仅 landing 注入', async () => {
    // 场景：阶段二，routeToLanding 把 target=new 改为 current 且 sessionId=null。
    // 此时 panel composer 不匹配（sessionId=null ≠ panel 的活跃 session），landing 匹配。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'current', path: 'new-task.ts', sessionId: null })
    await nextTick()

    // landing 注入成功（variant=landing 消费 sessionId=null 的 current 请求）
    const landingChip = landingEl.querySelector('.mention-file') as HTMLElement
    expect(landingChip).toBeTruthy()
    expect(landingChip.dataset.chipPath).toBe('new-task.ts')

    // panel 不匹配（sessionId=null ≠ 's-active'）
    expect(panelEl.querySelector('.mention-file')).toBeNull()
    expect(store.pendingInjection.value).toBeNull()
  })

  it('W18-3: panel + landing 双挂载 + target=new → landing 直接消费（阶段一前置：landing 已挂载）', async () => {
    // 场景：用户停在 landing 态，从 drawer 发起新对话注入。
    // 期望：landing composer 已挂载时直接消费 target=new（不路由到自身），
    //      panel composer 不消费 target=new（仅 session composer 触发 startFlow，但此处 panel 不匹配）。
    const { panelEl, landingEl, store } = setupDualMount('s-active')
    store.requestInjection({ target: 'new', path: 'fresh.ts', sessionId: 's-active' })
    await nextTick()

    // landing 直接消费 target=new
    const landingChip = landingEl.querySelector('.mention-file') as HTMLElement
    expect(landingChip).toBeTruthy()
    expect(landingChip.dataset.chipPath).toBe('fresh.ts')

    // panel 不注入（target=new 仅 landing composer 或路由阶段二消费）
    expect(panelEl.querySelector('.mention-file')).toBeNull()
    expect(store.pendingInjection.value).toBeNull()
  })
})
