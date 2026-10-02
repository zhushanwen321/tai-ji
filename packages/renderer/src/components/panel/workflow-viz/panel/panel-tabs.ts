/**
 * panel-tabs.ts —— workflow overlay 实况面板的一级 tab 模型纯逻辑
 *（workflow-visualization 设计 §3.1-2：一级 tab 首个固定为 workflow（不可关），phase/
 * agent tab 动态增删；tab 关闭后激活左侧相邻 tab，无左侧相邻则回 workflow 固定 tab）。
 *
 * tab 状态是组件内本地 state（随面板挂载初始化）——D11③「切换 run = 关全部 run 级 tab
 * 回 workflow 固定 tab」由 overlay 容器按 runId 重挂载面板（:key）构造性达成，本模块
 * 只承载单 run 内的增删与激活裁决。纯函数零副作用。
 */

/** 一级 tab 种类（workflow 固定 / phase 钻取 / agent 钻取）。 */
export type WorkflowTabKind = 'workflow' | 'phase' | 'agent'

/** 单个一级 tab。key 规约：固定 tab = 'workflow'；phase tab = `phase:<名>`；agent tab = `agent:<callId>`。 */
export interface WorkflowLiveTab { // oe-exempt:20261002:framework:workflow-viz 分段视图模型/派生契约类型——类型契约先行、单实现常态
  key: string
  kind: WorkflowTabKind
  /** tab 标题（phase 名 / agent 名）。 */
  title: string
  /** phase tab 归属 phase 名（kind === 'phase'）。 */
  phase?: string
  /** agent tab 归属 call（kind === 'agent'；WorkflowAgentCall.id = trace step 序号）。 */
  callId?: number
}

/** 固定 tab key（不可关；L2TabBar builtin 项不渲染 close 按钮）。 */
export const WORKFLOW_FIXED_TAB_KEY = 'workflow'

/** tab key 工厂（增删/激活查找共用同一构造，防双处拼接漂移）。 */
export function phaseTabKey(phase: string): string {
  return `phase:${phase}`
}

export function agentTabKey(callId: number): string {
  return `agent:${callId}`
}

/**
 * 打开 tab：已存在则仅激活（不重复追加），否则追加到尾部并激活。返回新数组
 *（不可变更新——tabs 是组件 ref 状态）。
 */
export function openLiveTab(
  tabs: readonly WorkflowLiveTab[],
  tab: WorkflowLiveTab,
): { tabs: WorkflowLiveTab[]; activeKey: string } {
  if (tabs.some((t) => t.key === tab.key)) {
    return { tabs: [...tabs], activeKey: tab.key }
  }
  return { tabs: [...tabs, tab], activeKey: tab.key }
}

/**
 * 关闭 tab：固定 tab 不可关（原样返回）；关闭当前激活 tab 时激活其左侧相邻，无左侧
 * 相邻（首个动态 tab）则回 workflow 固定 tab；关闭非激活 tab 激活键不变。
 *
 * `tabs` 只含动态 tab（phase/agent）——workflow 固定 tab 由组件隐式渲染在 tab 栏首位、
 * 不参与增删（L2TabBar 的 builtin 项形态）。
 */
export function closeLiveTab(
  tabs: readonly WorkflowLiveTab[],
  activeKey: string,
  closingKey: string,
): { tabs: WorkflowLiveTab[]; activeKey: string } {
  if (closingKey === WORKFLOW_FIXED_TAB_KEY) return { tabs: [...tabs], activeKey }
  const idx = tabs.findIndex((t) => t.key === closingKey)
  if (idx < 0) return { tabs: [...tabs], activeKey }
  const nextTabs = tabs.filter((t) => t.key !== closingKey)
  if (activeKey !== closingKey) return { tabs: nextTabs, activeKey }
  // 左侧相邻 = 动态数组中的前一个；首个动态 tab 关闭后无左侧相邻 → 回 workflow 固定 tab
  return { tabs: nextTabs, activeKey: idx > 0 ? tabs[idx - 1].key : WORKFLOW_FIXED_TAB_KEY }
}
