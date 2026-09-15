/**
 * 自动升级相关共享类型（前端 + main + preload 三方共享）。
 * 定义来源：slice auto-update-and-install DM3。
 */

/**
 * 更新来源（发布渠道）。
 * - 'github'：GitHub Releases（原唯一源）
 * - 'atomgit'：AtomGit Releases（发布流程自 GitHub 单向同步，内容一致）
 */
export type UpdateSource = 'github' | 'atomgit'

/**
 * 更新来源偏好（UpdateSettings.updateSource 的值域）。
 * 'auto' = 自动决定源顺序（默认）；显式 'github' / 'atomgit' = 该源优先
 * （优先级语义而非独占，任一环节失败仍自动经另一源完成升级）。
 */
export type UpdateSourcePref = 'auto' | UpdateSource

/**
 * 最新 Release 信息（已解析、按平台分流后的结构）。
 * 由 main 进程 ReleaseChecker.checkForLatestRelease 返回，preload 透传给 renderer。
 */
export interface LatestReleaseInfo {
  /** strip 前导 v 后的纯 3 位版本号（如 '0.9.0'） */
  version: string
  /** 原始 tag（如 'v0.9.0'） */
  tagName: string
  /** Release body 原文 markdown */
  releaseNotes: string
  /** 发布时间 ISO 8601 */
  publishedAt: string
  /** release 页面 URL（备用跳转） */
  htmlUrl: string
  /** 按平台分流的产物资产（缺失平台为 undefined） */
  assets: {
    macArm64Dmg?: ReleaseAsset
    winX64Exe?: ReleaseAsset
    linuxX64AppImage?: ReleaseAsset
  }
  /**
   * 该 release 的来源渠道（多源改造 D7）。
   * 随 pending/preloaded 落盘 JSON 自然携带；undefined = 旧版落盘文件（向后兼容，
   * 恢复后维持单源行为，不触发跨源降级）。消费点仅下载降级（确定对侧源），
   * install 链路与前端状态机不读。
   */
  source?: UpdateSource
}

/**
 * 单个 Release 资产。
 * sha256 来自 GitHub asset.digest strip 'sha256:' 前缀，或 manifest fallback
 * （AtomGit 源唯一来源）；缺失时为 undefined。
 */
export interface ReleaseAsset {
  /** 文件名（如 'TaiJi-mac-arm64.dmg'） */
  name: string
  /** 下载直链（browser_download_url） */
  downloadUrl: string
  /**
   * 文件大小（字节）。AtomGit API 不返回 size（实测响应无此字段），
   * 由 manifest fallback 填充（GitHub API size 恒有）；缺失为 undefined。
   */
  size?: number
  /** sha256 hex（缺失为 undefined） */
  sha256?: string
}

/** 升级流程的阶段（用于前端进度展示）。校验中态已随批次 3 删 update:perform 移除（m3：唯一推送点不存在） */
export type UpdateStage = 'downloading' | 'replacing' | 'restarting'

/** 升级流程的整体状态机 */
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'replacing'
  | 'restarting'
  | 'error'
  | 'unsupported'

/**
 * update:check 的返回形状（批次 4 RM2.3 信号透传，2026-08 一致性审查补齐）。
 *
 * 三态诚实建模：有新版（info 非空）/ 确认无新版（info=null）/ 被限额未知
 * （rateLimited=true，main 侧退避窗口内零联网短路）——限额不再并入「无新版」，
 * renderer 据此显示非侵入提示而非假阴性。main 侧退避窗口见 release-checker。
 */
export interface UpdateCheckResult {
  /** 检测到的新版信息；无新版/失败/被限额时为 null */
  info: LatestReleaseInfo | null
  /** true = 本次 null 是因为更新检查服务限流退避中（非「无新版」） */
  rateLimited: boolean
}

/**
 * update:install 的返回形状（update-network-resilience D2 交错缓解）。
 *
 * version = 实装版本（install 时从 preloaded 登记读取）：手动认领与后台
 * 预下载存在并发覆写窗口，UI 确认版本与实装版本可能不一致，renderer 进入
 * restarting 态前以本字段对齐 state.latestRelease（preload / lib/ipc.ts 签名已同步）。
 */
export interface UpdateInstallResult {
  /** true = 升级已触发、app 即将退出重启 */
  triggerRestart: boolean
  /** 实装版本（如 '0.9.12'；读取失败等容错场景为 undefined） */
  version?: string
}

/**
 * 升级错误事件 payload（main → preload → renderer 全链路透传，D3）。
 *
 * preload.ts onUpdateError 和 renderer lib/ipc.ts 的类型签名必须与此一致。
 */
export interface UpdateErrorPayload {
  stage: string
  message: string
  errorCode?: string
  suggestion?: string
}

/**
 * 代理配置接口。
 * 支持三种模式：
 * - system：自动检测系统代理
 * - manual：手动配置代理地址
 * - disabled：禁用代理
 */
export interface IProxyConfig {
  /** 代理模式 */
  mode: 'system' | 'manual' | 'disabled'
  /** 手动模式下的 HTTP 代理地址（如 http://127.0.0.1:7890） */
  httpProxy?: string
  /** 手动模式下的 HTTPS 代理地址（如 http://127.0.0.1:7890） */
  httpsProxy?: string
}

/**
 * 升级设置接口（main 进程持久化，前端经 IPC 读写）。
 *
 * 字段：
 * - preDownload：检测到新版时是否自动在后台预下载安装包。开启后点击更新跳过下载等待。
 *   默认 false（新用户不自动消耗流量/磁盘，需主动开启）。
 * - autoUpdate：启动时自动检查更新并提示下载（v6 demo 语义）。默认 true
 *   （2026-08-28 拍板，设计 §3.6 RM1；存量用户现状即自动检查，见 update-settings.ts）。
 *   可选字段：调用方可以只传部分字段做局部更新（setUpdateSettings 内部与现有值合并）。
 * - updateSource：更新来源偏好（'auto' / 'github' / 'atomgit'）。默认/缺省 'auto'。
 */
export interface UpdateSettings {
  /** 检测到新版时自动后台预下载 */
  preDownload: boolean
  /** 启动时自动检查更新并提示下载 */
  autoUpdate?: boolean
  /**
   * 更新来源偏好：'auto'（自动决定源顺序，默认）/ 'github' / 'atomgit'。
   * 语义为「优先级」而非「独占」——显式选择某源 = 该源优先，失败仍自动降级另一源。
   * 可选 + 缺省/非法值回退 'auto'：旧 settings 文件无此字段 = 'auto'（向后兼容）。
   */
  updateSource?: UpdateSourcePref
}

/**
 * 代理测试结果载荷（main → preload → renderer）。
 *
 * 失败时含错误码与建议，renderer 据此展示两段式测试结果。
 */
export interface ProxyTestResult {
  /** 测试是否成功 */
  success: boolean
  /** 错误码（失败时） */
  code?: string
  /** 错误摘要（失败时） */
  message?: string
  /** 解决建议（失败时） */
  suggestion?: string
}

/**
 * 启动结果终态状态值（D5 决策：升级成功/失败/回滚三态通知）。
 * cleanupCompletedUpdate 返回的 LaunchResult.status 仅限这三个值，
 * no-op（中断但无需回滚）不通知 renderer，返回 null。
 */
export const LAUNCH_RESULT_STATUSES = ['done', 'failed', 'rolled-back'] as const

/** 启动结果终态类型（三值联合） */
export type LaunchResultStatus = (typeof LAUNCH_RESULT_STATUSES)[number]

/** 启动结果信息（main → renderer 一次性通知） */
export interface LaunchResult {
  /** 终态类型 */
  status: LaunchResultStatus
  /** 版本号（升级成功=新版本，回滚=恢复到的旧版本） */
  version: string
  /**
   * 升级失败原因码（仅 status='failed' 时可能存在）。
   * 来源 = update-result.json 的 error 字段（升级脚本 fail() 写入，如 'sha mismatch'），
   * self-healer 构造 LaunchResult 时透传；renderer 据此映射具体失败文案（A-D1）。
   * 缺失/非字符串（旧版 result.json / 容错）→ undefined，renderer 回退通用文案。
   */
  error?: string
}

/**
 * 版本解析错误码（批次 3 信任锚 RC1）：update:download 请求的版本落后于权威 latest
 * （任一源胜出的 /releases/latest 实测值 ≠ 请求值）。renderer 收到此码后自动重新检查更新，
 * 拿到更新的 latest 再展示，而非重试旧版本（useAppUpdate.onUpdateError 处理）。
 *
 * 已并入 main 侧 types.ts 的 UpdateErrorCode 闭联合与 UPDATE_ERROR_MESSAGES 文案表。
 */
export const UPDATE_STALE_RELEASE = 'UPDATE_STALE_RELEASE'
