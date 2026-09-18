/**
 * Electron IPC 通道名 SSOT（renderer → main 方向，u-foundation）。
 *
 * 现状边界：本文件只登记**新增**通道名。preload.ts / main gateway 既有通道
 * （'runtime-port' / 'browser:create' / 'update:check' / 'sound:list' 等）仍为
 * 字符串字面量内联在 ipcRenderer.invoke / ipcMain.handle 两侧，不在本文件收敛
 * （纯新增原则，不改既有语义；存量迁移属独立清理项，不随崩溃韧性方案夹带）。
 *
 * 命名惯例（对齐 preload.ts 既有 electronAPI 两式并存）：
 * - 单动作扁平 kebab-case：'renderer-log'（同 'runtime-port' / 'open-external' / 'reveal-in-folder'）
 * - 领域通道族 `domain:action` 冒号式：'image-cache:write'（同 'browser:create' / 'update:check' / 'sound:list'）
 *
 * 消费方：u2-renderer-errors（RENDERER_LOG）· u7-memory-governance（IMAGE_CACHE_WRITE）。
 * preload / main 两侧 handler 注册时必须 import 此处常量，禁止字面量分叉。
 */

/**
 * renderer → main 日志上报通道 [D2]。
 *
 * invoke 通道：renderer 错误三件套（app.config.errorHandler / window.onerror /
 * unhandledrejection）捕获后经此上报；payload 含错误栈 + performance.memory 快照 +
 * sessionId；windowId 不入 payload，由 main 从 invoke event.sender 权威读取（不信任
 * renderer 自报），main 落盘 logs/renderer-error-<date>.log 并按 windowId 限流
 * （每窗口每分钟 100 条，超限合并汇总行）。选扁平 kebab-case：与 'runtime-port'
 * 等「单动作上报」通道同型，不属既有冒号领域族。
 */
export const RENDERER_LOG = 'renderer-log' as const

/**
 * toolResult 图片落盘通道 [D6-⑨]。
 *
 * invoke 通道：renderer 无 fs，toolResult 的 base64 图片经此委托 main 异步写盘
 * `~/.taiji/cache/images/<sessionId>/<sha256(data)>.<ext>`（ext 按 mimeType
 * 映射 .png/.jpg/.webp/.gif，缺省 .png），main 回填路径引用
 * （纯缓存语义：可随时丢弃、可幂等重建）。'image-cache:*' 通道族首成员，后续
 * 同族新增通道沿用该前缀；清理/删除不设 renderer 入口（session 删除级联、孤儿
 * 扫描、软上限均为 main 侧内部生命周期）。选冒号式：对齐 'browser:*' 领域族惯例。
 */
export const IMAGE_CACHE_WRITE = 'image-cache:write' as const

/**
 * logs 保留期清理手动触发通道 [A9② 验收调试口]。
 *
 * invoke 通道：renderer（dev 控制台 / 调试脚本）经此触发 main 侧 `runLogRetentionNow()`
 * 立即执行一次 logs/ 超龄清理扫描（main-logger init 与每日定时器走同一函数），返回
 * 清理统计 {scanned, removed}——验证「清理不只启动时跑」（配 TAIJI_LOG_KEEP_DAYS 小保留期
 * + 手动触发，断言超龄 runtime-* / pi-* 文件被清、固定名 stderr 文件不误删）。
 *
 * **验收调试入口，无鉴权面（本地 app 内），不进任何产品 UI**——仅 dev 调试用途，
 * renderer 产品代码不得调用。选冒号式 `debug:*`：对齐 'image-cache:write' 领域族惯例，
 * debug 前缀标识其非产品语义。
 */
export const DEBUG_RUN_LOG_RETENTION = 'debug:run-log-retention' as const

/**
 * 诊断包导出通道 [crash-forensics-and-watchdog §3.3 D6，实施计划 u3a]。
 *
 * invoke 通道：renderer（u3b 设置页 系统 分区 / 死态静态错误页入口）经此委托 main 打包
 * 诊断 zip——双台账现档 + 各层日志尾部 + 水位摘录 + 触发条件状态表 + summary.md（清单
 * 以 export-diagnostic-bundle.ts 头注释为准）。main 侧先弹保存对话框（用户自选保存位置，
 * D6），取消返回 { status: 'canceled' }；打包失败零抛错归一进 result.error（含具体
 * errno），invoke 无 rejection 面。选冒号式 `diagnostics:*`：对齐 'image-cache:*' /
 * 'debug:*' 领域族惯例，后续同族诊断通道沿用该前缀。
 */
export const DIAGNOSTICS_EXPORT_BUNDLE = 'diagnostics:export-bundle' as const
