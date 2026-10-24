/**
 * 重试规则域（remote-config 域 3，subagent-observability §3.3.12）：内置基线 ⊕ 远程覆盖
 * 合并视图 + retry-rules ext-config 文件 RMW（runtime 是该文件的唯一写方，pi 孙进程的
 * retry-rules extension 是纯消费方——单一数据源，mtime 热重载读侧在 extension）。
 *
 * 配置面三层（quota-fetchers 域同款形态）：
 * - 编译期基线 = shared RETRY_RULES_BASELINE（随发版更新，实测锚点头注释在 shared 源）；
 * - 远程覆盖 = configs/remote/retry-rules.json（同 id 覆盖基线 + 新 id 追加，热更新免发版；
 *   guard 整体拒用——坏远程配置的最坏后果是停留在基线）；
 * - 用户自定义 = ext-config 文件 customRules 段（settings round-trip 对象，全量存储）。
 *
 * ext-config 文件的 effectiveRules 段 = 合并持久段（基线 ⊕ 远程 ⊕ custom 合并视图），
 * extension 判定唯一消费段——合并权威在 runtime，extension 不持有基线副本、不感知远程
 * 通道。写点：① settings 保存自定义规则（setRetryRulesCustom）；② 远程刷新生效
 * （syncRetryRulesRemote，内容变化时重写 effectiveRules 段）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  isRetryRulesExtConfig,
  isRetryRulesRemoteConfig,
  mergeRetryRules,
  RETRY_RULES_BASELINE,
  validateRetryRuleList,
  type RetryableErrorRule,
  type RetryRulesExtConfig,
} from '@taiji/shared'

import { logger } from '../../infra/logger.js'
import { getPiAgentDir } from '../../infra/pi/pi-paths.js'
import { atomicWrite } from '../../utils/fs-utils.js'
import { withFileLockSync } from '../../utils/file-lock.js'
import { loadRemoteConfig, refreshRemoteConfig } from './remote-config-fetch.js'

/** ext-config 文件相对路径（与 extension 侧 llm-shared getConfigPath('retry-rules') 契约一致）。 */
const RETRY_RULES_CONFIG_REL = join('config', 'retry-rules-ext-config.json')

/** JSON 落盘缩进（全仓 JSON_INDENT = 2 约定，与 remote-config-fetch 同款）。 */
const JSON_INDENT = 2

function retryRulesExtConfigPath(): string {
  return join(getPiAgentDir(), RETRY_RULES_CONFIG_REL)
}

// ───────────────────────── 读侧 ─────────────────────────

/** 读 ext-config 文件（缺失/坏 JSON/形状非法 → 默认空集 + warn；读侧不抛错，network-proxy 同款）。 */
export function readRetryRulesExtConfig(): RetryRulesExtConfig {
  const path = retryRulesExtConfigPath()
  try {
    if (!existsSync(path)) {
      return { version: 1, customRules: [], effectiveRules: [] }
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!isRetryRulesExtConfig(parsed)) {
      logger.warn('[retry-rules] ext-config failed shape guard, treating as empty', { path })
      return { version: 1, customRules: [], effectiveRules: [] }
    }
    return parsed
  } catch (e) {
    logger.warn('[retry-rules] ext-config unreadable, treating as empty', {
      path,
      error: e instanceof Error ? e.message : String(e),
    })
    return { version: 1, customRules: [], effectiveRules: [] }
  }
}

// ───────────────────────── 合并视图 ─────────────────────────

/** 读远程域缓存（纯缓存不发网络；sync 是唯一网络触发点）。 */
function loadRemoteRetryRules(): { rules: Omit<RetryableErrorRule, 'source'>[] } | undefined {
  return loadRemoteConfig('retry-rules', isRetryRulesRemoteConfig)
}

/** 远程覆盖层（缓存读侧）→ source 归一 'remote' 的规则数组。 */
function remoteRulesNormalized(): RetryableErrorRule[] {
  return loadRemoteRetryRules()?.rules.map((r) => ({ ...r, source: 'remote' as const })) ?? []
}

/**
 * 内置层合并视图：编译期基线 ⊕ 远程覆盖（同 id 覆盖保留基线位置、覆盖值 source 归一
 * 'remote'；新 id 追加，source 'remote'）——settings 预设展示与 effectiveRules 合并共用。
 */
export function getBuiltinRetryRules(): RetryableErrorRule[] {
  return mergeRetryRules(RETRY_RULES_BASELINE, remoteRulesNormalized(), [])
}

// ───────────────────────── 写侧（唯一写方） ─────────────────────────

/** 合并持久段重算：内置层（基线 ⊕ 远程）+ 用户自定义。 */
function computeEffectiveRules(customRules: RetryableErrorRule[]): RetryableErrorRule[] {
  return mergeRetryRules(RETRY_RULES_BASELINE, remoteRulesNormalized(), customRules)
}

/** 原子写 ext-config（锁内整文件写；与 extension llm-shared saveConfig 序列化格式一致：2 空格缩进 + 尾换行）。 */
function writeRetryRulesExtConfig(config: RetryRulesExtConfig): void {
  const path = retryRulesExtConfigPath()
  withFileLockSync(path, () => {
    atomicWrite(path, `${JSON.stringify(config, null, JSON_INDENT)}\n`)
  })
}

/**
 * 保存用户自定义规则（settings setRetryRules 写点）：校验（shared 域，错误信封逐项收集）
 * → customRules 全量替换 + effectiveRules 重算 → 原子写。
 * custom id 与内置层（基线 ⊕ 远程）重叠拒绝——分层以 source 为键，id 重叠会让覆盖语义
 * 与 settings 展示双双失义。
 */
export function setRetryRulesCustom(
  customRules: RetryableErrorRule[],
): { ok: true } | { ok: false; errors: string[] } {
  const listResult = validateRetryRuleList(customRules, '自定义规则')
  if (!listResult.ok) return listResult
  const normalized = customRules.map((r) => ({ ...r, source: 'custom' as const }))
  const builtinIds = new Set(getBuiltinRetryRules().map((r) => r.id))
  const clash = normalized.filter((r) => builtinIds.has(r.id)).map((r) => r.id)
  if (clash.length > 0) {
    return {
      ok: false,
      errors: [`自定义规则 ID 与内置预设重叠（${clash.join('、')}），请修改 ID 后保存——内置预设的更新走远程配置通道，不经自定义层`],
    }
  }
  writeRetryRulesExtConfig({ version: 1, customRules: normalized, effectiveRules: computeEffectiveRules(normalized) })
  return { ok: true }
}

/**
 * 远程域刷新 + 生效落盘（config-service 远程同步挂点调用）：refreshRemoteConfig 拉取
 * （4h 节流 + ETag + fail-safe 链内建）→ 重算 effectiveRules 段落盘（extension 下轮
 * 判定热重载吃到）。
 *
 * [§3.3.12 G1 基线默认生效] ext-config 缺席（新机器 / 从未打开 settings）时**首次调用
 * 即补写基线落盘**（effectiveRules = 编译期基线 ⊕ 可用远程覆盖，customRules 空）——
 * 基线规则是功能默认生效面（「可重试错误不再被判死」），文件名缺席不得等于功能缺席；
 * 补写先于远程命中判定（拉取失败/无变化也补），单一写方纪律不变（本函数与
 * setRetryRulesCustom 同为本文件写侧）。
 */
export async function syncRetryRulesRemote(): Promise<{ refreshed: boolean; reason?: string }> {
  // 拉取先行（4h 节流 + ETag + fail-safe 链内建；失败也走缓存/基线，不阻断下方重算）。
  const { refreshed, reason } = await refreshRemoteConfig('retry-rules', isRetryRulesRemoteConfig)
  // [§3.3.12 G1/G1b] effectiveRules 是 runtime 拥有的**派生段**（extension 判定唯一消费
  // 面，用户只编辑 customRules）——每次同步无条件重算落盘（编译期基线 ⊕ 可用远程层 ⊕
  // 现有 customRules），与文件在场/远程命中均无关。幂等写、单写方纪律不变；extension
  // startupConfig 在启动早期建的占位文件（空 effectiveRules）由此被覆盖，基线规则
  // 默认生效（a8d 实测缺口：仅缺席补写会被该占位机制旁路）。
  const current = readRetryRulesExtConfig()
  writeRetryRulesExtConfig({ version: 1, customRules: current.customRules, effectiveRules: computeEffectiveRules(current.customRules) })
  return refreshed ? { refreshed: true } : { refreshed: false, ...(reason !== undefined ? { reason } : {}) }
}
