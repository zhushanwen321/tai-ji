import type { DiscoveryConfig, DiscoveryConfigV1 } from './provider'

/**
 * 判定单条路径的 scope 归属（方案 §2.3）：
 * - 绝对路径（以 `/` 或 `~` 开头，如 `/abs/...`、`~/.pi/agent/skills`）→ 'global'
 * - 相对路径（其余，如 `.agents/skills`、`.taiji/skills`）→ 'project'
 *
 * 与 skill-dirs.ts 旧版 resolveGlobalSkillDirs/resolveProjectSkillDirs 的 isAbsolute/startsWith('~/') 推断一致，
 * 确保迁移前后归类不变。
 */
function isGlobalPath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~')
}

/**
 * 将一个 v1 扁平路径数组按 §2.3 规则拆分为 { projectPaths, globalPaths }。
 * 纯函数：filter 返回新数组，不修改入参。
 */
function partitionDirs(dirs: string[]): { projectPaths: string[]; globalPaths: string[] } {
  return {
    projectPaths: dirs.filter((p) => !isGlobalPath(p)),
    globalPaths: dirs.filter((p) => isGlobalPath(p)),
  }
}

/**
 * v1→v2 discovery.json 迁移（方案 §2.3）。
 *
 * 规则：相对路径（不以 `/` 或 `~` 开头）→ projectPaths；绝对路径（以 `/` 或 `~` 开头）→ globalPaths。
 * 对 skill/agent/extension 三个 kind 同构处理。
 *
 * 纯函数：无 fs / 无副作用 / 不修改入参（仅读 v1.*Dirs 字段，构建全新 v2 对象）。
 */
export function migrateDiscoveryV1ToV2(v1: DiscoveryConfigV1): DiscoveryConfig {
  return {
    version: 2,
    skill: partitionDirs(v1.skillDirs),
    agent: partitionDirs(v1.agentDirs),
    extension: partitionDirs(v1.extensionDirs),
  }
}
