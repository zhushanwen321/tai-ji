/**
 * zcode → pi session 转换器（U4 占位 stub，session-import-unified 设计 §3.4 权威映射表：
 * T1 header/session_info / T2 user / T3+T3b+T3c assistant 分段与映射 / T4 tool output
 * 三形态 / T5 其余 part / T6 entry id 链）。U4 将整体替换本文件——签名是 U3 的
 * import-source-zcode.prepareImport 唯一耦合点，落地 write 前占位抛错（fail-fast，
 * 不产出半成品文件）。
 *
 * 产物正确性锚（§3.4 末）：产物必须能被 replayEntries(applyEntry) 重放消费——
 * U4 的 converter.test 以此为可证伪断言。
 */

import type { ZcodeReadonlyDb } from './sqlite-access.js'

/** 目标 pi header（与 ImportArtifact.header 同构；由 U3 的 T1 逻辑产出后传入）。 */
export interface ZcodeImportHeader {
  id: string
  timestamp: string
  cwd: string
}

/**
 * 把 sessionId 全量转换流式写到 tmpPath（编排层负责 mkdir/rename/清理，本函数只写
 * tmpPath）。U4 实现要求：首行 header + 第 2 行 session_info（T1）+ T6 确定性 id 链；
 * degradations 收集（D6/D7）经返回值或回调上抛——接口细节 U4 定稿。
 *
 * @param db        只读连接（sqlite-access 产出；转换全程只读，G4）
 * @param sessionId zcode 原始 session.id（sess_ 前缀形态，SQL 查询主键）
 * @param header    目标 pi header（id 已归一化，timestamp = ISO(time_created)）
 * @param tmpPath   编排层给定的临时落地路径
 */
export async function writeZcodeSessionFile(
  db: ZcodeReadonlyDb,
  sessionId: string,
  header: ZcodeImportHeader,
  tmpPath: string,
): Promise<void> {
  void db
  void sessionId
  void header
  void tmpPath
  throw new Error('U4-pending: zcode→pi 转换器尚未实现（设计 §3.4 映射表，由 U4 落地）')
}
