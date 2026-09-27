/**
 * drawer 域类型 —— @taiji/core 平台无关内核（headless）的 drawer 域类型归位。
 *
 * 定位：p3-strangler-domains::drawer 的 W1 类型迁移，承接架构文档 §10.2
 * （旧层 → core/domain/* 映射：renderer composables/features/useSideDrawer.ts 的
 * SideDrawerTab / OpenDrawerOptions / DrawerControlState 迁移至此）。
 *
 * 迁移过渡期（旧 SideDrawer 未删）：renderer 侧 useSideDrawer.ts 改为 re-export 兼容层，
 * 本文件为 SSOT；旧调用方（SideDrawer.vue / useDrawerWidgetBuffers 等）经兼容层 import
 * 类型，零改动。
 *
 * 零 DOM 约束：core tsconfig 未配置 DOM lib，本文件为纯类型定义，不引入 DOM/浏览器 API 类型。
 */

/** SideDrawer 的 tab 枚举：terminal（终端）/ browser（浏览器）/ git（变更集）/ doc（命令文档）/ detail（文件详情）/ subagent（子代理只读对话流）/ workflow（workflow agent call 列表）。
 * [P4 s5 drawer-widget-removal] tasks 成员已随 tasks 域删除移除（PluginViewContainer 承接）。
 * subagent/workflow 一级 tab（2026-08-14 subagent-workflow-drawer-tab）：collapsed only chat 块点击 → openSubagent/openWorkflow 开对应 tab。
 * subagent tab = 嵌套只读 MessageStream（复用主对话流渲染，D3）；workflow tab = agent call 列表（点 call 切 subagent tab）。
 * bashTask tab（2026-09 background-task-sidebar-view D5①）：后台命令详情（命令全文/元信息/输出尾部跟随/终止）。
 * plan tab（2026-09 plan 模式重设计 u1-drawer-tab）：计划产物（agent 按 skill 流程产出的多文档审阅面）。
 * 无打开参数（OpenDrawerOptions 零加员，bashTask 同款先例）；自动打开经 ADR-0053 per-session
 * pendingOpen 语义（renderer 接线，core 只持 tab 枚举成员）。 */
export type SideDrawerTab = 'terminal' | 'browser' | 'git' | 'doc' | 'detail' | 'subagent' | 'workflow' | 'bashTask' | 'plan'

/** drawer open 的可选参数：打开时指定要展示的 slash 命令名（Doc tab）/ 文件路径（Detail tab） */
export interface OpenDrawerOptions {
  /** Doc tab 当前展示的命令名（如 '/commit'），CommandDocPanel 据此 + commandStore/skills 解析文档 */
  commandName?: string
  /** Detail tab 打开后立即展示的文件路径（变更集卡点击文件行时传入，强制 diff 模式） */
  filePath?: string
}

/** per-session 控制态（ADR-0053 Map 分区） */
export interface DrawerControlState {
  isOpen: boolean
  activeTab: SideDrawerTab
  docked: boolean
  /** subagent tab 当前展示的 subagent 虚拟 id（`subagent:<mainSid>:<subId>` 或 `agentcall:<acsId>`，由调用方算好传入）；null=未选中（subagent tab 显空态） */
  selectedSubagentId: string | null
  /** workflow tab 当前展示的 workflow 名；null=未选中（workflow tab 显空态） */
  selectedWorkflowName: string | null
  /** subagent tab 的进入来源：'chat'=从 chat subagent 块进入（无返回按钮）；'workflow'=从 workflow tab 点 agent call 进入（显←返回按钮）；null=未在 subagent tab */
  enteredFrom: 'chat' | 'workflow' | null
  /** bashTask tab 当前展示的后台任务 id（registry taskId，background-task-sidebar-view D5①）；undefined=未选中（bashTask tab 显空态）。
   *  可选成员：默认控制态（core control.ts createDefaultControlState）无需初始化即可满足本接口。 */
  selectedBackgroundTaskId?: string
}

/** openSubagent 的参数（D3/D4：drawer SubagentTab 复用 MessageStream，virtualId 由调用方算好传入） */
export interface OpenSubagentOptions {
  /** subagent 虚拟 id（subagentVirtualId/agentCallVirtualId 算好的字符串），core 不感知 id 结构，原样存为 selectedSubagentId */
  virtualId: string
  /** 进入来源：chat subagent 块='chat'；workflow tab 点 agent call='workflow' */
  enteredFrom: 'chat' | 'workflow'
}
