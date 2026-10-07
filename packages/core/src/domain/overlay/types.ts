/**
 * overlay（浮层统一壳）域类型 —— display-containers §7.1/§6.5 开合态契约
 * （u-foundation：类型契约不实装行为，实装归 u-w1-core 的 state/coordination）。
 *
 * 语义（§7.1/§6.5）：统一壳挂 AppShell 层，开关态放 core（本域），单例 `{ kind, payload }` 换内容
 * （开新内容替换旧内容；多实例 tab 条 W4 才加维度）。**SSOT 迁移**：renderer 既有
 * workflow-viz-overlay.ts 的 overlayOpen / overlayCurrent 模块级 ref 随 u-w1-core 同 PR 退役
 * （DAG 缓存留 renderer）——开合态只保留 core 一份，禁止 core/renderer 双权威并存。
 * workflow 浮层载荷与迁移前 overlayCurrent `{ sessionId, runId }` 同构（SSOT 迁移对账锚）。
 */
import type { OverlayContentKind } from '@taiji/shared'

/** 浮层内容类型（§7.2 浮层条目 + scheduler 整合（2026-10-06 用户裁决）：
 * browser（网页）/ workflow（工作流图）/ scheduler（定时任务面板））。
 * 词表单源 = @taiji/shared OverlayContentKind（browser:overlay-state IPC payload
 * 契约四方共用），本域派生别名保持既有导出名与消费面不变。 */
export type OverlayKind = OverlayContentKind

/** browser 浮层载荷（openBrowser(url, sessionId) URL 注入链重建，W2 接线）。
 * sessionId = 发起会话（链接所在会话）：view 池按 session 键控（BrowserPane 订阅标识）、
 * 会话删除级联判定（closeBrowserOverlayForSession「仅发起会话被删才关」）、主进程
 * 显示收口谓词事实源（browser:overlay-state 的 sessionId）三处消费——故载荷必须携带
 * （u-foundation 契约 {url} 扩展，D1 下游消费面按 §7.4 发起会话语义补全）。 */
export interface BrowserOverlayPayload { // oe-exempt:20261003:framework:类型契约先行——容器契约层声明，D1 下游单元即为消费面
  url: string
  /** 发起会话 id（点击链接所在会话；BrowserPane 的 view 键 + 级联/谓词判定锚） */
  sessionId: string
}

/** workflow 浮层载荷（与 renderer workflow-viz-overlay.ts 迁移前 overlayCurrent 字段同构，SSOT 迁移对账锚） */
export interface WorkflowOverlayPayload { // oe-exempt:20261003:framework:类型契约先行——容器契约层声明，D1 下游单元即为消费面
  sessionId: string
  runId: string
}

/** scheduler 浮层载荷（定时任务面板整合进 workflow 浮层成一级 tab，2026-10-06 用户裁决）：
 * sessionId = 面板数据所属会话（scheduler-manager 插件树按 per-session 分区持续推送，
 * 不依赖旧 plugin modal 开着；浮层内 ViewHost 按 (sessionId, viewId) 消费同一分区）。 */
export interface SchedulerOverlayPayload { // oe-exempt:20261006:framework:类型契约先行——容器契约层声明，overlay 一级 tab UI 即为消费面
  sessionId: string
}

/** 浮层当前内容（判别联合，kind/payload 换内容） */
export type OverlayContent =
  | { kind: 'browser'; payload: BrowserOverlayPayload }
  | { kind: 'workflow'; payload: WorkflowOverlayPayload }
  | { kind: 'scheduler'; payload: SchedulerOverlayPayload }

/** 浮层开合态（单例）：isOpen=false 时 current 置 null（关浮层复位，§7.4 发起会话删除级联同语义） */
export interface OverlayControlState { // oe-exempt:20261003:framework:类型契约先行——容器契约层声明，D1 下游单元即为消费面
  isOpen: boolean
  current: OverlayContent | null
}

// ── 模态表面聚合旗标组（§6.7 登记表列）──
// 类型契约归口本域（u-w1-agg「编译依赖：旗标类型」经此消费；聚合模块实装落 renderer
// composables/features/app/modal-surface-registry/，本 core 域只持类型，保持 headless）。
// 命名注记：§6.7 原记 'yields⌘W'——⌘（U+2318）非 JS 标识符合法字符，字段名 ASCII 化 yieldsCmdW。

/** shieldsView 判定分档（§6.7 [MANDATORY] 分档）：
 * - 'unconditional'：全屏阻塞面（遮罩盖满视口）= 无条件隐藏 view；
 * - 'intersecting'：非全屏面（横幅/弹出层，锚定局部）= 与 view 显示矩形几何相交才隐藏；
 * - 'none'：不参与 view 遮蔽。 */
export type ShieldsViewMode = 'none' | 'unconditional' | 'intersecting'

/** 模态表面聚合成员旗标组（§6.7 登记表：yieldsEsc / 'yields⌘W' / shieldsView——双键让位族 R4 拆分） */
export interface ModalSurfaceFlags { // oe-exempt:20261003:framework:类型契约先行——容器契约层声明，D1 下游单元即为消费面
  /** Esc 让位族：成员打开 → 栈序编排器 Esc 不动作（Esc 先服务视觉最外层的模态） */
  yieldsEsc: boolean
  /** ⌘W 让位族（§6.7 记作 'yields⌘W'）：模态族 ✓（有未提交输入）/ 弹出层族 ✗（弹层瞬态、reka 不以 ⌘W dismiss，让位即死键） */
  yieldsCmdW: boolean
  /** view 遮蔽族（§5.1 规则 6② 读同一旗标，判定分档见 ShieldsViewMode） */
  shieldsView: ShieldsViewMode
}
