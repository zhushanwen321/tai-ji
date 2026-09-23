/**
 * composer-keydown 单测——test-coverage-r1 MUST_FIX #1 修复（U02 从 Composer.vue onKeydown
 * 拆出后键盘决策分支零测试触达）。
 *
 * useComposerKeydown 是纯事件分派器（deps 全只读注入、无自有状态、无 DOM 依赖），
 * 直接注入 fake deps 单测返回的 handler。断言到依赖调用层面（哪个 dep 被调/未被调 +
 * preventDefault 次数），非「不抛错」式弱断言。
 *
 * 覆盖矩阵（与源文件头部分发语义逐条对应，u5b D6 + composer-pi-shortcuts U1② 改造后）：
 *   bare-arrow：裸 ↑/↓ → preventDefault + moveCaretVertical；moved 不翻历史；
 *   at-edge ↑/↓ 翻历史；修饰键 + ↑/↓ 放行原生。
 *   Enter：staging 优先（⏎/Alt+⏎ 均提交 staging）；Alt+⏎ steer 路由行 → onFollowUp；
 *   Alt+⏎ defer/direct 行 → onSend（经统一分发器）；裸 ⏎ 恒 onSend（路由判定收口在
 *   core dispatch/send，keydown 层不分流）；⇧⏎ 放行换行。
 *   动作表接线（composer-pi-shortcuts）：链序（动作表先于 staging Esc）、消费短路（命中
 *   返回 true → 链终止）、未命中放行（返回 false → 既有段照常触达）、浮层未消费仍咨询
 *   （cmdOpen 入口守卫归动作表自判）、IME 段先行（组合中动作表不被咨询）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { SendRoute, StagingAction } from '@taiji/core/domain/composer'
import { useComposerKeydown, type ComposerKeydownDeps } from './composer-keydown'
import type { ShellInputInstance } from './composer-shell'
import CommandPopover from '@/components/panel/CommandPopover.vue'

// useCommandSync（CommandPopover 内直调）挂载即可能拉 session.getCommands：
// mock '@/api' 避免依赖真实通道（与 command-popover-registry-merge.test.ts 同款）
vi.mock('@/api', () => ({
  session: { getCommands: vi.fn().mockResolvedValue({ sessionId: '', commands: [] }) },
}))

// open-fetch 的 landing cwd 路 import composer domain（u5 re-anchor 后实现的 import 是 core
// 子路径）——mock 之隔离真实 WS 通路。「空结果 / 加载中 / query 无匹配」用例必须走真实 open
// 边沿拉取回写，mock specifier 必须与实现一致否则 mock 失效
// （与 composer-file-popover.test.ts 同款）
const getFileCandidatesByCwdMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/composer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/api/domains/composer')>()
  return {
    ...actual,
    getFileCandidatesByCwd: (...args: unknown[]) => getFileCandidatesByCwdMock(...args),
  }
})

type KeyMods = { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean }

/** 构造带 preventDefault spy 的键盘事件（happy-dom KeyboardEvent，isComposing 默认 false） */
function makeKeyEvent(key: string, mods: KeyMods = {}) {
  const e = new KeyboardEvent('keydown', {
    key,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    cancelable: true,
  })
  const preventDefault = vi.fn()
  e.preventDefault = preventDefault
  return { e, preventDefault }
}

/** fake deps：仅覆盖 keydown 分发路径实际消费的契约面（多余方法对测试无意义） */
function makeDeps(overrides: {
  /** moveCaretVertical 返回值（默认 at-edge → 触发翻历史路径） */
  caret?: 'moved' | 'at-edge'
  /** D6 发送路由（默认 direct） */
  route?: SendRoute
  stagingActive?: boolean
  /** 命令动作表返回值（composer-pi-shortcuts U1②；默认 false = 未命中放行） */
  shortcutConsumed?: boolean
  /** 命令浮层 open 态（接线矩阵用） */
  cmdOpen?: boolean
  /** 浮层 handleKeydown 返回值（null = 不接浮层实例；默认 null） */
  popoverConsumes?: boolean | null
} = {}) {
  const moveCaretVertical = vi.fn(() => overrides.caret ?? 'at-edge')
  const handleArrowUp = vi.fn()
  const handleArrowDown = vi.fn()
  const onFollowUp = vi.fn()
  const onSend = vi.fn()
  const shortcutActions = vi.fn(() => overrides.shortcutConsumed ?? false)
  const staging = {
    // Esc 路由默认不消费（消费与否属于 staging.action 自身测试，不在本矩阵）
    handleEsc: vi.fn(() => false),
    // 分派器只读 activeStaging.value 真值；staging action 行为契约由 staging 域测试覆盖
    activeStaging: computed(() =>
      overrides.stagingActive ? ({ type: 'fork' } as unknown as StagingAction) : null,
    ),
  }
  const popoverHandle =
    overrides.popoverConsumes === null || overrides.popoverConsumes === undefined
      ? null
      : { handleKeydown: vi.fn(() => overrides.popoverConsumes) }
  const deps: ComposerKeydownDeps = {
    cmdOpen: ref(overrides.cmdOpen ?? false),
    commandPopoverRef: ref(popoverHandle) as ComposerKeydownDeps['commandPopoverRef'],
    inputRef: ref({ moveCaretVertical } as unknown as ShellInputInstance),
    staging,
    sendRoute: computed(() => overrides.route ?? 'direct'),
    shortcutActions,
    handleArrowUp,
    handleArrowDown,
    onFollowUp,
    onSend,
  }
  return {
    deps,
    moveCaretVertical,
    handleArrowUp,
    handleArrowDown,
    onFollowUp,
    onSend,
    shortcutActions,
    staging,
    popoverHandle,
  }
}

describe('useComposerKeydown', () => {
  describe('bare-arrow 导航矩阵', () => {
    it('裸 ↑：preventDefault + moveCaretVertical(up)；caret moved 不翻历史', () => {
      const { deps, moveCaretVertical, handleArrowUp, handleArrowDown } = makeDeps({ caret: 'moved' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('ArrowUp')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(moveCaretVertical).toHaveBeenCalledWith('up')
      expect(handleArrowUp).not.toHaveBeenCalled()
      expect(handleArrowDown).not.toHaveBeenCalled()
    })

    it('裸 ↓：preventDefault + moveCaretVertical(down)；caret moved 不翻历史', () => {
      const { deps, moveCaretVertical, handleArrowUp, handleArrowDown } = makeDeps({ caret: 'moved' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('ArrowDown')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(moveCaretVertical).toHaveBeenCalledWith('down')
      expect(handleArrowUp).not.toHaveBeenCalled()
      expect(handleArrowDown).not.toHaveBeenCalled()
    })

    it('裸 ↑：caret at-edge → 翻上一条历史（handleArrowUp），不走下一条', () => {
      const { deps, moveCaretVertical, handleArrowUp, handleArrowDown } = makeDeps({ caret: 'at-edge' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('ArrowUp')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(moveCaretVertical).toHaveBeenCalledTimes(1)
      expect(handleArrowUp).toHaveBeenCalledTimes(1)
      expect(handleArrowDown).not.toHaveBeenCalled()
    })

    it('裸 ↓：caret at-edge → 翻下一条历史（handleArrowDown），不走上一条', () => {
      const { deps, handleArrowUp, handleArrowDown } = makeDeps({ caret: 'at-edge' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('ArrowDown')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(handleArrowDown).toHaveBeenCalledTimes(1)
      expect(handleArrowUp).not.toHaveBeenCalled()
    })

    it('修饰键 + ↑/↓ 放行原生（选区扩展/按词移动/段首段尾跳转）：不拦截不分派', () => {
      const cases: Array<{ key: string; mods: KeyMods }> = [
        { key: 'ArrowUp', mods: { shift: true } },
        { key: 'ArrowUp', mods: { alt: true } },
        { key: 'ArrowUp', mods: { ctrl: true } },
        { key: 'ArrowUp', mods: { meta: true } },
        { key: 'ArrowDown', mods: { shift: true } },
      ]
      for (const { key, mods } of cases) {
        const { deps, moveCaretVertical, handleArrowUp, handleArrowDown } = makeDeps()
        const onKeydown = useComposerKeydown(deps)
        const { e, preventDefault } = makeKeyEvent(key, mods)

        onKeydown(e)

        expect(preventDefault, `${key} + ${JSON.stringify(mods)} 应放行`).not.toHaveBeenCalled()
        expect(moveCaretVertical, `${key} + ${JSON.stringify(mods)} 应放行`).not.toHaveBeenCalled()
        expect(handleArrowUp).not.toHaveBeenCalled()
        expect(handleArrowDown).not.toHaveBeenCalled()
      }
    })
  })

  describe('Enter 分发矩阵（u5b D6：路由判定收口在 core dispatch/send）', () => {
    it('staging 活跃：裸 Enter → onSend（staging 提交优先）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ stagingActive: true, route: 'steer' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('staging 活跃：Alt+Enter → onSend（staging 优先于 followUp）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ stagingActive: true })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('Alt+Enter + steer 路由行 → onFollowUp（turn 活跃保留下一轮投递语义），不走 onSend', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ route: 'steer' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onFollowUp).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled()
    })

    it('Alt+Enter + defer 路由行 → onSend（占用期经统一分发器入队待重放）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ route: 'defer' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('Alt+Enter + direct → onSend（followUp 非活跃退化路径的语义收口）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ route: 'direct' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { alt: true })

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('裸 Enter + steer 路由行 → onSend（统一分发器：steer 路由并入当前回合，[HISTORICAL] isActive→onSteer 直调退役）', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ route: 'steer' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('裸 Enter + idle（direct）→ onSend', () => {
      const { deps, onFollowUp, onSend } = makeDeps({ route: 'direct' })
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter')

      onKeydown(e)

      expect(preventDefault).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onFollowUp).not.toHaveBeenCalled()
    })

    it('⇧⏎ 放行原生换行：不 preventDefault、不分派任何动作', () => {
      const { deps, onFollowUp, onSend } = makeDeps()
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Enter', { shift: true })

      onKeydown(e)

      expect(preventDefault).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(onFollowUp).not.toHaveBeenCalled()
    })
  })

  /**
   * 分发链接线（composer-pi-shortcuts U1②）：命令动作表分支插在 IME 之后、staging Esc 之前。
   * 本矩阵只锁链序与短路语义（动作表消费 → 链终止；未消费 → 链继续），动作表内部
   * 键位判定/守卫/编排由 composer-shortcut-actions.test.ts 全量覆盖。
   */
  describe('分发链接线：命令动作表分支（composer-pi-shortcuts）', () => {
    it('动作表消费（shift+tab 命中返回 true）：链短路——staging Esc / 裸箭头 / Enter 均不触达', () => {
      const { deps, moveCaretVertical, onSend, shortcutActions, staging } = makeDeps({
        shortcutConsumed: true,
        caret: 'at-edge',
      })
      const onKeydown = useComposerKeydown(deps)
      const { e } = makeKeyEvent('Tab', { shift: true })

      onKeydown(e)

      expect(shortcutActions).toHaveBeenCalledTimes(1)
      expect(shortcutActions).toHaveBeenCalledWith(e)
      expect(staging.handleEsc).not.toHaveBeenCalled()
      expect(moveCaretVertical).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
    })

    it('动作表未命中（返回 false）：链继续——裸箭头导航照常触达（既有段行为不变）', () => {
      const { deps, moveCaretVertical, handleArrowUp, shortcutActions } = makeDeps({
        shortcutConsumed: false,
        caret: 'at-edge',
      })
      const onKeydown = useComposerKeydown(deps)
      const { e } = makeKeyEvent('ArrowUp')

      onKeydown(e)

      expect(shortcutActions).toHaveBeenCalledTimes(1)
      expect(moveCaretVertical).toHaveBeenCalledTimes(1)
      expect(handleArrowUp).toHaveBeenCalledTimes(1)
    })

    it('链序：动作表先于 staging Esc（同键 Esc 未命中时 handleEsc 在其后被咨询）', () => {
      const { deps, shortcutActions, staging } = makeDeps({ shortcutConsumed: false })
      const onKeydown = useComposerKeydown(deps)
      const { e } = makeKeyEvent('Escape')

      onKeydown(e)

      expect(shortcutActions).toHaveBeenCalledTimes(1)
      expect(staging.handleEsc).toHaveBeenCalledTimes(1)
      expect(shortcutActions.mock.invocationCallOrder[0]).toBeLessThan(
        staging.handleEsc.mock.invocationCallOrder[0],
      )
    })

    it('IME 组合中动作表不被咨询（IME 段先于动作表放行——§3.4 插序约束）', () => {
      const { deps, shortcutActions, onSend } = makeDeps()
      const onKeydown = useComposerKeydown(deps)
      const { e, preventDefault } = makeKeyEvent('Tab', { shift: true })
      Object.defineProperty(e, 'isComposing', { value: true })

      onKeydown(e)

      expect(shortcutActions).not.toHaveBeenCalled()
      expect(preventDefault).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
    })

    it('浮层 open 且浮层未消费该键：动作表仍被咨询（消费与否由其 cmdOpen 入口守卫自判）', () => {
      const { deps, shortcutActions, onSend, popoverHandle } = makeDeps({
        cmdOpen: true,
        popoverConsumes: false,
      })
      const onKeydown = useComposerKeydown(deps)
      const { e } = makeKeyEvent('a')

      onKeydown(e)

      expect(popoverHandle!.handleKeydown).toHaveBeenCalledTimes(1)
      expect(shortcutActions).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled() // 'a' 非 Enter，正常落空
    })
  })

  /**
   * D2 时序锁（composer-chip-insertion-semantics 设计 §3.3 D2 + P5）：浮层 open 时 Enter
   * 经 CommandPopover window capture 消费（preventDefault + stopPropagation 截断）后，
   * 事件不得到达 composer 的 onKeydown/onSend——这是删除 defaultPrevented 防御层后的
   * 唯一防线，用真实 DOM 事件派发锁 capture/bubble 全链路（happy-dom 支持传播 + stopPropagation
   * 语义；真机链路另有设计 §4 场景表签收）。
   *
   * 链路模拟与产线同构：window（capture，CommandPopover onWindowKeydown）→ target
   * （bubble，useComposerKeydown 产物 onKeydown，cmdOpen/commandPopoverRef 按产线接线）。
   *
   * 消费条件（缺陷 B 修复后）= 「浮层 open 即消费」：PopoverContent 的 v-if 只看 open，
   * 每个 open 态都有可见行（候选列表 / 通用空态 / 加载中 / 加载失败），不再存在「open 但
   * 什么都不渲染」的态。[HISTORICAL] RC-A-1 曾把消费条件收紧为「浮层实际可见」（唯一边界 =
   * file 错误/空结果态），理由是「不可见态吞键 = 消息发不出且无提示」；反馈行补齐后该理由
   * 消失 ⇒ 判据删除（不是与旧判据并存）。仅「浮层未 open」仍全部键放行（末条用例锁定
   * Enter 正常发送）。
   *
   * D4 三态细化（command-enter-exact-send §3.3 D4）：非精确匹配锁 = 现状断言（首条 + 前缀条）；
   * 精确匹配锁 = select-and-send 同步直调 composer 分发链，onSend 恰一次（双发回归锁——
   * 实现若走合成事件二次派发，计数变 2 而红）；Tab 锁 = 恒 onSelect（补参通道不因完整名关闭）。
   * 精确锁前置 = 显式 focus（环境 activeElement 默认 body → D1 前置② fail-closed 恒拦，
   * 见 setupExactChain）。
   */
  describe('D2 时序锁三态（command-enter-exact-send D4）：前缀/门失败恒选中不发送、精确直发恰一次、Tab 恒选中（capture/bubble 全链路）', () => {
    let target: HTMLElement
    let removeTarget: () => void
    let popoverWrapper: ReturnType<typeof mount> | null = null
    let onSelect: ReturnType<typeof vi.fn>
    let onSelectAndSend: ReturnType<typeof vi.fn>
    let onSend: ReturnType<typeof vi.fn>
    /** select-and-send → composer 分发链直调通道（镜像产线 useCommandPopoverTrigger.onSelectAndSend
     *  的 onComposerKeydown 晚绑定闭包）；由 wireComposerKeydown 赋值，beforeEach 复位 */
    let composerKeydownHandler: ((e: KeyboardEvent) => void) | null

    beforeEach(() => {
      setActivePinia(createPinia())
      onSelect = vi.fn()
      onSend = vi.fn()
      composerKeydownHandler = null
      // select-and-send 消费端 = 产线直调镜像（传原事件，零合成零 DOM 派发）。
      // onSend 恰一次断言的作用面盖三处：①键盘层分流只调一次 ②原事件被 capture 截断不到
      // target 冒泡（到则 composer 分发器二次 dispatchEnter）③CommandPopover 未合成再派发
      // KeyboardEvent（再派发会重进 window capture → 第二次 select-and-send → 第二次直调）。
      onSelectAndSend = vi.fn((payload: { originalEvent: KeyboardEvent }) => {
        composerKeydownHandler?.(payload.originalEvent)
      })
      // target 模拟 composer contenteditable：keydown 冒泡链上挂 useComposerKeydown 产物
      target = document.createElement('div')
      target.setAttribute('contenteditable', 'true')
      document.body.appendChild(target)
      removeTarget = () => target.remove()
    })

    afterEach(() => {
      vi.useRealTimers()
      // landing `$` 拉取 mock 逐用例复位：mockImplementationOnce 若未被消费（理论上不会——
      // 每次挂载新实例、1s 节流窗口随实例从 0 起）不留到下一用例
      getFileCandidatesByCwdMock.mockReset()
      popoverWrapper?.unmount()
      popoverWrapper = null
      removeTarget()
      document.body.innerHTML = ''
    })

    /** target（composer contenteditable）挂 composer keydown 分发器，cmdOpen/commandPopoverRef
     *  按产线接线指向已挂载的浮层实例。 */
    function wireComposerKeydown(open: boolean): void {
      const deps: ComposerKeydownDeps = {
        cmdOpen: ref(open),
        commandPopoverRef: ref(popoverWrapper!.vm as never),
        inputRef: ref(null),
        staging: { handleEsc: vi.fn(() => false), activeStaging: computed(() => null) },
        sendRoute: computed(() => 'direct' as SendRoute),
        shortcutActions: vi.fn(() => false),
        handleArrowUp: vi.fn(),
        handleArrowDown: vi.fn(),
        onFollowUp: vi.fn(),
        onSend,
      }
      composerKeydownHandler = useComposerKeydown(deps)
      target.addEventListener('keydown', composerKeydownHandler)
    }

    /** 挂真 CommandPopover（panel 态无 sid → compact 一项保底非空）+ 接线 composer keydown。
     *  propsOverride 供可见性矩阵用例换 type/query/variant（query 无匹配即可造「open 但空候选」）。
     *  onSelectAndSend 按产线 `@select-and-send="onSelectAndSend"` 接线（消费端见 beforeEach）。 */
    function setupChain(open: boolean, propsOverride: Record<string, unknown> = {}): void {
      popoverWrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open, type: 'slash', variant: 'panel', onSelect, onSelectAndSend, ...propsOverride } as never,
      })
      wireComposerKeydown(open)
    }

    /**
     * 浮层「可见但候选为空」的生产形态：landing `$` 空结果态——fileNoResultsVisible 为真
     * ⇒ 模板渲染 file-no-results 行，但 items 为空。
     * 必须走真实链路造态：挂载时 open=false，再 setProps 打开触发 open false→true 边沿拉取
     * （getFileCandidatesByCwd 回空 files 且 truncated=false）+ flush 回写 success。
     * 1s 节流窗口是组件实例级（useCommandPopoverOpenFetch 内的局部量，每次挂载从 0 起），
     * 用例间不互相撞窗口；fake Date 冻结时间派生读数（flushPromises 依赖的
     * setImmediate/setTimeout 保持真实）。
     */
    async function setupLandingFileEmptyChain(): Promise<void> {
      vi.useFakeTimers({ toFake: ['Date'] })
      getFileCandidatesByCwdMock.mockResolvedValueOnce({ files: [], truncated: false })
      popoverWrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open: false, type: 'file', variant: 'landing', cwd: '/tmp/empty-dir', onSelect } as never,
      })
      wireComposerKeydown(true)
      await nextTick()
      await popoverWrapper.setProps({ open: true })
      await flushPromises()
      await nextTick()
      // 造态自检：浮层确实渲染（空态行在 DOM 中），否则下方「可见态消费」断言会假绿
      expect(document.body.querySelector('[data-testid="cmd-file-empty"]')).not.toBeNull()
    }

    /** 真实 DOM 派发（cancelable 保证 preventDefault 生效；bubbles 走完整 capture→target→bubble） */
    function dispatchEnter(isComposing = false): KeyboardEvent {
      const e = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        isComposing,
      })
      target.dispatchEvent(e)
      return e
    }

    /** 精确锁链前置（D1 前置② focus 门，设计 §5 U3「测试态显式 focus composer」）：
     *  环境 activeElement 默认 body → activeElement 门恒 fail-closed 拦截，精确锁进直发
     *  分支前必须显式 focus。产线 shellInputRef = Composer shellInputHolder.ref（识别源 =
     *  ComposerInput expose 的 getInputElement）；本组用例的「composer 输入区」= target
     *  （contenteditable div，E-1 activeElementInInput 按该 expose 判据裁决），fake 实例
     *  getInputElement 指向 target。withShellRef=false = 通道缺省 → 门 fail-closed（D1
     *  降级态造法，focus 照做以证明拦截来自通道缺省而非焦点缺失）。 */
    function setupExactChain(query: string, withShellRef = true): void {
      const shellInputRef = withShellRef
        ? ref<ShellInputInstance | null>({ getInputElement: () => target } as unknown as ShellInputInstance)
        : undefined
      setupChain(true, { query, shellInputRef })
      target.focus()
      expect(document.activeElement).toBe(target) // 造态自检：focus 门前置确已生效
    }

    it('浮层 open：Enter 被浮层 capture 消费（onSelect 一次）且 stopPropagation 截断——onSend 不触发、事件 defaultPrevented', () => {
      setupChain(true)

      const e = dispatchEnter()

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'slash', name: '/compact' }))
      expect(onSend).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    // ── D4 三态细化（command-enter-exact-send §3.3 D4 + §4 场景 5）────────────────
    // 非精确锁 = 上方既有用例（query 空 → 非精确，现状断言零改动）+ 下方前缀用例
    // （前缀 + 焦点门通过 → 精确谓词为假 → 仍恒选中——设计场景 2「前缀插 chip 不回归」）。
    it('非精确锁（前缀）：query=com + 输入区 focus → Enter 仍恒选中（onSelect 一次、不直发）', () => {
      setupExactChain('com')

      const e = dispatchEnter()

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'slash', name: '/compact' }))
      expect(onSelectAndSend).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    it('精确锁：完整名 /compact + 输入区 focus + Enter → 直发——select-and-send 恰一次且 onSend 恰一次（双发回归锁）', () => {
      setupExactChain('compact')

      const e = dispatchEnter()

      expect(onSelectAndSend).toHaveBeenCalledTimes(1)
      expect(onSelectAndSend).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'slash', name: '/compact', originalEvent: e }),
      )
      // D2 双发回归锁：唯一发送来源 = select-and-send 同步直调 composer 分发链（传原事件）。
      // 实现若走合成事件二次派发（重进 window capture 或落 target 冒泡）→ 第二次
      // dispatchEnter → 计数变 2 而红；=0 则直调链断（fail-closed 通道亦红）。
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onSelect).not.toHaveBeenCalled() // 直发不经 select 通路（插 chip 前置态在产线 onCmdSelect 侧）
      expect(e.defaultPrevented).toBe(true) // capture 截断：原事件不到 target 冒泡（到则第二次 onSend）
    })

    it('Tab 锁：完整名 + 输入区 focus + Tab → 恒选中插 chip（onSelect 一次、select-and-send/onSend 零次）', () => {
      setupExactChain('compact')

      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      target.dispatchEvent(tab)

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'slash', name: '/compact' }))
      // exactMatch 直发仅 Enter；Tab 恒 onSelect（补参通道不因完整名关闭——设计场景 3）
      expect(onSelectAndSend).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(tab.defaultPrevented).toBe(true)
    })

    it('门失败降级：shellInputRef 缺省（D1 前置② fail-closed）+ 精确形 query → 不直发走选中', () => {
      setupExactChain('compact', false)

      const e = dispatchEnter()

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'slash', name: '/compact' }))
      expect(onSelectAndSend).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    // ── F-1 回归锁（W1 验收 P1）：门识别源 = getInputElement，不读实例 $el ──────────────
    // 缺陷形态：dev 构建保留 ComposerInput 模板 HTML 注释 → subTree 根为 Fragment → 实例
    // $el 是注释节点（nodeType 8）→ 旧实现 root.contains(activeElement) 恒 false →
    // 精确直发在 dev 全变体静默退化插 chip（prod 剥离注释才正常）。两用例反向锁死 $el
    // 通道不得复活：①$el 是注释 + expose 正确 → 门必须通过；②expose 缺失 + $el 正确 →
    // 门必须 fail-closed（实现若回退 $el，②的 onSelectAndSend 会被调而红）。
    it('F-1 锁：$el 为注释节点（dev 构建形态）+ getInputElement 正确 → 门通过，精确直发照常', () => {
      setupChain(true, {
        query: 'compact',
        shellInputRef: ref<ShellInputInstance | null>({
          $el: document.createComment(' 富文本输入区（contenteditable）'),
          getInputElement: () => target,
        } as unknown as ShellInputInstance),
      })
      target.focus()
      expect(document.activeElement).toBe(target) // 造态自检：焦点门前置确已生效

      const e = dispatchEnter()

      expect(onSelectAndSend).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onSelect).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    it('F-1 锁：expose 缺失（$el 正确且 focus 在内）→ 门 fail-closed 不直发（禁回退 $el）', () => {
      setupChain(true, {
        query: 'compact',
        shellInputRef: ref<ShellInputInstance | null>({ $el: target } as unknown as ShellInputInstance),
      })
      target.focus()
      expect(document.activeElement).toBe(target) // 造态自检：焦点在位，拦截只能来自 expose 缺失

      const e = dispatchEnter()

      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'slash', name: '/compact' }))
      expect(onSelectAndSend).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    // ── 缺陷 B：open 即渲染反馈行 + open 即消费 ──────────────────────────────
    // 修复前这些 open 态什么都不渲染（旧 v-if = items 非空 || fileFallbackVisible），按
    // RC-A-1「实际可见才消费」放行 Enter ⇒ landing 首发会把 `@query` 这类触发符字面量发出去。
    // 反馈行补齐后消费条件回到「open 即消费」（因果见 command-popover-keyboard.ts 头部）。
    it('open 但无候选（行首 `/zzz` 无匹配命令）→ 渲染「无匹配项」行 + Enter 被消费：onSend 不触发', async () => {
      setupChain(true, { query: 'zzz' })
      // reka PopoverContent 经 Presence 渲染（open=true 后下一拍进 DOM）——DOM 断言前先 flush
      await flushPromises()
      await nextTick()

      const emptyRow = document.body.querySelector('[data-testid="cmd-popover-empty"]')
      expect(emptyRow).not.toBeNull()
      expect(emptyRow!.textContent).toContain('无匹配项')
      expect(document.body.querySelectorAll('.cmd-row')).toHaveLength(0) // 确无候选（自检）

      const e = dispatchEnter()

      expect(onSelect).not.toHaveBeenCalled() // 无项可选中
      expect(onSend).not.toHaveBeenCalled() // stopPropagation 截断：未落到 composer 分发器
      expect(e.defaultPrevented).toBe(true)
    })

    it('open 但无候选：Tab 同口径被消费（不再按可见性分叉键位）', () => {
      setupChain(true, { query: 'zzz' })

      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      target.dispatchEvent(tab)

      expect(tab.defaultPrevented).toBe(true)
      expect(onSend).not.toHaveBeenCalled()
    })

    // 此前不可见态矩阵（缺陷 B）：四路空候选源 + landing `@` 无 sessionId + landing `$` 无 cwd。
    // 共同后果 = Enter 直达 onSend（landing 首发会创建 session 并发出 `@query` 字面量）。
    it.each([
      { label: 'slash 空候选（/zzz 无匹配）', props: { type: 'slash', query: 'zzz' } },
      { label: 'session 空候选', props: { type: 'session', query: 'zzz' } },
      { label: 'landing `@` 无 sessionId', props: { type: 'subagent', variant: 'landing' } },
      { label: 'skill 空候选', props: { type: 'skill', query: 'zzz' } },
      { label: 'landing `$` 无 cwd', props: { type: 'file', variant: 'landing' } },
    ])('open 但无候选（$label）→ 反馈行渲染 + Enter 被消费（不再放行）', async ({ props }) => {
      setupChain(true, props)
      await flushPromises() // reka PopoverContent 进 DOM 需下一拍（见上条注释）
      await nextTick()
      const handleKeydown = popoverWrapper!.vm.handleKeydown as (e: KeyboardEvent) => boolean

      const row = document.body.querySelector('[data-testid="cmd-popover-empty"]')
      expect(row).not.toBeNull()
      expect(row!.textContent).toContain('无匹配项')
      expect(document.body.querySelectorAll('.cmd-row')).toHaveLength(0)
      expect(document.body.querySelector('[data-testid="cmd-popover-loading"]')).toBeNull()

      const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
      expect(handleKeydown(enter)).toBe(true)
      expect(enter.defaultPrevented).toBe(true) // 已消费 ⇒ 不再冒泡到发送链路
    })

    it('landing `$` 有 cwd 但候选未到（open-fetch 在途）→ 渲染「加载中」行 + Enter 被消费、不发送', async () => {
      // 在途：mock 永不 settle ⇒ cwdFileStatus 停在 idle（与「本次 open 因 1s 节流跳过」同态，
      // 两者都是「结果稍后会到」）。修复前该 open 态无任何渲染 ⇒ Enter 直达 onSend。
      getFileCandidatesByCwdMock.mockImplementationOnce(() => new Promise(() => {}))
      popoverWrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open: false, type: 'file', variant: 'landing', cwd: '/tmp/in-flight', onSelect } as never,
      })
      wireComposerKeydown(true)
      await popoverWrapper.setProps({ open: true })
      await flushPromises()
      await nextTick()

      const row = document.body.querySelector('[data-testid="cmd-popover-loading"]')
      expect(row).not.toBeNull()
      expect(row!.textContent).toContain('加载中')
      expect(document.body.querySelector('[data-testid="cmd-popover-empty"]')).toBeNull() // 两态互斥

      const e = dispatchEnter()

      expect(onSend).not.toHaveBeenCalled()
      expect(onSelect).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    it('landing `$` 候选源非空但 query 无匹配 → 渲染「无匹配项」行（非加载中/非 file-no-results）+ Enter 被消费', async () => {
      getFileCandidatesByCwdMock.mockImplementationOnce(() =>
        Promise.resolve({ files: [{ path: 'a.ts', name: 'a.ts', type: 'file' }], truncated: false }),
      )
      popoverWrapper = mount(CommandPopover, {
        attachTo: document.body,
        props: { open: false, type: 'file', variant: 'landing', cwd: '/tmp/proj', onSelect } as never,
      })
      wireComposerKeydown(true)
      await popoverWrapper.setProps({ open: true })
      await flushPromises()
      await nextTick()
      expect(document.body.querySelectorAll('.cmd-row')).toHaveLength(1) // 造态自检：候选已到位

      await popoverWrapper.setProps({ query: 'zzz' })
      await nextTick()

      expect(document.body.querySelectorAll('.cmd-row')).toHaveLength(0)
      const row = document.body.querySelector('[data-testid="cmd-popover-empty"]')
      expect(row).not.toBeNull()
      expect(row!.textContent).toContain('无匹配项')
      // 候选源非空 ⇒ 既不是「加载中」也不是「当前目录无匹配文件」（那两态各有专属文案）
      expect(document.body.querySelector('[data-testid="cmd-popover-loading"]')).toBeNull()
      expect(document.body.querySelector('[data-testid="cmd-file-empty"]')).toBeNull()

      const e = dispatchEnter()

      expect(onSend).not.toHaveBeenCalled()
      expect(e.defaultPrevented).toBe(true)
    })

    it('浮层可见但候选为空（landing `$` 空结果态）：Enter 仍被消费——defaultPrevented、不选中、不得到达 onSend、不自动关闭浮层', async () => {
      await setupLandingFileEmptyChain()

      const e = dispatchEnter()

      expect(e.defaultPrevented).toBe(true) // 事件被浮层消费（preventDefault），未被放行
      expect(onSend).not.toHaveBeenCalled() // 未落到 composer 分发器（stopPropagation 截断）
      expect(onSelect).not.toHaveBeenCalled() // 无候选可选中
      // 不改变 open 状态：不自动关闭（否则用户下一次 Enter 会在无浮层可感知下意外发送）
      expect(popoverWrapper!.emitted('update:open')).toBeFalsy()
    })

    it('浮层可见但候选为空：↑↓ 仍无害放行（现状行为不变），仅 Enter/Tab 被消费', async () => {
      await setupLandingFileEmptyChain()
      const handleKeydown = popoverWrapper!.vm.handleKeydown as (e: KeyboardEvent) => boolean

      // 方向键无项可移 → 返回 false 且不 preventDefault（行为与修复前一致，未被本次重排改变）
      const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true })
      expect(handleKeydown(down)).toBe(false)
      expect(down.defaultPrevented).toBe(false)

      const up = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true })
      expect(handleKeydown(up)).toBe(false)
      expect(up.defaultPrevented).toBe(false)

      // Enter/Tab 例外：可见空态也消费（返回 true + preventDefault），但不选中任何项
      const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
      expect(handleKeydown(enter)).toBe(true)
      expect(enter.defaultPrevented).toBe(true)

      const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
      expect(handleKeydown(tab)).toBe(true)
      expect(tab.defaultPrevented).toBe(true)

      expect(onSelect).not.toHaveBeenCalled()
    })

    // ── ↑↓ 截断回归锁（缺陷：浮层 open 时 ↑/↓ 穿透到 composer 方向键导航）─────────────
    // 只 preventDefault 不 stopPropagation 时：window capture 消费后事件继续到 contenteditable
    // 的冒泡监听 → composer handleBareArrowNav 二次消费（defaultPrevented 幂等守卫只挡
    // activeIndex 二次变更，不挡 composer 的方向键导航）→ dom-core 单视觉行 at-edge →
    // history setText 用上一条历史消息替换当前草稿。下方用例用真实 DOM 派发锁 capture/bubble
    // 全链路（window capture 注册 = useCommandPopoverKeyboard，target 冒泡 = useComposerKeydown）。
    it.each(['ArrowUp', 'ArrowDown'])(
      '浮层 open 且候选非空：%s 被完全消费（preventDefault + stopPropagation），事件不传到 contenteditable 冒泡监听',
      async (key) => {
        setupChain(true)
        await flushPromises()
        await nextTick()
        expect(document.body.querySelectorAll('.cmd-row').length).toBeGreaterThan(0) // 造态自检：候选非空

        const bubbleSpy = vi.fn()
        target.addEventListener('keydown', bubbleSpy) // 注册在 composer 分发器之后：不截断则必被调用

        const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        target.dispatchEvent(e)

        expect(e.defaultPrevented).toBe(true) // window capture 侧已消费
        expect(e.cancelBubble).toBe(true) // stopPropagation 已截断
        expect(bubbleSpy).not.toHaveBeenCalled() // 事件未到达 contenteditable 冒泡监听（防穿透）
        expect(onSend).not.toHaveBeenCalled()
      },
    )

    it('对照：浮层空态行（候选为空）时 ↑ 仍放行——事件到达 contenteditable 冒泡监听（放行行为不变）', async () => {
      setupChain(true, { query: 'zzz' })
      await flushPromises()
      await nextTick()
      expect(document.body.querySelectorAll('.cmd-row')).toHaveLength(0) // 造态自检：确为空候选

      const bubbleSpy = vi.fn()
      target.addEventListener('keydown', bubbleSpy)

      const e = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
      target.dispatchEvent(e)

      expect(e.defaultPrevented).toBe(true) // 被 composer 侧裸箭头导航消费（非浮层）
      expect(e.cancelBubble).toBe(false) // 浮层未截断
      expect(bubbleSpy).toHaveBeenCalledTimes(1) // 事件确实到达冒泡监听（放行）
    })

    it('浮层可见但候选为空：Escape 由浮层 DismissableLayer 兜底关闭（不被提前返回拦死）', async () => {
      await setupLandingFileEmptyChain()
      const handleKeydown = popoverWrapper!.vm.handleKeydown as (e: KeyboardEvent) => boolean

      const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      // 本层不消费（方向键/其他键在无候选项时放行）——浮层已渲染，Escape 交 reka DismissableLayer
      expect(handleKeydown(esc)).toBe(false)
      expect(esc.defaultPrevented).toBe(false)
    })

    it('IME composing 态（compositionstart 置 composingRef）：Enter 不选中浮层候选（只锁「浮层不选中」）', () => {
      // 本用例只锁浮层侧行为（composingRef 真值时 handleKeydown 不消费 Enter → 不选中候选）。
      // 不加 onSend 断言的原因：本用例的 target 是纯 div 直挂 composer 分发器，绕过产线上
      // 真正的 IME 防线——dom-core contenteditable.ts:242 的元素级 composing 守卫（事件根本
      // 不会转发到 composer-keydown）。「IME 场景不发送」的有效锁在 dom-core contenteditable.test.ts
      // 「onKeydown IME 守卫」用例；事件属性路径（e.isComposing=true）见下方用例。
      setupChain(true)
      // 组合发生在 composer 输入区（target），compositionstart 冒泡到 window capture 置 composingRef
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))

      dispatchEnter()

      expect(onSelect).not.toHaveBeenCalled()
    })

    it('IME composing 态（事件属性 isComposing）：Enter 不选中浮层候选、到达 composer 被 IME 守卫放行不发送', () => {
      setupChain(true)

      dispatchEnter(true)

      expect(onSelect).not.toHaveBeenCalled()
      expect(onSend).not.toHaveBeenCalled()
    })

    it('浮层关闭：Enter 正常到达 composer → onSend（防截断误伤正常发送）', () => {
      setupChain(false)

      dispatchEnter()

      expect(onSelect).not.toHaveBeenCalled()
      expect(onSend).toHaveBeenCalledTimes(1)
    })
  })
})
