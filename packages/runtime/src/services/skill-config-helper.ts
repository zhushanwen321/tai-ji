/**
 * Skill 加载 / CRUD helper（从 config-service.ts 抽出，控 max-lines 500）。
 *
 * 职责：扫描已加载 skill（强制目录 ∪ discovery.json.skillDirs，按 ADR §1.1 优先级
 * 合并去重）+ skill 文件读写（deprecated 向后兼容）+ skill 扫描委托。强制目录靠桥接层
 * 重定向注入 pi 原生扫描；可选目录靠 discovery→settings 投影 + argv 注入。
 *
 * 抽出原因：config-service.ts 超 ESLint max-lines(500)。本模块含 skill 相关方法，
 * 移到本模块后 ConfigService 仅保留单行委托，行为 / 签名 / import 路径零变化
 *（复用 worktree-config-helper 的 accessors 注入模式，依赖经 configStore / projectRoot 参数注入）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SkillInfo, ScannedSkillInfo } from '@taiji/shared'
import type { IConfigStore } from './ports/config.js'
import { expandHome } from '../utils/path-utils.js'
import { scanSkills as scanSkillsImpl, loadSkillFromDir } from './scanners/skill-scanner.js'
import {
  resolveGlobalSkillDirs,
  resolveProjectSkillDirs,
} from './skill-dirs.js'
import { getConfigDir } from '../infra/pi/pi-paths.js'

/**
 * 扫描已加载 skill：强制目录（§1.1 层 1-2）∪ discovery.json.skillDirs（层 3）。
 * 按 ADR §1.1 优先级合并去重，填 effective（最高优先那条）+ sources（多来源 badge 链）。
 * 强制目录靠桥接层重定向注入 pi 原生扫描；可选目录靠 discovery→settings 投影 + argv 注入。
 *
 * 纯函数：configStore / projectRoot 经参数注入（原 ConfigService.loadSkills 逐字搬迁）。
 */
export function loadSkills(configStore: IConfigStore, projectRoot: string): SkillInfo[] {
  // 目录发现 SSOT（skill-dirs.ts）：scanner 与 watcher 共用同一份逻辑，
  // 从结构上保证 watch 范围 = scan 范围（修复 EMFILE 事故的 watch 整个 cwd 问题）。
  // 相对路径（.taiji/skills + discovery 相对路径）按 projectRoot resolve 成绝对路径。
  const orderedDirs = [
    ...resolveGlobalSkillDirs(configStore, getConfigDir()),
    ...resolveProjectSkillDirs(projectRoot, configStore),
  ]

  // name → 按 priority 收集的所有来源（用于合并去重 + sources badge 链）
  const byName = new Map<string, Array<{ dir: string; scanned: ScannedSkillInfo }>>()

  for (const dir of orderedDirs) {
    const expanded = expandHome(dir)
    if (!existsSync(expanded)) continue
    // discovery 目录可能含多个 skill 子目录，强制目录同理——用 loadSkillFromDir 处理单目录（含 SKILL.md），
    // 但外部目录（~/.agents/skills 等）是「含多个 skill 子目录的容器」，需遍历子目录。
    // 复用 skill-scanner 的 forEachScannedDir 语义：对容器目录遍历子目录找 SKILL.md。
    collectSkillsFromDir(dir, byName)
  }

  // 合并去重：每个 name 取最高优先来源为 effective，其余进 sources badge 链
  const results: SkillInfo[] = []
  for (const [, entries] of byName) {
    const primary = entries[0] // 数组按优先级顺序，第一个为最高优先
    const scanned = primary.scanned
    const sources = entries.length > 1
      ? entries.map(e => ({ source: e.scanned.sourceType, sourcePath: e.scanned.sourcePath }))
      : undefined
    results.push({
      id: scanned.id,
      name: scanned.name,
      description: scanned.description,
      enabled: true, // ADR §5：目录在 = 启用，恒 true
      source: scanned.sourceType,
      triggers: scanned.triggers,
      argumentHint: scanned.argumentHint,
      sourcePath: scanned.sourcePath,
      content: scanned.content,
      fileSize: scanned.fileSize,
      tools: scanned.tools,
      effective: true, // 最高优先来源标生效
      sources,
    })
  }
  return results
}

/**
 * 从单个目录收集 skill。dir 可能是：
 * - 含 SKILL.md 的单 skill 目录（强制目录的典型）→ loadSkillFromDir
 * - 含多个 skill 子目录的容器（~/.agents/skills 等）→ 遍历子目录
 */
function collectSkillsFromDir(dir: string, byName: Map<string, Array<{ dir: string; scanned: ScannedSkillInfo }>>): void {
  const expanded = expandHome(dir)
  // 先尝试 dir 本身含 SKILL.md（单 skill 目录）
  const direct = loadSkillFromDir(dir)
  if (direct) {
    pushSkillSource(byName, dir, direct)
    return
  }
  // 否则当作容器，遍历子目录
  if (!existsSync(expanded)) return
  try {
    const names = readdirSync(expanded)
    for (const name of names) {
      const childDir = join(expanded, name)
      try {
        if (!statSync(childDir).isDirectory()) continue
      } catch { continue }
      const childScanned = loadSkillFromDir(join(dir, name))
      if (childScanned) pushSkillSource(byName, join(dir, name), childScanned)
    }
  // eslint-disable-next-line taste/no-silent-catch -- 容器不可读则跳过
  } catch {
    // dir 不可读，跳过
  }
}

/** 把一个 skill 来源按优先级顺序追加进 byName（靠前目录 = 高优先，先入为主）。 */
function pushSkillSource(
  byName: Map<string, Array<{ dir: string; scanned: ScannedSkillInfo }>>,
  dir: string,
  scanned: ScannedSkillInfo,
): void {
  const list = byName.get(scanned.name) ?? []
  list.push({ dir, scanned })
  byName.set(scanned.name, list)
}

/** No-op: skills are discovered from discovery.json + forced dirs, not independently persisted. */
export function saveSkills(_projectRoot: string, _skills: SkillInfo[]): void {
  // no-op — skill persistence is managed by discovery.json SSOT (ADR-0021 §1)
}

/** @deprecated ADR-0021 §5 目录级管道：文件级注册已废弃，保留兼容期。新代码用 setSkillDirs。 */
export function upsertSkill(configStore: IConfigStore, skill: SkillInfo): void {
  console.warn('[config-service] upsertSkill is deprecated (ADR-0021 §5). Use setSkillDirs for directory-level config.')
  if (skill.sourcePath) {
    const dir = dirname(skill.sourcePath)
    configStore.addSkillPath(dir)
  }
}

/** @deprecated ADR-0021 §5 目录级管道：文件级删除已废弃，保留兼容期。新代码用 setSkillDirs。 */
export function deleteSkill(configStore: IConfigStore, projectRoot: string, skillId: string): void {
  console.warn('[config-service] deleteSkill is deprecated (ADR-0021 §5). Use setSkillDirs for directory-level config.')
  const skills = loadSkills(configStore, projectRoot)
  const skill = skills.find(s => s.id === skillId)
  if (skill?.sourcePath) {
    const dir = dirname(skill.sourcePath)
    configStore.removeSkillPath(dir)
  }
}

/** 委托 skill-scanner 扫描候选目录（原 ConfigService.scanSkills 逐字搬迁）。 */
export function scanSkills(sources: string[], existingIds: Set<string>): ScannedSkillInfo[] {
  return scanSkillsImpl(sources, existingIds)
}
