/**
 * workflow-viz overlay 控制器（workflow-visualization U6）——模块级单例状态 + 数据接线。
 *
 * 职责（设计 §3.3-D1/D10/D11）：
 * - overlay 开关：全局单例（开新 run 切换内容，SearchModal 范式；split mode 下盖全屏、
 *   绑定发起 pane 的 session——D11⑤）。关闭只切 open 标志：事件流缓存归 workflowStore
 *   （D11② overlay 关闭不清）、DAG 侧 runtime 按 runId 缓存（仅成功），本模块不持第二份
 *   数据缓存（open 时无条件重拉，代价 = 一次 RPC ack 延迟）。
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
 */
import { ref } from 'vue'
import type { WorkflowDag, WorkflowRunRecord } from '@taiji/shared'
import {
  bindWorkflowOverlayOpener,
  bindWorkflowRunLookup,
  openWorkflowInDrawer,
} from '@taiji/core/domain/drawer'
import { session as sessionApi } from '@/api'
import { usePanelStore } from '@/stores/panel'
import { useWorkflowStore } from '@/stores/workflow'
import type { WorkflowVizDagLoadError } from './types'

// ── 模块级单例状态（overlay 全局单例，D8；导出供 Host 容器消费）───────────────

// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：overlay 开关
/** overlay 开关（Host 壳 open prop 源）。 */
export const overlayOpen = ref(false)
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：overlay 当前 run 换指针
/** 当前查看的 run（null = 未打开）。开新 run 换指即「切换内容」。 */
export const overlayCurrent = ref<{ sessionId: string; runId: string } | null>(null)
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：overlay DAG 态槽
/** DAG 蓝图（成功臂；null + dagError=null = 解析中）。 */
export const overlayDag = ref<WorkflowDag | null>(null)
// taste:allow-no-data-owner W24-EX-B（模块级单例 UI 瞬态，12 类未覆盖存量，登记草稿）：overlay DAG 错误槽
/** DAG 不可得归一错误（null = 通道正常）。 */
export const overlayDagError = ref<WorkflowVizDagLoadError | null>(null)

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
  const byName = records.filter((w) => w.scriptName === nameOrRunId && (slug === undefined || slug === '' || w.slug === slug))
  return byName.length > 0 ? byName[byName.length - 1] : undefined
}

// ── 开关 + DAG 拉取 ──────────────────────────────────────────────────────────

/** 打开 overlay（入口改向与编程打开的唯一入口）：换指当前 run + 重置 DAG 态 + 拉取。 */
export function openWorkflowVizOverlay(sessionId: string, runId: string): void {
  if (!sessionId || !runId) return
  overlayCurrent.value = { sessionId, runId }
  overlayOpen.value = true
  overlayDag.value = null
  overlayDagError.value = null
  void loadDag(sessionId, runId)
}

/** 关闭 overlay（三通道统一出口）：仅切标志——缓存清理由 store 生命周期承担（D11②）。 */
export function closeWorkflowVizOverlay(): void {
  overlayOpen.value = false
}

/** session 删除编排（SessionCleanupHooks.closeWorkflowOverlay）：删除的是发起 session 时关。 */
export function closeWorkflowVizOverlayForSession(sessionId: string): void {
  if (overlayCurrent.value?.sessionId === sessionId) closeWorkflowVizOverlay()
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
  const cur = overlayCurrent.value
  return cur !== null && cur.sessionId === sessionId && cur.runId === runId
}

/** parse_failed 重试（失败不缓存故可重试；重拉当前 run）。 */
export function retryDagParse(): void {
  const cur = overlayCurrent.value
  if (cur === null) return
  overlayDag.value = null
  overlayDagError.value = null
  void loadDag(cur.sessionId, cur.runId)
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
