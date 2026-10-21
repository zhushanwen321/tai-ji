/**
 * 羊毛 provider 域 —— taiji 宿主侧类型 SSOT（wool-provider 设计 D2/D6/D7）。
 *
 * 分工边界：本文件只承载 **taiji 侧**消费的类型（WS 帧 payload / 资产清单 schema /
 * 向导状态机 / 运行态视图）。与羊毛扩展侧共享的管理指令协议（envelope 编解码、
 * 账号状态 schema、错误码词表）权威在 `extensions/shared/wool-shared`（pi 扩展进程
 * 内消费），packages/shared 不依赖 extensions 包——两侧对齐的字段在此注释指向
 * wool-shared 对应模块，字段漂移由各自包内测试锚定（wool-shared 管理协议测试 +
 * 本域 WS 帧测试）。
 *
 * 权威源声明（设计 D6 ③）：羊毛模型清单权威 = pi registry；taiji 侧 catalog 视图
 * 是派生缓存（标注数据时点），缓存刷新时机由 wool-manager 编排（向导完成 / 手动 /
 * 报错触发 / 安装完成）。
 */

// 家族 id 词表与 @zhushanwen/pi-wool-shared types.ts WOOL_FAMILY_IDS 对齐（新增家族
// 两处同批扩展；wool-shared 是运行时协议权威，此处是宿主展示面词表）。
export const WOOL_FAMILY_IDS = ['qoder', 'trae', 'workbuddy'] as const
export type WoolFamilyId = (typeof WOOL_FAMILY_IDS)[number]

/** 凭据来源两值（设计 D3；与 wool-shared WoolCredentialsSource 对齐）。 */
export type WoolCredentialsSource = 'ide-extract' | 'oauth'

// ── 资产清单 schema（设计 D2：家族 → 版本 + 完整性散列，taiji 官方发布通道维护）──

/** 清单内单家族条目：安装钉版本 + 展示元数据（向导家族卡数据源，D7 宿主渲染不执行扩展 UI 代码）。 */
export interface WoolManifestFamily {  // oe-exempt:20261022:framework:资产清单 JSON schema 的家族条目族，清单格式钉版本（D2）
  /** npm 包名（含 scope，如 `@zhushanwen/pi-wool-qoder`）。 */
  pkg: string
  /** 钉定版本（semver 字面量；安装命令 `npm:<pkg>@<version>`，散列校验归 npm/既有安装链）。 */
  version: string
  /** 完整性散列（预留字段：`<alg>:<hex>` 形态；当前安装链以 npm registry integrity 为准，清单侧记录供审计比对）。 */
  integrity?: string
  /** 家族显示名（如 `Qoder`）。 */
  displayName: string
  /** 厂商标注（家族卡副标题，如 `阿里`）。 */
  vendor: string
  /** 凭据来源（决定向导渲染哪个模板，D7）。 */
  credentialsSource: WoolCredentialsSource
  /** 风险文案（家族卡固定行，设计 §3.1「非官方接口……」一段的家族级补充）。 */
  riskNotice: string
}

/** 资产清单 JSON 顶层 schema（远端清单拉取的形状契约；schemaVersion 升版 = 结构演进）。 */
export interface WoolAssetManifest {  // oe-exempt:20261022:framework:资产清单 JSON schema（D2 钉版本），wool-manager 拉取+测试消费
  schemaVersion: 1
  /** 清单生成时点（Unix ms，观测字段）。 */
  generatedAt: number
  families: Partial<Record<WoolFamilyId, WoolManifestFamily>>
}

/** 清单拉取结果：ok = 已校验清单；失败 = 结构化原因（阻断重试，不降级直装——设计 D2）。 */
export type WoolManifestFetchResult =
  | { ok: true; manifest: WoolAssetManifest; fetchedAt: number }
  | { ok: false; error: { code: WoolManifestErrorCode; message: string } }

export type WoolManifestErrorCode =
  | 'unreachable'   // 网络不可达 / 非 2xx（可重试）
  | 'bad_shape'     // 响应非 JSON / schema 校验不过（清单损坏，重试无意义时提示检查发布通道）
  | 'family_absent' // 清单内无目标家族条目（清单与客户端版本错配，升级 taiji 或等待清单更新）

// ── 向导状态机（D6 ① / D7 两族模板）──

/** 向导模板族（由 manifest.family 的 credentialsSource 决定，D7）。 */
export type WoolWizardTemplate = 'extract' | 'oauth'

/** 提取族（ide-extract）步骤：安装 → 凭据提取（检测/确认/提取合一）→ 完成。 */
export type WoolExtractStep = 'install' | 'credentials' | 'done'
/** 授权族（oauth）步骤：安装 → 账号授权 → 凭据就绪 → 签到与续期 → 完成（设计 §3.1 五步）。 */
export type WoolOauthStep = 'install' | 'authorize' | 'ready' | 'checkin' | 'done'

/** 单步执行态（向导内每步的四态；失败态文案按设计 §3.1 失败路径表映射）。 */
export type WoolStepStatus = 'pending' | 'running' | 'ok' | 'failed'

/** 步骤失败态（失败路径表 §3.1：code 决定恢复指引渲染分支）。 */
export type WoolStepFailureCode =
  | 'manifest_unreachable'  // 清单不可达 → 重试 + 查看网络设置，不降级直装
  | 'manifest_bad_shape'    // 清单损坏 → 同上
  | 'family_absent'         // 清单内无目标家族条目（清单与客户端版本错配）
  | 'install_failed'        // 扩展安装失败 → 重试（安装通道既有回滚）
  | 'extension_missing'     // 扩展未加载（管理命令探测未命中）→ 重试 / 重装
  | 'not_logged_in'         // 扩展报无凭据 → 引导接入流程
  | 'upstream_error'        // 上游调用失败 → 可重试
  | 'authorize_unavailable' // 授权动作通道未就绪（扩展管理协议无 authorize 动作）
  | 'extract_unavailable'   // 提取动作通道未就绪（扩展管理协议无 extract 动作）
  | 'uninstall_failed'      // 卸载链失败（extension-service uninstallExtension 抛错；与 WoolActionErrorCode 同名码）
  | 'manage_unavailable'    // 管理会话编排失败（spawn/指令往返链路，可重试）
  | 'internal'              // 扩展内部异常 / taiji 侧编排异常
  | 'cancelled'             // 用户取消（非错误态）

// ── 运行态视图（wool.state 帧 payload；taiji 侧缓存快照）──

/**
 * 羊毛模型目录条目视图（派生缓存，权威 = pi registry）。字段是模型选择器展示所需
 * 最小集；fetchedAt 标注数据时点（「无会话时读缓存展示」的时点来源）。
 */
export interface WoolCatalogModelView {  // oe-exempt:20261022:framework:renderer↔runtime 跨层模型目录视图形状
  id: string
  name: string
  api?: string
  reasoning?: boolean
  contextWindow?: number
}

/** 单家族目录缓存视图（null = 尚无缓存）。 */
export interface WoolCatalogView {  // oe-exempt:20261022:framework:renderer↔runtime 跨层目录视图形状
  models: WoolCatalogModelView[]
  /** 目录采集时点（Unix ms，记录性字段，不参与过期判定——D4 无 TTL 语义）。 */
  fetchedAt: number
}

/**
 * 账号状态视图（与 wool-shared account-status.ts WoolAccountStatus 字段对齐；本视图
 * 是 taiji 缓存态，来源 = 管理会话 status 动作回包经运行时守卫收窄后的可信值）。
 */
export interface WoolAccountStatusView {  // oe-exempt:20261022:framework:renderer↔runtime 跨层账号状态视图形状
  loggedIn: boolean
  nickname?: string
  quota?: { used: number; total?: number; remaining?: number; unit: string }
  checkin?: { doneToday: boolean; streak?: number; lastCheckedAt?: number }
  tokenExpiresAt?: number
  /** 上游状态采集时点（Unix ms，透传扩展回包 fetchedAt）。 */
  fetchedAt: number
}

/** 登录态检测结果（detect 动作回包视图；ide-extract 家族家族卡检测徽标数据源）。 */
export interface WoolDetectResultView {  // oe-exempt:20261022:framework:renderer↔runtime 跨层登录态检测视图形状
  /** 凭据文件存在性判定结果（扩展侧只 stat 存在性，不读内容——设计 D3）。 */
  detected: boolean
  detail?: string
  fetchedAt: number
}

/** 单家族运行态（wool.state 帧 families[] 元素）。 */
export interface WoolFamilyState {  // oe-exempt:20261022:framework:家族接入状态形状，7 文件跨层消费（shared→runtime/renderer）
  family: WoolFamilyId
  displayName: string
  vendor: string
  credentialsSource: WoolCredentialsSource
  /** 家族卡风险文案（清单下发；清单未达时用 taiji 内置兜底文案）。 */
  riskNotice: string
  /** 扩展包已安装（scanExtensions 命中同名包且启用）。 */
  installed: boolean
  /** 已安装版本（npm 目录 package.json 读取；未装 = undefined）。 */
  installedVersion?: string
  /** 可更新标记（installedVersion ≠ 清单 version 派生，D2 更新角标数据源；清单未达或未装 = false）。 */
  updateAvailable?: boolean
  /** 已完成接入（settings.json 羊毛域接入标记；向导完成时置位）。 */
  adopted: boolean
  /** 每日自动签到开关（默认关；开 = 黄色警示，D5）。 */
  autoCheckin: boolean
  /** 账号状态缓存（null = 从未拉取）。 */
  account: WoolAccountStatusView | null
  /** 登录态检测缓存（null = 从未检测；oauth 家族恒 null——不显示检测徽标）。 */
  detect: WoolDetectResultView | null
  /** 模型目录缓存（null = 尚无缓存；条目区「模型数」与选择器并入数据源）。 */
  catalog: WoolCatalogView | null
}

/** wool.state 帧 payload（getState reply 与广播同名同形）。 */
export interface WoolRuntimeSnapshot {  // oe-exempt:20261022:framework:runtime→renderer 快照消息形状，8 文件消费
  families: WoolFamilyState[]
  /** 快照组装时点（Unix ms）。 */
  fetchedAt: number
}

// ── wool.action 动作面 ──

/**
 * 宿主动作词表（taiji 向导/条目区经 wool.action 触发的编排动作）。
 * 与扩展管理动作词表（wool-shared WOOL_MANAGE_ACTIONS：status/detect/checkin/clear）
 * 是两层：本词表是 renderer → runtime 的编排动作；wool-manager 把其中
 * detect/status/checkin/clear（uninstall 第一步）翻译为管理会话内的同名扩展动作。
 * uninstall = D3 卸载三步编排（管理会话 clear → extension-service 卸载 → settings 羊毛域清除）。
 */
export const WOOL_ACTION_TYPES = [
  'install',
  'detect',
  'status',
  'checkin',
  'refresh',
  'setAutoCheckin',
  'authorize',
  'extract',
  'uninstall',
] as const
export type WoolActionType = (typeof WOOL_ACTION_TYPES)[number]

/** wool.action 请求 payload（payload 单对象；设置域全局状态无 sessionId）。 */
export interface WoolActionRequest {  // oe-exempt:20261022:framework:taiji↔扩展管理协议宿主侧形状（与 wool-shared WoolManageRequest 对齐），10 文件消费
  action: WoolActionType
  /** family 必填（全部动作都是家族维度）。 */
  family: WoolFamilyId
  /** 动作参数（setAutoCheckin 消费 { enabled }；其余动作无参）。 */
  params?: { enabled?: boolean }
}

/** wool.action reply payload（动作结果信封；状态变化经 wool.state 广播推回）。 */
export type WoolActionReply =
  | { ok: true; data?: unknown }
  | { ok: false; error: { code: WoolActionErrorCode; message: string } }

/**
 * uninstall 动作回执 data（D3 三步编排结果视图，按扩展侧 clear 实际能力分层）。
 * credentialsCleared = pi auth.json 凭据是否已清除（D3 ①）——pi 扩展 API 无凭据删除
 * 通道、宿主无 Models.logout 通路，清除通道补齐前恒 false；此时 residualHint 必带
 * （D3 降级条款：不静默残留——扩展侧 clear 的分层结果〔进程内副本 / persist 目录〕
 * 与手动清除指引并入 hint 文本），renderer 按 hint 呈现。
 */
export interface WoolUninstallResult {  // oe-exempt:20261022:framework:uninstall 动作回执视图（runtime 组装 / renderer 消费）
  /** pi auth.json 凭据是否已清除（D3 ①；清除通道缺失期间恒 false，残留提示必带）。 */
  credentialsCleared: boolean
  /** 残留提示（credentialsCleared=false 时必带：扩展侧已清项分层说明 + 残留内容 + 手动清除指引）。 */
  residualHint?: string
}

/** 动作错误码词表（renderer 按码分流恢复指引；与 WoolStepFailureCode 对应关系在 renderer 映射）。 */
export type WoolActionErrorCode =
  | 'invalid_request'       // 参数非法 / 家族不在词表（renderer bug，重试无意义）
  | WoolManifestErrorCode   // 'unreachable' | 'bad_shape' | 'family_absent'
  | 'install_failed'
  | 'extension_missing'     // 管理命令探测未命中（扩展未装/未启用/加载失败）
  | 'not_logged_in'
  | 'upstream_error'
  | 'internal'
  | 'manage_unavailable'    // 管理会话编排失败（spawn/prompt/getEntries 链路错误）
  | 'authorize_unavailable' // 授权动作通道未就绪（扩展管理协议无 authorize 动作；与 WoolStepFailureCode 同名码）
  | 'extract_unavailable'   // 提取动作通道未就绪（扩展管理协议无 extract 动作；同上对称码）
  | 'uninstall_failed'      // 卸载链失败（extension-service uninstallExtension 抛错；凭据清除失败不阻断卸载，走 credentialsCleared=false 残留提示形态）

// ── 运行时守卫（读侧不信任外部格式；消费 WS 帧 / 清单 JSON 前收窄）──

export function isWoolFamilyId(value: unknown): value is WoolFamilyId {
  return typeof value === 'string' && (WOOL_FAMILY_IDS as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 资产清单运行时守卫（schemaVersion / families 形状逐项校验；families 元素缺 displayName 等必填字段即拒）。 */
export function isWoolAssetManifest(value: unknown): value is WoolAssetManifest {
  if (!isRecord(value)) return false
  if (value.schemaVersion !== 1) return false
  if (typeof value.generatedAt !== 'number') return false
  if (!isRecord(value.families)) return false
  return Object.values(value.families).every((entry) => {
    if (!isRecord(entry)) return false
    return (
      typeof entry.pkg === 'string' && entry.pkg.length > 0 &&
      typeof entry.version === 'string' && entry.version.length > 0 &&
      typeof entry.displayName === 'string' && typeof entry.vendor === 'string' &&
      (entry.credentialsSource === 'ide-extract' || entry.credentialsSource === 'oauth') &&
      typeof entry.riskNotice === 'string'
    )
  })
}

/** detect 回包 data 守卫：期望 { detected: boolean }；形态不符 = 检测不可用（不猜）。 */
export function isWoolDetectData(value: unknown): value is { detected: boolean; detail?: string } {
  if (!isRecord(value)) return false
  if (typeof value.detected !== 'boolean') return false
  if (value.detail !== undefined && typeof value.detail !== 'string') return false
  return true
}

/**
 * 账号状态运行时守卫（与 wool-shared account-status.ts isWoolAccountStatus 同构的宿主侧
 * 镜像——packages/shared 不依赖 extensions 包，两侧字段对齐义务由各自包内测试锚定）。
 * status 动作回包 data 经此收窄后才进 accountCache（读侧不信任扩展回包）。
 */
export function isWoolAccountStatusView(value: unknown): value is WoolAccountStatusView {
  if (!isRecord(value)) return false
  if (typeof value.loggedIn !== 'boolean') return false
  if (value.nickname !== undefined && typeof value.nickname !== 'string') return false
  if (value.tokenExpiresAt !== undefined && typeof value.tokenExpiresAt !== 'number') return false
  if (typeof value.fetchedAt !== 'number') return false
  if (value.quota !== undefined) {
    if (!isRecord(value.quota) || typeof value.quota.used !== 'number' || typeof value.quota.unit !== 'string') {
      return false
    }
    if (value.quota.total !== undefined && typeof value.quota.total !== 'number') return false
    if (value.quota.remaining !== undefined && typeof value.quota.remaining !== 'number') return false
  }
  if (value.checkin !== undefined) {
    if (!isRecord(value.checkin) || typeof value.checkin.doneToday !== 'boolean') return false
    if (value.checkin.streak !== undefined && typeof value.checkin.streak !== 'number') return false
    if (value.checkin.lastCheckedAt !== undefined && typeof value.checkin.lastCheckedAt !== 'number') return false
  }
  return true
}
