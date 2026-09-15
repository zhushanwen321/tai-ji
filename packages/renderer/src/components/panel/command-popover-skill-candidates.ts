/**
 * CommandPopover skill-only 候选构建（多 skill 注入 u4，D1 数据源 + D2 已选禁选）。
 *
 * 从 CommandPopover.vue 拆出（script 行数约束，vue_rules_checker ≤300），
 * 与 command-popover-symbols.ts / CommandPopover.vue 内联 file 分支同模式：
 * 纯函数、零组件依赖，items computed 委托调用。
 *
 * 数据源（D1）：
 * - panel 态：commandStore（pi get_commands 真源）过滤 source 为 skill 的项。name 带
 *   `skill:` 前缀，剥前缀得裸名——与私有标记 `<taiji-skill/>` 的 name、runtime 权威映射
 *   key 同口径（D4）。`__` 内部项过滤（isInternalSkillName）。
 * - landing 态（无 pi 真源）：globalSkills + projectSkills 合并，global 优先、project
 *   补独有项（与既有 slash landing 源优先级一致）。
 * - 已选禁选（D2）：selectedNames 命中的项标 selected，浮层显示「已选」并禁选。
 */
import type { SkillInfo } from '@taiji/shared'
import { isInternalSkillName } from '@/lib/internal-command-filter'

/** panel 候选源结构窄化（commandStore SessionCommand 的 skill 分支所需字段） */
interface SkillCommandLike {
  name: string
  kind: string
  description?: string
  sourceInfo?: { path?: string }
}

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

/** pi skill 命令 name 剥前缀得裸 skill 名（'skill:xxx' / '/skill:xxx' / 'xxx' → 'xxx'）。 */
export function bareSkillCommandName(name: string): string {
  return name.replace(/^\//, '').replace(/^skill:/, '')
}

/** skill 候选源（CommandPopover props 的结构子集，直接透传） */
interface SkillCandidateSource {
  sessionId?: string
  globalSkills?: SkillInfo[]
  projectSkills?: SkillInfo[]
  query?: string
  selectedSkillNames?: string[]
}

/** 构建 skill-only 候选项（按 variant 分数据源 + query 过滤 + 已选标记）。 */
export function buildSkillCandidates(
  variant: 'panel' | 'landing',
  source: SkillCandidateSource,
  commands: SkillCommandLike[],
): SkillCandidate[] {
  const q = (source.query ?? '').trim().toLowerCase()
  const candidates: Array<{ name: string; description?: string; location?: string }> = []
  if (variant === 'landing') {
    const seen = new Set<string>()
    const fromInfo = (skills: SkillInfo[]) =>
      skills
        .filter((s) => !isInternalSkillName(s.name))
        .filter((s) => !seen.has(s.name))
        .map((s) => {
          seen.add(s.name)
          return { name: s.name, description: s.description, location: s.sourcePath }
        })
    candidates.push(...fromInfo(source.globalSkills ?? []), ...fromInfo(source.projectSkills ?? []))
  } else {
    commands
      .filter((c) => c.kind === 'skill')
      .forEach((c) => {
        const name = bareSkillCommandName(c.name)
        if (isInternalSkillName(name)) return
        candidates.push({ name, description: c.description, location: c.sourceInfo?.path })
      })
  }
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
