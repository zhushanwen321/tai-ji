/**
 * view 转发键清单 renderer 半边（display-containers §7.4 [MANDATORY]，F1-17 补齐）。
 *
 * 与 apps/electron/main/test/browser-forward-keys.test.ts（主进程半边）配对：
 * **两侧各跑同一键矩阵断言同判定**（§7.4 双端匹配配对契约）。MATRIX 逐行同源镜像——
 * 修改任一侧须同步另一侧（渲染侧不可跨层 import 主进程模块，矩阵以常量复制 + 注释锚同步）。
 *
 * 覆盖：
 * 1. 键矩阵：非 alt 行 renderer 判定 ≡ 主进程期望（mod 两分皆认 / shift 严格双分 / 裸键不命中）；
 *    alt 行 = 登记的已知不对称（F1-18）：renderer matchOverrideKey/默认路径不拒绝未声明修饰键、
 *    主进程严格拒绝——方向安全（严格侧只会少转发不会误转发），断言 renderer ⊇ 主进程。
 * 2. 入清单约束（deriveForwardAccelerators 镜像 parseForwardAccelerator）：仅 mod 前缀组合；
 *    裸键/shift-only/alt/Esc override 不入清单（页面聚焦态不生效，§7.4 已知边界）。
 * 3. 上报触发面：setup 即全量重报（browserSetForwardKeys，覆盖初始化/renderer 重载/崩溃恢复）；
 *    overrides 变化 → browserUpdateForwardKeys 注册/注销增量（settings 重录触发面）。
 * 4. 转发派发：onBrowserForwardKey 回执 accelerator → 同一 keymap 派发动作（guardComposerFocus
 *    不适用——转发事件蕴含焦点在 WebContentsView，composer 非输入态）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/shell/useGlobalShortcuts-forward-keys.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'

/** ipc mock：转发三 API 可控（其余导出走真实实现——纯类型 + 无副作用模块） */
const ipcMock = vi.hoisted(() => ({
  setForwardKeys: vi.fn(() => Promise.resolve({ accepted: [], rejected: [] })),
  updateForwardKeys: vi.fn(() => Promise.resolve({ accepted: [], rejected: [] })),
  forwardKeyHandlers: [] as Array<(payload: { accelerator: string }) => void>,
}))
vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>()
  return {
    ...actual,
    browserSetForwardKeys: (...args: Parameters<typeof actual.browserSetForwardKeys>) => ipcMock.setForwardKeys(...args),
    browserUpdateForwardKeys: (...args: Parameters<typeof actual.browserUpdateForwardKeys>) => ipcMock.updateForwardKeys(...args),
    onBrowserForwardKey: (cb: (payload: { accelerator: string }) => void) => {
      ipcMock.forwardKeyHandlers.push(cb)
      return () => {
        const idx = ipcMock.forwardKeyHandlers.indexOf(cb)
        if (idx >= 0) ipcMock.forwardKeyHandlers.splice(idx, 1)
      }
    },
  }
})

/** commandStore 壳 mock：shortcutOverrides 可控 ref（重录触发面驱动点；真 ref 使 watch 可触发） */
const commandStoreMock = vi.hoisted(() => ({
  overrides: null as { value: Record<string, string> } | null,
}))
vi.mock('@/composables/features/command/useCommandStore', async () => {
  const { ref } = await import('vue')
  const overridesRef = ref<Record<string, string>>({})
  commandStoreMock.overrides = overridesRef
  return {
    useCommandStore: () => ({ shortcutOverrides: overridesRef }),
  }
})

const searchModalMock = vi.hoisted(() => ({
  toggle: vi.fn(),
}))
vi.mock('@taiji/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core')>()
  return {
    ...actual,
    useSearchModal: () => ({ toggle: searchModalMock.toggle }),
  }
})

import {
  useGlobalShortcuts,
  deriveForwardAccelerators,
  effectiveAcceleratorOf,
  isForwardableAccelerator,
  matchKeymapEntry,
  type UseGlobalShortcutsOptions,
} from '@/composables/shell/useGlobalShortcuts'
import { useNavigationStore } from '@/stores/navigation'

/** 键矩阵行：input × accelerator × 主进程期望判定（与 apps/electron/main/test/
 *  browser-forward-keys.test.ts 的 MATRIX 逐行同源——改任一侧必须同步另一侧） */
const MATRIX: Array<{
  name: string
  input: { key: string; meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean }
  accelerator: string
  expected: boolean
}> = [
  { name: 'mod+k × ⌘K', input: { key: 'k', meta: true }, accelerator: 'mod+k', expected: true },
  { name: 'mod+k × ⌃K', input: { key: 'k', control: true }, accelerator: 'mod+k', expected: true },
  { name: 'mod+k × ⌘⇧K（shift 严格双分）', input: { key: 'k', meta: true, shift: true }, accelerator: 'mod+k', expected: false },
  { name: 'mod+shift+k × ⌘⇧K', input: { key: 'k', meta: true, shift: true }, accelerator: 'mod+shift+k', expected: true },
  { name: 'mod+shift+k × ⌃⇧K', input: { key: 'k', control: true, shift: true }, accelerator: 'mod+shift+k', expected: true },
  { name: 'mod+shift+k × ⌘K（shift 严格双分）', input: { key: 'k', meta: true }, accelerator: 'mod+shift+k', expected: false },
  { name: 'mod+k × ⌥⌘K（alt 拒绝）', input: { key: 'k', meta: true, alt: true }, accelerator: 'mod+k', expected: false },
  { name: 'mod+shift+p × ⌥⌘⇧P（alt 拒绝）', input: { key: 'p', meta: true, shift: true, alt: true }, accelerator: 'mod+shift+p', expected: false },
  { name: 'mod+k × 裸 k', input: { key: 'k' }, accelerator: 'mod+k', expected: false },
  { name: "裸 'j' 清单项 × ⌘J（不入清单，永不匹配）", input: { key: 'j', meta: true }, accelerator: 'j', expected: false },
  { name: "shift-only 'shift+j' 清单项 × ⌘⇧J（不入清单）", input: { key: 'j', meta: true, shift: true }, accelerator: 'shift+j', expected: false },
  { name: 'mod+p × ⌘P（大小写归一）', input: { key: 'P', meta: true }, accelerator: 'mod+p', expected: true },
  { name: 'mod+, × ⌘,', input: { key: ',', meta: true }, accelerator: 'mod+,', expected: true },
  { name: 'mod+[ × ⌘[', input: { key: '[', control: true }, accelerator: 'mod+[', expected: true },
  { name: 'mod+escape 清单项 × ⌥⌘Esc（Esc 不入清单）', input: { key: 'escape', meta: true }, accelerator: 'mod+escape', expected: false },
]

/** 由矩阵行 accelerator 构造同义 keymap entry（无 override 默认路径） */
function entryFor(accelerator: string): { key: string; shift?: boolean } {
  const parts = accelerator.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  return { key, shift: parts.includes('shift') || undefined }
}

function toShortcutInput(input: { key: string; meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean }) {
  return { key: input.key, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }
}

describe('键矩阵：renderer 判定与主进程同判定（§7.4 配对契约）', () => {
  for (const row of MATRIX) {
    it(`${row.name} → 主进程 ${row.expected ? 'match' : 'no match'}`, () => {
      const entry = entryFor(row.accelerator)
      const listMembership = deriveForwardAccelerators([entry], {}).includes(row.accelerator)
      if (!isForwardableAccelerator(row.accelerator)) {
        // 不入清单项（裸 'j' / shift-only / mod+escape）：两侧同判「永不生效」——
        // 主进程 parse 拒绝（expected=false ⇒ 永不转发），renderer 清单不含 ⇒ 无从派发
        expect(row.expected).toBe(false)
        expect(listMembership).toBe(false)
        return
      }
      expect(listMembership, '可转发项必须在派生清单内（注册契约）').toBe(true)
      const rendererHit = matchKeymapEntry(toShortcutInput(row.input), entry, {})
      if (row.input.alt) {
        // 已知不对称（F1-18 登记）：renderer 不拒绝未声明修饰键、主进程严格拒绝——
        // 方向安全断言：renderer 判定 ⊇ 主进程（主进程不转发 ⇒ renderer 侧不产生误转发面）
        expect(row.expected).toBe(false)
        expect(rendererHit).toBe(true)
      } else {
        expect(rendererHit).toBe(row.expected)
      }
    })
  }
})

describe('入清单约束（deriveForwardAccelerators 镜像主进程 parseForwardAccelerator）', () => {
  it('mod 前缀组合入清单；裸键/shift-only/alt/Esc override 拒绝（页面聚焦态不生效，已知边界）', () => {
    expect(isForwardableAccelerator('mod+k')).toBe(true)
    expect(isForwardableAccelerator('mod+shift+p')).toBe(true)
    expect(isForwardableAccelerator('MOD+K')).toBe(true)
    for (const spec of ['j', 'shift+j', 'alt+x', 'mod+alt+x', 'escape', 'mod+escape', '', 'mod+', 'shift', 'mod+shift', 'ctrl+k']) {
      expect(isForwardableAccelerator(spec), spec).toBe(false)
    }
  })

  it('派生清单：默认 keymap 产生 mod 前缀全集；override 替换生效 accelerator；非法 override 不入', () => {
    const keymap = [
      { key: 'k', action: () => {} },
      { key: 'p', shift: true, commandId: 'open-preset-select', action: () => {} },
      { key: 'n', commandId: 'new-session', action: () => {} },
    ]
    expect(deriveForwardAccelerators(keymap, {})).toEqual(['mod+k', 'mod+shift+p', 'mod+n'])
    // 重录 new-session → mod+m（旧 accelerator 从清单消失，由 update 增量上报）
    expect(deriveForwardAccelerators(keymap, { 'new-session': 'mod+m' })).toEqual(['mod+k', 'mod+shift+p', 'mod+m'])
    // 重录为裸键/alt → 不入清单（该 override 页面聚焦态不生效）
    expect(deriveForwardAccelerators(keymap, { 'new-session': 'j' })).toEqual(['mod+k', 'mod+shift+p'])
    expect(deriveForwardAccelerators(keymap, { 'new-session': 'alt+n' })).toEqual(['mod+k', 'mod+shift+p'])
    expect(effectiveAcceleratorOf(keymap[1]!, {})).toBe('mod+shift+p')
  })
})

describe('上报与派发（useGlobalShortcuts 装配点）', () => {
  function mountShortcuts(options?: Partial<UseGlobalShortcutsOptions>): () => void {
    const scope = effectScope()
    scope.run(() =>
      useGlobalShortcuts({
        onNewSession: vi.fn(),
        forkFromLastAssistant: vi.fn(),
        enterForkModeFromLastAssistant: vi.fn(),
        handoffFromLastAssistant: vi.fn(),
        navigation: useNavigationStore(),
        openSettings: vi.fn(),
        ...options,
      }),
    )
    return () => scope.stop()
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    commandStoreMock.overrides!.value = {}
    ipcMock.forwardKeyHandlers.length = 0
  })

  it('setup 即全量重报（初始化/renderer 重载/崩溃恢复同一入口）：清单含默认 mod 族，非法项不出现在上报', async () => {
    const stop = mountShortcuts()
    expect(ipcMock.setForwardKeys).toHaveBeenCalledTimes(1)
    const reported = ipcMock.setForwardKeys.mock.calls[0]![0] as string[]
    expect(reported).toContain('mod+k')
    expect(reported).toContain('mod+shift+p')
    expect(reported).toContain('mod+,')
    for (const acc of reported) expect(isForwardableAccelerator(acc), acc).toBe(true)
    stop()
  })

  it('settings 重录（overrides 变化）→ browserUpdateForwardKeys 注册/注销增量', async () => {
    const stop = mountShortcuts()
    ipcMock.setForwardKeys.mockClear()
    commandStoreMock.overrides!.value = { 'new-session': 'mod+m' }
    await vi.waitFor(() => expect(ipcMock.updateForwardKeys).toHaveBeenCalledTimes(1))
    expect(ipcMock.updateForwardKeys.mock.calls[0]![0]).toEqual({ add: ['mod+m'], remove: ['mod+n'] })
    expect(ipcMock.setForwardKeys).not.toHaveBeenCalled()
    stop()
  })

  it('转发派发：⌘K accelerator → search toggle；⌘, → openSettings；未登记 accelerator 不动作', () => {
    const openSettings = vi.fn()
    const stop = mountShortcuts({ openSettings })
    expect(ipcMock.forwardKeyHandlers.length).toBe(1)
    const dispatch = ipcMock.forwardKeyHandlers[0]!

    dispatch({ accelerator: 'mod+k' })
    expect(searchModalMock.toggle).toHaveBeenCalledTimes(1)

    dispatch({ accelerator: 'mod+,' })
    expect(openSettings).toHaveBeenCalledTimes(1)

    // 未登记/非法 accelerator（主进程不会转发，防御性断言）→ 无动作
    dispatch({ accelerator: 'mod+escape' })
    dispatch({ accelerator: 'j' })
    expect(searchModalMock.toggle).toHaveBeenCalledTimes(1)
    expect(openSettings).toHaveBeenCalledTimes(1)
    stop()
  })

  it('guardComposerFocus 不用于转发派发（焦点在 WebContentsView 时 composer 必非输入态）', () => {
    document.body.innerHTML = '<div class="composer-box" data-testid="composer-box" tabindex="0"><div contenteditable="true"></div></div>'
    try {
      const forkFromLastAssistant = vi.fn()
      const stop = mountShortcuts({ forkFromLastAssistant })
      const dispatch = ipcMock.forwardKeyHandlers[0]!
      const composer = document.querySelector('[data-testid="composer-box"]') as HTMLElement
      composer.querySelector('[contenteditable="true"]')!.focus()
      // 宿主 window keydown 路径会因 composer 聚焦禁用 fork 条目；转发路径不适用该守卫
      dispatch({ accelerator: 'mod+g' })
      expect(forkFromLastAssistant).toHaveBeenCalledTimes(1)
      stop()
    } finally {
      document.body.innerHTML = ''
    }
  })
})
