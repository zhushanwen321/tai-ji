/**
 * composer-shortcut-actions 单测——composer-pi-shortcuts U1⑥（设计回归防线主体，验收 A1 全量下沉 L1）。
 *
 * 覆盖矩阵（与设计文档逐条对应）：
 *   §3.4 守卫矩阵全行（每行至少 1 条）：浮层 open / auto-repeat（含 ctrl+x 不忽略例外）/
 *   composer 内选区（放行原生剪切 + 三个切换键与选区无关）/ staging 活跃 / landing 态 / 已建态 /
 *   档位仅 off / 模型 ≤1。IME 行不在本文件测：分发链 IME 段是单点防线（composer-keydown.test.ts
 *   钉住），本表不复判（over-engineering-audit 20260916 裁决）。
 *   §3.3 键位表：修饰键约束（alt+p 不绑定、meta 系不命中）+ 循环取值起点规则（不在列表/
 *   undefined/脏值/绕回/enabled 过滤）。
 *   决策 8 意图目标生命周期：设立/等值清/reject 清/sessionId 清/进 staging 清/RTT 内连按逐次递进。
 *   §3.5 错误规格：clipboard reject toast error / 空流 no-op 无 toast / 错误消息照常复制 /
 *   空串照常提示。
 * 事件拦截语义（决策 7）：命中任一键位（含 no-op 行）→ preventDefault + stopPropagation + true；
 * 未命中 → false 原样放行。
 *
 * 范式沿用 composer-keydown.test.ts：fake deps 注入，断言到依赖调用 + 拦截返回值层。
 * 意图目标清除依赖 watch（pre flush）——凡变更 ref 后断言清除效果，先 await flushPromises()。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import type { Message, ModelInfo, ProviderId } from '@taiji/shared'
import {
  useComposerShortcutActions,
  type ComposerShortcutActionDeps,
} from './composer-shortcut-actions'

function mkModel(providerId: string, id: string, enabled = true): ModelInfo {
  return { id, name: id, providerId: providerId as ProviderId, providerName: providerId, enabled }
}

let msgSeq = 0
function mkMsg(role: Message['role'], content: Message['content'], status: Message['status'] = 'complete'): Message {
  msgSeq += 1
  return { id: `m${msgSeq}`, role, content, status, timestamp: msgSeq }
}

type KeyMods = {
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
  meta?: boolean
  repeat?: boolean
}

/** 构造带 preventDefault/stopPropagation spy 的键盘事件（repeat 经 defineProperty 注入，构造器初始化支持面不稳） */
function makeKeyEvent(key: string, mods: KeyMods = {}) {
  const e = new KeyboardEvent('keydown', {
    key,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    cancelable: true,
  })
  Object.defineProperty(e, 'repeat', { value: !!mods.repeat })
  const preventDefault = vi.fn()
  const stopPropagation = vi.fn()
  e.preventDefault = preventDefault
  e.stopPropagation = stopPropagation
  return { e, preventDefault, stopPropagation }
}

/** 选区 mock（§3.4 选区行；anchorNode 落点决定「composer 内选区」判定） */
function mockSelection(anchorNode: Node | null, collapsed = false): void {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: collapsed,
    rangeCount: collapsed ? 0 : 1,
    anchorNode,
  } as unknown as Selection)
}

/** navigator.clipboard 桩（happy-dom 无实现；configurable 供 afterEach 清除） */
function stubClipboard(fn: (text: string) => Promise<void>): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(fn)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

/** fake deps（设计 §5 U1 deps 11 项全量注入；默认已建态 / 3 模型 prov::{a,b,c} / 4 档位 / current medium）。
 *  sessionId/currentThinkingLevel 用 in 判缺（非 ??）：显式 null/undefined（landing/占位）是合法测试态，不得被默认值吞掉 */
function makeDeps(opts: {
  cmdOpen?: boolean
  sessionId?: string | null
  isStaging?: boolean
  currentModelId?: string
  currentThinkingLevel?: string | undefined
  supportedLevels?: string[] | undefined
  models?: ModelInfo[]
  messages?: Message[]
} = {}) {
  const cmdOpen = ref(opts.cmdOpen ?? false)
  const sessionId = ref<string | null>('sessionId' in opts ? opts.sessionId! : 's1')
  const isStaging = ref(opts.isStaging ?? false)
  const currentModelId = ref(opts.currentModelId ?? 'prov/a')
  const currentThinkingLevel = ref<string | undefined>(
    'currentThinkingLevel' in opts ? opts.currentThinkingLevel : 'medium',
  )
  const currentSupportedLevels = ref<string[] | undefined>(
    opts.supportedLevels ?? ['off', 'low', 'medium', 'high'],
  )
  const enabledModels = ref<ModelInfo[]>(
    opts.models ?? [mkModel('prov', 'a'), mkModel('prov', 'b'), mkModel('prov', 'c')],
  )
  const onModelSelect = vi.fn((_payload: { modelId: string; provider: ProviderId }) => Promise.resolve())
  const onThinkingSelect = vi.fn((_level: string) => Promise.resolve())
  const getMessages = vi.fn((_sid: string) => opts.messages ?? [])
  const toastInfo = vi.fn()
  const toastError = vi.fn()
  const deps: ComposerShortcutActionDeps = {
    cmdOpen,
    sessionId,
    isStaging,
    currentModelId,
    currentThinkingLevel,
    currentSupportedLevels,
    enabledModels,
    onModelSelect,
    onThinkingSelect,
    getMessages,
    toast: { info: toastInfo, error: toastError },
  }
  return {
    deps,
    cmdOpen,
    sessionId,
    isStaging,
    currentModelId,
    currentThinkingLevel,
    currentSupportedLevels,
    enabledModels,
    onModelSelect,
    onThinkingSelect,
    getMessages,
    toastInfo,
    toastError,
  }
}

describe('useComposerShortcutActions', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  // ── 键位判定 + 事件拦截语义（§3.3 键位表 + §3.4 拦截语义/决策 7）──────────────
  describe('键位判定与事件拦截', () => {
    it('shift+tab 命中：档位循环触发 + preventDefault + stopPropagation + 返回 true', () => {
      const { deps, onThinkingSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)
      const { e, preventDefault, stopPropagation } = makeKeyEvent('Tab', { shift: true })

      const consumed = handler(e)

      expect(consumed).toBe(true)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(stopPropagation).toHaveBeenCalledTimes(1)
      expect(onThinkingSelect).toHaveBeenCalledTimes(1)
    })

    it('ctrl+p 命中 model-forward：从当前真值前进一步', () => {
      const { deps, onModelSelect } = makeDeps({ currentModelId: 'prov/b' })
      const handler = useComposerShortcutActions(deps)
      const { e } = makeKeyEvent('p', { ctrl: true })

      expect(handler(e)).toBe(true)
      expect(onModelSelect).toHaveBeenCalledTimes(1)
      expect(onModelSelect.mock.calls[0][0]).toEqual({ modelId: 'c', provider: 'prov' })
    })

    it('ctrl+shift+p 命中 model-backward：从当前真值退一步（独立实例，避免意图续步跨用例语义混淆）', () => {
      const { deps, onModelSelect } = makeDeps({ currentModelId: 'prov/b' })
      const handler = useComposerShortcutActions(deps)
      const { e } = makeKeyEvent('p', { ctrl: true, shift: true })

      expect(handler(e)).toBe(true)
      expect(onModelSelect).toHaveBeenCalledTimes(1)
      expect(onModelSelect.mock.calls[0][0]).toEqual({ modelId: 'a', provider: 'prov' })
    })

    it.each(['a', 'Enter', 'Tab'])('未命中键（%s）：返回 false 原样放行，无拦截无动作', (key) => {
      const { deps, onThinkingSelect, onModelSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)
      const { e, preventDefault, stopPropagation } = makeKeyEvent(key)

      expect(handler(e)).toBe(false)
      expect(preventDefault).not.toHaveBeenCalled()
      expect(stopPropagation).not.toHaveBeenCalled()
      expect(onThinkingSelect).not.toHaveBeenCalled()
      expect(onModelSelect).not.toHaveBeenCalled()
    })

    it('修饰键约束：alt+p / ctrl+alt+p 不命中（决策 6 无 alt+p 绑定）；meta+p / meta+shift+p 不命中（⌘ 系冒泡给全局表，决策 7）', () => {
      const { deps, onModelSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)

      for (const { key, mods } of [
        { key: 'p', mods: { alt: true } },
        { key: 'p', mods: { ctrl: true, alt: true } },
        { key: 'p', mods: { meta: true } },
        { key: 'p', mods: { meta: true, shift: true } },
        { key: 'Tab', mods: { ctrl: true, shift: true } },
        { key: 'Tab', mods: { alt: true, shift: true } },
      ]) {
        const { e, preventDefault } = makeKeyEvent(key, mods)
        expect(handler(e), `${key} + ${JSON.stringify(mods)} 应不命中`).toBe(false)
        expect(preventDefault).not.toHaveBeenCalled()
      }
      expect(onModelSelect).not.toHaveBeenCalled()
    })
  })

  // ── 守卫矩阵 §3.4 逐行 ──────────────────────────────────────────────────────
  describe('守卫矩阵（§3.4 全行）', () => {
    // 行 1：命令浮层 open → 不触发（入口守卫整体跳过，不吞键）
    it('浮层 open：shift+tab / ctrl+p 均不触发不吞键（入口 cmdOpen 守卫直接 return false）', () => {
      const { deps, onThinkingSelect, onModelSelect } = makeDeps({ cmdOpen: true })
      const handler = useComposerShortcutActions(deps)

      const tab = makeKeyEvent('Tab', { shift: true })
      expect(handler(tab.e)).toBe(false)
      expect(tab.preventDefault).not.toHaveBeenCalled()
      const p = makeKeyEvent('p', { ctrl: true })
      expect(handler(p.e)).toBe(false)
      expect(p.preventDefault).not.toHaveBeenCalled()

      expect(onThinkingSelect).not.toHaveBeenCalled()
      expect(onModelSelect).not.toHaveBeenCalled()
    })

    // 行 2（IME）：模块级不复判——分发链 IME 段是单点防线（composer-keydown.test.ts 钉住），
    // 本表只经分发链调用（over-engineering-audit 20260916 裁决删除模块级二次守卫）

    // 行 3：auto-repeat —— 三个切换键忽略；ctrl+x 不忽略（决策 8 幂等例外）
    it('auto-repeat：shift+tab 忽略（吞键不动作，防 RPC 风暴）', () => {
      const { deps, onThinkingSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)
      const { e, preventDefault } = makeKeyEvent('Tab', { shift: true, repeat: true })

      expect(handler(e)).toBe(true)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onThinkingSelect).not.toHaveBeenCalled()
    })

    it('auto-repeat：ctrl+p 忽略（吞键不动作）', () => {
      const { deps, onModelSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)
      const { e } = makeKeyEvent('p', { ctrl: true, repeat: true })

      expect(handler(e)).toBe(true)
      expect(onModelSelect).not.toHaveBeenCalled()
    })

    it('auto-repeat：ctrl+shift+p 忽略（吞键不动作）', () => {
      const { deps, onModelSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)
      const { e } = makeKeyEvent('p', { ctrl: true, shift: true, repeat: true })

      expect(handler(e)).toBe(true)
      expect(onModelSelect).not.toHaveBeenCalled()
    })

    it('auto-repeat：ctrl+x 不忽略（幂等无 RPC，决策 8 例外——照常复制）', () => {
      const { deps } = makeDeps({
        messages: [mkMsg('assistant', 'streaming partial')],
      })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())
      const { e } = makeKeyEvent('x', { ctrl: true, repeat: true })

      expect(handler(e)).toBe(true)
      expect(writeText).toHaveBeenCalledWith('streaming partial')
    })

    // 行 4：composer 内有选区 —— ctrl+x 放行原生剪切；三个切换键正常触发（选区守卫只挂 copy 分支）
    it('选区行：composer 内有选区时 ctrl+x 放行原生剪切（不拦截、不触发复制动作）', () => {
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      document.body.appendChild(editor)
      editor.focus()
      expect(document.activeElement).toBe(editor) // 造态自检：焦点在输入框
      mockSelection(editor)

      const { deps, toastInfo } = makeDeps({ messages: [mkMsg('assistant', 'reply')] })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())
      const { e, preventDefault } = makeKeyEvent('x', { ctrl: true })

      expect(handler(e)).toBe(false)
      expect(preventDefault).not.toHaveBeenCalled()
      expect(writeText).not.toHaveBeenCalled()
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('选区行：选区锚点在焦点元素外（非 composer 选区）→ ctrl+x 照常触发复制', () => {
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      document.body.appendChild(editor)
      editor.focus()
      const detached = document.createElement('span') // 未挂载：不在任何焦点祖先内
      mockSelection(detached)

      const { deps } = makeDeps({ messages: [mkMsg('assistant', 'reply')] })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())

      expect(handler(makeKeyEvent('x', { ctrl: true }).e)).toBe(true)
      expect(writeText).toHaveBeenCalledWith('reply')
    })

    it('选区行：shift+tab 与选区无关，正常触发档位循环', () => {
      const editor = document.createElement('div')
      document.body.appendChild(editor)
      editor.focus()
      mockSelection(editor)

      const { deps, onThinkingSelect } = makeDeps()
      const handler = useComposerShortcutActions(deps)

      expect(handler(makeKeyEvent('Tab', { shift: true }).e)).toBe(true)
      expect(onThinkingSelect).toHaveBeenCalledTimes(1)
    })

    it('选区行：composer 内有选区时 ctrl+p / ctrl+shift+p 正常触发模型双向循环（选区守卫只挂 copy 分支）', () => {
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      document.body.appendChild(editor)
      editor.focus()
      mockSelection(editor)

      // 独立实例：避免决策 8 意图续步把第一按目标当第二按起点，保持「选区无关」单变量语义
      const forward = makeDeps({ currentModelId: 'prov/b' })
      const forwardHandler = useComposerShortcutActions(forward.deps)
      expect(forwardHandler(makeKeyEvent('p', { ctrl: true }).e)).toBe(true)
      expect(forward.onModelSelect).toHaveBeenCalledTimes(1)
      expect(forward.onModelSelect).toHaveBeenCalledWith({ modelId: 'c', provider: 'prov' })

      const backward = makeDeps({ currentModelId: 'prov/b' })
      const backwardHandler = useComposerShortcutActions(backward.deps)
      expect(backwardHandler(makeKeyEvent('p', { ctrl: true, shift: true }).e)).toBe(true)
      expect(backward.onModelSelect).toHaveBeenCalledTimes(1)
      expect(backward.onModelSelect).toHaveBeenCalledWith({ modelId: 'a', provider: 'prov' })
    })

    // 行 5：staging 活跃 —— 切换改暂存值（core 快照路由，经同一 onModelSelect/onThinkingSelect）；复制正常
    it('staging 活跃：shift+tab / ctrl+p 经同一入口触发（写暂存快照由 core 三分支承接）', () => {
      const { deps, onThinkingSelect, onModelSelect } = makeDeps({ isStaging: true })
      const handler = useComposerShortcutActions(deps)

      expect(handler(makeKeyEvent('Tab', { shift: true }).e)).toBe(true)
      expect(onThinkingSelect).toHaveBeenCalledWith('high')
      expect(handler(makeKeyEvent('p', { ctrl: true }).e)).toBe(true)
      expect(onModelSelect).toHaveBeenCalledWith({ modelId: 'b', provider: 'prov' })
    })

    it('staging 活跃：ctrl+x 正常复制（staging 不影响消息流）', () => {
      const { deps } = makeDeps({
        isStaging: true,
        messages: [mkMsg('assistant', 'staged flow reply')],
      })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())

      expect(handler(makeKeyEvent('x', { ctrl: true }).e)).toBe(true)
      expect(writeText).toHaveBeenCalledWith('staged flow reply')
    })

    // 行 6：landing 态（sessionId=null）—— 切换写 pending/localThinkingLevel 路径（core 承接，经同一入口）；复制无消息流
    it('landing 态：shift+tab / ctrl+p 经同一入口触发（写 localThinkingLevel/pendingModel 由 core 承接）', () => {
      const { deps, onThinkingSelect, onModelSelect } = makeDeps({ sessionId: null })
      const handler = useComposerShortcutActions(deps)

      expect(handler(makeKeyEvent('Tab', { shift: true }).e)).toBe(true)
      expect(onThinkingSelect).toHaveBeenCalledTimes(1)
      expect(handler(makeKeyEvent('p', { ctrl: true }).e)).toBe(true)
      expect(onModelSelect).toHaveBeenCalledTimes(1)
    })

    it('landing 态：ctrl+x 无消息流 → no-op 无 toast（键吞掉）', () => {
      const { deps, toastInfo, toastError } = makeDeps({ sessionId: null })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())
      const { e } = makeKeyEvent('x', { ctrl: true })

      expect(handler(e)).toBe(true)
      expect(writeText).not.toHaveBeenCalled()
      expect(toastInfo).not.toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    })

    // 行 7：已建态 → RPC + 回执真值 + 决策 8 续步（生命周期专项在下方 describe）
    // 行 8：档位可用集仅 off（non-reasoning）→ no-op（键吞掉）
    it('档位可用集仅 off：shift+tab no-op（键吞掉、无动作、无噪音）', () => {
      const { deps, onThinkingSelect } = makeDeps({ supportedLevels: ['off'], currentThinkingLevel: 'off' })
      const handler = useComposerShortcutActions(deps)
      const { e, preventDefault, stopPropagation } = makeKeyEvent('Tab', { shift: true })

      expect(handler(e)).toBe(true)
      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(stopPropagation).toHaveBeenCalledTimes(1)
      expect(onThinkingSelect).not.toHaveBeenCalled()
    })

    // 行 9：模型列表 ≤1 → no-op（键吞掉）
    it('模型列表 ≤1 或空：ctrl+p / ctrl+shift+p no-op（键吞掉）', () => {
      const single = makeDeps({ models: [mkModel('prov', 'a')], currentModelId: 'prov/a' })
      const handlerSingle = useComposerShortcutActions(single.deps)
      expect(handlerSingle(makeKeyEvent('p', { ctrl: true }).e)).toBe(true)
      expect(handlerSingle(makeKeyEvent('p', { ctrl: true, shift: true }).e)).toBe(true)
      expect(single.onModelSelect).not.toHaveBeenCalled()

      const empty = makeDeps({ models: [], currentModelId: '' })
      const handlerEmpty = useComposerShortcutActions(empty.deps)
      expect(handlerEmpty(makeKeyEvent('p', { ctrl: true }).e)).toBe(true)
      expect(empty.onModelSelect).not.toHaveBeenCalled()
    })
  })

  // ── 循环取值与起点规则（§3.3）───────────────────────────────────────────────
  describe('循环取值与起点规则', () => {
    it('模型 forward 绕回：表尾 → 表头', () => {
      const { deps, onModelSelect } = makeDeps({ currentModelId: 'prov/c' })
      useComposerShortcutActions(deps)(makeKeyEvent('p', { ctrl: true }).e)
      expect(onModelSelect).toHaveBeenCalledWith({ modelId: 'a', provider: 'prov' })
    })

    it('模型 backward 绕回：表头 → 表尾', () => {
      const { deps, onModelSelect } = makeDeps({ currentModelId: 'prov/a' })
      useComposerShortcutActions(deps)(makeKeyEvent('p', { ctrl: true, shift: true }).e)
      expect(onModelSelect).toHaveBeenCalledWith({ modelId: 'c', provider: 'prov' })
    })

    it('模型起点不在列表（landing 占位空串）：forward 取第一个 / backward 取最后一个', () => {
      const forward = makeDeps({ currentModelId: '' })
      useComposerShortcutActions(forward.deps)(makeKeyEvent('p', { ctrl: true }).e)
      expect(forward.onModelSelect).toHaveBeenCalledWith({ modelId: 'a', provider: 'prov' })

      const backward = makeDeps({ currentModelId: '' })
      useComposerShortcutActions(backward.deps)(makeKeyEvent('p', { ctrl: true, shift: true }).e)
      expect(backward.onModelSelect).toHaveBeenCalledWith({ modelId: 'c', provider: 'prov' })
    })

    it('模型循环序 = deps.enabledModels 注入序（壳层负责 enabled 过滤，模块零过滤逻辑）：按注入序循环', () => {
      // 契约：composer-shell 组装时已按 enabled !== false 兜底过滤（ModelSelectPopover 双保险
      // 同款），模块直接消费注入列表——此处注入已过滤的 [a, c]（b 禁用被壳层剔除）
      const { deps, onModelSelect } = makeDeps({
        currentModelId: 'prov/a',
        models: [mkModel('prov', 'a'), mkModel('prov', 'c')],
      })
      useComposerShortcutActions(deps)(makeKeyEvent('p', { ctrl: true }).e)
      expect(onModelSelect).toHaveBeenCalledWith({ modelId: 'c', provider: 'prov' })
    })

    it('thinking 起点 undefined（占位）：取归一序列第一档（off）', () => {
      const { deps, onThinkingSelect } = makeDeps({ currentThinkingLevel: undefined })
      useComposerShortcutActions(deps)(makeKeyEvent('Tab', { shift: true }).e)
      expect(onThinkingSelect).toHaveBeenCalledWith('off')
    })

    it('thinking 起点为脏值（不在归一集，钳制残值）：forward 取第一档', () => {
      // supportedLevels 含非法值 'bogus' → 归一 ['off','high']；'weird' 不在归一集 → 取 'off'
      const { deps, onThinkingSelect } = makeDeps({
        currentThinkingLevel: 'weird',
        supportedLevels: ['high', 'off', 'bogus'],
      })
      useComposerShortcutActions(deps)(makeKeyEvent('Tab', { shift: true }).e)
      expect(onThinkingSelect).toHaveBeenCalledWith('off')
    })

    it('thinking supportedLevels undefined：归一默认五档（off..high），medium → high', () => {
      const { deps, onThinkingSelect } = makeDeps({
        currentThinkingLevel: 'medium',
        supportedLevels: undefined,
      })
      useComposerShortcutActions(deps)(makeKeyEvent('Tab', { shift: true }).e)
      expect(onThinkingSelect).toHaveBeenCalledWith('high')
    })

    it('thinking 绕回：表尾（high）→ off', () => {
      const { deps, onThinkingSelect } = makeDeps({ currentThinkingLevel: 'high' })
      useComposerShortcutActions(deps)(makeKeyEvent('Tab', { shift: true }).e)
      expect(onThinkingSelect).toHaveBeenCalledWith('off')
    })
  })

  // ── 决策 8 意图目标生命周期（已建态）────────────────────────────────────────
  describe('决策 8：意图目标生命周期（仅已建态设立与续步）', () => {
    function makePendingDeps(opts: Parameters<typeof makeDeps>[0] = {}) {
      const ctx = makeDeps(opts)
      // RPC 永不 settle：模拟 RTT 窗口（回执未到），意图目标为唯一计算起点
      ctx.onModelSelect.mockImplementation(() => new Promise<void>(() => {}))
      ctx.onThinkingSelect.mockImplementation(() => new Promise<void>(() => {}))
      return ctx
    }

    it('模型 RTT 内连按 3 次：意图目标续步，目标逐次递进 b→c→d（不重步）', () => {
      const { deps, onModelSelect } = makePendingDeps({
        currentModelId: 'prov/a',
        models: [mkModel('prov', 'a'), mkModel('prov', 'b'), mkModel('prov', 'c'), mkModel('prov', 'd')],
      })
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('p', { ctrl: true }).e)
      handler(makeKeyEvent('p', { ctrl: true }).e)
      handler(makeKeyEvent('p', { ctrl: true }).e)

      expect(onModelSelect.mock.calls.map((c) => c[0].modelId)).toEqual(['b', 'c', 'd'])
    })

    it('thinking RTT 内连按 3 次：档位逐次递进 high→off（绕回）→low', () => {
      const { deps, onThinkingSelect } = makePendingDeps({ currentThinkingLevel: 'medium' })
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('Tab', { shift: true }).e)
      handler(makeKeyEvent('Tab', { shift: true }).e)
      handler(makeKeyEvent('Tab', { shift: true }).e)

      expect(onThinkingSelect.mock.calls.map((c) => c[0])).toEqual(['high', 'off', 'low'])
    })

    it('等值清：回执真值到达且等于意图目标后清除——后续按键从新真值起算（而非残留意图）', async () => {
      const { deps, onModelSelect, currentModelId } = makeDeps({ currentModelId: 'prov/a' })
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('p', { ctrl: true }).e) // 意图 b
      await flushPromises() // 回执到达
      currentModelId.value = 'prov/b' // store 真值 = 意图目标 → 等值清
      await flushPromises()

      // 外部把真值挪回 a（session 快照重拉等）：若意图未清，续步起点 b → 目标 c（错）
      currentModelId.value = 'prov/a'
      await flushPromises()
      handler(makeKeyEvent('p', { ctrl: true }).e)
      expect(onModelSelect).toHaveBeenCalledTimes(2)
      expect(onModelSelect.mock.calls[1][0]).toEqual({ modelId: 'b', provider: 'prov' })
    })

    it('reject 清：RPC 失败清除意图目标 + console.warn + 无 toast——连按从真值重新起算', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { deps, onModelSelect, toastInfo, toastError } = makeDeps({ currentModelId: 'prov/a' })
      onModelSelect.mockImplementationOnce(() => Promise.reject(new Error('rpc down')))
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('p', { ctrl: true }).e) // 意图 b，随后 reject
      await flushPromises()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(toastInfo).not.toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()

      // 意图已清 → 从真值 a 起算目标 b（若残留意图 b 则会算出 c）
      handler(makeKeyEvent('p', { ctrl: true }).e)
      expect(onModelSelect).toHaveBeenCalledTimes(2)
      expect(onModelSelect.mock.calls[1][0]).toEqual({ modelId: 'b', provider: 'prov' })
    })

    it('sessionId 变化即清：跨 session 不残留意图错一步起点', async () => {
      const { deps, onModelSelect, sessionId } = makePendingDeps({ currentModelId: 'prov/a' })
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('p', { ctrl: true }).e) // session s1：意图 b
      sessionId.value = 's2'
      await flushPromises()
      handler(makeKeyEvent('p', { ctrl: true }).e)

      // 真值仍 a → 目标 b（若残留意图 b 则续步到 c）
      expect(onModelSelect).toHaveBeenCalledTimes(2)
      expect(onModelSelect.mock.calls[1][0]).toEqual({ modelId: 'b', provider: 'prov' })
    })

    it('进入 staging 即清：已建 in-flight 意图不跨态残留（影响面审 S-1）', async () => {
      const { deps, onModelSelect, isStaging } = makePendingDeps({ currentModelId: 'prov/a' })
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('p', { ctrl: true }).e) // 已建态：意图 b
      isStaging.value = true // 进入 fork staging
      await flushPromises()
      handler(makeKeyEvent('p', { ctrl: true }).e) // staging 分支：起点应为真值 a

      expect(onModelSelect).toHaveBeenCalledTimes(2)
      expect(onModelSelect.mock.calls[1][0]).toEqual({ modelId: 'b', provider: 'prov' })
    })

    it('landing 态不设意图：RTT 内连按两次均从真值起算（同步写语义，目标相同不重步缺失）', () => {
      const { deps, onThinkingSelect } = makePendingDeps({
        sessionId: null,
        currentThinkingLevel: 'medium',
      })
      const handler = useComposerShortcutActions(deps)

      handler(makeKeyEvent('Tab', { shift: true }).e)
      handler(makeKeyEvent('Tab', { shift: true }).e)

      // 无意图 → 两次起点都是真值 medium → 两次目标都是 high（若有意图则第二次为 off）
      expect(onThinkingSelect.mock.calls.map((c) => c[0])).toEqual(['high', 'high'])
    })
  })

  // ── 复制动作（§3.3 决策 4 + §3.5 错误规格）──────────────────────────────────
  describe('复制动作（ctrl+x）', () => {
    it('最后一条 assistant 纯文本复制成功：clipboard 写入 + toast info + 拦截', async () => {
      const { deps, toastInfo, toastError } = makeDeps({
        messages: [
          mkMsg('user', 'q1'),
          mkMsg('assistant', 'first reply'),
          mkMsg('user', 'q2'),
          mkMsg('assistant', 'second reply'),
        ],
      })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())
      const { e, preventDefault } = makeKeyEvent('x', { ctrl: true })

      expect(handler(e)).toBe(true)
      await flushPromises()
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith('second reply')
      expect(toastInfo).toHaveBeenCalledWith('panel.composer.copyLastReply')
      expect(toastError).not.toHaveBeenCalled()
      expect(preventDefault).toHaveBeenCalledTimes(1)
    })

    it('assistant content 为 Segment[]：normalizeContent 归一纯文本后写入', async () => {
      const { deps } = makeDeps({
        messages: [mkMsg('assistant', [{ type: 'text', text: 'segment text' }])],
      })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())

      handler(makeKeyEvent('x', { ctrl: true }).e)
      await flushPromises()
      expect(writeText).toHaveBeenCalledWith('segment text')
    })

    it('clipboard writeText reject：toast error「复制失败」+ 不抛出（无 unhandled rejection）', async () => {
      const { deps, toastInfo, toastError } = makeDeps({
        messages: [mkMsg('assistant', 'reply')],
      })
      const handler = useComposerShortcutActions(deps)
      stubClipboard(() => Promise.reject(new Error('clipboard denied')))

      expect(() => handler(makeKeyEvent('x', { ctrl: true }).e)).not.toThrow()
      await flushPromises()
      expect(toastError).toHaveBeenCalledWith('panel.composer.copyLastReplyFailed')
      expect(toastInfo).not.toHaveBeenCalled()
    })

    it('空流（无 assistant 消息）：no-op 不弹 toast（避免空态噪音），键吞掉', () => {
      const { deps, toastInfo, toastError } = makeDeps({ messages: [mkMsg('user', 'only user')] })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())

      expect(handler(makeKeyEvent('x', { ctrl: true }).e)).toBe(true)
      expect(writeText).not.toHaveBeenCalled()
      expect(toastInfo).not.toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    })

    it('最后一条 assistant 为错误消息（status=error）：照常复制错误全文（§3.5）', async () => {
      const { deps } = makeDeps({
        messages: [mkMsg('assistant', 'ok'), mkMsg('assistant', 'boom', 'error')],
      })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())

      handler(makeKeyEvent('x', { ctrl: true }).e)
      await flushPromises()
      expect(writeText).toHaveBeenCalledWith('boom')
    })

    it('复制内容为空串：写剪贴板空串 + toast info 照常提示（§3.5）', async () => {
      const { deps, toastInfo } = makeDeps({ messages: [mkMsg('assistant', '')] })
      const handler = useComposerShortcutActions(deps)
      const writeText = stubClipboard(() => Promise.resolve())

      handler(makeKeyEvent('x', { ctrl: true }).e)
      await flushPromises()
      expect(writeText).toHaveBeenCalledWith('')
      expect(toastInfo).toHaveBeenCalledWith('panel.composer.copyLastReply')
    })
  })
})
