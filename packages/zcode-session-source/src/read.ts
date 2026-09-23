/**
 * db 读取 + 纯转换组合（zcode source 包对外主函数 readZcodeSession 的承载，自
 * converter.ts 拆出：converter 聚焦纯转换映射，本文件持有开库 → 查 session 行 →
 * 转换 → dispose 的组合编排）。
 */

import type { NormalizedSession } from '@zhushanwen/session-core'

import { convertZcodeTranscript } from './converter.ts'
import { openZcodeSessionDb } from './sqlite-access.ts'

/**
 * 读单会话并转换为 NormalizedSession（zcode source 包对外主函数，D1）。
 *
 * 契约面说明：现生产消费方（reader 扩展 / runtime 导入薄包装）均走
 * openZcodeSessionDb + convertZcodeTranscript 组合形态（各自持有分相位错误映射），
 * 本函数当前无生产调用方——保留导出是设计 §1.5 声明的对外主函数（未来第三源契约锚），
 * 第二源落地前的契约面。
 *
 * 开库走 sqlite-access 的 openZcodeSessionDb（存在性 → 四级恢复阶梯 → schema 已知集
 * 闸门）；返回值三键 {header, entries, degradations}（NormalizedSession，session-core
 * 类型强制）。db 行存在性在查询阶段复查（定位校验与会话读取间的竞态窗口）。
 *
 * 错误面（归消费侧，调用方按各自词表映射——reader → zcode_* / runtime 导入 → import_*）：
 * - db 文件不存在 / 恢复阶梯耗尽 → Error（sqlite-access 抛出，消息含路径与已尝试级别）
 * - schema 版本超出已知集 → ZcodeSchemaDriftError（观测版本在 observedVersion 字段）
 * - session 行不存在（zcode 侧 GC / 从未落库）→ Error，消息含 sessionId 与事实归因
 * - 行 data 列 JSON 非法（schema 漂移域）→ 原始 Error 上抛（sqlite-access 不静默跳过）
 */
export async function readZcodeSession(dbPath: string, sessionId: string): Promise<NormalizedSession> {
  const handle = await openZcodeSessionDb(dbPath)
  try {
    const row = handle.db.getSessionRow(sessionId)
    if (!row) {
      throw new Error(
        `该会话已不在 zcode 库中（sessionId=${sessionId}）：该 id 可能已被 zcode 侧回收或从未落库`,
      )
    }
    const transcript = handle.db.getSessionTranscript(sessionId)
    return convertZcodeTranscript(transcript, { id: sessionId, title: row.title, timeCreated: row.timeCreated })
  } finally {
    handle.dispose()
  }
}
