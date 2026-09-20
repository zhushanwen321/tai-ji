/**
 * @zhushanwen/zcode-session-source — zcode 会话库唯一读取基座（设计 D2/D3）。
 *
 * 三个消费面：session-reader 扩展（bun 宿主，G1 读链）、runtime 导入薄包装
 * （node 侧）、未来第三个 coding-agent source。公共面 = 驱动适配层（D3 双驱动）
 * + 四级恢复阶梯（§3.5 单一规格）+ 行集查询 / schema 闸门 / 库路径投影。
 * converter（Entry 树转换）不在本导出面（U4 领地，后续单元补）。
 */

export {
  loadSqliteDriver,
  toSqliteFileUri,
  type SqliteDb,
  type SqliteDriver,
  type SqliteOpenOptions,
  type SqliteStatement,
} from './sqlite-driver.ts'

export {
  SNAPSHOT_MAX_DB_BYTES,
  SNAPSHOT_TMP_PREFIX,
  REQUIRED_TABLES,
  SqliteUnreadableError,
  countSnapshotDirs,
  openViaSnapshot,
  openWithRecovery,
  type OpenedWithRecovery,
  type RecoveryLevel,
  type SnapshotOpenResult,
} from './recovery.ts'

export {
  KNOWN_ZCODE_SCHEMA_VERSIONS,
  ZcodeSchemaDriftError,
  assertKnownSchema,
  hostZcodeDbPath,
  zcodeImportDbAllowlist,
  zcodeIsolatedDbPath,
  openZcodeSessionDb,
  type ZcodeReadonlyDb,
  type ZcodeSessionDbHandle,
  type ZcodeSessionRow,
  type ZcodeTranscriptMessageRow,
} from './sqlite-access.ts'
