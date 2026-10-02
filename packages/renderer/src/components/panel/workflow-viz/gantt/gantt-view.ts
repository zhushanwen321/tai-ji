/**
 * Gantt 展示几何纯函数（workflow-visualization U4 gantt/ 展示组件的构建者白盒层）。
 *
 * 输入 = u2 冻结的 WorkflowGanttSegments（分段派生单处在 u5 gantt-segments.ts，
 * 本模块不复制分段派生语义）；输出 = 渲染几何（时间域 / 行分组 / 退避间隙）。
 * 纯函数零 DOM——fixture 单测对象。
 */
import type { WorkflowGanttAttemptSegment, WorkflowGanttSegments } from '@taiji/shared'

/** 单个 call 行（taskIndex 一行；多代际段同行、段间空隙保留——中断/崩溃空隙可见）。 */
export interface GanttRow { // oe-exempt:20261002:framework:workflow-viz 分段视图模型/派生契约类型——类型契约先行、单实现常态
  taskIndex: number
  /** 该 call 的全部分段（已按 generation/attempt 升序）。 */
  segments: WorkflowGanttAttemptSegment[]
  /**
   * 退避琥珀段：同一 call 同一代际内相邻 attempt 段的间隙（宽 = backoffMs——
   * attempt N 失败终点 = retrying.ts − backoffMs、attempt N+1 起点 = retrying.ts，
   * 间隙即退避等待）。跨代际间隙是中断/崩溃空隙，不产退避段。
   */
  backoffGaps: { generation: number; startTs: number; endTs: number }[]
}

/** Gantt 时间域（epoch ms）。 */
export interface GanttDomain { // oe-exempt:20261002:framework:workflow-viz 分段视图模型/派生契约类型——类型契约先行、单实现常态
  startTs: number
  endTs: number
}

/**
 * 分组 call 行：按 taskIndex 聚合、行内按 generation/attempt 升序、推导同代际
 * 相邻段间隙为退避段。行序 = taskIndex 升序。
 */
export function buildGanttRows(segments: WorkflowGanttAttemptSegment[]): GanttRow[] {
  const byTask = new Map<number, WorkflowGanttAttemptSegment[]>()
  for (const seg of segments) {
    const list = byTask.get(seg.taskIndex) ?? []
    list.push(seg)
    byTask.set(seg.taskIndex, list)
  }
  const rows: GanttRow[] = []
  for (const taskIndex of [...byTask.keys()].sort((a, b) => a - b)) {
    const segs = (byTask.get(taskIndex) ?? []).sort(
      (a, b) => a.generation - b.generation || a.attempt - b.attempt,
    )
    const backoffGaps: GanttRow['backoffGaps'] = []
    for (let i = 1; i < segs.length; i++) {
      const prev = segs[i - 1]
      const cur = segs[i]
      // 仅同代际相邻段之间的间隙是退避等待；跨代际间隙 = 中断/崩溃空隙，保留可见
      if (prev.generation === cur.generation && cur.startTs > prev.endTs) {
        backoffGaps.push({ generation: prev.generation, startTs: prev.endTs, endTs: cur.startTs })
      }
    }
    rows.push({ taskIndex, segments: segs, backoffGaps })
  }
  return rows
}

/** 域最小宽度（全段零宽时兜 1s，防除零与零宽渲染）。 */
const DOMAIN_MIN_SPAN_MS = 1000
/** 域两侧边距比例（域宽的 2%，让首末段不贴边）。 */
const DOMAIN_PAD_RATIO = 0.02
/** 百分比基数（0~100 映射）。 */
const PCT_BASE = 100

/**
 * 计算时间域：全部 attempt 段与 phase 段的起止并集，外扩 2% 边距；游标 ts 参与
 * 域（运行中游标可能超出最后事件）。分段全空且无游标 → null（调用方出空态）。
 */
export function computeGanttDomain(
  segments: Pick<WorkflowGanttSegments, 'attemptSegments' | 'phaseBands'>,
  cursorTs?: number,
): GanttDomain | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const seg of segments.attemptSegments) {
    min = Math.min(min, seg.startTs)
    max = Math.max(max, seg.endTs)
  }
  for (const band of segments.phaseBands) {
    min = Math.min(min, band.startTs)
    max = Math.max(max, band.endTs)
  }
  if (cursorTs !== undefined) {
    min = Math.min(min, cursorTs)
    max = Math.max(max, cursorTs)
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null
  if (max - min < DOMAIN_MIN_SPAN_MS) max = min + DOMAIN_MIN_SPAN_MS
  const pad = (max - min) * DOMAIN_PAD_RATIO
  return { startTs: min - pad, endTs: max + pad }
}

/** 时间 → 百分比（0~100，域内线性映射、越界钳制）。 */
export function toPercent(ts: number, domain: GanttDomain): number {
  const ratio = ((ts - domain.startTs) / (domain.endTs - domain.startTs)) * PCT_BASE
  return Math.min(PCT_BASE, Math.max(0, ratio))
}
