/**
 * DiscoveryStore — discovery.json 的唯一读写层（ADR-0021 §1 落地）。
 *
 * discovery.json 是 skill/agent/extension 加载路径的**唯一真相源（SSOT）**：
 *   - 路径：`<piAgentDir>/discovery.json`（<dataDir>/agent/discovery.json）
 *   - schema v2：{ version:2, skill/agent/extension: { projectPaths, globalPaths } }
 *   - 每个 kind 拆 project（项目级，跟随 cwd，可含相对路径如 .agents/skills）
 *     与 global（全局级，限绝对路径如 ~/.pi/agent/skills）。
 *   - 合并语义：resolveLoadPaths(cfg, kind) = dedupe([...projectPaths, ...globalPaths])，
 *     项目在前 = 项目优先级 > 全局（靠前覆盖靠后，§1.1 层 3）。
 *   - 强制目录（~/.taiji/skills · .taiji/skills 等）不进此文件（桥接层硬编码注入）
 *   - 默认态（文件缺失回落）：全部 preset 目录默认勾选（DEFAULT_DISCOVERY_CONFIG，
 *     pi + taiji 相关路径；claude 已移出预设）——新装用户打开设置即见勾选态，无需手动配置。
 *
 * v1→v2 迁移：读取 v1（扁平 skillDirs/agentDirs/extensionDirs）时按路径特征归类
 * （相对→project / 绝对/~→global，见 migrateDiscoveryV1ToV2），迁移后立即作为 v2 返回（下次写回落盘）。
 *
 * 与 settings.json 的关系（ADR §理由 2 + 方案 C 决策）：
 *   discovery.json = SSOT（taiji 自有，UI 读写此）。
 *   settings.json.skills = 派生投影（pi 原生经 collectSettingsSkillPaths 读此加载 skill）。
 *   每次 discovery.json 的 skill 路径变更，由 pi-provider-store 同步投影到 settings.json.skills。
 *
 * 🔒 三层架构：本模块属 infra（直接碰文件系统），services 经 port 访问。
 */
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  PRESET_SKILL_DIRS,
  PRESET_AGENT_DIRS,
  PRESET_EXTENSION_DIRS,
  DEFAULT_DISCOVERY_CONFIG,
  migrateDiscoveryV1ToV2,
} from '@taiji/shared'
import type { DiscoveryConfig, DiscoveryConfigV1, SkillDirConfig } from '@taiji/shared'
import { JsonStore } from '../../utils/json-store.js'
import { getPiAgentDir } from './pi-paths.js'
import { expandHome } from '../../utils/path-utils.js'

/** discovery 的三个 kind（skill/agent/extension），结构同构。 */
type DiscoveryKind = 'skill' | 'agent' | 'extension'

/** 某 kind 的 v2 子结构（project + global 两组路径）。 */
export type ScopedPaths = { projectPaths: string[]; globalPaths: string[] }

/** discovery.json 当前 schema 版本（deserialize 只认此值 + v1 迁移路径） */
const DISCOVERY_SCHEMA_VERSION = 2

/**
 * discovery.json 默认态（文件缺失时的回落值）：全部 preset 目录默认勾选（pi + taiji 相关，
 * 路径 SSOT 见 shared DEFAULT_DISCOVERY_CONFIG）。此前默认全空 → 新装用户打开设置页所有
 * 目录都是未勾选态，需手动配置；现在打开即默认勾选，无需用户操作。
 *
 * 顺序：projectPaths/globalPaths 各自内部按 preset 顺序，与 buildDirConfigs 展示序一致。
 */
const DEFAULT_DISCOVERY: DiscoveryConfig = {
  version: DISCOVERY_SCHEMA_VERSION,
  skill: {
    projectPaths: [...DEFAULT_DISCOVERY_CONFIG.skill.projectPaths],
    globalPaths: [...DEFAULT_DISCOVERY_CONFIG.skill.globalPaths],
  },
  agent: {
    projectPaths: [...DEFAULT_DISCOVERY_CONFIG.agent.projectPaths],
    globalPaths: [...DEFAULT_DISCOVERY_CONFIG.agent.globalPaths],
  },
  extension: {
    projectPaths: [...DEFAULT_DISCOVERY_CONFIG.extension.projectPaths],
    globalPaths: [...DEFAULT_DISCOVERY_CONFIG.extension.globalPaths],
  },
}

/** 把未知值归一为 string[]（过滤非字符串元素）。 */
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
}

/** 把未知值归一为 ScopedPaths（补全缺失字段，过滤非字符串）。 */
function asScopedPaths(k: unknown): ScopedPaths {
  const obj = k && typeof k === 'object' && !Array.isArray(k) ? (k as Record<string, unknown>) : {}
  return {
    projectPaths: asStringArray(obj.projectPaths),
    globalPaths: asStringArray(obj.globalPaths),
  }
}

let discoveryStore = createDiscoveryStore(getDiscoveryPath())

/**
 * discovery.json 存储：read-through（TTL 缓存 + ENOENT 容错）+ atomicWrite。
 * schema guard：认 v2（直接用）+ v1（迁移到 v2 后返回，不再 fallback 清空）。
 */
function createDiscoveryStore(path: string): JsonStore<DiscoveryConfig> {
  return new JsonStore<DiscoveryConfig>(path, DEFAULT_DISCOVERY, {
    ttlMs: 3_000,
    deserialize: (raw): DiscoveryConfig => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        console.warn(`[discovery-store] ${path} schema 不匹配，使用 fallback`)
        return { ...DEFAULT_DISCOVERY }
      }
      const obj = raw as Record<string, unknown>
      // v2：字段校验 + 补全后直接用
      if (obj.version === DISCOVERY_SCHEMA_VERSION) {
        return {
          version: DISCOVERY_SCHEMA_VERSION,
          skill: asScopedPaths(obj.skill),
          agent: asScopedPaths(obj.agent),
          extension: asScopedPaths(obj.extension),
        }
      }
      // v1：按路径特征迁移到 v2（相对→project / 绝对/~→global），迁移后即作为 v2 返回
      // （下次 writeDiscovery 落盘为 v2，完成原地升级；不再 fallback 清空，避免丢用户配置）。
      if (obj.version === 1) {
        const v1: DiscoveryConfigV1 = {
          version: 1,
          skillDirs: asStringArray(obj.skillDirs),
          agentDirs: asStringArray(obj.agentDirs),
          extensionDirs: asStringArray(obj.extensionDirs),
        }
        const migrated = migrateDiscoveryV1ToV2(v1)
        console.log(
          `[discovery-store] ${path} v1→v2 migrated: ` +
            `skill ${v1.skillDirs.length}→{project:${migrated.skill.projectPaths.length},global:${migrated.skill.globalPaths.length}}, ` +
            `agent ${v1.agentDirs.length}→{project:${migrated.agent.projectPaths.length},global:${migrated.agent.globalPaths.length}}, ` +
            `extension ${v1.extensionDirs.length}→{project:${migrated.extension.projectPaths.length},global:${migrated.extension.globalPaths.length}}`,
        )
        return migrated
      }
      console.warn(`[discovery-store] ${path} 未知 version=${String(obj.version)}，使用 fallback`)
      return { ...DEFAULT_DISCOVERY }
    },
    // 不再配置 shouldDeleteWhen（旧「六字段全空 → 删文件」已移除）：默认态非空后，全空只能
    // 来自用户显式取消全部勾选——删文件会让下次读回落到 DEFAULT_DISCOVERY，用户关掉的目录
    // 在下次读取时「复活」为勾选态。保留全空文件即保留用户意图；旧的清理诉求（pi 首启
    // 占位脏数据）已由读写两端的 existsSync 脏数据过滤承担（partitionByScope / buildDirConfigs）。
  })
}

/** discovery.json 路径：<piAgentDir>/discovery.json。导出供 pi-provider-store 投影逻辑复用。 */
export function getDiscoveryPath(): string {
  return `${getPiAgentDir()}/discovery.json`
}

/**
 * 覆盖 discovery.json 路径（仅测试用）。生产不应调用。
 * 重建 store 实例并清空缓存，确保后续读拿到新路径的文件。
 */
export function setDiscoveryPath(path: string): void {
  discoveryStore = createDiscoveryStore(path)
}

/** 失效缓存（外部改了文件后调用）。 */
export function invalidateDiscoveryCache(): void {
  discoveryStore.invalidate()
}

/** 读取 discovery.json 全量（带 3s 缓存）。 */
export function readDiscovery(): DiscoveryConfig {
  return discoveryStore.read()
}

/** 写入 discovery.json 全量（刷新缓存；全空文件保留——见 createDiscoveryStore 内 shouldDeleteWhen 注）。 */
export function writeDiscovery(config: DiscoveryConfig): void {
  discoveryStore.write(config)
}

/**
 * 合并某 kind 的 project + global 路径为有序扁平数组（方案 §2.1）。
 * project 在前 = 项目优先级 > 全局；去重保留首次出现（靠前胜出）。
 * 供 pi-provider-store settings 投影 + session-service pi 启动参数等「需扁平合并」的消费方。
 */
export function resolveLoadPaths(cfg: DiscoveryConfig, kind: DiscoveryKind): string[] {
  const { projectPaths, globalPaths } = cfg[kind]
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of [...projectPaths, ...globalPaths]) {
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

// ── 便捷访问器 ──

/** 读取 skill 合并路径（project ∪ global 去重，项目在前）。 */
export function getSkillDirs(): string[] {
  return resolveLoadPaths(readDiscovery(), 'skill')
}

/** 读取 agent 合并路径（project ∪ global 去重，项目在前）。 */
export function getAgentDirs(): string[] {
  return resolveLoadPaths(readDiscovery(), 'agent')
}

/** 读取 extension 合并路径（project ∪ global 去重，项目在前）。 */
export function getExtensionDirs(): string[] {
  return resolveLoadPaths(readDiscovery(), 'extension')
}

/** 读取 skill 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
export function getSkillPathScopes(): ScopedPaths {
  return readDiscovery().skill
}

/** 读取 agent 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
export function getAgentPathScopes(): ScopedPaths {
  return readDiscovery().agent
}

/** 读取 extension 的 v2 分 scope 结构（projectPaths / globalPaths）。 */
export function getExtensionPathScopes(): ScopedPaths {
  return readDiscovery().extension
}

/**
 * 把 SkillDirConfig[] 按 scope 分发到 projectPaths / globalPaths（脏数据过滤后）。
 *
 * ADR §5 脏数据过滤：写入前剔除不存在的「自定义」绝对路径（/path/a 等 pi 首次写入的占位符、
 * 已删除的自定义路径）。与 services/skill-dir-config.ts 的 buildDirConfigs 读取端过滤对齐——
 * 双向拦截，确保 discovery.json 不残留脏数据。
 *
 * 豁免（与 buildDirConfigs 一致）：
 *   - preset 成员（推荐候选语义，即使不存在也保留）
 *   - 相对路径（无 cwd 上下文，不检查存在性）
 *
 * 仅写入 enabled 的项（enabled:false 的 preset 候选不进 discovery.json，靠 buildDirConfigs 从 preset 补）。
 * enabled 字段省略时视为 true（与 SkillInfo 约定一致）。
 */
function partitionByScope(dirs: SkillDirConfig[], preset: readonly string[]): ScopedPaths {
  const presetNormalized = new Set(preset.map(expandHome))
  const projectPaths: string[] = []
  const globalPaths: string[] = []
  for (const d of dirs) {
    if (!d || typeof d.path !== 'string') continue
    if (d.enabled === false) continue
    const resolved = expandHome(d.path)
    const isPresetMember = presetNormalized.has(resolved)
    if (!isPresetMember && isAbsolute(resolved) && !existsSync(resolved)) continue
    if (d.scope === 'project') {
      projectPaths.push(d.path)
    } else {
      globalPaths.push(d.path)
    }
  }
  return { projectPaths, globalPaths }
}

/**
 * 覆盖 skill 路径（SkillDirConfig[]，按 scope 分发写 projectPaths/globalPaths；脏数据过滤保留）。
 */
export function setSkillDirs(dirs: SkillDirConfig[]): void {
  const scoped = partitionByScope(dirs, PRESET_SKILL_DIRS)
  writeDiscovery({ ...readDiscovery(), skill: scoped })
}

/**
 * 覆盖 agent 路径（SkillDirConfig[]，按 scope 分发；脏数据过滤保留）。与 setSkillDirs 对称。
 */
export function setAgentDirs(dirs: SkillDirConfig[]): void {
  const scoped = partitionByScope(dirs, PRESET_AGENT_DIRS)
  writeDiscovery({ ...readDiscovery(), agent: scoped })
}

/**
 * 覆盖 extension 路径（SkillDirConfig[]，按 scope 分发；脏数据过滤保留）。与 setSkillDirs 对称。
 */
export function setExtensionDirs(dirs: SkillDirConfig[]): void {
  const scoped = partitionByScope(dirs, PRESET_EXTENSION_DIRS)
  writeDiscovery({ ...readDiscovery(), extension: scoped })
}
