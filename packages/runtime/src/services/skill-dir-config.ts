/**
 * ADR-0021 §1/§2/§3 目录级管道配置（discovery.json SSOT）的 UI 视图构建。
 *
 * 此前长在 transport/server.ts（config 域业务逻辑泄漏到传输层），C2 拆分时下沉到 services/。
 * 消费方：sendInitialState（新连接推送 config.skillDirs/config.agentDirs）+
 * 两个 broadcast helper（目录变更后广播）。
 */
import type { SkillDirConfig } from '@taiji/shared'
import { PRESET_SKILL_DIRS, PRESET_AGENT_DIRS, PRESET_EXTENSION_DIRS } from '@taiji/shared'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { expandHome } from '../utils/path-utils.js'

// Re-export 供历史调用方（消费 PRESET_SKILL_DIRS/PRESET_AGENT_DIRS/PRESET_EXTENSION_DIRS 的模块）继续从此处 import，
// SSOT 已上提到 @taiji/shared/constants（infra 与 services 共享，消除本地副本漂移）。
export { PRESET_SKILL_DIRS, PRESET_AGENT_DIRS, PRESET_EXTENSION_DIRS }

/**
 * discovery 某 kind 的 v2 分 scope 结构（与 DiscoveryConfig[kind] 同构）。
 * buildDirConfigs 接收此结构以按 project/global 分组产出带 scope 的 SkillDirConfig[]。
 */
export interface DirScopes {
  projectPaths: string[]
  globalPaths: string[]
}

/**
 * 判定 preset 路径的 scope 归属（与 migrateDiscoveryV1ToV2 的 isGlobalPath 一致）：
 * 绝对路径（以 `/` 或 `~` 开头）→ 'global'；相对路径 → 'project'。
 * 用于把 preset 候选分到正确的 scope 组渲染。
 */
function presetScopeOf(p: string): 'project' | 'global' {
  return p.startsWith('/') || p.startsWith('~') ? 'global' : 'project'
}

/**
 * 把预设候选目录 + discovery 启用列表（v2 分 scope）组合成 UI 用的 SkillDirConfig[]。
 *
 * 顺序语义（ADR-0021 §1.1：靠前覆盖靠后 + 方案 §3.2 第3点）：
 *   1. project 启用目录，按 projectPaths 顺序（用户拖拽优先级）
 *   2. global 启用目录，按 globalPaths 顺序
 *   3. project preset 中未启用的候选（相对路径 preset，按 preset 固定顺序）
 *   4. global preset 中未启用的候选（绝对/~ preset，按 preset 固定顺序）
 *
 * 这保证用户拖拽改变 discovery 顺序后，广播回来的 UI 列表顺序与之一致，
 * 不会被 preset 固定顺序覆盖（否则拖拽排序失效）。项目组在前体现项目优先级 > 全局。
 *
 * 过滤：不存在的「自定义」启用路径不展示（脏数据，如 /path/a 等 pi 首制 discovery 占位符）。ADR §5。
 * **preset 成员豁免存在性检查**：preset 是「推荐候选」语义，用户勾选启用后即使该目录在此机器
 * 上不存在（未安装 Claude Code / 换机器 / 正准备创建），也应显示为 enabled，否则用户启用的配置
 * 会从 UI 消失、不可取消勾选（回归）。相对路径（如 .agents/skills）不检查（不知 cwd，且 preset 含相对路径作为候选语义）。
 *
 * @param preset 预设候选路径（PRESET_SKILL_DIRS 等）
 * @param scopes discovery 某 kind 的 v2 分 scope 结构（projectPaths/globalPaths，仅含启用路径）
 */
export function buildDirConfigs(preset: readonly string[], scopes: DirScopes): SkillDirConfig[] {
  const configs: SkillDirConfig[] = []
  const presetNormalized = new Set(preset.map(expandHome))
  // 启用集合（展开 ~ 后归一），用于判断 preset 候选是否已启用
  const enabledNormalized = new Set<string>([
    ...scopes.projectPaths.map(expandHome),
    ...scopes.globalPaths.map(expandHome),
  ])

  // 1. project 启用目录，按 projectPaths 顺序。ADR §5 脏数据过滤（preset 豁免 + 绝对 existsSync）。
  for (const dir of scopes.projectPaths) {
    const resolved = expandHome(dir)
    const isPresetMember = presetNormalized.has(resolved)
    if (!isPresetMember && isAbsolute(resolved) && !existsSync(resolved)) continue
    configs.push({ path: dir, enabled: true, scope: 'project' })
  }
  // 2. global 启用目录，按 globalPaths 顺序。
  for (const dir of scopes.globalPaths) {
    const resolved = expandHome(dir)
    const isPresetMember = presetNormalized.has(resolved)
    if (!isPresetMember && isAbsolute(resolved) && !existsSync(resolved)) continue
    configs.push({ path: dir, enabled: true, scope: 'global' })
  }
  // 3-4. preset 中未启用的候选，按 scope 分组追加（project 在前），每组内按 preset 固定顺序。
  for (const scope of ['project', 'global'] as const) {
    for (const path of preset) {
      if (presetScopeOf(path) !== scope) continue
      if (enabledNormalized.has(expandHome(path))) continue
      configs.push({ path, enabled: false, scope })
    }
  }
  return configs
}
