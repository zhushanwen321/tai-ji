/**
 * 归档域错误 → i18n 文案 key 的单点映射（session-archive 设计 §5.2 失败路径表）。
 *
 * 为什么单点：三个归档操作（归档 / 恢复 / 彻底删除）各有独立 catch 分支，若各写一份
 * code→文案映射，迟早漂移（同一个失败在两处显示不同指引）。映射表 = §5.2「界面表现 +
 * 恢复指引」两列的渲染落点：命中码给完整中英双语文案；未命中（含 archive_failed /
 * archive_unsupported 两个 transport 层码与系统错误）返回 null，由调用方回退到操作级
 * 通用模板 + runtime message。
 *
 * 按操作限定可命中码：同一码在不同操作下的前缀不同（archive_io_error 的「操作失败」），
 * 且领域码本就不应跨操作出现——跨操作命中视为未知码，避免错误前缀文案。
 */
import type { ArchiveErrorCode } from '@taiji/shared'

/** 归档域三个 RPC 操作（映射表按操作分区）。 */
export type ArchiveOperation = 'archive' | 'unarchive' | 'purge'

const ERROR_KEYS: Record<ArchiveOperation, Partial<Record<ArchiveErrorCode, string>>> = {
  archive: {
    archive_generating: 'archive.error.generating',
    archive_already_archived: 'archive.error.alreadyArchived',
    archive_io_error: 'archive.error.ioError',
  },
  unarchive: {
    archive_restore_conflict: 'archive.error.restoreConflict',
    archive_corrupted: 'archive.error.corrupted',
    archive_io_error: 'archive.error.ioError',
  },
  purge: {
    archive_not_found: 'archive.error.notFound',
    archive_io_error: 'archive.error.ioError',
  },
}

/** 命中返回 i18n key（不含翻译）；未命中返回 null（调用方走操作级通用模板）。 */
export function archiveErrorKey(operation: ArchiveOperation, err: unknown): string | null {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  if (typeof code !== 'string') return null
  return ERROR_KEYS[operation][code as ArchiveErrorCode] ?? null
}
