// project-chips.ts —— NewTaskSheet 项目 chip 数据聚合（remote-use-mobile-v2 §6.12）。
//
// 排序源显式钉定（§6.12 采用段字面）：客户端按 SessionSummary（projectId, lastActiveAt）
// 分组取 max(lastActiveAt) 聚合——**禁用 Project.lastUsedAt 作活跃信号**（R6.2 用户裁决
// 2026-10-11：该字段仅 addProject 新建时写入一次、此后不可变，按它排得到的是创建序，
// 排序去更新它直接违反 R6.2）。项目名来自 project.load RPC 清单（Project 无路径字段，
// 设计 §7.2 已登记）；cwd 派生 = 该项目最近一个会话（组内 max lastActiveAt）的
// SessionSummary.cwd（摘要含 cwd，shared/src/session.ts ✅ 亲读）。
//
// 纯函数单点（单测表驱动：聚合/排序/cwd 派生/默认项目兜底/无会话项目殿后）。
import type { Project, SessionSummary } from '@taiji/shared'

/** 未归类 session 的默认项目兜底聚合 id（D14 语义，shared/src/project.ts 头注同值锚定） */
export const DEFAULT_PROJECT_ID = 'proj-default'

/** 项目 chip 视图模型（NewTaskSheet 横滑呈现面） */
export interface ProjectChip {  // oe-exempt:20261026:framework:项目 chip 聚合视图模型契约（NewTaskSheet 消费边界）
  projectId: string
  /** 项目名（默认项目 name 空 → 呈现层用「默认项目」兜底文案，本函数不填文案） */
  name: string
  /** 组内全部会话 max(lastActiveAt)——活跃排序键（R6.2：与 Project.lastUsedAt 无关） */
  lastActiveAt: number
  /** 该项目最近一个会话的 cwd（新会话 cwd 派生源）；无会话 = undefined（手输兜底） */
  cwd?: string
  /** 组内会话数（呈现层计数标注） */
  sessionCount: number
}

/**
 * 项目 chip 聚合：project 清单（project.load reply）× 会话摘要（config.sessions）按
 * projectId 分组（无 projectId 归默认项目）取 max(lastActiveAt)，活跃降序排 chip 序；
 * 无会话项目（清单有、无任何关联会话）lastActiveAt=0 稳定殿后（有会话组之后，组间按
 * 清单序保持稳定）。cwd 取组内最近会话。
 */
export function aggregateProjectChips(projects: Project[], sessions: SessionSummary[]): ProjectChip[] {
  // btw 旁路线会话（surface==='btw'）不进主列表聚合（shared session.ts surface 语义）
  const sidebarSessions = sessions.filter((s) => s.surface !== 'btw')
  const groups = new Map<string, { lastActiveAt: number; cwd?: string; count: number }>()
  for (const s of sidebarSessions) {
    const pid = s.projectId ?? DEFAULT_PROJECT_ID
    const g = groups.get(pid)
    if (!g) {
      groups.set(pid, { lastActiveAt: s.lastActiveAt, cwd: s.cwd, count: 1 })
      continue
    }
    // 严格更晚才换 cwd：同刻并列保持先到者（排序稳定性，不引入额外 tiebreak）
    if (s.lastActiveAt > g.lastActiveAt) {
      g.lastActiveAt = s.lastActiveAt
      g.cwd = s.cwd
    }
    g.count += 1
  }

  const nameOf = new Map(projects.map((p) => [p.id, p.name]))
  const chips: ProjectChip[] = []
  for (const [projectId, g] of groups) {
    chips.push({
      projectId,
      name: nameOf.get(projectId) ?? '',
      lastActiveAt: g.lastActiveAt,
      ...(g.cwd !== undefined ? { cwd: g.cwd } : {}),
      sessionCount: g.count,
    })
  }
  // 清单中存在但无任何关联会话的项目：殿后占位（name 有值供呈现；无 cwd = 手输兜底）
  const seen = new Set(chips.map((c) => c.projectId))
  for (const p of projects) {
    if (!seen.has(p.id)) {
      chips.push({ projectId: p.id, name: p.name, lastActiveAt: 0, sessionCount: 0 })
    }
  }
  // 活跃降序；无会话组（lastActiveAt=0）沉底，组间保持插入序（Array.sort 稳定序，ES2019+）
  return chips.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}
