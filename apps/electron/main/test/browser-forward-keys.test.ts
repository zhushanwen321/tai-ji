/**
 * 转发键清单单测（display-containers §7.4 view 转发键清单——主进程半边）。
 *
 * 覆盖：
 * 1. 键矩阵（双端匹配配对契约）：mod 两分皆认 / shift 严格双分 / alt、裸键、shift-only 一律不匹配；
 *    容器键（⌃` / ⌘W）与 window-factory 窗口级 before-input-event 逐字同源；
 *    Esc 不入清单（[MANDATORY]，§6.7 所有权第 4 层）。
 * 2. 入清单约束（[MANDATORY]）：仅 mod 前缀组合；违规项拒绝入清单（rejected 回执）。
 * 3. 转发桥：命中 → preventDefault + 转发主窗口处理链（容器键走 'shortcut' 既有通道、
 *    app 族走 'shortcut:forward'）；未命中（含 Esc）→ 页面自身语义优先（不拦截不转发）。
 *
 * 运行：cd apps/electron/main && npx vitest run test/browser-forward-keys.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ForwardKeyRegistry,
  attachForwardKeyBridge,
  forwardKeyRegistry,
  matchAppAccelerator,
  matchContainerShortcut,
  matchForwardedKey,
  normalizeForwardKeys,
  parseForwardAccelerator,
  type ForwardInput,
} from '../browser/gateway/forward-keys.js'

/** 键矩阵行：input × 期望判定（与 renderer 侧同一矩阵对账——§7.4 配对契约） */
const MATRIX: Array<{ name: string; input: ForwardInput; accelerator: string; expected: boolean }> = [
  // 'mod+k'：mod 两分皆认（meta / ctrl 各算命中）
  { name: 'mod+k × ⌘K', input: { key: 'k', meta: true }, accelerator: 'mod+k', expected: true },
  { name: 'mod+k × ⌃K', input: { key: 'k', control: true }, accelerator: 'mod+k', expected: true },
  // shift 严格双分：⌘⇧K 与 ⌘K 是不同键
  { name: 'mod+k × ⌘⇧K（shift 严格双分）', input: { key: 'k', meta: true, shift: true }, accelerator: 'mod+k', expected: false },
  { name: 'mod+shift+k × ⌘⇧K', input: { key: 'k', meta: true, shift: true }, accelerator: 'mod+shift+k', expected: true },
  { name: 'mod+shift+k × ⌃⇧K', input: { key: 'k', control: true, shift: true }, accelerator: 'mod+shift+k', expected: true },
  { name: 'mod+shift+k × ⌘K（shift 严格双分）', input: { key: 'k', meta: true }, accelerator: 'mod+shift+k', expected: false },
  // alt 一律不匹配
  { name: 'mod+k × ⌥⌘K（alt 拒绝）', input: { key: 'k', meta: true, alt: true }, accelerator: 'mod+k', expected: false },
  { name: 'mod+shift+p × ⌥⌘⇧P（alt 拒绝）', input: { key: 'p', meta: true, shift: true, alt: true }, accelerator: 'mod+shift+p', expected: false },
  // 裸键 / 无 mod 一律不匹配（不入清单项永不匹配）
  { name: 'mod+k × 裸 k', input: { key: 'k' }, accelerator: 'mod+k', expected: false },
  { name: "裸 'j' 清单项 × ⌘J（不入清单，永不匹配）", input: { key: 'j', meta: true }, accelerator: 'j', expected: false },
  { name: "shift-only 'shift+j' 清单项 × ⌘⇧J（不入清单）", input: { key: 'j', meta: true, shift: true }, accelerator: 'shift+j', expected: false },
  // 大小写不敏感（input.key 与 accelerator key 归一小写）
  { name: 'mod+p × ⌘P（大小写归一）', input: { key: 'P', meta: true }, accelerator: 'mod+p', expected: true },
  // 标点键（settings 可配置族：⌘, / ⌘[ / ⌘]）
  { name: 'mod+, × ⌘,', input: { key: ',', meta: true }, accelerator: 'mod+,', expected: true },
  { name: 'mod+[ × ⌘[', input: { key: '[', control: true }, accelerator: 'mod+[', expected: true },
  // Esc 不入清单：'mod+escape' 拒绝入清单 → 永不匹配
  { name: "mod+escape 清单项 × ⌥⌘Esc（Esc 不入清单）", input: { key: 'escape', meta: true }, accelerator: 'mod+escape', expected: false },
]

describe('forward-keys 入清单约束（[MANDATORY] 仅 mod 前缀组合，Esc 不入清单）', () => {
  it('mod 前缀组合入清单（含 shift 变体）', () => {
    expect(parseForwardAccelerator('mod+k')).toEqual({ key: 'k', shift: false })
    expect(parseForwardAccelerator('mod+shift+p')).toEqual({ key: 'p', shift: true })
    expect(parseForwardAccelerator('MOD+K')).toEqual({ key: 'k', shift: false })
    expect(parseForwardAccelerator('mod+,')).toEqual({ key: ',', shift: false })
  })

  it('裸键 / shift-only / alt 组合 / Esc / 畸形格式一律拒绝入清单', () => {
    for (const spec of ['j', 'shift+j', 'alt+x', 'mod+alt+x', 'escape', 'mod+escape', '', 'mod+', 'shift', 'mod+shift', 'ctrl+k']) {
      expect(parseForwardAccelerator(spec)).toBeNull()
    }
  })

  it('normalizeForwardKeys 切分 accepted / rejected（违规项不入清单，重复项幂等去重）', () => {
    const report = normalizeForwardKeys(['mod+k', 'j', 'mod+shift+p', 'mod+k', 'shift+j'])
    expect(report.accepted).toEqual(['mod+k', 'mod+shift+p'])
    expect(report.rejected).toEqual(['j', 'shift+j'])
  })
})

describe('forward-keys 键矩阵（双端匹配配对契约，§7.4）', () => {
  for (const row of MATRIX) {
    it(`${row.name} → ${row.expected ? 'match' : 'no match'}`, () => {
      expect(matchAppAccelerator(row.input, row.accelerator)).toBe(row.expected)
    })
  }

  it('容器键判定与 window-factory 窗口级逐字同源（⌘W / ⌃`）', () => {
    expect(matchContainerShortcut({ key: 'w', meta: true })).toBe('close')
    expect(matchContainerShortcut({ key: 'W', control: true })).toBe('close')
    expect(matchContainerShortcut({ key: '`', control: true })).toBe('toggle-bottom-drawer')
    // ⌃⇧` / ⌘` / ⌥⌃` 不是容器键（window-factory 严格匹配 Control+Backquote）
    expect(matchContainerShortcut({ key: '`', control: true, shift: true })).toBeNull()
    expect(matchContainerShortcut({ key: '`', meta: true })).toBeNull()
    expect(matchContainerShortcut({ key: '`', control: true, alt: true })).toBeNull()
    // Esc 不转发（页面自身语义优先，§6.7 所有权第 4 层）
    expect(matchContainerShortcut({ key: 'escape' })).toBeNull()
    expect(matchContainerShortcut({ key: 'escape', meta: true })).toBeNull()
  })

  it('matchForwardedKey：容器键优先于 app 族（app 族不得抢占 ⌘W / ⌃` 语义）', () => {
    const hit = matchForwardedKey({ key: 'w', meta: true }, ['mod+w', 'mod+k'])
    expect(hit).toEqual({ kind: 'container', type: 'close' })
  })

  it('matchForwardedKey：app 族命中带 accelerator 回执；Esc 恒不命中', () => {
    expect(matchForwardedKey({ key: 'k', meta: true }, ['mod+k'])).toEqual({ kind: 'app', accelerator: 'mod+k' })
    expect(matchForwardedKey({ key: 'escape', meta: true }, ['mod+k', 'mod+escape'])).toBeNull()
    expect(matchForwardedKey({ key: 'x' }, ['mod+k'])).toBeNull()
  })
})

describe('ForwardKeyRegistry（set 全量重报 / update 注册注销增量）', () => {
  let registry: ForwardKeyRegistry
  beforeEach(() => {
    registry = new ForwardKeyRegistry()
  })

  it('set 全量替换（幂等：同清单重复 set 无副作用）', () => {
    registry.set(['mod+k', 'j'])
    expect(registry.list()).toEqual(['mod+k'])
    registry.set(['mod+shift+p'])
    expect(registry.list()).toEqual(['mod+shift+p'])
    registry.set(['mod+shift+p'])
    expect(registry.list()).toEqual(['mod+shift+p'])
  })

  it('update 增量注册/注销（规范化后匹配，含大小写/空白归一）', () => {
    registry.set(['mod+k'])
    registry.update({ add: [' MOD+N ', 'mod+k'] })
    expect(registry.list()).toEqual(['mod+k', 'mod+n'])
    registry.update({ remove: ['MOD+K'] })
    expect(registry.list()).toEqual(['mod+n'])
    // 注销不存在项幂等
    registry.update({ remove: ['mod+ghost'] })
    expect(registry.list()).toEqual(['mod+n'])
  })

  it('违规项进 rejected 不入清单（update 同约束）', () => {
    const report = registry.update({ add: ['mod+j', 'j', 'alt+x'] })
    expect(registry.list()).toEqual(['mod+j'])
    expect(report.rejected).toEqual(['j', 'alt+x'])
  })
})

describe('attachForwardKeyBridge（转发桥：命中转发主窗口处理链，未命中放行页面）', () => {
  interface CapturedListener { // oe-exempt:20261003:test:转发键捕获 mock 监听器夹具形态
    event: { preventDefault: ReturnType<typeof vi.fn> }
    input: ForwardInput
    prevented: boolean
  }

  function makeBridge() {
    const listeners: Array<(event: { preventDefault(): void }, input: ForwardInput) => void> = []
    const send = vi.fn()
    const windowStub = { isDestroyed: () => false, webContents: { send } }
    const wc = {
      on: (_event: 'before-input-event', listener: (event: { preventDefault(): void }, input: ForwardInput) => void) => {
        listeners.push(listener)
      },
    }
    const registry = new ForwardKeyRegistry()
    attachForwardKeyBridge(wc, () => windowStub, registry)
    const fire = (input: ForwardInput): CapturedListener => {
      const event = { preventDefault: vi.fn() }
      for (const listener of listeners) listener(event, input)
      return { event, input, prevented: event.preventDefault.mock.calls.length > 0 }
    }
    return { registry, send, fire, windowStub }
  }

  beforeEach(() => {
    // 进程级默认注册表隔离（避免用例间污染）
    forwardKeyRegistry.set([])
  })

  it('容器键：preventDefault + send(`shortcut`, close/toggle-bottom-drawer)（与 window-factory 同通道同字面量）', () => {
    const { registry, send, fire } = makeBridge()
    registry.set([])

    const w = fire({ key: 'w', meta: true })
    expect(w.prevented).toBe(true)
    expect(send).toHaveBeenLastCalledWith('shortcut', 'close')

    const tick = fire({ key: '`', control: true })
    expect(tick.prevented).toBe(true)
    expect(send).toHaveBeenLastCalledWith('shortcut', 'toggle-bottom-drawer')
  })

  it('app 快捷键族：preventDefault + send(`shortcut:forward`, { accelerator })', () => {
    const { registry, send, fire } = makeBridge()
    registry.set(['mod+k', 'mod+shift+p'])

    const k = fire({ key: 'k', meta: true })
    expect(k.prevented).toBe(true)
    expect(send).toHaveBeenLastCalledWith('shortcut:forward', { accelerator: 'mod+k' })

    const p = fire({ key: 'p', meta: true, shift: true })
    expect(p.prevented).toBe(true)
    expect(send).toHaveBeenLastCalledWith('shortcut:forward', { accelerator: 'mod+shift+p' })
  })

  it('Esc 与未命中键：不 preventDefault、不转发（页面自身语义优先，§6.7 第 4 层）', () => {
    const { registry, send, fire } = makeBridge()
    registry.set(['mod+k'])

    for (const input of [{ key: 'escape' }, { key: 'escape', meta: true }, { key: 'k' }, { key: 'x', meta: true }]) {
      const result = fire(input)
      expect(result.prevented).toBe(false)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('清单外的 mod 组合不转发（改键后未上报的组合不劫持页面）', () => {
    const { registry, send, fire } = makeBridge()
    registry.set(['mod+n'])

    const result = fire({ key: 'k', meta: true })
    expect(result.prevented).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('目标窗口失联时仍 preventDefault（键被宿主消费）但不转发', () => {
    const listeners: Array<(event: { preventDefault(): void }, input: ForwardInput) => void> = []
    const send = vi.fn()
    const wc = {
      on: (_e: 'before-input-event', listener: (event: { preventDefault(): void }, input: ForwardInput) => void) => {
        listeners.push(listener)
      },
    }
    const registry = new ForwardKeyRegistry()
    registry.set(['mod+k'])
    attachForwardKeyBridge(wc, () => ({ isDestroyed: () => true, webContents: { send } }), registry)

    const event = { preventDefault: vi.fn() }
    for (const listener of listeners) listener(event, { key: 'k', meta: true })
    expect(event.preventDefault).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
