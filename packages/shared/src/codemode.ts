/**
 * codemode 域 WS 协议契约（runtime ↔ renderer 共享，接口先行）。
 *
 * 命令对 `config.getCodemodeEnabled` / `config.setCodemodeEnabled`（codemode 设计 D1：
 * 设置页开关经 services port 读写 settings.json `defaultTools` 字段域）。本文件只承载
 * payload/reply 的类型定义，供两端共同 import 防止裁量漂移；消息类型字符串与
 * type→payload 映射登记在 shared protocol.ts（受 ReplyPayloadMap 类型约束，新增命令
 * 须五处挂接：ClientMessageType / ClientMessageMap / ServerMessageType /
 * ServerMessageMap / ReplyPayloadMap），case 分发由 runtime transport 层 handler
 * 登记。
 *
 * 损坏错误态（codemode 设计 A1，fail-fast 裁决）：settings.json 非法 JSON 时——
 * get 返回错误态（enabled=false + corruption 有值，不走默认读路径，避免 get 自身触发
 * 隔离改名）；set 在写入前拒入。损坏检测每次现查，用户修复文件后重试即恢复，无需重启。
 */

/**
 * settings.json 损坏错误态形状（设计 A1 检测的两种损坏形态的协议投影）：
 * ①原路径存在但 JSON 非法；②原路径已被其他读方自动隔离为 `.corrupt-<时间戳>` 副本。
 * 字段即 D3 错误态渲染所需：完整路径（带复制按钮）+ 隔离副本提示。
 */
export interface CodemodeSettingsCorruption { // oe-exempt:20261004:framework:WS 协议契约类型（runtime↔renderer 共享防裁量漂移），协议形状先行单实现常态
  /** settings.json 完整路径（用户定位与修复入口） */
  filePath: string
  /** 已被自动隔离时的副本路径（原内容可从此找回）；未被隔离 = null */
  corruptCopyPath: string | null
}

/** `config.getCodemodeEnabled` 响应（设计 A1 读侧错误态）：损坏时 enabled=false + corruption 有值。 */
export interface CodemodeEnabledResult { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  enabled: boolean
  corruption: CodemodeSettingsCorruption | null
}

/** `config.setCodemodeEnabled` 请求：目标态（增量条目规范化等写入语义归 runtime 侧）。 */
export interface CodemodeSetEnabledRequest { // oe-exempt:20261004:framework:WS 协议契约类型（两端共同 import），协议形状先行单实现常态
  enabled: boolean
}

/**
 * `config.setCodemodeEnabled` 响应（两态信封，同 LlmRetryValidationResult 判别式风格）：
 * 成功 = 写后落盘终态（写入含幂等不动 / 占位追加等规范化分支，renderer 以服务端终态
 * 校准开关显示）；损坏拒绝 = 设计 A1 写点拒入，error 含拒绝原因，corruption 含路径与
 * 隔离副本提示（D3 错误态渲染同源）。
 */
export type CodemodeSetEnabledResult =
  | {
      ok: true
      enabled: boolean
    }
  | {
      ok: false
      error: string
      corruption: CodemodeSettingsCorruption
    }
