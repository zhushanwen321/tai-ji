/**
 * bottom-drawer 控制态 —— per-session 分区（ADR-0053 / ADR-0049 Map 分区派），
 * display-containers §7.1：`isOpen` = per-session 内存分区、**不持久化**
 * （右抽屉 isOpen 现状同样不持久化——刷新后底抽屉关闭）。
 *
 * 分层（C4 单向依赖）：本文件（control）= 纯控制态原语，不感知 heightPct 全局布局值
 * （layout.ts 职责）与协调函数语义（coordination.ts 职责）。
 * coordination / layout → control → foundation/use-session-scoped-state，禁止反向。
 *
 * 分区键绑定（bindDrawerSessionId 同款先例，core headless 不读 pinia）：renderer 装配层
 * 须在模块加载时调 `bindBottomDrawerSessionId(computed(() => usePanelStore().focusedSessionId))`。
 * 未绑定（boundSid=null）时模块级 API 按 null sid 语义操作（不写 Map 分区，安全默认）。
 *
 * 单实例：模块级单例（底抽屉全局一个，跟随 active panel 的 session 分区）。
 */
import { ref, computed, reactive } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useSessionScopedState } from '../../foundation/use-session-scoped-state'
import type { BottomDrawerControlState } from './types'

// ── 分区键占位 + 绑定（headless 不直接读 pinia；bindDrawerSessionId 同款）──
// 必须显式注解变量类型：Vue 3.5 的 ref<T> 在 T 本身是 Ref 类型时返回 T 而非 Ref<T> 包装
// （drawer/control.ts 同款注释——裸 `ref<Ref<string|null>|null>(null)` 会让 .value 链断裂）。
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：bottom-drawer 绑定 sid 单例 ref
const boundSid: Ref<Ref<string | null> | null> = ref(null)
const sidRef = computed<string | null>(() => boundSid.value?.value ?? null)

/**
 * 绑定模块级分区键（幂等：同 ref 重复绑定不报错；新 ref 覆盖）。
 * renderer 装配层模块顶层调用（bindDrawerSessionId 同款时机）。
 */
export function bindBottomDrawerSessionId(bound: Ref<string | null>): void {
  boundSid.value = bound
}

/** 读取当前绑定分区键（null = 未绑定或绑定值为 null） */
export function getBoundBottomDrawerSessionId(): string | null {
  return sidRef.value
}

/** 读取当前分区控制态（coordination 层 toggle 判断 isOpen 用）。返回 reactive 分区对象本身 */
export function getBottomDrawerControlState(): BottomDrawerControlState {
  return controlState.current.value
}

// ── per-session 分区状态（useSessionScopedState）──
/**
 * 新 session 的默认控制态。[HISTORICAL] 必须返回 reactive 容器——plain object 的 mutate
 * 不触发下游 computed 重算（useSessionScopedState 响应式契约，drawer/control.ts 同款教训）。
 */
function createDefaultControlState(): BottomDrawerControlState {
  return reactive({
    isOpen: false,
  })
}

const controlState = useSessionScopedState<BottomDrawerControlState>(
  sidRef,
  createDefaultControlState,
)

/**
 * 内部原语命名空间（coordination 层专用薄封装；业务代码用
 * openBottomDrawer / closeBottomDrawer / toggleBottomDrawer）。
 */
export const bottomDrawerControl = {
  /** 打开底抽屉（当前分区） */
  open(): void {
    controlState.current.value.isOpen = true
  },
  /** 关闭底抽屉（当前分区） */
  close(): void {
    controlState.current.value.isOpen = false
  },
  /** 切换开合（当前分区） */
  toggle(): void {
    const cur = controlState.current.value
    cur.isOpen = !cur.isOpen
  },
}

/**
 * 控制态视图：读当前分区字段（切 session 切分区，响应式自动跟随）。
 * 供 renderer 消费（底抽屉挂载点的 v-if / 布局开合态源）。
 */
export function useBottomDrawerControl(): {
  isOpen: ComputedRef<boolean>
  } {
  return {
    isOpen: computed(() => controlState.current.value.isOpen),
  }
}

/**
 * 清空 control 分区（测试隔离用；coordination._resetBottomDrawerForTest 组合调用）。
 * 生产代码禁止调用。
 */
export function _resetBottomDrawerControlForTest(): void {
  controlState._clearAllForTest()
}
