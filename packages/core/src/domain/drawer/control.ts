/**
 * drawer 控制态 —— per-session 分区（ADR-0053 / ADR-0049 Map 分区派）。
 *
 * 迁移自 renderer composables/features/useSideDrawer.ts 的控制态部分（W1，drawer 域向 core
 * 归位第一步）。core 保持 headless（零 pinia 依赖）：分区键不直接读 renderer panel store，
 * 而是模块级占位 + 显式绑定（bindDrawerSessionId），由 renderer 兼容层注入
 * `computed(() => usePanelStore().focusedSessionId)`（惰性 computed，首次求值 pinia 已 active）。
 *
 * 分层（C4 单向依赖）：本文件（control）= 纯控制态原语（isOpen/activeTab + 分区键），
 * 不感知 pendingOpen 守卫 / 瞬时参数 / 选中态（那是 coordination 与 selection 层职责）。
 * coordination → control → foundation/use-session-scoped-state；selection/<域> → control
 * （drawerSessionKey）；control 不 import coordination/selection（无环）。
 *
 * [display-containers §6.6 W0 状态还债] DrawerControlState 收窄为 { isOpen, activeTab }：
 * 选中态五字段迁出至 selection/ 各内容域分区（selectedSubagentId/enteredFrom → subagent、
 * selectedWorkflowName → workflow、selectedBackgroundTaskId → bashTask、selectedBtwVid → btw），
 * 瞬时参数（selectedCommandName/detailFilePath）迁 selection/transient.ts 按会话分区；
 * docked 死状态全链删除（display-containers §7.6）。复合谓词读取单一源 = selection/predicates.ts。
 *
 * 单实例（Q2=A 单例）：模块级单例（控制态物理只有一份），SideDrawer 单实例跟随 active panel。
 *
 * 迁移过渡期：renderer useSideDrawer.ts 为 re-export 兼容层，本文件为 SSOT。
 */
import { ref, computed, reactive } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useSessionScopedState } from '../../foundation/use-session-scoped-state'
import type { RightDrawerTab, DrawerControlState } from './types'

// ── 分区键占位 + 绑定（headless 不直接读 pinia）──
// boundSid 存绑定目标 ref（初始 null = 未绑定，模块级 API 按 null sid no-op 语义）。
// 必须显式注解变量类型：Vue 3.5 的 ref<T>/shallowRef<T> 条件类型在 T 本身是 Ref 类型时
// 返回 T（值本身）而非 Ref<T> 包装，裸 `ref<Ref<string|null>|null>(null)` 会让 boundSid
// 直接变成 Ref<string|null>|null，`.value` 链断裂。显式注解强制 Ref 包装。
// sidRef = boundSid.value?.value ?? null：boundSid.value 是响应式读（绑定时 sidRef 失效重算），
// 内层 .value 是绑定 ref 的响应式读（focusedSessionId 变化时 sidRef 跟随），两种变化都正确传播。
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：drawer 绑定 sid 单例 ref（12 类未覆盖）
const boundSid: Ref<Ref<string | null> | null> = ref(null)
const sidRef = computed<string | null>(() => boundSid.value?.value ?? null)

/**
 * drawer 域分区键（selection/ 各内容域分区共用同一键——五字段迁出后选中态分区与
 * 控制态分区同键不同表，切 session 同步换区）。只读暴露给 selection/<域> 工厂。
 */
export const drawerSessionKey: ComputedRef<string | null> = sidRef

/**
 * 绑定模块级分区键（幂等：同 ref 重复绑定不报错；新 ref 覆盖）。
 * renderer 兼容层模块顶层调用 bindDrawerSessionId(computed(() => usePanelStore().focusedSessionId))。
 * 绑定前（boundSid=null）模块级 API 按 null sid no-op（不抛错、不写 Map 分区）。
 */
export function bindDrawerSessionId(bound: Ref<string | null>): void {
  boundSid.value = bound
}

/** 读取当前绑定分区键（coordination 层守卫分发 / FR-9 清理用）。null = 未绑定或绑定值为 null */
export function getBoundSessionId(): string | null {
  return sidRef.value
}

/** 读取当前分区控制态（coordination 层 toggle 判断 isOpen 用）。返回 reactive 分区对象本身 */
export function getDrawerControlState(): DrawerControlState {
  return controlState.current.value
}

/**
 * 按 sid 读控制态分区（复合谓词 selection/predicates.ts 跨域读取用）。
 * updateFor 语义：已删 sid no-op（返回 undefined，不复活分区）；分区不存在时惰性建默认空分区。
 */
export function readDrawerControlFor<R>(sid: string, read: (s: DrawerControlState) => R): R | undefined {
  let out: R | undefined
  controlState.updateFor(sid, (s) => {
    out = read(s)
  })
  return out
}

// ── per-session 分区状态（useSessionScopedState）──
/**
 * 新 session 的默认控制态。[HISTORICAL] 必须返回 reactive 容器——plain object 的 mutate
 * 不触发下游 computed 重算，导致 sid 稳定时手动 open() 失效（drawer 打不开）。
 * 违反 useSessionScopedState 响应式契约曾导致 todo/goal 自动打开能开、手动点击打不开。
 *
 * 默认 activeTab = 'git'（display-containers §7.1：terminal 迁底抽屉后 git 是 L1 图标序首位
 * 且高频——「首开右抽屉呈现 git」由 u-w1-layout S10 断言）。
 */
function createDefaultControlState(): DrawerControlState {
  return reactive({
    isOpen: false,
    activeTab: 'git',
  })
}

const controlState = useSessionScopedState<DrawerControlState>(
  sidRef,
  createDefaultControlState,
)

/**
 * 内部原语命名空间（coordination 层专用，公开 API 之外的薄封装）。
 *
 * ⚠️ 直接调用会跳过瞬时参数写入（selectedCommandName/detailFilePath）与选中态写入
 * （selection/ 各内容域分区）——业务代码应使用 coordination 层的 openDrawerTab /
 * closeDrawer / toggleDrawer / setDrawerTab / openSubagent / openWorkflowInDrawer /
 * setBtwView / selectBackgroundTask（C2 契约）。
 *
 * drawerControl 现行职责：只写纯控制态（isOpen/activeTab）——瞬时参数与选中态不在此
 * 写入，它们是 coordination 层职责（opts 归 coordination.openDrawerTab，选中态归
 * selection/<域>），control 保持纯控制态（C4 单向依赖防循环）。
 */
export const drawerControl = {
  /** 打开抽屉（当前分区），可指定初始 tab */
  open(tab?: RightDrawerTab): void {
    const cur = controlState.current.value
    if (tab) cur.activeTab = tab
    cur.isOpen = true
  },
  /** 关闭抽屉 */
  close(): void {
    controlState.current.value.isOpen = false
  },
  /** 切换 tab（抽屉关闭时仅改 activeTab，不自动打开） */
  setTab(tab: RightDrawerTab): void {
    controlState.current.value.activeTab = tab
  },
}

/**
 * 控制态视图：读当前分区字段（切 session 切分区，响应式自动跟随）。
 * 供新代码直接消费（renderer 兼容层 useSideDrawer() 返回形状由此派生）。
 * 选中态/瞬时参数不在本视图（各回各的内容域，见 selection/）。
 */
export function useDrawerControl(): {
  isOpen: ComputedRef<boolean>
  activeTab: ComputedRef<RightDrawerTab>
  } {
  return {
    isOpen: computed(() => controlState.current.value.isOpen),
    activeTab: computed(() => controlState.current.value.activeTab),
  }
}

/**
 * 清空 control 分区（测试隔离用；coordination._resetDrawerForTest 组合调用）。
 * 生产代码禁止调用。
 */
export function _resetDrawerControlForTest(): void {
  controlState._clearAllForTest()
}
