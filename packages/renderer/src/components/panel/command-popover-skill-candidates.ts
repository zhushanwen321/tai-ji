/**
 * CommandPopover skill-only 候选构建（多 skill 注入 u4，D1 数据源 + D2 已选禁选）。
 *
 * 从 CommandPopover.vue 拆出（script 行数约束，vue_rules_checker ≤300），
 * 与 command-popover-symbols.ts / CommandPopover.vue 内联 file 分支同模式：
 * 纯函数、零组件依赖，items computed 委托调用。
 *
 * 数据源（D1；ADR-0050 修订，skill-reload-nondestructive D6）：panel 与 landing 两态统一
 * taiji SkillRegistry 源——globalSkills ∪ projectSkills 合并，global 优先、project 补独有项
 * （与 slash landing 源优先级一致）。候选新鲜度由 config.skillCacheInvalidated 广播链驱动
 * （watcher → 重扫 → 广播 → useGlobalSkills/useProjectSkills 重拉），不依赖 pi reload 往返；
 * panel 态 projectSkills 的 cwd 由 Composer 按 session cwd 接线（sessionStore 投影）。
 * location 取 SkillInfo.sourcePath（SKILL.md 绝对路径，权威扫描产出）。
 * `__` 内部项过滤（isInternalSkillName）。
 * 已选禁选（D2）：selectedNames 命中的项标 selected，浮层显示「已选」并禁选。
 */
import type { SkillInfo } from '@taiji/shared'
import { isInternalSkillName } from '@/lib/internal-command-filter'

/** skill 候选项（CommandPopover items 的 skill 分支返回形状） */
interface SkillCandidate {
  id: string
  name: string
  displayName: string
  kind: string
  icon: string
  isSkill: boolean
  description?: string
  /** SKILL.md 绝对路径（select payload → insertSkillChip dataset），可得时带上 */
  location?: string
  /** 已插入过（selectedNames 命中）→「已选」禁选 */
  selected: boolean
}

/** pi skill 命令 name 剥前缀得裸 skill 名（'skill:xxx' / '/skill:xxx' / 'xxx' → 'xxx'）。
 *  slash 路（landing 态浮层仍列 /skill: 项）的显示名/已选比对消费此口径。 */
export function bareSkillCommandName(name: string): string {
  return name.replace(/^\//, '').replace(/^skill:/, '')
}

/** skill 候选源（CommandPopover props 的结构子集，直接透传） */
interface SkillCandidateSource {
  globalSkills?: SkillInfo[]
  projectSkills?: SkillInfo[]
  query?: string
  selectedSkillNames?: string[]
}

/** 构建 skill-only 候选项（taiji 源合并 + query 过滤 + 已选标记）。 */
export function buildSkillCandidates(source: SkillCandidateSource): SkillCandidate[] {
  const q = (source.query ?? '').trim().toLowerCase()
  const seen = new Set<string>()
  const candidates: Array<{ name: string; description?: string; location?: string }> = []
  const fromInfo = (skills: SkillInfo[]) =>
    skills
      .filter((s) => !isInternalSkillName(s.name))
      .filter((s) => !seen.has(s.name))
      .map((s) => {
        seen.add(s.name)
        return { name: s.name, description: s.description, location: s.sourcePath }
      })
  candidates.push(...fromInfo(source.globalSkills ?? []), ...fromInfo(source.projectSkills ?? []))
  const filtered = q ? candidates.filter((c) => c.name.toLowerCase().includes(q)) : candidates
  const selected = new Set(source.selectedSkillNames ?? [])
  return filtered.map((c) => ({
    id: `skill-${c.name}`,
    name: c.name,
    displayName: c.name,
    kind: 'skill',
    icon: 'star',
    isSkill: true,
    description: c.description,
    location: c.location,
    selected: selected.has(c.name),
  }))
}
