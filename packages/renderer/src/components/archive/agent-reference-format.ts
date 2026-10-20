/**
 * session-archive D11「agent 引用视图」预检正文（纯函数）。
 *
 * 逐字复刻 session-reader extension 归档态返回正文（D7 字面契约：agent 必须能区分
 * 摘要与完整历史）——extension 侧权威实装在
 * `extensions/universal/session-reader/src/discovery/archive-ledger.ts` 的
 * formatArchivedText（其测试锁定字面）。renderer 无法 import extension 包（bundle
 * 隔离边界，同 shared/archive.ts 头注释登记的「bundle 隔离侧复制同语义实现」口径，
 * 但方向相反：extension 是运行时真值产出方，本函数只服务「用户预检 agent 将看到
 * 什么」的只读预览）。
 *
 * **同步锚（防漂移）**：本函数与 extension formatArchivedText 是同一 D7 契约的两份
 * 实现，任一侧改动（头部标注 / turn 分隔 / 尾注 / 占位字面）必须同步另一侧与两侧
 * 测试锚定字面。输入形态差异：extension 消费 ArchiveLedgerEntry（簿记消费子集），
 * 本函数消费 shared ArchiveSummary（config.archives DTO）；两输入的同名字段语义
 * 一致（name 空串 = 未命名）。
 *
 * 只覆盖 archived 态：renderer 的归档摘要视图在 staging 期渲染全区「摘要生成中」占位
 * （ArchiveSummaryView 内容区 v-if，双 tab 亦隐藏），staging 头部形态只存在于 agent
 * 侧真实返回（extension STAGING_HEADER）——本预检函数不为不可达形态维护副本。
 */
import type { ArchiveSummary } from '@taiji/shared'

/** 归档态摘要条目（预检函数的唯一输入形态；staging 期由组件占位，不进入本函数）。 */
type ArchivedSummary = Extract<ArchiveSummary, { status: 'archived' }>

/** 归档态头部标注（D7 字面契约，与 extension ARCHIVED_HEADER 同字面）。 */
const ARCHIVED_HEADER = '状态: 已归档 (archived) — 完整内容已压缩离线，以下仅为摘要'

/** 尾注恢复指引（D7 字面契约，与 extension RESTORE_NOTE 同字面）。 */
const RESTORE_NOTE = '注: 如需完整历史，请让用户在归档列表中恢复该会话。'

/** 纯图片/附件 user 消息占位（与 extension USER_ATTACHMENT_PLACEHOLDER 同字面）。 */
const USER_ATTACHMENT_PLACEHOLDER = '[图片/附件消息]'

/** turn 无 agent 文本占位（extension 侧重摘要语义、无「—— 摘要跳过该段」后缀，D7/D11 各自字面）。 */
const AGENT_NO_TEXT_PLACEHOLDER = '（此 turn 以工具调用结束，无文本回复）'

/**
 * 渲染 session_read 对归档 session 的返回正文（用户预检视图用）：
 * `[session-reader]` 头行 + 头部标注 + `── turn N ──` 分隔的摘要 turns
 * （user / assistant (摘要) 两行）+ 尾注恢复指引。
 */
export function formatArchiveAgentReference(archive: ArchivedSummary): string {
  const displayName = archive.name.length > 0 ? archive.name : archive.sessionId
  const lines: string[] = []
  lines.push(`[session-reader] session: ${displayName}`)
  lines.push(ARCHIVED_HEADER)
  for (let i = 0; i < archive.summary.turns.length; i++) {
    const turn = archive.summary.turns[i]!
    lines.push(`── turn ${i + 1} ──`)
    lines.push(`user: ${turn.user.length > 0 ? turn.user : USER_ATTACHMENT_PLACEHOLDER}`)
    lines.push(`assistant (摘要): ${turn.agent ?? AGENT_NO_TEXT_PLACEHOLDER}`)
  }
  lines.push(RESTORE_NOTE)
  return lines.join('\n')
}
