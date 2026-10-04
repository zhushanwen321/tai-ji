import { existsSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'

import { zcodeImportDbAllowlist } from '@zhushanwen/zcode-session-source'

/**
 * zcode 会话库白名单闸（design session-reader-shared-core §3.1 第③步 / §3.3 D5 /
 * §3.4 检查顺序 / 探针 P-whitelist）。
 *
 * dbPath 来自 session 数据（manifest engineHandle.sessionRef / 主 session custom
 * entry），是**不可信输入**（会话文件可被构造）——开库前必须过本闸，白名单是必需
 * 闸而非可选优化。集合与 runtime 导入侧 `zcodeImportDbAllowlist(dataDir)` **同源
 * 同形**：隔离库（现役）+ 宿主库（存量兼容）两项，路径段单源 = 该函数内部引用的
 * `@zhushanwen/subagent-engine-sdk` zcode-db-paths 常量（跨侧契约根，禁手拼字面量
 * 段——SDK 头注「两侧必须同源推导，禁止各自拼字符串漂移」）。
 *
 * **检查顺序铁律（§3.4 三段递进，实现与测试双锚定）**：存在性先于路径——
 * `existsSync` 为 false 报 `zcode_db_unreadable`（库文件不存在）而非
 * `zcode_db_path_forbidden`，避免把「只是还没落库」误报成安全事件（forbidden 是
 * 安全面错误，语义更重、更惊扰 agent）。存在才 realpath 后与派生允许集合精确比对。
 * 开库（第 3 段）由调用方在本闸通过后进行。
 *
 * **TOCTOU 残留（设计 §3.4 显式登记，不在本梯队硬化）**：realpath 之后仍按原
 * dbPath 开库，两步间存在理论竞态窗口；利用它需攻击者具备同用户写权限，而同用户
 * 权限下本就可直接读该库——实测方向安全，fd 复用/O_NOFOLLOW 属纵深防御非实际威胁面。
 *
 * **realpath 对齐**：dbPath 与集合项都经 realpath 归一后再比对（realpath 失败——
 * 竞态删除/权限——按原串参与）。taiji 生产布局（`~/.taiji` 下无 symlink）两者等价；
 * macOS 临时目录（`/var` → `/private/var`）等 symlink 环境下不对齐会把合法库误判
 * 集合外，P-whitelist 单测按 tmp dataDir 布局锚定此语义。
 */

/** symlink 归一（失败按原串——不存在的路径进不了比对成功分支，由调用方顺序保证）。 */
function realOf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * dbPath 的派生允许集合（realpath 对齐后）：`zcodeIsolatedDbPath(dirname(agentDir))`
 * + `hostZcodeDbPath()`。F11：taiji 下 agentDir = `<dataDir>/agent` →
 * dirname(agentDir) = dataDir，与引擎侧/导入侧的隔离库推导同一 dataDir。纯 pi 宿主
 * （agentDir 退化为 `~/.pi/...`）下隔离库项恒不可达且不存在 taiji 派生的 zcode 锚
 * （D5「纯 pi 宿主边界」），无害，不需特例分支。
 */
export function zcodeDbAllowlistFor(agentDir: string): readonly string[] {
  return zcodeImportDbAllowlist(dirname(agentDir)).map(realOf)
}

/** `zcode_db_unreadable` 的 👉 恢复指引（§3.4 表逐行；隔离库路径运行时动态推导）。 */
export function formatZcodeDbUnreadable(dataDir: string, detail: string): string {
  const isolated = zcodeImportDbAllowlist(dataDir)[0]
  return (
    `[zcode_db_unreadable] zcode 会话库不可读（恢复阶梯 L1-L3 均未成功）。${detail}\n` +
    `👉 使原目录可写，或把库连 -wal/-shm 一起拷回白名单内原路径（隔离库 = ${isolated}）后重试。\n` +
    `⚠️ 告诫：缺 -wal 的库未 checkpoint 的已提交数据可能已丢——这是写者未干净退出造成的既成事实，非恢复引入；完整性以连 -wal 一起拷贝为准。`
  )
}

/** `zcode_db_path_forbidden` 的 👉 恢复指引（§3.4 表逐行）。 */
export function formatZcodeDbPathForbidden(dbPath: string): string {
  return (
    `[zcode_db_path_forbidden] 该会话引用的 zcode 库路径不在允许范围：${dbPath}\n` +
    `👉 在 taiji 内打开原会话读取，或用会话导入对话框导入后读取。`
  )
}

/**
 * 白名单闸（第 1 段存在性 → 第 2 段路径；通过才允许开库）。
 *
 * @throws Error（消费侧映射为 zcode_db_unreadable / zcode_db_path_forbidden，
 *         消息即 §3.4 的 👉 指引文案——tool-handler 直接 throw 给 pi 错误面）
 */
export function assertZcodeDbPathAllowed(dbPath: string, agentDir: string): void {
  // 第 1 段 存在性（先于路径——「还没落库」不是安全事件）
  if (!existsSync(dbPath)) {
    throw new Error(formatZcodeDbUnreadable(dirname(agentDir), `（库文件不存在：${dbPath}）`))
  }
  // 第 2 段 路径（存在才 realpath 比对；TOCTOU 残留见文件头注）
  const allowed = zcodeDbAllowlistFor(agentDir)
  if (!allowed.includes(realOf(dbPath))) {
    throw new Error(formatZcodeDbPathForbidden(dbPath))
  }
}
