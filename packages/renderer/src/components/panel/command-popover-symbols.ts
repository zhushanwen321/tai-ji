/**
 * CommandPopover 四符号候选派生纯函数（composer-symbol-system U2a）。
 *
 * 定位：# session / @ subagent 两路浮层候选的数据整形（过滤/排序/副行文案），
 * 从 CommandPopover.vue 拆出（照 command-popover-source.ts 先例）——纯函数无副作用，
 * 可直接单测；CommandPopover 只负责消费 store 数据 + 渲染。
 *
 * 数据源（G2/G3）：
 * - session 路：sessionStore（sidebar 同款 groups/list，跨 cwd 全量）
 * - subagent 路：subagentStore per-session 分区（ADR-0049 Map 分区）+ 固定尾部「新建」项
 */
import type { SessionSummary, SkillInfo, SubagentRecord } from '@taiji/shared'
import { isInternalSkillName, isInternalSlashName } from '@/lib/internal-command-filter'
import { bareSkillCommandName } from './command-popover-skill-candidates'

/** 「＋ 新建 subagent」固定项 id（CommandPopover 选中上抛 subagentId/slug 空串） */
const NEW_SUBAGENT_ITEM_ID = '__new_subagent__'

/** 浮层统一候选项视图（file/slash 路在 CommandPopover 内联派生，session/subagent 路在此派生） */
interface SymbolCandidate {
  id: string
  /** 主行文本（session=label / subagent=slug / 新建项=文案） */
  name: string
  kind: string
  /** SLASH_ICON_COMPONENTS key（session→folder / subagent→Bot） */
  icon: string
  /** 两行展示的副行文本（session=cwd · age / subagent=agent · status / 新建项=无） */
  subText?: string
  /** session 路透传（onCmdSelect → insertSessionChip） */
  sessionId?: string
  label?: string
  /** subagent 路透传（onCmdSelect → insertSubagentChip；新建项两字段空串） */
  subagentId?: string
  slug?: string
}

/** 1 分钟 / 1 小时 / 1 天 毫秒数（formatAge 分桶阈值） */
const ONE_MINUTE = 60_000
const ONE_HOUR = 3_600_000
const ONE_DAY = 86_400_000

/**
 * 相对时间 age 格式化（照 TUI hash-provider 的 age 简化实现）：xxm / xxh / xxd。
 * <1m → 'now'；≥1d → 'Nd' 封顶（更久也用天，浮层场景无需月/年粒度）。
 */
export function formatAge(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  if (diff < ONE_MINUTE) return 'now'
  if (diff < ONE_HOUR) return `${Math.floor(diff / ONE_MINUTE)}m`
  if (diff < ONE_DAY) return `${Math.floor(diff / ONE_HOUR)}h`
  return `${Math.floor(diff / ONE_DAY)}d`
}

/**
 * session 候选派生（G2）：全量 session（跨 cwd）按 lastActiveAt 降序，
 * query 按 label/id 子串过滤（大小写不敏感——id 是 uuid 子串也要能命中），
 * hidden session 排除（与 sidebar 展示口径一致）。
 * landing/panel 统一「有数据就列」（D1 删 hasSessionId 门：sessionStore 启动即常驻，
 * landing 也直接列；D7：不做 landing 特殊过滤，跨 cwd 全量口径不变）。
 */
export function buildSessionCandidates(
  sessions: SessionSummary[],
  query: string,
  now = Date.now(),
): SymbolCandidate[] {
  const q = query.trim().toLowerCase()
  return sessions
    .filter((s) => !s.hidden)
    .filter((s) => {
      if (!q) return true
      return s.label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
    })
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((s) => ({
      id: `session-${s.id}`,
      name: s.label || s.id,
      kind: 'session',
      icon: 'folder',
      subText: `${s.cwd} · ${formatAge(s.lastActiveAt, now)}`,
      sessionId: s.id,
      label: s.label || s.id,
    }))
}

/**
 * subagent 候选派生（G3）：当前 session 分区的 records，query 按 slug/agent 过滤，
 * 固定尾部「＋ 新建 subagent」项（subagentId/slug 空串，选中语义由上层定）。
 * landing 态（hasSessionId=false）返回空——@ 范围限当前 session（D3 拍板），无 session 无数据源。
 */
export function buildSubagentCandidates(
  records: SubagentRecord[],
  query: string,
  hasSessionId: boolean,
  newSubagentLabel: string,
): SymbolCandidate[] {
  if (!hasSessionId) return []
  const q = query.trim().toLowerCase()
  const items: SymbolCandidate[] = records
    .filter((r) => {
      if (!q) return true
      return r.slug.toLowerCase().includes(q) || r.agent.toLowerCase().includes(q)
    })
    .map((r) => ({
      id: `subagent-${r.subagentId}`,
      name: r.slug || r.subagentId,
      kind: 'subagent',
      icon: 'subagents',
      subText: `${r.agent} · ${r.status}`,
      subagentId: r.subagentId,
      slug: r.slug,
    }))
  items.push({
    id: NEW_SUBAGENT_ITEM_ID,
    name: newSubagentLabel,
    kind: 'subagent',
    icon: 'subagents',
    subagentId: '',
    slug: '',
  })
  return items
}

// ── slash 路（行首命令浮层）候选派生（自 CommandPopover.vue 拆出，≤300 行规范）──────────

/** slash 名归一化：补 / 前缀（pi 返回 'goal' → '/goal'，含路由前缀供 onSelect → pi 路由）。 */
export function normalizedSlashName(name: string): string {
  return name.startsWith('/') ? name : `/${name}`
}

/** skill 显示名：剥离 `skill:` / `/skill:` / `/` 前缀，只留 skill 名（icon 已表示类型）。
 *  复用 bareSkillCommandName（口径单点，与 skill-only 入口 / selected 比对同源）——pi 的 skill
 *  命令名是**裸** `skill:<name>`（无前导 /，见 pi dist/core/agent-session.js 的
 *  `name: \`skill:${skill.name}\``），只剥 `/skill:` 会漏配 ⇒ 浮层显示名带前缀。
 *  [HISTORICAL] RC-A-5/RC-B-11：此前仅剥 `/skill:` 与 `/`，裸 `skill:x` 原样返回，
 *  与设计 §3.1 场景 2 期望（显示 code-review-graph）及模板「skill 只显名字」注释不符。 */
export function skillDisplayName(name: string): string {
  return bareSkillCommandName(name)
}

interface SlashCandidateInput {
  id: string
  name: string
  kind: string
  icon?: string
  description?: string
  /** skill 项：SKILL.md 绝对路径（location = SkillInfo.sourcePath，registry 源 skill 项自带，
 *  可得时带上；onCmdSelect 按 isSkill 分流后透传 insertSkillChip 落 chip dataset——设计 D3） */
  location?: string
}

/**
 * slash 项是否 skill 形态（单点判据）：kind === 'skill'（SessionCommand.kind = pi source，
 * pi 真源 skill 命令的 source 恒 'skill'）或归一化名带 /skill: 前缀（pi 的 skill 命令名是
 * 裸 `skill:<name>`，归一化补 / 后命中）。同时驱动：buildSlashCandidates 的 selected 比对/
 * onSelect 分流/displayName 剥前缀（isSkill 局部量）与 buildPanelSlashCandidates 的 pi 真源
 * skill 项剔除（ADR-0050 二次修订换源保留——pi 真源 skill 命令是 reload 才刷新的滞后快照，
 * 剔除后由 registry 源 skill 项补入）。
 */
function isSkillSlashItem(name: string, kind?: string): boolean {
  return kind === 'skill' || normalizedSlashName(name).startsWith('/skill:')
}

/**
 * slash 路候选（行首命令浮层）：query 过滤（子串匹配）+ CmdItem 组装。
 * skill 命令去 /skill: 前缀显名（icon 已表示类型）；displayName 仅用于模板，onSelect 传完整
 * name；声明侧无 icon（schema v2 无 icon 字段）——iconKeyForCommand 按 name/source 推断
 * （builtin 命中 / skill→star / extension→terminal）。
 *
 * `selectedSkillNames`（多 skill 注入 D2 已选去重，S-2）：已插入的 skill 名集合，命中项标
 * `selected` → CommandPopover 渲染「已选」且 onSelect 早退。此前只有 skill-only 入口打该标记，
 * slash 路（`+` 菜单「命令」入口 / 行首浮层）不打 ⇒ 同一 skill 可插两次、runtime 注入两遍
 * SKILL.md 全文。比对键与 skill 通路同口径：剥 `/skill:` / `/` 前缀的裸 skill 名。
 *
 * `isSkill` 判据（isSkillSlashItem 单点）同时驱动 selected 比对、onSelect 分流
 * （insertSkillChip）与 displayName 剥前缀——提成局部量后一处判定三处消费。此前 displayName
 * 只看 `c.kind === 'skill'`：kind 非 skill 但名字带 `/skill:` 的项会被判为 skill（裸名比对 +
 * 走 skill chip），显示却仍带 `/skill:` 前缀（最终复审 N-4）。当前产线不可达（pi 的 source 恒
 * `'skill'`、landing 侧显式写 `kind:'skill'`），提同源只为消除潜在不一致。
 */
export function buildSlashCandidates(
  all: SlashCandidateInput[],
  query: string | undefined,
  iconKeyForCommand: (name: string, kind: string) => string,
  selectedSkillNames?: readonly string[],
): Array<{
  id: string
  name: string
  displayName: string
  kind: string
  icon: string
  isSkill: boolean
  description?: string
  location?: string
  /** skill 项：已插入过（selectedSkillNames 按裸名命中）→「已选」禁选；非 skill 项恒 undefined */
  selected?: boolean
  dirPath: undefined
}> {
  const q = (query ?? '').trim().toLowerCase()
  const selectedSkills = new Set(selectedSkillNames ?? [])
  const filtered = q ? all.filter((c) => normalizedSlashName(c.name).toLowerCase().includes(q)) : all
  return filtered.map((c) => {
    const name = normalizedSlashName(c.name)
    const isSkill = isSkillSlashItem(c.name, c.kind)
    return {
      id: c.id,
      name,
      displayName: isSkill ? skillDisplayName(c.name) : name,
      kind: c.kind,
      icon: c.icon ?? iconKeyForCommand(c.name, c.kind),
      isSkill,
      description: c.description,
      location: c.location,
      selected: isSkill ? selectedSkills.has(bareSkillCommandName(name)) : undefined,
      dirPath: undefined,
    }
  })
}

/**
 * registry 源 SkillInfo[] → slash 项（/skill:<name> 归一化）追加（两态共用追加函数）：
 * 跳过 base 已有同名（seen 集合）与 `__` 内部 skill，global 优先、project 补独有。
 * D3：location 取 SkillInfo.sourcePath（权威扫描产出，可得时带上）。
 */
function appendRegistrySkillItems(
  base: ReadonlyArray<SlashCandidateInput>,
  globalSkills: SkillInfo[],
  projectSkills: SkillInfo[],
): SlashCandidateInput[] {
  const seen = new Set<string>()
  base.forEach((c) => seen.add(normalizedSlashName(c.name)))
  const mapSkillInfo = (skills: SkillInfo[]) =>
    skills
      .filter((s) => !isInternalSkillName(s.name))
      .filter((s) => !seen.has(`/skill:${s.name}`))
      .map((s) => {
        seen.add(`/skill:${s.name}`)
        return {
          id: `skill-${s.name}`,
          name: `/skill:${s.name}`,
          kind: 'skill',
          icon: 'star',
          description: s.description,
          location: s.sourcePath,
        }
      })
  return [...mapSkillInfo(globalSkills), ...mapSkillInfo(projectSkills)]
}

/**
 * panel 态 slash 候选组装（自 CommandPopover.vue 拆出，≤300 行规范）：
 * compact 固定头部 + merged 过滤内部命令与 pi 真源 skill 项 + registry 源 skill 项追加。
 *
 * skill 项换源保留（ADR-0050 二次修订，推翻 0.10.1 首版的「过滤 skill 项」）：pi 真源的
 * `skill:xxx` 命令是 reload 才刷新的滞后快照（skill-reload D7 否决形态），仍剔除；skill
 * 候选一律换 taiji registry 源补入（appendRegistrySkillItems，与 landing 单列形态同构）。
 * 行首 `/` 与行中 `/` skill 段双入口共存——跨入口防双插由 selectedSkillNames 已选标记
 * （S-2，buildSlashCandidates 对 slash 路 skill 项同样生效）承担，不依赖入口裁剪。
 * slash 命令族 compact + merged 语义不变。
 */
export function buildPanelSlashCandidates(
  merged: ReadonlyArray<SlashCandidateInput>,
  compactCmd: SlashCandidateInput,
  globalSkills: SkillInfo[],
  projectSkills: SkillInfo[],
): Array<SlashCandidateInput> {
  const commands = merged
    .filter((c) => !isInternalSlashName(c.name))
    .filter((c) => !isSkillSlashItem(c.name, c.kind))
  return [
    compactCmd,
    ...commands,
    ...appendRegistrySkillItems(commands, globalSkills, projectSkills),
  ]
}

/**
 * landing 态 slash 候选组装（自 CommandPopover.vue 拆出，≤300 行规范）：
 * merged 声明源 + registry 源 skill 项追加（appendRegistrySkillItems 两态共用）。
 * 优先级：merged 源已在 seen，全局次之（globalSkills），项目最后（projectSkills 补独有项）。
 */
export function buildLandingSlashCandidates(
  merged: ReadonlyArray<SlashCandidateInput>,
  globalSkills: SkillInfo[],
  projectSkills: SkillInfo[],
): Array<SlashCandidateInput> {
  return [...merged, ...appendRegistrySkillItems(merged, globalSkills, projectSkills)]
}
