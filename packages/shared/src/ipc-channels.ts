/**
 * Electron IPC 通道名 SSOT（preload ↔ main ↔ renderer 三侧，u-foundation）。
 *
 * 全量通道收敛：preload（ipcRenderer.invoke/on）与 main（ipcMain.handle /
 * webContents.send）两侧注册一律 import 此处常量，禁止字面量分叉（renderer 经
 * preload electronAPI 方法面间接消费，不持通道名）。invoke 通道（renderer → main）
 * 与 main → renderer 推送通道（runtime-port / browser:state 等）都在册。
 *
 * 命名惯例（对齐 preload.ts 既有 electronAPI 两式并存）：
 * - 单动作扁平 kebab-case：'renderer-log'（同 'runtime-port' / 'open-external' / 'reveal-in-folder'）
 * - 领域通道族 `domain:action` 冒号式：'image-cache:write'（同 'browser:create' / 'update:check' / 'sound:list'）
 *   领域前缀内层同用 kebab-case（image-cache / debug / diagnostics）；例外 = `localFile:` 族
 *   （`localFile:servable` / `localFile:read`，均为设计/ADR 逐字记录值）
 *   ——该族字面量已由设计 §6.9 D9 / ADR-0118 第 3 条与 renderer 侧 lib/ipc、preload/index.d.ts
 *   注释逐字记录为契约，改 kebab 会与设计/ADR 记录漂移，故保持设计字面量，此处只做 SSOT 收敛。
 *
 * 消费方：u2-renderer-errors（RENDERER_LOG）· u7-memory-governance（IMAGE_CACHE_WRITE）·
 * chat-html-support u2-infra（LOCAL_FILE_SERVABLE / LOCAL_FILE_READ）。
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
 * `<dataDir>/ext-sessions/<sessionId>/image-cache/<sha256(data)>.<ext>`（session 存储
 * 树域 3；ext 按 mimeType 映射 .png/.jpg/.webp/.gif，缺省 .png），main 回填路径引用
 * （纯缓存语义：可随时丢弃、可幂等重建）。'image-cache:*' 通道族首成员，后续
 * 同族新增通道沿用该前缀；清理/删除不设 renderer 入口（session 删除随整树软删、
 * 孤儿扫描、软上限均为 main 侧内部生命周期）。选冒号式：对齐 'browser:*' 领域族惯例。
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
 * 诊断 zip——双条目清单现档 + 各层日志尾部 + 水位摘录 + 触发条件状态表 + summary.md（清单
 * 以 export-diagnostic-bundle.ts 头注释为准）。main 侧先弹保存对话框（用户自选保存位置，
 * D6），取消返回 { status: 'canceled' }；打包失败零抛错归一进 result.error（含具体
 * errno），invoke 无 rejection 面。选冒号式 `diagnostics:*`：对齐 'image-cache:*' /
 * 'debug:*' 领域族惯例，后续同族诊断通道沿用该前缀。
 */
export const DIAGNOSTICS_EXPORT_BUNDLE = 'diagnostics:export-bundle' as const

/**
 * 会话 JSONL 导出通道（2026-10-12 立项）。
 *
 * invoke 通道：renderer（SessionItemContextMenu 右键菜单「导出 JSONL」）经此委托 main 把
 * 该会话的 pi session JSONL 文件复制到用户自选位置——main 先弹保存对话框（用户确认落点，
 * 对齐 DIAGNOSTICS_EXPORT_BUNDLE 先例），取消返回 { status: 'canceled' }；源路径为
 * renderer 半可信输入，main 侧必须先校验位于会话文件三棵树
 * `<piAgentDir>/sessions|subagents|btw` 之内（SessionJsonlExportResult 三态契约见
 * ipc-payloads.ts；校验失败拒绝并报错，不 fallback）。选冒号式 `session:*`：对齐
 * 'diagnostics:*' / 'image-cache:*' 领域族惯例，后续同族会话通道沿用该前缀。
 */
export const SESSION_EXPORT_JSONL = 'session:export-jsonl' as const

/**
 * local-file servable 预检通道 [chat-html-support §6.9 D9，ADR-0118 第 3 条]。
 *
 * invoke 通道：renderer（内联预览容器 HtmlPreviewInline 经 deps `probeArtifact?` 挂载前
 * 预检——v16 唯一渲染面）传绝对路径，main 侧返回 `{ servable, reason?, size? }`（reason ∈
 * `not_found` / `is_dir` / `out_of_whitelist`）——谓词与 `protocol.handle('local-file')` 复用同一规范化管线模块
 * （准入前缀成员资格先行短路 → 存在性 → 目录性；越界不触 fs，杜绝存在性探测通道）；
 * 通道准入前缀 = 会话产物子树 `<dataDir>/ext-sessions/<sid>/artifacts/**`（按现存会话
 * 枚举——读/预检通道收窄面，非协议 handler 全量白名单——通道入参含模型消息文本路径载荷，
 * 见 computeLocalFileReadPrefixes）。
 * 通道名 `localFile:servable` 为设计/ADR 逐字记录值（见文件头命名惯例注），不随 kebab 惯例改名。
 */
export const LOCAL_FILE_SERVABLE = 'localFile:servable' as const

/**
 * local-file 源码内容读取通道 [chat-html-support §8.2 S3「切换『源码』看到 shiki 高亮」]。
 *
 * invoke 通道：内联容器源码态（deps readArtifact）与 DetailPane 变更集/文件树产物源码读取
 * （useDetailPane loadPreviewContent）传绝对路径，main 侧返回
 * `{ ok: true, content, truncated }` 或 `{ ok: false, reason }`（reason ∈ servable 三原因 +
 * `read_failed`）——谓词与 `LOCAL_FILE_SERVABLE` / 协议 handler 复用同一白名单模块
 * （准入前缀成员资格先行短路 → 存在性 → 目录性；越界不触 fs）；通道准入前缀 = 产物子树
 * `<dataDir>/ext-sessions/<sid>/artifacts/**`（按现存会话枚举——读通道收窄面，非协议
 * handler 全量白名单——`<dataDir>` 整前缀含 pi agent 目录凭据，文本读取面限定在实际消费域）。
 * 为何需要独立通道：产物目录 `<dataDir>/ext-sessions/<sessionId>/artifacts/` 在 session cwd 外（§6.7 D7），
 * runtime `file.read` 的 cwd 守门对主要产物路径不可达，源码态需与 servable 同源的读取面。
 * 通道名沿用 `localFile:` 族前缀（与 `LOCAL_FILE_SERVABLE` 同一族，见文件头命名惯例注）。
 */
export const LOCAL_FILE_READ = 'localFile:read' as const

// ── runtime 域（端口 / token / 启动失败 / 重启）──────────────────────────────
// 生产点：main gateway/bridge-handlers（invoke 族）+ supervisor（推送族）；
// 消费点：preload electronAPI + renderer 连接编排（use-connection / transport）。

/** runtime 就绪端口推送（main → renderer；supervisor 启动成功/重启成功广播）。 */
export const RUNTIME_PORT = 'runtime-port' as const
/** runtime 启动失败推送（main → renderer；payload { message }）。 */
export const RUNTIME_ERROR = 'runtime-error' as const
/** runtime 崩溃后自动重启中推送（main → renderer；payload { attempt }）。 */
export const RUNTIME_RESTARTING = 'runtime-restarting' as const
/** runtime 自动重启用尽推送（main → renderer；payload { attempts, message }）。 */
export const RUNTIME_FAILED = 'runtime-failed' as const
/** 读取 runtime 目标快照（invoke；payload = RuntimeTargetSnapshot {seq, runtimeId, port, token}，
 *  connection-datasync-ssot §6.1：连接目标单一权威读口——supervisor 每次 spawn 更新快照，
 *  renderer 启动与重连前经此拉取 {seq, runtimeId, port, token} 并置目标）。 */
export const GET_RUNTIME_TARGET_SNAPSHOT = 'get-runtime-target-snapshot' as const
/** 读取最近一次启动失败真因（invoke；RD-3#2 boot 竞态拉取兜底）。 */
export const GET_RUNTIME_START_ERROR = 'get-runtime-start-error' as const
/** 请求手动重启 runtime（invoke；崩溃重启用尽后用户点重试触发）。 */
export const RUNTIME_RESTART = 'runtime-restart' as const

// ── 窗口 / 对话框 / 系统集成族（扁平 kebab）──────────────────────────────────

/** 创建新窗口（invoke；可选携带 sessionId 迁移）。 */
export const CREATE_WINDOW = 'create-window' as const
/** 读取窗口状态列表（invoke）。 */
export const GET_WINDOWS = 'get-windows' as const
/** 聚焦指定窗口（invoke）。 */
export const FOCUS_WINDOW = 'focus-window' as const
/** 窗口列表变化推送（main → renderer；创建/关闭/更新）。 */
export const WINDOW_LIST_UPDATED = 'window-list-updated' as const
/** 最小化当前窗口（invoke；win/linux 自绘圆点点击）。 */
export const WINDOW_MINIMIZE = 'window-minimize' as const
/** 最大化/还原切换（invoke）。 */
export const WINDOW_TOGGLE_MAXIMIZE = 'window-toggle-maximize' as const
/** 关闭当前窗口（invoke）。 */
export const WINDOW_CLOSE = 'window-close' as const
/** macOS 全屏状态变化推送（main → renderer；payload { isFullscreen }）。 */
export const FULLSCREEN_CHANGED = 'fullscreen-changed' as const
/** 打开目录选择对话框（invoke）。 */
export const PICK_DIRECTORY = 'pick-directory' as const
/** 打开文件选择对话框（invoke）。 */
export const PICK_FILE = 'pick-file' as const
/** 用系统默认浏览器打开外链（invoke；main 校验 http/https）。 */
export const OPEN_EXTERNAL = 'open-external' as const
/** 在文件管理器中显示文件（invoke；main 校验绝对路径）。 */
export const REVEAL_IN_FOLDER = 'reveal-in-folder' as const
/** 读取数据目录展示路径（invoke；~ 缩写形式）。 */
export const GET_DATA_DIR = 'get-data-dir' as const

// ── shortcut 族（键转发推送）────────────────────────────────────────────────
// 生产点：main shortcut-registry / window-factory / browser/gateway/forward-keys。

/** app 快捷键事件推送（main → renderer；payload = type 字符串）。 */
export const SHORTCUT = 'shortcut' as const
/** view 转发键推送（main → renderer；payload { accelerator }，display-containers §7.4）。 */
export const SHORTCUT_FORWARD = 'shortcut:forward' as const

// ── browser:* 族（嵌入式浏览器 WebContentsView 生命周期，display-containers）──

/** 创建 WebContentsView 并 attach 到指定窗口（invoke）。 */
export const BROWSER_CREATE = 'browser:create' as const
/** 导航到指定 URL（invoke）。 */
export const BROWSER_NAVIGATE = 'browser:navigate' as const
/** 隐藏 view（invoke；keep-alive 不销毁）。 */
export const BROWSER_HIDE = 'browser:hide' as const
/** 显示请求（invoke；恢复最近 rect）。 */
export const BROWSER_SHOW = 'browser:show' as const
/** 切换可见 view 到指定 session（invoke）。 */
export const BROWSER_FOCUS = 'browser:focus' as const
/** 设置 view 位置/尺寸（invoke；CSS px = DIP）。 */
export const BROWSER_SET_RECT = 'browser:set-rect' as const
/** 销毁 view（invoke；removeChildView + webContents.destroy）。 */
export const BROWSER_DESTROY = 'browser:destroy' as const
/** 历史后退（invoke；Wave 5）。 */
export const BROWSER_BACK = 'browser:back' as const
/** 历史前进（invoke；Wave 5）。 */
export const BROWSER_FORWARD = 'browser:forward' as const
/** 设置缩放因子（invoke；Wave 5）。 */
export const BROWSER_SET_ZOOM = 'browser:set-zoom' as const
/** 读取缩放因子（invoke；Wave 5）。 */
export const BROWSER_GET_ZOOM = 'browser:get-zoom' as const
/** 读取 view 内当前选区 + URL（invoke；Wave 6 预留）。 */
export const BROWSER_GET_SELECTION = 'browser:get-selection' as const
/** 浮层开合/内容切换上报（invoke；payload 见 shared OverlayContentKind 通道契约）。 */
export const BROWSER_OVERLAY_STATE = 'browser:overlay-state' as const
/** shieldsView 遮蔽面全量上报（invoke；payload 见 shared ShieldsFacesPayload）。 */
export const BROWSER_SHIELDS = 'browser:shields' as const
/** 转发键清单上报（invoke；全量 set / 增量 add+remove 两形态共用）。 */
export const BROWSER_FORWARD_KEYS = 'browser:forward-keys' as const
/** view 状态变化推送（main → renderer；payload = BrowserFrameState，ipc-payloads.ts）。 */
export const BROWSER_STATE = 'browser:state' as const

// ── update:* 族（自动升级检测 / 执行 / 设置 / 代理）──────────────────────────

/** 检测最新版本（invoke）。 */
export const UPDATE_CHECK = 'update:check' as const
/** 拆分升级的下载阶段（invoke；版本号化契约）。 */
export const UPDATE_DOWNLOAD = 'update:download' as const
/** 拆分升级的安装阶段（invoke；权威源 = 预下载产物）。 */
export const UPDATE_INSTALL = 'update:install' as const
/** 读取预下载产物（invoke）。 */
export const UPDATE_GET_PRELOADED = 'update:getPreloaded' as const
/** 读取启动结果（invoke；consumed 一次性）。 */
export const UPDATE_GET_LAUNCH_RESULT = 'update:getLaunchResult' as const
/** 读取代理配置（invoke）。 */
export const UPDATE_GET_PROXY_CONFIG = 'update:getProxyConfig' as const
/** 保存代理配置（invoke）。 */
export const UPDATE_SET_PROXY_CONFIG = 'update:setProxyConfig' as const
/** 测试代理连接（invoke；双引擎准绳 D8）。 */
export const UPDATE_TEST_PROXY = 'update:testProxy' as const
/** 读取升级提醒持久化标志（invoke）。 */
export const UPDATE_GET_PENDING = 'update:getPending' as const
/** 读取升级设置（invoke）。 */
export const UPDATE_GET_SETTINGS = 'update:getSettings' as const
/** 保存升级设置（invoke；局部更新）。 */
export const UPDATE_SET_SETTINGS = 'update:setSettings' as const
/** 打开手动升级产物目录（invoke；D9）。 */
export const UPDATE_OPEN_MANUAL_DIR = 'update:openManualDir' as const
/** 升级进度推送（main → renderer；payload { stage, percent }）。 */
export const UPDATE_PROGRESS = 'update:progress' as const
/** 升级错误推送（main → renderer；payload UpdateErrorPayload）。 */
export const UPDATE_ERROR = 'update:error' as const

// ── remote-access 族（设置面板连接信息）──────────────────────────────────────

/** 读取远程访问配置 + LAN 地址候选（invoke）。 */
export const GET_REMOTE_ACCESS_INFO = 'get-remote-access-info' as const
/** 轮换 remote token（invoke）。 */
export const ROTATE_REMOTE_ACCESS_TOKEN = 'rotate-remote-access-token' as const
/** 切换远程访问开关（invoke；开关变化且 runtime 在跑时触发重启）。 */
export const SET_REMOTE_ACCESS_ENABLED = 'set-remote-access-enabled' as const

// ── sound:* 族（系统提示音跨平台播放）────────────────────────────────────────

/** 列出当前平台可用系统提示音（invoke）。 */
export const SOUND_LIST = 'sound:list' as const
/** 播放系统提示音（invoke；win 返 wav base64）。 */
export const SOUND_PLAY = 'sound:play' as const
