/**
 * Provider 导入预览缓存（DM3）—— 模块级 Map 单例 + 5min TTL + 惰性清理。
 *
 * 设计目的（DM1 安全红线）：
 *   API key 明文**绝不进前端**。Step1 preview 解析出的完整配置（含 apiKey 明文）只活在
 *   本缓存（runtime 进程内存），Step2 apply 据缓存里的完整配置写 models.json。
 *   preview 返回给前端的只有脱敏后的 apiKeyExtracted 布尔。
 *
 * 生命周期：
 *   - createPreview：解析后存入，返回 importId（randomUUID）。
 *   - consumePreview：apply 时取出，**不删**（apply 成功才调 deletePreview，避免 apply 中途
 *     异常导致缓存丢失无法重试）。
 *   - deletePreview：apply 成功后立即删（一次性，防止 importId 被复用）。
 *   - 惰性清理：每次 create/consume 前先 pruneExpired 扫一遍过期项。
 *
 * TTL = 5min（300_000ms）：用户从 preview 到 apply 的典型决策窗口。
 * 模块级单例 Map（进程内唯一），不持久化（进程重启即丢，用户需重新 preview）。
 */
import { randomUUID } from 'node:crypto'
import type { ProviderSource } from '@taiji/shared'
import type { ParsedProvider, ParsedOrphanCredential } from './provider-parser.js'

/** 预览缓存 TTL：5 分钟。 */
const TTL_MS = 300_000

/**
 * 预览缓存条目。
 *
 * - providers 含 apiKey 明文（runtime 内部用，绝不返回前端）。
 * - orphanCredentials 含孤儿凭据 apiKey 明文（sa3 F1，同上安全红线）。
 * - createdAt 用于 TTL 惰性清理。
 */
export interface PreviewCacheEntry {
  createdAt: number
  source: ProviderSource
  /** 完整配置（含 apiKey 明文）。apply 时剥离 _ 前缀元数据后 upsertProvider。 */
  providers: ParsedProvider[]
  /** 孤儿凭据（auth.json 有、models.json 无定义的 providerId，含 apiKey 明文）。apply 时匹配内置模板补全。 */
  orphanCredentials: ParsedOrphanCredential[]
}

/** 模块级单例缓存（进程内唯一）。key = importId（randomUUID）。 */
const cache = new Map<string, PreviewCacheEntry>()

/**
 * 惰性清理过期条目。在每次 create/consume 前调用，避免缓存无限增长 + 保证读到的是未过期数据。
 */
function pruneExpired(): void {
  const now = Date.now()
  for (const [id, entry] of cache) {
    if (now - entry.createdAt > TTL_MS) cache.delete(id)
  }
}

/**
 * 创建预览缓存条目，返回 importId。
 *
 * 调用方：previewImport（解析源配置后存入完整配置，返回脱敏 preview + importId）。
 */
export function createPreview(
  source: ProviderSource,
  providers: ParsedProvider[],
  orphanCredentials: ParsedOrphanCredential[] = [],
): string {
  pruneExpired()
  const importId = randomUUID()
  cache.set(importId, { createdAt: Date.now(), source, providers, orphanCredentials })
  return importId
}

/**
 * 取出预览缓存条目（**不删**）。
 *
 * 调用方：applyImport（据 importId 取完整配置，逐个 upsertProvider）。
 * apply 成功后才调 deletePreview 删除——避免 apply 中途异常导致缓存丢失无法重试。
 * 过期/不存在返回 null（apply 时调用方据此返回 PREVIEW_EXPIRED 错误）。
 */
export function consumePreview(importId: string): PreviewCacheEntry | null {
  pruneExpired()
  const entry = cache.get(importId)
  if (!entry) return null
  // 不删——apply 成功才调 deletePreview
  return entry
}

/**
 * 删除预览缓存条目（apply 成功后立即删，一次性）。
 *
 * 防止 importId 被复用（apply 后再次 apply 同一 importId 会 PREVIEW_EXPIRED）。
 */
export function deletePreview(importId: string): void {
  cache.delete(importId)
}

/**
 * 仅测试用：清空缓存（vi.useFakeTimers 场景在每个 test 前重置，避免跨用例污染）。
 *
 * 命名加 _ 前缀标记「内部/测试专用」，与 ParsedProvider 的 _ 前缀元数据字段同惯例。
 */
export function _resetCacheForTest(): void {
  cache.clear()
}
