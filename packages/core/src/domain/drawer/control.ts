/**
 * drawer 控制态 —— per-session 分区（ADR-0053 / ADR-0049 Map 分区派）。
 *
 * 迁移自 renderer composables/features/useSideDrawer.ts 的控制态部分（W1，drawer 域向 core
 * 归位第一步）。core 保持 headless（零 pinia 依赖）：分区键不直接读 renderer panel store，
 * 而是模块级占位 + 显式绑定（bindDrawerSessionId），由 renderer 兼容层注入
 * `computed(() => usePanelStore().focusedSessionId)`（惰性 computed，首次求值 pinia 已 active）。
 *
 * 分层（C4 单向依赖）：本文件（control）= 纯控制态原语，不感知 pendingOpen 守卫 / 瞬时参数
 * （那些是 coordination 层职责）。coordination → control → foundation/use-session-scoped-state，
 * 禁止 control → coordination 循环。
 *
 * 单实例（Q2=A 单例）：模块级单例（控制态物理只有一份），SideDrawer 单实例跟随 active panel。
 *
 * 迁移过渡期：renderer useSideDrawer.ts 为 re-export 兼容层，本文件为 SSOT。
 */
import { ref, computed, reactive } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useSessionScopedState } from '../../foundation/use-session-scoped-state'
import type { SideDrawerTab, DrawerControlState } from './types'

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

// ── per-session 分区状态（useSessionScopedState）──
/**
 * 新 session 的默认控制态。[HISTORICAL] 必须返回 reactive 容器——plain object 的 mutate
 * 不触发下游 computed 重算，导致 sid 稳定时手动 open() 失效（drawer 打不开）。
 * 违反 useSessionScopedState 响应式契约曾导致 todo/goal 自动打开能开、手动点击打不开。
 */
function createDefaultControlState(): DrawerControlState {
  return reactive({
    isOpen: false,
    activeTab: 'terminal',
    docked: false,
    selectedSubagentId: null,
    selectedWorkflowName: null,
    enteredFrom: null,
  })
}

const controlState = useSessionScopedState<DrawerControlState>(
  sidRef,
  createDefaultControlState,
)

/**
 * 内部原语命名空间（coordination 层专用，公开 API 之外的薄封装）。
 *
 * ⚠️ 直接调用会跳过瞬时参数写入（selectedCommandName/detailFilePath/browserUrl）——
 * 业务代码应使用 coordination 层的 openDrawerTab / closeDrawer / toggleDrawer /
 * setDrawerTab / toggleDrawerDock（C2 契约）。
 *
 * 与 renderer 原 openInternal 的差异：瞬时参数（selectedCommandName/detailFilePath/browserUrl）
 * 不在此写入——它们是 coordination 层职责（opts 归 coordination.openDrawerTab），
 * control 保持纯控制态（C4 单向依赖防循环）。
 */
export const drawerControl = {
  /** 打开抽屉（当前分区），可指定初始 tab */
  open(tab?: SideDrawerTab): void {
    const cur = controlState.current.value
    if (tab) cur.activeTab = tab
    cur.isOpen = true
  },
  /** 关闭抽屉（钉住态亦可手动关闭） */
  close(): void {
    controlState.current.value.isOpen = false
  },
  /** 切换 tab（抽屉关闭时仅改 activeTab，不自动打开） */
  setTab(tab: SideDrawerTab): void {
    controlState.current.value.activeTab = tab
  },
  /** 切换钉住态（仅当前分区） */
  toggleDock(): void {
    controlState.current.value.docked = !controlState.current.value.docked
  },
  /** 设置 subagent tab 视图：切到 subagent tab + 记录选中的 subagent 虚拟 id + 进入来源 + 打开 drawer（D4）。
   *  virtualId 由调用方算好（subagentVirtualId/agentCallVirtualId），core 不感知 id 结构。 */
  setSubagentView(virtualId: string, enteredFrom: 'chat' | 'workflow'): void {
    const cur = controlState.current.value
    cur.activeTab = 'subagent'
    cur.selectedSubagentId = virtualId
    cur.enteredFrom = enteredFrom
    cur.isOpen = true
  },
  /** 设置 workflow tab 视图：切到 workflow tab + 记录 workflow 名 + 打开 drawer */
  setWorkflowView(workflowName: string): void {
    const cur = controlState.current.value
    cur.activeTab = 'workflow'
    cur.selectedWorkflowName = workflowName
    cur.isOpen = true
  },
}

/**
 * 控制态视图：读当前分区字段（切 session 切分区，响应式自动跟随）。
 * 供新代码直接消费（renderer 兼容层 useSideDrawer() 返回形状由此派生）。
 */
export function useDrawerControl(): {
  isOpen: ComputedRef<boolean>
  activeTab: ComputedRef<SideDrawerTab>
  docked: ComputedRef<boolean>
  selectedSubagentId: ComputedRef<string | null>
  selectedWorkflowName: ComputedRef<string | null>
  enteredFrom: ComputedRef<'chat' | 'workflow' | null>
  } {
  return {
    isOpen: computed(() => controlState.current.value.isOpen),
    activeTab: computed(() => controlState.current.value.activeTab),
    docked: computed(() => controlState.current.value.docked),
    selectedSubagentId: computed(() => controlState.current.value.selectedSubagentId),
    selectedWorkflowName: computed(() => controlState.current.value.selectedWorkflowName),
    enteredFrom: computed(() => controlState.current.value.enteredFrom),
  }
}

/**
 * 清空 control 分区（测试隔离用；coordination._resetDrawerForTest 组合调用）。
 * 生产代码禁止调用。
 */
export function _resetDrawerControlForTest(): void {
  controlState._clearAllForTest()
}

// ── [B9 agentcall LRU 联动] panel 枚举豁免查询源（memory-leak-remediation §3.3-B9）──

/** 全部 panel 的 focusedSessionId 列表源（split 恢复时多 panel 全查；单 panel 恒 1 元素） */
type ViewedPanelsSource = Ref<readonly (string | null)[]>

/**
 * panel 枚举绑定（headless 模式，对齐 bindDrawerSessionId）：panel 枚举是 renderer
 * 数据（panel store），core 不 import renderer——renderer 装配模块（composables/
 * features/chat/agentcall-lru-linkage.ts）注册 computed(() => usePanelStore().panels
 * .map(p => p.sessionId))。惰性求值（首次读发生在 LRU 驱逐时，pinia 已 active）。
 * 幂等：同 ref 重复绑定无副作用；新 ref 覆盖（测试隔离重绑定用）。
 * 未绑定时 getViewedVids 返回空集（驱逐无豁免，安全默认）。
 */
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：panel 枚举绑定单例 ref
const boundViewedPanels: Ref<ViewedPanelsSource | null> = ref(null)

/** 绑定 panel 枚举源（renderer 装配层调用；重绑定覆盖旧源） */
export function bindViewedVidPanels(source: ViewedPanelsSource): void {
  boundViewedPanels.value = source
}

/**
 * [B9] 当前正在查看的 subagent/agentcall 虚拟 id 集（LRU 联动驱逐的豁免源）。
 *
 * 组合链（查询源钉死 panel 枚举，R2 S1）：逐 panel → focusedSessionId → 该 sid 的
 * drawer 分区 → 当前选中 vid。三分量同时满足才计入豁免：
 * - isOpen：关闭 drawer 后焦点切走，分区应可驱逐（A6「关闭 drawer 后再切走，分区释放」）；
 * - activeTab === 'subagent'：drawer 开在其他 tab 时 SubagentTab 未挂载，不算正在查看
 *   （切回 subagent tab 会重挂 + immediate watch 重拉快照，白屏自愈路径不破坏）；
 * - selectedSubagentId 非空：实际选中的虚拟 id。
 *
 * [禁止] drawer 分区全枚举：曾开过 drawer 的 session 焦点切走后分区保留（isOpen/
 * selectedSubagentId 不被 LRU 清），全枚举会把全部历史 agentcall 分区永久豁免，
 * B9 对重度用户静默失效。分区读取经 updateFor（updater 零写入，纯读；分区不存在时
 * 惰性建默认空分区，量级 = panel 数 × 几十字节，接受）。
 */
export function getViewedVids(): Set<string> {
  const viewed = new Set<string>()
  const panels = boundViewedPanels.value?.value ?? []
  for (const sid of panels) {
    if (!sid) continue
    controlState.updateFor(sid, (p) => {
      if (p.isOpen && p.activeTab === 'subagent' && p.selectedSubagentId) {
        viewed.add(p.selectedSubagentId)
      }
    })
  }
  return viewed
}
