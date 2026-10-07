/**
 * workflow-viz overlay 控制器（workflow-visualization U6）——模块级单例状态 + 数据接线。
 *
 * 职责（设计 §3.3-D1/D10/D11）：
 * - overlay 开关：**开合态 SSOT 已迁 core/domain/overlay（u-w1-core，唯一权威）**——
 * 本模块不再持有 overlayOpen / overlayCurrent 模块级 ref（已退役），开关/当前内容经
 * core 的 openOverlay / closeOverlay / getOverlayControlState 读写；本模块保留 DAG 缓存
 * （overlayDag / overlayDagError，设计 §7.1「DAG 缓存留 renderer」）。全局单例语义不变
 * （开新 run 切换内容，SearchModal 范式；split mode 下盖全屏、绑定发起 pane 的 session
 * ——D11⑤）。关闭只切 open 标志：事件流缓存归 workflowStore（D11② overlay 关闭不清）、
 * DAG 侧 runtime 按 runId 缓存（仅成功），本模块不持第二份数缓存（open 时无条件重拉，
 * 代价 = 一次 RPC ack 延迟）。
 * - 入口改向桥接（D1）：core coordination.openWorkflow 改向为开 overlay——core headless
 *   不感知 renderer，经 bindWorkflowOverlayOpener/bindWorkflowRunLookup 注入（本模块
 *   顶层装配；绑定动作在模块加载时执行，函数体首次执行在用户交互时刻，pinia 已 active）。
 *   托盘行传 runId（零改动）、对话流 block 传 (scriptName, slug, sessionId)——反查动作
 *   （先 runId 精确匹配、后 (scriptName, slug) 匹配取最新；slug 缺失回落 name → 最新）
 *   在 findRun 单处执行，与 drawer 侧 WorkflowTab 的兼收解析口径逐字对齐（记录末条 =
 *   最新）。
 * - DAG 通道接线（§3.1-5）：session.getWorkflowDag 拉取 + 两通道错误归一（结构化领域
 *   回执 code 透传 / RPC 通道错误 → 'channel'）+ 在途丢弃（settle 时活跃组合已切走则
 *   丢弃，对齐 store D11①）+ parse_failed 重试（失败不缓存故可重试）。
 * - session 删除关 overlay（D11⑤）：closeWorkflowVizOverlayForSession 供
 *   useSidebar.deleteSession 编排链经 SessionCleanupHooks.closeWorkflowOverlay 调用。
 * - overlay 一级 tab（scheduler 整合，2026-10-06 用户裁决）：overlayTab 展示态（开合态/
 *   内容 SSOT 在 core，tab 是本模块的展示维度）+ openSchedulerTab / setOverlayTab 写入口
 *   + 关闭任意通道复位 watch + SCHEDULER_MODAL_VIEW_ID 单源（ViewHost 分区键）。
 */
import { ref, watch } from 'vue'
import type { WorkflowDag, WorkflowRunRecord } from '@taiji/shared'
import {
  bindWorkflowOverlayOpener,
  bindWorkflowRunLookup,
  openWorkflowInDrawer,
} from '@taiji/core/domain/drawer'
import {
  closeOverlay,
  getOverlayControlState,
  openOverlay,
  openSchedulerOverlay,
} from '@taiji/core/domain/overlay'
import { session as sessionApi } from '@/api'
import { usePanelStore } from '@/stores/panel'
import { useWorkflowStore } from '@/stores/workflow'
import { normalizeWorkflowScriptName } from '../run-name'
import type { WorkflowVizDagLoadError } from './types'

// ── 模块级状态（DAG 缓存留 renderer；overlay 开合态 SSOT 在 core/domain/overlay）──────

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，已登记 §4 ⑧ 2026-10-02）：overlay DAG 态槽
/** DAG 蓝图（成功臂；null + dagError=null = 解析中）。 */
export const overlayDag = ref<WorkflowDag | null>(null)
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，已登记 §4 ⑧ 2026-10-02）：overlay DAG 错误槽
/** DAG 不可得归一错误（null = 通道正常）。 */
export const overlayDagError = ref<WorkflowVizDagLoadError | null>(null)

// ── overlay 一级 tab（scheduler 整合进浮层，2026-10-06 用户裁决）─────────────────────

/** 浮层一级 tab：'runs' = DAG + 实况 dock（现状 body）；'scheduler' = 定时任务面板（ViewHost 消费插件树）。 */
export type OverlayTab = 'runs' | 'scheduler'

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，补登 §4 ⑧ 2026-10-06）：overlay 一级 tab 槽
/** 浮层一级 tab 展示态（开合态/内容 SSOT 在 core，tab 是 renderer 展示维度——壳经 Host 受控透传）。 */
export const overlayTab = ref<OverlayTab>('runs')

/**
 * 定时任务面板 viewId：单源 = extension-protocol SCHEDULER_MODAL_VIEW_ID（插件
 * views.update 推树与本 tab ViewHost 消费跨包共用，历史命名 modal-<pluginId>-<modalId>
 * 原值保留）；此处 re-export 保持既有导入路径（壳/测试）不变。
 */
export { SCHEDULER_MODAL_VIEW_ID } from '@zhushanwen/extension-protocol'

// overlay 关闭（任意通道：Esc 编排器直关 core 开合态 / 壳 close / 会话删除级联）→ tab 复位
// 'runs'；下次打开由入口显式置位（openWorkflowVizOverlay→'runs' / openSchedulerTab→'scheduler'）。
// flush sync：复位锚在「关闭发生」时刻而非渲染 tick——状态级不变量（关 = tab 归位），无渲染顺序依赖。
watch(
  () => getOverlayControlState().isOpen,
  (open) => {
    if (!open) overlayTab.value = 'runs'
  },
  { flush: 'sync' },
)

// ── run 反查（opener 与 chips lookup 共用的单处实现）──────────────────────────

/**
 * run 反查（D1 配套小改的执行体）：
 * ① nameOrRunId 先按 runId 精确匹配（托盘行路径，零改动直开）；
 * ② 否则按 scriptName 匹配——slug 有值时要求 record.slug 等值（区分并发 run，slug 的
 *    设计本职 shared/workflow.ts:160），slug 缺失/空串回落「name → 最新 run」现状语义；
 * ③ 命中多条（slug 碰撞极端形态）取记录末条（= 最新，与 WorkflowTab.vue 的
 *    byName[byName.length - 1] 逐字同口径），照常打开不阻塞。
 */
function findRun(sessionId: string, nameOrRunId: string, slug?: string): WorkflowRunRecord | undefined {
  if (!sessionId || !nameOrRunId) return undefined
  const records = useWorkflowStore().getRecordsBySession(sessionId)
  const byRunId = records.find((w) => w.runId === nameOrRunId)
  if (byRunId) return byRunId
  // 名字形态归一（L4 走查发现）：主 agent 调 workflow 工具常传脚本路径（/abs/path/x.js），
  // record.scriptName 存 basename（x）——严格等值恒 miss。归一单源在 run-name.ts（与
  // drawer WorkflowTab 共用，两入口判据同源）；slug 判据不变。
  const want = normalizeWorkflowScriptName(nameOrRunId)
  const byName = records.filter(
    (w) => normalizeWorkflowScriptName(w.scriptName) === want && (slug === undefined || slug === '' || w.slug === slug),
  )
  return byName.length > 0 ? byName[byName.length - 1] : undefined
}

// ── 开关 + DAG 拉取 ──────────────────────────────────────────────────────────

/** 打开 overlay（入口改向与编程打开的唯一入口）：换内容当前 run + tab 归位 runs + 重置 DAG 态 + 拉取。 */
export function openWorkflowVizOverlay(sessionId: string, runId: string): void {
  if (!sessionId || !runId) return
  openOverlay({ kind: 'workflow', payload: { sessionId, runId } })
  overlayTab.value = 'runs'
  overlayDag.value = null
  overlayDagError.value = null
  void loadDag(sessionId, runId)
}

/**
 * 打开浮层定时任务 tab（scheduler 直达入口）：core 换内容 scheduler kind + tab 置 scheduler。
 * 换入的会话可能无 run 数据（shell 侧「运行」tab 按 run 缺省禁用）。
 */
export function openSchedulerTab(sessionId: string): void {
  if (!sessionId) return
  openSchedulerOverlay(sessionId)
  overlayTab.value = 'scheduler'
}

/** tab 切换（壳 tab 条点击接线）：只写 renderer tab 展示维度，不改 core 开合态/内容。 */
export function setOverlayTab(tab: OverlayTab): void {
  overlayTab.value = tab
}

/** 关闭 overlay（三通道统一出口）：仅切标志——缓存清理由 store 生命周期承担（D11②）。 */
export function closeWorkflowVizOverlay(): void {
  closeOverlay()
}

/** session 删除编排（SessionCleanupHooks.closeWorkflowOverlay）：删除的是发起 session 时关
 *  （workflow 与 scheduler 两类内容同判据——载荷都持发起 sessionId，§7.4 级联同语义）。 */
export function closeWorkflowVizOverlayForSession(sessionId: string): void {
  const cur = getOverlayControlState().current
  if (
    (cur?.kind === 'workflow' || cur?.kind === 'scheduler')
    && cur.payload.sessionId === sessionId
  ) closeWorkflowVizOverlay()
}

/**
 * DAG 拉取执行体。错误二分归一（overlay/types.ts WorkflowVizDagLoadError）：
 * 结构化领域回执 code 透传（parse_failed/no_script_source/record_not_found/path_rejected）；
 * RPC 通道错误（reject）归一为 'channel'。在途丢弃：settle 时活跃组合已切走/关闭 → 丢弃
 * 写入（对齐 workflowStore D11①；本模块关闭不清 dag 态，重开同 run 会被 open 的重置覆盖）。
 */
async function loadDag(sessionId: string, runId: string): Promise<void> {
  try {
    const reply = await sessionApi.getWorkflowDag(sessionId, runId)
    if (!isActive(sessionId, runId)) return
    if ('dag' in reply) {
      overlayDag.value = reply.dag
      overlayDagError.value = null
    } else {
      overlayDagError.value = { code: reply.code, message: reply.message }
    }
  } catch (e) {
    if (!isActive(sessionId, runId)) return
    const msg = e instanceof Error ? e.message : String(e)
    overlayDagError.value = { code: 'channel', message: msg }
  }
}

/** 在途丢弃判据（当前活跃组合 = 本拉取的组合）。 */
function isActive(sessionId: string, runId: string): boolean {
  const cur = getOverlayControlState().current
  return cur !== null && cur.kind === 'workflow'
    && cur.payload.sessionId === sessionId && cur.payload.runId === runId
}

/** parse_failed 重试（失败不缓存故可重试；重拉当前 run）。 */
export function retryDagParse(): void {
  const cur = getOverlayControlState().current
  if (cur === null || cur.kind !== 'workflow') return
  overlayDag.value = null
  overlayDagError.value = null
  void loadDag(cur.payload.sessionId, cur.payload.runId)
}

// ── core 桥接装配（模块顶层，bindDrawerSessionId 同款先例）────────────────────

bindWorkflowOverlayOpener((nameOrRunId, slug, sessionId) => {
  // 发起 pane 的 session：block 场景精确传（D11⑤）；缺省回落焦点 pane。
  const sid = sessionId || usePanelStore().focusedSessionId
  if (!sid) return
  const run = findRun(sid, nameOrRunId, slug)
  if (run) {
    openWorkflowVizOverlay(sid, run.runId)
    return
  }
  // 反查未命中的兜底归宿 = 显式 drawer 语义（现状行为：drawer workflow tab 显空态或
  // 全部）——点击不丢反馈；不经改向后的 openWorkflow（重入本 opener 无意义且已 no-op）。
  openWorkflowInDrawer(nameOrRunId)
})

bindWorkflowRunLookup((sessionId, scriptName, slug) => findRun(sessionId, scriptName, slug))
