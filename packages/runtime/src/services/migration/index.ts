/**
 * 迁移功能 service barrel。
 *
 * W1：source-detector（检测本机其他 agent 的 skill/agent 目录）。
 * W2（cw-2026-07-26-migration-other-agents）：provider 迁移核心链路
 *   - preview-cache：内存缓存（5min TTL，存完整配置含 apiKey 明文，DM3）
 *   - provider-parser：4 源 Mock 解析器（W3 替换为真实文件解析）
 *   - provider-importer：previewImport + applyImport 两步数据流（IF2/IF3）
 *
 * 安全红线（DM1）：API key 明文不进前端。preview 返回脱敏数据，完整配置只活在 preview-cache。
 *
 * S8：preview-cache 不用 `export *`（避免 `_resetCacheForTest` 经 barrel 泄漏到生产）。
 * 测试文件直接 `from './preview-cache.js'` 引入 `_resetCacheForTest`。
 */
export * from './source-detector.js'
export * from './provider-parser.js'
export * from './provider-importer.js'
export {
  createPreview,
  consumePreview,
  deletePreview,
  type PreviewCacheEntry,
} from './preview-cache.js'
