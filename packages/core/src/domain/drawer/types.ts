/**
 * drawer 域类型 —— @taiji/core 平台无关内核（headless）的 drawer 域类型归位。
 *
 * 定位：p3-strangler-domains::drawer 的 W1 类型迁移，承接架构文档 §10.2
 * （旧层 → core/domain/* 映射：renderer composables/features/useSideDrawer.ts 的
 * 抽屉 tab 枚举 / OpenDrawerOptions / DrawerControlState 迁移至此）。
 *
 * 迁移过渡期（旧 SideDrawer 未删）：renderer 侧 useSideDrawer.ts 改为 re-export 兼容层，
 * 本文件为 SSOT；旧调用方（SideDrawer.vue / useDrawerWidgetBuffers 等）经兼容层 import
 * 类型，零改动。
 *
 * 零 DOM 约束：core tsconfig 未配置 DOM lib，本文件为纯类型定义，不引入 DOM/浏览器 API 类型。
 */

/** 右抽屉 tab 枚举（display-containers §7.1 终态 8 员）：git（变更集）/ doc（命令文档）/ detail（文件详情）/ subagent（子代理只读对话流）/ bashTask（后台命令详情）/ plan（计划文档）/ btw（旁路线）/ workflow（回落载体，L1 常驻，主入口浮层）。
 * workflow 保留作回落载体（ADR-0104 回落链类型层不断裂——display-containers 走查裁决）；
 * terminal/browser 不入本枚举（terminal 迁底抽屉、browser 走浮层，§7.6）——本枚举是右抽屉
 * tab 的唯一类型，'terminal'/'browser' 赋给任何右抽屉 tab 位即编译错（注册表终态由类型层强制）。
 * 无打开参数（OpenDrawerOptions 零加员）；自动打开经 ADR-0053 per-session pendingOpen
 * 语义（renderer 接线，core 只持 tab 枚举成员）。 */
export type RightDrawerTab = 'git' | 'doc' | 'detail' | 'subagent' | 'bashTask' | 'plan' | 'btw' | 'workflow'

/** drawer open 的可选参数：打开时指定要展示的 slash 命令名（Doc tab）/ 文件路径（Detail tab） */
export interface OpenDrawerOptions { // oe-exempt:20261003:framework:类型契约先行——容器契约层声明，D1 下游单元即为消费面
  /** Doc tab 当前展示的命令名（如 '/commit'），CommandDocPanel 据此 + commandStore/skills 解析文档 */
  commandName?: string
  /** Detail tab 打开后立即展示的文件路径（变更集卡点击文件行时传入，强制 diff 模式） */
  filePath?: string
}

/** per-session 控制态（ADR-0053 Map 分区）。
 * [display-containers §6.6①/③ W0 还债] 收窄为容器控制态两字段：选中态五字段
 * （selectedSubagentId/enteredFrom/selectedWorkflowName/selectedBackgroundTaskId/selectedBtwVid）
 * 迁出至 selection/ 各内容域分区（各回各的内容域）；死状态 docked 全链删除（§7.6）。 */
export interface DrawerControlState { // oe-exempt:20261003:framework:类型契约先行——容器契约层声明，D1 下游单元即为消费面
  isOpen: boolean
  activeTab: RightDrawerTab
}

/** openSubagent 的参数（D3/D4：drawer SubagentTab 复用 MessageStream，virtualId 由调用方算好传入） */
export interface OpenSubagentOptions { // oe-exempt:20261003:framework:类型契约先行——容器契约层声明，D1 下游单元即为消费面
  /** subagent 虚拟 id（subagentVirtualId/agentCallVirtualId 算好的字符串），core 不感知 id 结构，原样存为 selectedSubagentId */
  virtualId: string
  /** 进入来源：chat subagent 块='chat'；workflow tab 点 agent call='workflow' */
  enteredFrom: 'chat' | 'workflow'
}
