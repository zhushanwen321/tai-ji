/**
 * CommandPopover 键盘路由（↑↓ ⏎ Tab Esc）+ 高亮索引收敛单点化。
 *
 * 从 CommandPopover.vue 拆出（照 composition-flag.ts 范式：window 事件在 composable 内
 * 注册/注销；组件只留候选组装与渲染）。键盘决策与 activeIndex 的生命周期归本文件。
 *
 * 收敛点单一化（缺陷 A）：候选源可在浮层打开期间**缩短**（query 变化 / 数据回写）。
 * 此时 activeIndex 可 ≥ 新长度，后果三处不一致：模板只按 `i === activeIndex` 高亮 ⇒
 * 无行高亮；Enter 在该窗口静默选中末项（旧实现靠 `Math.min` 读点兜底）；首次 ↑/↓ 按
 * `(idx ± 1 + len) % len` 对越界值不收敛到邻项（旧实现把越界归 0）。故在**唯一收敛点**
 * ——列表长度变化的同一拍（sync watch）——把 activeIndex 夹到 [0, len-1]（空表归 0），
 * 使「模板高亮行 / Enter 选中项 / ↑↓ 起点」三处天然一致；候选读点不再兜底
 * （读点兜底只救 Enter，救不了高亮与 ↑↓ 起点，且把「越界」固化成隐性契约）。
 *
 * 消费语义（缺陷 B）：浮层 `open` 时 ↑↓ ⏎ Tab 被消费（↑↓ 以候选非空为前提；Enter/Tab 空候选
 * 也消费）——preventDefault 终止浏览器默认行为，并 stopPropagation 截断事件向 target 的传播。
 * window capture 是**主入口**（同一事件另经 contenteditable 冒泡到 Composer 的 keydown 路由，
 * 那是兜底路——见下方 defaultPrevented 幂等守卫）；不截断则事件继续到达 contenteditable 的
 * 冒泡监听、被 composer 的方向键导航二次消费。
 * ↑↓ 的截断尤其必要：composer 裸箭头导航在单视觉行返回 at-edge 后会触发历史召回
 * （dom-core input/history 的 setText），把当前草稿替换成上一条历史消息——浮层开着时按 ↑/↓
 * 绝不能落到这条链路。组件为每个 open 态都渲染了可见行（候选列表 / 空态提示 / 加载中 /
 * 加载失败），不再存在「open 但无任何渲染」的态。
 * `len === 0`（空态行）时 ↑↓ 放行（无项可移，放行后走 composer 的光标/历史导航）；
 * Enter/Tab 仍消费（length 判据对本文件余下分支不生效的唯一例外）。Esc 亦放行，交 reka
 * DismissableLayer 兜底关闭浮层——空态行这三条行为由 composer-keydown.test.ts
 * 「浮层可见但候选为空」用例组锁定。
 * [HISTORICAL] 曾按「浮层实际可见才消费」（RC-A-1 override）：其唯一边界条件是 file 路的
 * 错误/空结果态（唯一可见空态），其余 open 态一律放行——因为「不可见态吞键 = 消息发不出
 * 且无提示」。反馈行落地后该理由消失 ⇒ 消费条件回到「open 即消费」（空候选态按长度放行）。
 * 「浮层未 open 时 Enter 正常发送」是保留契约：本文件首个 early-return 即它。
 *
 * ADR-0049 判定：activeIndex 是浮层自身的 UI 焦点态（随每次 open/type/query 重置），
 * 不做按 sessionId 分区，故为普通 composable 而非 useSessionScopedState 工厂。
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useCompositionFlag } from './composition-flag'

export interface CommandPopoverKeyboardOpts<T> {
  /** 浮层 open 态：false 时全部键放行（Enter 正常发送契约） */
  open: () => boolean
  /** 当前候选列表（长度变化即触发 activeIndex 收敛） */
  items: () => readonly T[]
  /** 选中候选项（鼠标点击与键盘 Enter/Tab 共用同一入口，含已选禁选守卫） */
  onSelect: (item: T) => void
  /** 关闭浮层（Escape 分支） */
  close: () => void
  /** 高亮重置键（open / type / query 变化即归零——沿用组件既有语义） */
  resetKeys: () => readonly unknown[]
}

export interface CommandPopoverKeyboard {
  /** 当前高亮索引（模板高亮 + ↑↓ 起点 + Enter 读点共用；由本文件唯一收敛） */
  activeIndex: Ref<number>
  /** Composer 的 keydown 路由入口：返回 true 表示已消费（preventDefault + stopPropagation 截断，
   *  不再冒泡到发送/导航链路）。候选非空时的 ↑↓ ⏎ Tab 命中此列；`len === 0` 空态行的 ↑↓ 与
   *  Esc 返回 false 放行（见文件头消费语义） */
  handleKeydown: (e: KeyboardEvent) => boolean
}

export function useCommandPopoverKeyboard<T>(opts: CommandPopoverKeyboardOpts<T>): CommandPopoverKeyboard {
  const activeIndex = ref(0)
  /** IME 组合态双保险的事件侧面（window capture compositionstart/end 维护，详见 composition-flag.ts） */
  const { composing: composingRef } = useCompositionFlag()

  // 唯一收敛点：候选列表长度变化的同一拍（sync）夹住 activeIndex，杜绝「越界窗口」。
  // 长度未变即不动（watch 的 Object.is 比较），保住用户当前高亮位置。
  watch(
    () => opts.items().length,
    (len) => {
      if (len === 0) activeIndex.value = 0
      else if (activeIndex.value > len - 1) activeIndex.value = len - 1
      else if (activeIndex.value < 0) activeIndex.value = 0
    },
    { flush: 'sync' },
  )

  // 浮层打开 / 换 type / query 变化：高亮回第一项
  watch(
    () => opts.resetKeys(),
    () => {
      activeIndex.value = 0
    },
  )

  /** ComposerInput keydown 路由：浮层 open 且候选非空时消费 ↑↓ ⏎ Tab（preventDefault +
   *  stopPropagation 全截断）；`len === 0` 空态行 ↑↓ 与 Esc 放行、Enter/Tab 仍消费。
   *  返回 true 表示已消费。
   *  幂等守卫 defaultPrevented：同一事件可能经 window capture 与 contenteditable 冒泡两条入口
   *  命中，split mode 双实例亦共享 window capture 节点（先到先得），不守卫 ↑↓ 会跳两项
   *  （① 已消费则 ② 不再处理）。 */
  function handleKeydown(e: KeyboardEvent): boolean {
    if (!opts.open()) return false
    if (e.defaultPrevented) return false // 幂等守卫：① 已消费则 ② 不再重复处理
    const list = opts.items()
    const len = list.length
    const isEnterOrTab = e.key === 'Enter' || e.key === 'Tab'
    // 无候选（空态提示行）时方向键无项可移（(0 ± 1 + 0) % 0 = NaN）⇒ 放行；Enter/Tab 仍须消费
    if (len === 0 && !isEnterOrTab) return false
    // 方向键必须同时截断传播（与下方 Enter/Tab 同款）：截断点即 window capture 主入口，
    // 只 preventDefault 而不 stopPropagation 时事件继续到达 contenteditable 冒泡监听 →
    // composer-keydown 的 handleBareArrowNav 二次消费（defaultPrevented 幂等守卫只挡
    // activeIndex 二次变更，不挡 composer 的方向键导航）→ dom-core 单视觉行 at-edge →
    // history setText 用上一条历史消息替换当前草稿。勿删。
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      activeIndex.value = (activeIndex.value + 1) % len
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      activeIndex.value = (activeIndex.value - 1 + len) % len
      return true
    }
    if (isEnterOrTab) {
      // 时序契约（composer-chip-insertion-semantics 设计 D2）：本分支多经 window capture
      // （onWindowKeydown）进入，消费 Enter/Tab 后必须 stopPropagation 截断事件向 target 的
      // 传播——这是「浮层 open 时 Enter 选中候选、绝不触发 composer onSend」的唯一防线
      // （composer-keydown 无 defaultPrevented 防御层：contenteditable Enter 分支恒先
      // preventDefault 再转发，防御层会拦死正常发送）。勿删。
      // 边界：stopPropagation 不拦同节点上已注册的其他 listener——split mode 双浮层同时 open
      // 时按注册序先到先得（设计 D2 边界声明①，已知限制）。
      if (composingRef.value || e.isComposing) return false // IME 双保险：组合中 Enter 是确认候选词，放行
      e.preventDefault()
      e.stopPropagation()
      // 空候选（空态行）：无项可选中，仅消费事件终止链路；**不**顺带关闭浮层（不改变 open
      // 状态）——避免用户下一次 Enter 在无浮层可感知的情况下意外发送（Escape 仍是显式关闭入口）。
      // 读点直取 list[activeIndex]：越界已由上方 sync watch 收敛（收敛点单一化），不再 Math.min 兜底。
      if (len > 0) opts.onSelect(list[activeIndex.value])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      opts.close()
      return true
    }
    return false
  }

  /** window keydown capture 监听：键盘导航主入口（Composer 的 keydown 路由为兜底路），先于组件 keydown 保证稳定命中。 */
  function onWindowKeydown(e: KeyboardEvent): void {
    if (!opts.open()) return
    handleKeydown(e)
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onWindowKeydown, true)
    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onWindowKeydown, true)
    })
  }

  return { activeIndex, handleKeydown }
}
