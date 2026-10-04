/**
 * Skill 路径管理 helper（从 pi-provider-store.ts 抽出，控 max-lines 500）。
 *
 * 职责：ADR-0021 §1 的 skill 路径 SSOT 管理——discovery.json.skillDirs 读写（SSOT，
 * 有序数组 = 优先级）+ 同步投影到 settings.json.skills（pi 原生读此加载 skill）+
 * 旧版 settings.json.skills → discovery.json 一次性迁移。
 *
 * 数据流（方案 C 决策）：
 *   UI 读写 → discovery.json.skillDirs（SSOT，有序数组 = 优先级）
 *   discovery.json 变更 → syncSkillDirsToSettings() 同步投影到 settings.json.skills
 *   pi 启动 → collectSettingsSkillPaths 读 settings.json.skills 加载 skill（pi 官方扩展点）
 *
 * 抽出原因：pi-provider-store.ts 超 ESLint max-lines(500)。本模块只经 discovery-store /
 * settings.json（不碰 modelsStore 模块级缓存），移到本模块后 pi-provider-store 经 barrel
 * re-export 保 import 路径不变，行为 / 签名零变化。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillDirConfig } from '@taiji/shared'
import { updateSettingsFields, readSettings } from './pi-settings-store.js'
import {
  getSkillDirs as getDiscoverySkillDirs,
  getSkillPathScopes as getDiscoverySkillScopes,
  setSkillDirs as setDiscoverySkillDirs,
  readDiscovery,
  writeDiscovery,
} from './discovery-store.js'
import { normalizeToHome } from '../../utils/path-utils.js'

/**
 * 把 discovery.json.skillDirs 投影到 settings.json.skills（pi 原生读此加载 skill）。
 * 在 setSkillPaths/addSkillPath/removeSkillPath 写入 discovery 后调用，保持派生缓存一致。
 */
function syncSkillDirsToSettings(): void {
  updateSettingsFields('skills', s => { s.skills = getDiscoverySkillDirs() })
}

/**
 * 两步写（discovery.json → settings.json 投影）+ 失败回滚（RT-3#8）。
 *
 * 为什么必须有：settings 投影走 updateSettingsFields（跨进程锁，锁超时/写盘失败可抛）；
 * 先写 discovery 再投影，第二步失败会留下「discovery 已新、settings 仍旧」的分歧态，
 * pi 读到的 skills 与 taiji 视图不一致（直到下次成功写）。回滚 = 把 discovery 恢复为
 * 写前内容后原样上抛——旧值在内存中（readDiscovery），回滚成本一次小文件写，优于
 * pending-reconcile 标记 + 启动重放方案（后者要新增持久化状态与重放入口，收益相同
 * 成本更高）。回滚自身失败（极端：磁盘只读）仅 error 留痕，分歧态由下一次成功写
 * 自愈（syncSkillDirsToSettings 恒从 discovery 派生）。
 */
function setDiscoverySkillDirsThenSync(dirs: SkillDirConfig[], context: string): void {
  const previous = readDiscovery().skill
  setDiscoverySkillDirs(dirs)
  try {
    syncSkillDirsToSettings()
  } catch (e) {
    try {
      setSkillDirsRaw(previous)
    } catch (rollbackErr) {
      // 降级策略（best-effort）：回滚失败仅 error 留痕不掩盖原投影错误；分歧态由下一次
      // 成功写自愈（syncSkillDirsToSettings 恒从 discovery 派生）。
      console.error(
        `[pi-skill-paths] ${context}: settings 投影失败且回滚 discovery 失败——discovery 与 settings.skills 处于分歧态，` +
        `下次成功写入时自愈。rollback error:`,
        rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
      )
    }
    throw e
  }
}

/** 把 ScopedPaths 形态原样写回 discovery.skill（回滚专用，不做 scope 重分派）。 */
function setSkillDirsRaw(scoped: { projectPaths: string[]; globalPaths: string[] }): void {
  writeDiscovery({ ...readDiscovery(), skill: { projectPaths: [...scoped.projectPaths], globalPaths: [...scoped.globalPaths] } })
}

/**
 * 判断目录是否是「skill 容器」（含 ≥1 个带 SKILL.md 的子目录）。
 * 用于迁移时区分容器目录（如 ~/.pi/agent/skills）与单 skill 目录（如 .../skills/anysearch）。
 * ADR-0021 §1：discovery.json 存容器目录粒度，目录内资源全开。
 */
function isSkillContainer(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false
  let entries: string[]
  try {
    entries = readdirSync(dirPath)
  } catch {
    return false
  }
  for (const name of entries) {
    try {
      if (statSync(join(dirPath, name)).isDirectory() && existsSync(join(dirPath, name, 'SKILL.md'))) {
        return true
      }
    } catch {
      continue
    }
  }
  return false
}

/**
 * 一次性迁移：把旧版本 settings.json.skills（粒度错误：存的是单 skill 目录）
 * 归并为 ADR-0021 §1 的容器目录粒度，提升为 discovery.json SSOT。
 *
 * 旧数据问题：旧 addSkillPath(dirname(skill.sourcePath)) 把每个 skill 的父目录
 * 单独塞进 settings.json.skills（如 ~/.pi/agent/skills/anysearch），而非容器目录
 *（~/.pi/agent/skills）。44 条单 skill 路径去重父目录后只有 2 个容器。
 *
 * 归并策略：对每条旧路径取父目录 → 去重 → 仅保留确实是容器（含 ≥1 个 SKILL.md 子目录）的。
 * 幂等：discovery 已有容器目录数据则 no-op。
 * 由 ConfigService 初始化时调用。
 */
export function migrateSettingsSkillsToDiscovery(): void {
  const discovery = readDiscovery()
  // discovery 已有「有效容器」数据则 no-op（幂等）。
  // 注意：不能仅凭数组长度>0 判定——可能存有脏数据（/path/a 等测试残留），
  // 故用 isSkillContainer 校验每条；全无效则继续迁移覆盖。
  const existingSkillPaths = [...discovery.skill.projectPaths, ...discovery.skill.globalPaths]
  if (existingSkillPaths.length > 0 && existingSkillPaths.some(c => isSkillContainer(c))) return
  const legacy = readSettings().skills ?? []
  if (legacy.length === 0) return

  // 取父目录去重（旧路径是 <container>/<skillName>，父目录才是容器）
  const containers = new Set<string>()
  for (const p of legacy) {
    const idx = p.lastIndexOf('/')
    const parent = idx > 0 ? p.slice(0, idx) : p
    containers.add(parent)
  }

  // 仅保留确实是容器的父目录（含 ≥1 个带 SKILL.md 的子目录）
  const validContainers = [...containers].filter(c => isSkillContainer(c))
  if (validContainers.length === 0) return
  // 归一化为 ~ 形式（家目录下的路径用 ~ 前缀），与预设候选 ~/.pi/agent/skills 等保持一致，
  // 避免 buildDirConfigs 的字符串匹配因 ~ vs 绝对路径失配而重复显示。
  // 容器目录均为绝对/~路径 → scope global（写入端按路径特征归类，与 migrateDiscoveryV1ToV2 一致）。
  const normalized = validContainers.map(normalizeToHome).map(path => ({
    path,
    enabled: true,
    scope: 'global' as const,
  }))
  setDiscoverySkillDirsThenSync(normalized, 'migrateSettingsSkillsToDiscovery')
  console.log(`[provider-store] migrated ${legacy.length} legacy skill paths → ${normalized.length} container dirs in discovery.json`)
}

export function getSkillPaths(): string[] {
  return getDiscoverySkillDirs()
}

/** discovery.skill 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
export function getSkillPathScopes() {
  return getDiscoverySkillScopes()
}

export function setSkillPaths(dirs: SkillDirConfig[]): void {
  setDiscoverySkillDirsThenSync(dirs, 'setSkillPaths')
}

/** 判定单路径 scope 归属（与 migrateDiscoveryV1ToV2 一致）：/ 或 ~ 开头 → global，其余 → project。 */
function isGlobalPath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~')
}

/** 读当前 skill 启用列表为 SkillDirConfig[]（保留 v2 scope），供 add/remove 单路径操作。 */
function readSkillDirConfigs(): SkillDirConfig[] {
  const scopes = getDiscoverySkillScopes()
  return [
    ...scopes.projectPaths.map(path => ({ path, enabled: true, scope: 'project' as const })),
    ...scopes.globalPaths.map(path => ({ path, enabled: true, scope: 'global' as const })),
  ]
}

export function addSkillPath(path: string): void {
  const current = readSkillDirConfigs()
  if (current.some(c => c.path === path)) return
  const scope = isGlobalPath(path) ? 'global' : 'project'
  setSkillPaths([...current, { path, enabled: true, scope }])
}

export function removeSkillPath(path: string): void {
  setSkillPaths(readSkillDirConfigs().filter(c => c.path !== path))
}
