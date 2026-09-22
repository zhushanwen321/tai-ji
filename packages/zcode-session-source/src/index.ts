/**
 * @zhushanwen/zcode-session-source — zcode 会话库唯一读取基座（设计 D2/D3）。
 *
 * 三个消费面：session-reader 扩展（bun 宿主，G1 读链）、runtime 导入薄包装
 * （node 侧）、未来第三个 coding-agent source。导出面 = 实测消费集 + readZcodeSession
 * （设计 §1.5 对外主函数契约锚）：converter / 访问层（开库 + 行集 + schema 闸门 +
 * 库路径投影）/ 错误形态 / 归一化。驱动适配与恢复阶梯的内部件（sqlite-driver 全部、
 * recovery 的编排/快照/计数件）不经包面导出——现生产消费方走 openZcodeSessionDb +
 * convertZcodeTranscript 组合形态，包内测试走相对路径。
 */

export { SqliteUnreadableError, type RecoveryLevel } from './recovery.ts'

export {
  ZcodeSchemaDriftError,
  hostZcodeDbPath,
  zcodeImportDbAllowlist,
  zcodeIsolatedDbPath,
  openZcodeSessionDb,
  type ZcodeReadonlyDb,
  type ZcodeSessionRow,
} from './sqlite-access.ts'

export { convertZcodeTranscript, readZcodeSession } from './converter.ts'

export { normalizeZcodeSessionId, zcodeCandidateKey } from './normalize.ts'
