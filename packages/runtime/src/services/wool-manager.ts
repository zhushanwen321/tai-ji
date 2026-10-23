/**
 * WoolManager — 羊毛 provider 宿主编排服务（wool-provider 设计 D2/D6/D7；凭据通道 D2 裁决）。
 *
 * 职责（五件，M5 宿主编排 + 凭据通道）：
 * ① 资产清单拉取（远端 JSON，钉版本 + 家族展示元数据；清单不可达 = 阻断 + 重试，不降级直装）；
 * ② 安装编排（消费既有 extension-service installExtension：npm 安装 + 校验 + 失败回滚全既有）；
 * ③ 管理专用会话生命周期（D6 ②：hidden RPC 会话即起即收——一次编排 spawn 一个会话、
 *    编排完成即回收销毁；禁常驻、禁空闲回收定时器；指令经 message-dispatcher 的
 *    sendSystemCommand 正道直达扩展命令，响应经 get_entries 拉 custom entry）；
 * ④ 凭据通道（extract/authorize 编排：管理会话收凭据回包 → models.json 羊毛 provider
 *    条目幂等更新（WoolModelsEntryPort，凭据落 apiKey + refreshToken headers 键，不写
 *    pi auth.json）；授权族 authorize 窗内拦截扩展 notify 的授权页 URL → wool.authorize_url
 *    广播驱动浮层浏览器；卸载删条目即凭据清除）；
 * ⑤ 账号状态 / 登录态检测 / 模型目录三类缓存（目录持久化 <dataDir>/wool-catalog.json，
 *    标注数据时点供无会话时设置页展示；pi registry 是羊毛模型唯一权威，本缓存是派生视图）。
 *
 * 通道事实链（u-foundation P6 探针定夺，runlog 21:52）：
 * - 管理会话触发正道 = sendSystemCommand（"/" 前缀编排旁路，不经用户消息内核）；
 * - 命令-only 会话（无 user/assistant 消息）pi 文件不 flush，appendEntry 响应仅内存态——
 *   结果读取通道 = getRpcClient(sid).getEntries()（RPC 响应内存态），无磁盘残留。
 * - pi 请求时凭据消费链（已核实 provider-composer.js / model-runtime.js prepareRequest）：
 *   models.json 羊毛条目 apiKey/headers 经 getApiKeyAndHeaders 合并进 resolvedAuth 传
 *   扩展 streamSimple；运行中会话可见性由 provider-live-sync 扩展 2s 轮询 registry refresh 承载。
 *
 * 错误分级（分级即错误处理契约）：安装/清单/凭据落库是核心链 fail-fast 结构化错误（code +
 * 中文恢复指引）；账号状态/目录拉取是辅助链——失败回结构化错误信封不拖垮 provider 列表
 * （listWoolProviderInfos 纯内存缓存读，管理链故障零影响）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProviderInfo, ServerMessage } from '@taiji/shared'
import {
  isWoolAccountStatusView,
  isWoolAssetManifest,
  isWoolCredentialsData,
  isWoolDetectData,
  isWoolFamilyId,
  WOOL_FAMILY_FALLBACK_META,
  type WoolAccountStatusView,
  type WoolActionErrorCode,
  type WoolActionReply,
  type WoolActionRequest,
  type WoolAssetManifest,
  type WoolCatalogModelView,
  type WoolCatalogView,
  type WoolCredentialsData,
  type WoolDetectResultView,
  type WoolFamilyId,
  type WoolFamilyState,
  type WoolManifestFetchResult,
  type WoolRuntimeSnapshot,
  type WoolUninstallResult,
} from '@taiji/shared'
import type { ISessionService } from '../interfaces.js'
import { toErrorMessage } from '../utils/errors.js'

/** 羊毛 provider 注册名（与 wool-shared types.ts woolProviderId 同公式：`wool-<family>`）。 */
function woolProviderId(family: WoolFamilyId): string {
  return `wool-${family}`
}

/** 管理响应 custom entry 类型（与 wool-shared manage-protocol.ts WOOL_MANAGE_ENTRY_TYPE 一致——字面量镜像，一致性由双方测试锚定）。 */
const WOOL_MANAGE_ENTRY_TYPE = 'wool-manage-response'
/** 管理指令 envelope 协议版本（与 wool-shared WOOL_MANAGE_PROTOCOL_VERSION 一致）。 */
const WOOL_MANAGE_PROTOCOL_VERSION = 1
/** 管理命令名（与 wool-shared woolManageCommandName 同公式）。 */
function woolManageCommandName(family: string): string {
  return `wool-${family}`
}

/**
 * 资产清单缺省挂点：发布权威源 = 羊毛扩展发布仓（tai-ji-plugin）的 GitHub release
 * 最新版资产（releases/latest/download 302 → 最新版资产直链）。
 */
export const DEFAULT_WOOL_MANIFEST_URL =
  'https://github.com/zhushanwen321/tai-ji-plugin/releases/latest/download/wool-manifest.json'
/**
 * gitcode 镜像仓 releases 匿名 API（国内备源通道第一跳）：匿名可读，返回 JSON 数组，
 * 元素含 tag_name/prerelease/assets，assets 元素含 name 与 browser_download_url。
 */
const GITCODE_RELEASES_API_URL =
  'https://api.gitcode.com/api/v5/repos/qq_18433817/tai-ji-plugin/releases?per_page=5'
/** gitcode release assets 中承载清单的文件名（发布流程契约）。 */
const GITCODE_MANIFEST_ASSET_NAME = 'wool-manifest.json'
/** 清单拉取超时（控制范围单请求粒度，红线 19：秒级；双通道下每个请求独立计时）。 */
const MANIFEST_FETCH_TIMEOUT_MS = 10_000
/**
 * 管理编排回收上界（回收层统一有界兜底，crash-forensics 附录 E：dispose/kill 允许默认有界）。
 * 覆盖 spawn + 指令往返 + 扩展侧上游调用（账号状态/签到走上游 HTTP，量级十秒内）；
 * 超时 = 编排判失败 + 会话强制回收（finally 链），不存在常驻残留。
 */
const MANAGE_ORCHESTRATION_TIMEOUT_MS = 120_000
/** 管理响应轮询间隔（单指令往返等待的重试节奏；判定依据是 entry 出现与否的确定性信号）。 */
const MANAGE_RESPONSE_POLL_INTERVAL_MS = 100
/** 单指令响应等待上界（prompt 受理口径后扩展 handler 执行 + entry 落树的窗口；量级秒级）。 */
const MANAGE_RESPONSE_WAIT_MS = 10_000
/**
 * authorize 授权窗等待上界（任务书契约：管理会话在授权窗内保持存活，即起即收边界 =
 * 编排完成含授权轮询完成或取消）。覆盖「扩展发授权页 URL → 用户在浮层浏览器完成授权 →
 * 扩展轮询到回调完成 → 响应 entry 落树」全程；用户显式点击授权按钮触发（红线 19 的
 * 用户显式发起形态），5 分钟覆盖常规 OAuth 操作。同时作为 authorize 编排的回收上界
 * （withTimeout 同值覆盖）——超时 = 编排判失败 + 会话回收，用户可重开授权。
 */
const AUTHORIZE_WINDOW_MS = 300_000
/**
 * 羊毛条目 refreshToken 的 headers 承载键（凭据通道 D2：models.json ProviderConfig 无
 * refreshToken 字段，headers 经 getApiKeyAndHeaders 合并透传家族 stream——是刷新令牌
 * 到达扩展请求面的唯一通道）。键名与扩展侧（wool-shared 家族 stream 消费方）对齐。
 */
const WOOL_REFRESH_TOKEN_HEADER = 'x-wool-refresh-token'
/**
 * 授权通知 JSON 的 type 判别值（扩展侧 buildWoolAuthorizeNotice 契约：单行 JSON
 * { type, family, authUrl, callbackUrl, state } 经 pi notify 投递）。
 */
const WOOL_AUTHORIZE_NOTICE_TYPE = 'wool-authorize'
/**
 * 授权确认信号请求超时（控制范围单请求粒度，红线 19：秒级）——本机 127.0.0.1 回调
 * 端点往返 + 扩展侧一次令牌交换（上游 HTTP），10s 覆盖。
 */
const AUTHORIZE_SIGNAL_TIMEOUT_MS = 10_000
/** done 信号的「令牌交换完成」响应码（callback-server 契约）。 */
const AUTHORIZE_SIGNAL_DONE_STATUS = 200
/** done 信号的「上游尚未完成（等待页，可重试）」响应码。 */
const AUTHORIZE_SIGNAL_PENDING_STATUS = 202
/** 旧扩展 invalid_request 的「词表未实装」判别（wool-shared parseWoolManageRequest 文案锚点）。 */
const UNKNOWN_ACTION_RE = /Unknown action/i
/** 授权取消终态判别（扩展 OAuth 取消路径 throw 的 DOMException message 文案锚点）。 */
const AUTH_CANCELLED_RE = /cancelled/i
/** 目录装载等待上界（refresh 动作：registry spawn 后异步装载，persist 缺失的快照回落路径秒级稳定）。 */
const CATALOG_LOAD_WAIT_MS = 5_000
/** 目录装载轮询间隔。 */
const CATALOG_LOAD_POLL_INTERVAL_MS = 250
/** 目录缓存文件名（<dataDir>/ 下，QuotaCache 同形态先例）。 */
const CATALOG_CACHE_FILENAME = 'wool-catalog.json'
/** 目录缓存 JSON 缩进宽度（2 空格，人可读审计形态）。 */
const CATALOG_CACHE_JSON_INDENT = 2
/**
 * 每日签到提醒时点（本地时 09:00，D5「到点提醒」的产品功能定时）。选型说明：设计未钉
 * 具体时点，取「工作日上午开始」作缺省——签到额度按日刷新，上午 9 点覆盖「当天首次
 * 打开工作台」主流形态；时点只影响提醒新鲜度，不改变签到可用性（用户全天可手动签到）。
 */
const DAILY_CHECKIN_REMINDER_HOUR = 9
/**
 * 会话错误 401/未授权分类（noteSessionError 消费）。词界 401 防相邻数字误命中（上游
 * 错误码 4011 = 限流惩罚窗，非鉴权失败）；not_logged_in = wool-shared 管理错误码透传形态。
 */
const SESSION_AUTH_ERROR_RE = /\b401\b|unauthorized|not_logged_in/i
/** 会话错误「模型不存在」分类（pi 实装文案 Model not found——缺凭据同文案，按 D6 ③ 裁决走清单重新拉取）。 */
const SESSION_MODEL_MISSING_RE = /model not found|no such model|unknown model/i

/** settings.json 羊毛域持久化形状（`wool` 键；scope 声明见 pi-settings-store SCOPE_FIELDS.wool）。 */
export interface WoolSettingsDomain {  // oe-exempt:20261022:framework:依赖注入端口模式——settings 域端口，生产实装 pi-settings-store + 测试 stub 双实现（stub 在 tests 目录不进检查计数）
  families?: Partial<Record<WoolFamilyId, { adopted?: boolean; autoCheckin?: boolean; nickname?: string }>>
}

/** settings.json 羊毛域读侧收窄（组合根闭包消费：坏形状回空域，羊毛接入态不阻断启动）。 */
export function isWoolSettingsDomain(value: unknown): value is WoolSettingsDomain {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const families = (value as Record<string, unknown>).families
  if (families === undefined) return true
  if (typeof families !== 'object' || families === null || Array.isArray(families)) return false
  return Object.values(families).every((entry) => {
    if (entry === undefined) return true
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
    const record = entry as Record<string, unknown>
    return (
      (record.adopted === undefined || typeof record.adopted === 'boolean') &&
      (record.autoCheckin === undefined || typeof record.autoCheckin === 'boolean') &&
      (record.nickname === undefined || typeof record.nickname === 'string')
    )
  })
}

/** wool-manager 专用结构化错误（code 进 wool.action 错误信封）。 */
export class WoolActionError extends Error {
  readonly code: WoolActionErrorCode

  constructor(code: WoolActionErrorCode, message: string) {
    super(message)
    this.name = 'WoolActionError'
    this.code = code
  }
}

/** 管理会话窄依赖（ISessionService 的消费子集；测试用对象字面量即可装配）。 */
export interface WoolSessionPort {  // oe-exempt:20261022:framework:依赖注入端口模式——会话 spawn 端口，生产 SessionService + 测试 stub 双实现
  create: ISessionService['create']
  delete: ISessionService['delete']
  getRpcClient: ISessionService['getRpcClient']
  sendSystemCommand: ISessionService['sendSystemCommand']
}

/** 扩展安装窄依赖（既有 extension-service 通道，羊毛不新建安装机制）。 */
export interface WoolExtensionPort {  // oe-exempt:20261022:framework:依赖注入端口模式——扩展安装端口，生产 extension-service + 测试 stub 双实现
  scanExtensions(): Promise<Array<{ name: string; version: string; enabled: boolean }>>
  installExtension(source: string): Promise<void>
  /** 卸载（D3 卸载编排第三步：既有 extension-service uninstallExtension 链——目录删除 + settings 登记/npm uninstall 全既有）。 */
  uninstallExtension(name: string): Promise<void>
}

/** settings.json 羊毛域读写 port（组合根以 pi-settings-store 闭包装配；services 层不 import infra）。 */
export interface WoolSettingsPort {  // oe-exempt:20261022:framework:依赖注入端口模式——settings 读写端口，生产实装 + 测试 stub 双实现
  read(): WoolSettingsDomain
  write(data: WoolSettingsDomain): void
}

/**
 * models.json 羊毛 provider 条目读写 port（凭据通道 D2：凭据落 models.json 条目，
 * 不写 pi auth.json）。组合根以 infra/pi/pi-provider-store（upsertProvider /
 * removeProvider / getProviderConfig）闭包装配——写前 JSON 损坏拒入（ModelsStoreCorruptedError）
 * 由该既有写入器防线承载；条目 id 公式 `wool-<family>` 与扩展注册名一致（woolProviderId）。
 * 读写均为同步原语（pi-provider-store 全同步，无锁竞争窗口外移）。
 */
export interface WoolModelsEntryPort {  // oe-exempt:20261022:framework:依赖注入端口模式——models.json 条目端口，生产 pi-provider-store 装配 + 测试 stub 双实现
  /** 读单条目（无条目 = undefined；深拷贝形态，调用方可原地合并）。 */
  readEntry(providerId: string): Record<string, unknown> | undefined
  /** 写条目（整体替换该 provider 条目；其余条目由 infra 写入器保留）。 */
  writeEntry(providerId: string, entry: Record<string, unknown>): void
  /**
   * 删条目（卸载编排：条目整体删除即凭据清除——含 apiKey/headers/name 全部）。
   * 返回删除前条目是否含非空 apiKey（credentialsCleared 判定素材；条目本就不存在 = false，
   * 语义为「无凭据可清」而非「清除失败」）。
   */
  deleteEntry(providerId: string): boolean
  /** 条目是否持非空 apiKey（listWoolProviderInfos 的 apiKeySet 事实源）。 */
  hasCredentials(providerId: string): boolean
}

export interface WoolManagerDeps {  // oe-exempt:20261022:framework:依赖注入端口模式——WoolManager 构造依赖聚合，生产装配 + 测试 stub 双实现
  sessionService: WoolSessionPort
  extensionService: WoolExtensionPort
  settings: WoolSettingsPort
  /** models.json 羊毛条目读写 port（凭据通道 D2；组合根以 pi-provider-store 装配）。 */
  modelsEntry: WoolModelsEntryPort
  /** 数据目录（管理会话 cwd + 目录缓存文件落点；动态推导注入，禁止硬编码绝对路径）。 */
  dataDir: string
  /** wool.state 广播出口（组合根组装 id 后经 broker 纯全局通道下发）。 */
  broadcast: (msg: ServerMessage<'wool.state'> | ServerMessage<'wool.authorize_url'>) => void
  /**
   * 管理会话 ext-sessions 树回收口（组合根装配 = sessionStore.trashDirectory）。
   * 管理会话是命令-only 形态（pi 不 flush jsonl 主文件），而 sessionService.delete 的
   * active 分支对「主文件缺失」语义 = 整体零动作（外部已删假设）——树内 logs 域会
   * 泄漏累积，与 ADR-0141「删除会话 = 整树回收」相悖；羊毛域自回收（D3 验收发现）。
   */
  reclaimSessionTree?: (sessionId: string) => void
  /**
   * 清单拉取地址（高级覆盖 / 测试 fixture）。显式注入 = 单源语义：只拉该 URL，不并发
   * 备源；缺省 = 双通道（DEFAULT_WOOL_MANIFEST_URL 权威源 + gitcode 国内备源）。
   */
  manifestUrl?: string
  /** 网络出口（测试注入；缺省 globalThis.fetch）。 */
  fetchFn?: typeof fetch
  /** 时钟（测试注入）。 */
  now?: () => number
  /** 管理编排回收上界（测试压缩用；生产缺省 MANAGE_ORCHESTRATION_TIMEOUT_MS；authorize 另用 authorizeWindowMs）。 */
  manageTimeoutMs?: number
  /** 单指令响应等待上界（测试压缩用；生产缺省 MANAGE_RESPONSE_WAIT_MS）。 */
  manageResponseWaitMs?: number
  /** 管理响应轮询间隔（测试压缩用；生产缺省 MANAGE_RESPONSE_POLL_INTERVAL_MS）。 */
  manageResponsePollIntervalMs?: number
  /** authorize 授权窗等待上界（测试压缩用；生产缺省 AUTHORIZE_WINDOW_MS，覆盖响应等待与编排回收两层）。 */
  authorizeWindowMs?: number
  /**
   * 每日签到提醒定时器延迟（测试注入用；缺省 = 到下一个本地时 09:00 的实际毫秒数）。
   * 注入 0 使定时器立即触发，单测可验证到点编排全链。
   */
  dailyCheckinDelayMs?: number
}

/** 管理响应 envelope 形状守卫（与 wool-shared isWoolManageResponse 同构镜像；本域只消费）。 */
function isWoolManageResponseShape(value: unknown): value is { v: 1; ok: true; data: unknown } | { v: 1; ok: false; error: { code: string; message: string } } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.v !== WOOL_MANAGE_PROTOCOL_VERSION) return false
  if (record.ok === true) return true
  if (record.ok !== false) return false
  const error = record.error
  return (
    typeof error === 'object' && error !== null &&
    typeof (error as Record<string, unknown>).code === 'string' &&
    typeof (error as Record<string, unknown>).message === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 清单拉取通道内部结果：通道内任何一步失败（网络/超时/HTTP 非 2xx/结构不符/资产缺失）
 * 都折算为 detail 文案，通道函数不抛出——双通道并发消费面无 unhandled rejection。
 */
type ManifestChannelOutcome =
  | { ok: true; raw: unknown }
  | { ok: false; detail: string }

/**
 * gitcode releases API 响应 → 清单资产直链。取数组中首个 `prerelease !== true` 的发布
 * （prerelease = 预发布，稳定版用户不消费；releases 按时间倒序，首个即最新稳定版），
 * 在其 assets 中找清单资产的 browser_download_url。响应非数组 / 选中发布结构不符 /
 * 清单资产缺失 = undefined（通道失败素材，不猜其余条目——镜像结构漂移应显式失败）。
 */
function pickGitcodeManifestAssetUrl(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined
  const release = (raw as unknown[]).find((entry) => isRecord(entry) && entry.prerelease !== true)
  if (!isRecord(release) || !Array.isArray(release.assets)) return undefined
  const asset = (release.assets as unknown[]).find(
    (entry) => isRecord(entry) && entry.name === GITCODE_MANIFEST_ASSET_NAME,
  )
  const url = isRecord(asset) ? asset.browser_download_url : undefined
  return typeof url === 'string' && url.length > 0 ? url : undefined
}

/**
 * allSettled 结果 → 通道结果。rejected 理论不可达（通道函数全捕获不抛出），仍折算为
 * 通道失败 detail——结构性保证 fetchManifest 消费面无异常路径。
 */
function settledChannelOutcome(result: PromiseSettledResult<ManifestChannelOutcome>): ManifestChannelOutcome {
  return result.status === 'fulfilled' ? result.value : { ok: false, detail: toErrorMessage(result.reason) }
}

/** get_entries 响应域内收窄（history-rebuild-cache GetEntriesResult 同款先例）。 */
type GetEntriesResult = { data?: { entries?: unknown[] } }

/** 扩展管理错误码 → 宿主动作错误码映射（词表语义一一对应，无猜测改写）。 */
function mapManageErrorCode(code: string): WoolActionErrorCode {
  switch (code) {
    case 'invalid_request':
    case 'not_logged_in':
    case 'upstream_error':
    case 'internal':
      return code
    default:
      return 'internal'
  }
}

/**
 * 目录缓存持久化文件形状（<dataDir>/wool-catalog.json；损坏读丢弃重置——缓存是派生
 * 视图，权威在 pi registry，坏缓存不值得用户干预）。
 */
type WoolCatalogCacheFile = {
  families?: Partial<Record<WoolFamilyId, WoolCatalogView>>
}

export class WoolManager {
  private readonly deps: WoolManagerDeps
  private readonly now: () => number
  private readonly manageTimeoutMs: number
  private readonly authorizeWindowMs: number

  /** 清单内存缓存（成功结果缓存；失败不缓存，下次动作重拉）。 */
  private manifestCache: { manifest: WoolAssetManifest; fetchedAt: number } | undefined
  /** 安装态缓存（key = family；initialize 与 install 动作后刷新）。 */
  private installedCache = new Map<WoolFamilyId, { installed: boolean; version?: string }>()
  /** 账号状态缓存（key = family）。 */
  private accountCache = new Map<WoolFamilyId, WoolAccountStatusView>()
  /** 登录态检测缓存（key = family）。 */
  private detectCache = new Map<WoolFamilyId, WoolDetectResultView>()
  /** 模型目录缓存（key = family；持久化 wool-catalog.json + 内存镜像）。 */
  private catalogCache = new Map<WoolFamilyId, WoolCatalogView>()
  /**
   * 在途管理会话 sid 集合（授权 URL 通知的合法来源判定：只消费自家管理会话的
   * extension:notify，普通会话的通知零误报）。withManageSession create 入集 / finally 出集。
   */
  private readonly liveManageSessions = new Set<string>()
  /** authorize 编排在途的家族（null = 无在途授权；URL 通知只在该窗口内消费）。 */
  private authorizeInFlight: WoolFamilyId | null = null
  /** authorize 授权窗的本机回调端点（扩展通知投递；authorizeSignal done/cancel 信号目标；编排收尾清空）。 */
  private authorizeCallback: { callbackUrl: string; state: string } | null = null
  /** 每日签到提醒定时器句柄（D5 产品功能定时；unref 不阻止进程退出，dispose 清除）。 */
  private dailyCheckinTimer: NodeJS.Timeout | undefined
  /** dispose 已置位标记（定时器回调 fire 后的重排护栏——timer 已出队时 clearTimeout 追不上）。 */
  private disposed = false
  /** 报错触发目录刷新的在途护栏（key = family；并发错误帧只触发一次刷新编排）。 */
  private readonly errorRefreshInFlight = new Set<WoolFamilyId>()

  constructor(deps: WoolManagerDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.manageTimeoutMs = deps.manageTimeoutMs ?? MANAGE_ORCHESTRATION_TIMEOUT_MS
    this.authorizeWindowMs = deps.authorizeWindowMs ?? AUTHORIZE_WINDOW_MS
  }

  /**
   * 启动恢复（组合根 fire-and-forget 调用）：读目录缓存文件 + 扫安装态 + best-effort
   * 拉一次资产清单（D2 更新角标数据源——重启后 manifestCache 为空则角标无从派生）。
   * 各步失败都只 warn 降级（缓存缺失 = 设置页显示无缓存态；安装态扫描失败 =
   * installed 判 false；清单不可达 = 角标不亮，动作期重拉），不阻塞启动。
   */
  async initialize(): Promise<void> {
    this.loadCatalogCacheFile()
    try {
      await this.refreshInstalledCache()
    } catch (e) {
      // best-effort 降级：安装态扫描失败 = installed 判 false（下次安装编排纠正），不阻塞启动。
      console.warn(`[wool-manager] installed-cache scan failed: ${toErrorMessage(e)}`)
    }
    const fetched = await this.fetchManifest()
    if (!fetched.ok) {
      // best-effort 降级：清单拉取失败不阻断启动（角标暂不派生；install 动作期会再拉并阻断）。
      console.warn(`[wool-manager] startup manifest fetch failed (update badge degraded): ${fetched.error.message}`)
    }
  }

  // ── 每日签到提醒（D5：定时器在 taiji 侧，产品功能定时白名单形态）────────

  /**
   * 启动每日签到提醒定时器（组合根 initialize 后调用一次）。到点编排：
   * autoCheckin 开 = 经管理通道自动执行签到（D5「触发后经管理通道调扩展执行」）；
   * autoCheckin 关（默认）= 拉一次账号状态并广播——「今日未签到」徽标以新鲜数据点亮，
   * 即「到点提醒你手动签到」的呈现载体（签到徽标点击即手动签到）。错过的时点不补
   * （进程未运行的时段无提醒，次日到点再来；当日手动签到入口全天可用）。
   */
  startDailyCheckinTimer(): void {
    this.stopDailyCheckinTimer()
    const delayMs = this.deps.dailyCheckinDelayMs ?? this.msUntilNextDailyCheckin()
    this.dailyCheckinTimer = setTimeout(() => {
      // fire 后重排护栏：dispose 在 clearTimeout 与本回调之间执行时，此处不再重排。
      if (this.disposed) return
      void this.runDailyCheckinTick()
      // 链式排程次日（tick 失败不断链——下一时点照常触发）。
      this.startDailyCheckinTimer()
    }, delayMs)
    this.dailyCheckinTimer.unref()
  }

  /** 到下一个提醒时点（本地时 09:00）的毫秒数；已过今日时点 = 明日同时。 */
  private msUntilNextDailyCheckin(): number {
    const now = new Date(this.now())
    const next = new Date(
      now.getFullYear(), now.getMonth(),
      now.getDate() + (now.getHours() >= DAILY_CHECKIN_REMINDER_HOUR ? 1 : 0),
      DAILY_CHECKIN_REMINDER_HOUR,
    )
    return Math.max(next.getTime() - now.getTime(), 1)
  }

  /**
   * 到点编排（公开 = 单测直调入口；定时器到点触发同函数）。逐家族独立降级：单家族
   * 编排失败（管理会话不可达/上游失败）只 warn，不阻断其余家族与整体广播。
   */
  async runDailyCheckinTick(): Promise<void> {
    const settings = this.deps.settings.read()
    for (const family of ['qoder', 'trae', 'workbuddy'] as const) {
      const entry = settings.families?.[family]
      if (entry?.adopted !== true) continue
      try {
        if (entry.autoCheckin === true) {
          await this.checkinFamily(family)
        } else {
          // 提醒形态 = 账号状态新鲜化（not_logged_in 走 fetchAccountStatus 既有分支写
          // loggedIn:false 失效态——徽标数据照常更新；失败降级只 warn 不放大）。
          await this.fetchAccountStatus(family).catch((e) => {
            // 降级 ≠ 吞错：失败日志照记（与 checkin 分支 warn 同款口径），到点提醒
            // 未点亮时可从 runtime 日志归因（状态拉取失败与成功可区分）。
            console.warn(`[wool-manager] daily reminder status fetch failed (family=${family}): ${toErrorMessage(e)}`)
          })
        }
      } catch (e) {
        // 辅助链降级：单家族到点失败只 warn（下一天再触发；用户手动入口不受影响）。
        console.warn(`[wool-manager] daily checkin tick failed (family=${family}): ${toErrorMessage(e)}`)
      }
    }
    this.broadcastState()
  }

  /** 停每日提醒定时器（dispose 路径；幂等）。 */
  private stopDailyCheckinTimer(): void {
    if (this.dailyCheckinTimer !== undefined) {
      clearTimeout(this.dailyCheckinTimer)
      this.dailyCheckinTimer = undefined
    }
  }

  /** 生命周期收尾（组合根 shutdown 调用）：置 disposed 护栏 + 停定时器。无其他待回收资源（管理会话即起即收）。 */
  dispose(): void {
    this.disposed = true
    this.stopDailyCheckinTimer()
  }

  // ── 会话错误分类（D6 ③ 报错时刷新 + 失败路径表对话 401 分类）────────────

  /**
   * 会话错误文本分类入口（组合根在 event-adapter interpret 旁路喂错误帧文本，
   * resumeDecision.observe 同款隔离范式——wool-manager 只做分类与缓存编排）。
   * 保守归属：文本含 `wool-<family>`（pi 错误文案携带 provider id 形态）才命中家族，
   * 不带羊毛标识的错误不误触发。命中后二分：
   * - 401/未授权类 → 账号缓存置失效 + 广播（失效徽标判定源之二，失败路径表「对话
   *   401 分类」——与 status 拉取判定源「任一命中」）；
   * - 模型不存在类 → 触发一次目录刷新（D6 ③「选不存在的模型报错→清单重新拉取收敛」；
   *   在途护栏防并发编排堆积）。
   */
  noteSessionError(errorText: string): void {
    if (typeof errorText !== 'string' || errorText.length === 0) return
    for (const family of ['qoder', 'trae', 'workbuddy'] as const) {
      if (!errorText.includes(woolProviderId(family))) continue
      if (SESSION_AUTH_ERROR_RE.test(errorText)) {
        const prev = this.accountCache.get(family)
        this.accountCache.set(family, {
          loggedIn: false,
          fetchedAt: this.now(),
          ...(prev?.nickname !== undefined ? { nickname: prev.nickname } : {}),
        })
        this.broadcastState()
      } else if (SESSION_MODEL_MISSING_RE.test(errorText)) {
        this.triggerErrorCatalogRefresh(family)
      }
      return
    }
  }

  /** 报错触发的目录刷新（fire-and-forget；同家族在途不重复编排）。 */
  private triggerErrorCatalogRefresh(family: WoolFamilyId): void {
    if (this.errorRefreshInFlight.has(family)) return
    this.errorRefreshInFlight.add(family)
    void this.refreshCatalog(family)
      .catch((e: unknown) => {
        console.warn(`[wool-manager] error-triggered catalog refresh failed (family=${family}): ${toErrorMessage(e)}`)
      })
      .finally(() => this.errorRefreshInFlight.delete(family))
  }

  // ── 授权 URL 通知拦截（授权族 authorize 编排在途 → 浮层浏览器打开链）────────

  /**
   * 管理会话内 extension:notify 观察（组合根 EventAdapter interpret 旁路喂入，与
   * noteSessionError 同挂点同隔离范式）。授权族 authorize 协议契约（扩展侧
   * buildWoolAuthorizeNotice）：授权窗内经 pi notify 发单行 JSON
   * `{ type: 'wool-authorize', family, authUrl, callbackUrl, state }`——宿主按此解析
   * （非 JSON/类型不符零消费，generic 通知通道不受影响），只消费「自家在途管理会话 +
   * authorize 编排中 + family 匹配」的通知（普通会话通知/非授权窗通知零误报）：
   * authUrl 经 wool.authorize_url 广播（无 sessionId 全局帧）驱动 renderer 浮层浏览器；
   * callbackUrl/state 存 authorizeCallback（authorizeSignal 的 done/cancel 信号目标）。
   */
  noteExtensionNotify(sessionId: string, message: string): void {
    if (typeof sessionId !== 'string' || typeof message !== 'string') return
    const family = this.authorizeInFlight
    if (family === null) return
    if (!this.liveManageSessions.has(sessionId)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(message)
    } catch {
      return
    }
    if (!isRecord(parsed) || parsed.type !== WOOL_AUTHORIZE_NOTICE_TYPE) return
    if (parsed.family !== family) return
    const authUrl = parsed.authUrl
    const callbackUrl = parsed.callbackUrl
    const state = parsed.state
    if (typeof authUrl !== 'string' || authUrl.length === 0) return
    if (typeof callbackUrl !== 'string' || callbackUrl.length === 0) return
    if (typeof state !== 'string' || state.length === 0) return
    this.authorizeCallback = { callbackUrl, state }
    try {
      this.deps.broadcast({ type: 'wool.authorize_url', payload: { family, url: authUrl } })
    } catch (e) {
      // 广播失败不阻断授权主链（authorize 动作回执仍会落；authorizeSignal 仍可发），
      // warn 留痕非静默。
      console.warn(`[wool-manager] authorize url broadcast failed (family=${family}): ${toErrorMessage(e)}`)
    }
  }

  /**
   * authorizeSignal（宿主自有动作，不透传扩展）：authorize 授权窗内用户「已完成授权/
   * 取消」→ 向扩展本机回调端点发信号（callback-server 契约：
   * `GET callbackUrl?state=<state>&status=done|cancel`）。done：200 = 扩展侧令牌交换
   * 完成（authorize 动作回执随后到达）；202 = 浏览器内登录尚未完成（completed=false，
   * 用户可再次确认）；cancel：扩展侧取消终态（authorize 动作随后回 cancelled）。
   * 信号只在本授权窗内有效（authorizeCallback 缺失/家族不符 = 窗外误触，invalid_request）。
   */
  private async authorizeSignalFamily(family: WoolFamilyId, status: 'done' | 'cancel'): Promise<unknown> {
    if (this.authorizeInFlight !== family || this.authorizeCallback === null) {
      throw new WoolActionError('invalid_request', '授权窗不在进行中（授权页未打开或已结束）。请在向导重新发起授权')
    }
    const { callbackUrl, state } = this.authorizeCallback
    const url = `${callbackUrl}?state=${encodeURIComponent(state)}&status=${status}`
    const fetchFn = this.deps.fetchFn ?? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init))
    let response: Response
    try {
      response = await fetchFn(url, { signal: AbortSignal.timeout(AUTHORIZE_SIGNAL_TIMEOUT_MS) })
    } catch (e) {
      // 回调端点不可达 = 授权窗已收口（完成/取消/超时后扩展回收监听）——如实报，不猜状态。
      throw new WoolActionError('invalid_request', `授权回调通道不可达（授权窗可能已结束）：${toErrorMessage(e)}。若授权已完成请直接查看结果；否则请重新发起授权`)
    }
    if (status === 'cancel') {
      return { cancelled: true }
    }
    // done：200 = 扩展侧令牌交换完成；202 = 上游尚未完成（扩展侧等待页语义，用户可再点
    // 确认重试）。completed 只认 200（Response.ok 对一切 2xx 为 true，202 不可混入）。
    if (response.status !== AUTHORIZE_SIGNAL_DONE_STATUS && response.status !== AUTHORIZE_SIGNAL_PENDING_STATUS) {
      throw new WoolActionError('upstream_error', `授权确认信号失败（HTTP ${response.status}）。请重试；持续失败请重新发起授权`)
    }
    return { completed: response.status === AUTHORIZE_SIGNAL_DONE_STATUS }
  }

  // ── 快照组装（纯内存读，设置页 wool.getState 零 IO 即时回）──────────────

  getSnapshot(): WoolRuntimeSnapshot {
    const families: WoolFamilyState[] = []
    for (const family of ['qoder', 'trae', 'workbuddy'] as const) {
      const manifestEntry = this.manifestCache?.manifest.families[family]
      const settingsEntry = this.deps.settings.read().families?.[family]
      const installed = this.installedCache.get(family)
      // D2 更新角标数据源：已装且清单已拉到、且清单版本 ≠ 已装版本 = 可更新（钉版本语义
      // 下清单 version 即目标版本，字符串不等即版本差异；点击角标触发 install 即钉版本升级）。
      const updateAvailable = installed?.installed === true &&
        manifestEntry !== undefined &&
        installed.version !== undefined &&
        installed.version !== manifestEntry.version
      families.push({
        family,
        // 清单不可达（manifestCache=null）时兜底 WOOL_FAMILY_FALLBACK_META：凭据来源是
        // 家族固有属性，静态兜底正确；旧缺省 '?? ide-extract' 会把 OAuth 家族（workbuddy）
        // 误导成提取族——向导模板与已接入卡的重连按钮语义全错（重连对 OAuth 扩展发
        // extract 必失败）。
        displayName: manifestEntry?.displayName ?? WOOL_FAMILY_FALLBACK_META[family].displayName,
        vendor: manifestEntry?.vendor ?? '',
        credentialsSource: manifestEntry?.credentialsSource ?? WOOL_FAMILY_FALLBACK_META[family].credentialsSource,
        riskNotice:
          manifestEntry?.riskNotice ??
          '非官方接口：使用你自己的账号额度，存在账号风控与接口变动风险；凭据与协议实装仅在本机运行',
        installed: installed?.installed ?? false,
        ...(installed?.version !== undefined ? { installedVersion: installed.version } : {}),
        ...(updateAvailable ? { updateAvailable: true } : {}),
        adopted: settingsEntry?.adopted ?? false,
        autoCheckin: settingsEntry?.autoCheckin ?? false,
        account: this.accountCache.get(family) ?? null,
        detect: this.detectCache.get(family) ?? null,
        catalog: this.catalogCache.get(family) ?? null,
      })
    }
    return { families, fetchedAt: this.now() }
  }

  private broadcastState(): void {
    try {
      this.deps.broadcast({ type: 'wool.state', payload: { snapshot: this.getSnapshot() } })
    } catch (e) {
      // 广播失败不阻断动作主链（下一个动作/查询会带回新快照），warn 留痕非静默。
      console.warn(`[wool-manager] broadcast state failed: ${toErrorMessage(e)}`)
    }
  }

  // ── 动作分派（wool.action 唯一入口）──────────────────────────────────

  async runAction(req: WoolActionRequest): Promise<WoolActionReply> {
    if (!isWoolFamilyId(req.family)) {
      return { ok: false, error: { code: 'invalid_request', message: `未知家族 ${String(req.family)}；合法词表 qoder/trae/workbuddy` } }
    }
    try {
      const data = await this.dispatch(req)
      this.broadcastState()
      return data === undefined ? { ok: true } : { ok: true, data }
    } catch (e) {
      if (e instanceof WoolActionError) {
        return { ok: false, error: { code: e.code, message: e.message } }
      }
      return { ok: false, error: { code: 'internal', message: `羊毛编排失败：${toErrorMessage(e)}` } }
    }
  }

  private async dispatch(req: WoolActionRequest): Promise<unknown> {
    switch (req.action) {
      case 'install':
        return this.installFamily(req.family)
      case 'detect':
        return this.detectFamily(req.family)
      case 'status':
        return this.fetchAccountStatus(req.family)
      case 'checkin':
        return this.checkinFamily(req.family)
      case 'refresh':
        return this.refreshCatalog(req.family)
      case 'setAutoCheckin':
        return this.setAutoCheckin(req.family, req.params?.enabled === true)
      case 'authorize':
        return this.authorizeFamily(req.family)
      case 'authorizeSignal': {
        // status 必填收窄（done/cancel）——缺省不默认静默（renderer bug 显形）。
        const status = req.params?.status
        if (status !== 'done' && status !== 'cancel') {
          throw new WoolActionError('invalid_request', 'authorizeSignal 需要 params.status = "done" | "cancel"')
        }
        return this.authorizeSignalFamily(req.family, status)
      }
      case 'extract':
        return this.extractFamily(req.family)
      case 'uninstall':
        return this.uninstallFamily(req.family)
      default: {
        // 词表外 action：WoolActionRequest 类型层已穷举，运行时到达 = 协议漂移，fail-fast。
        throw new WoolActionError('invalid_request', `未知动作 ${String((req as { action?: unknown }).action)}`)
      }
    }
  }

  // ── 清单拉取（D2：失败阻断 + 重试，不降级直装）────────────────────────

  async fetchManifest(): Promise<WoolManifestFetchResult> {
    if (this.manifestCache) {
      return { ok: true, manifest: this.manifestCache.manifest, fetchedAt: this.manifestCache.fetchedAt }
    }
    const fetchFn = this.deps.fetchFn ?? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init))
    let selected: ManifestChannelOutcome
    if (this.deps.manifestUrl !== undefined) {
      // 显式 manifestUrl（高级覆盖 / 测试 fixture）= 单源语义：指哪打哪，不进双通道
      // 并发——覆盖者对清单来源有明确意图，备源并发是噪音。
      selected = await this.fetchChannelJson(fetchFn, this.deps.manifestUrl)
    } else {
      // 缺省双通道并发（allSettled：通道结果独立消费，单通道异常不放大为整体失败）：
      // github 发布权威源直拉 + gitcode 国内备源（两跳）。
      const [github, gitcode] = await Promise.allSettled([
        this.fetchChannelJson(fetchFn, DEFAULT_WOOL_MANIFEST_URL),
        this.fetchGitcodeChannel(fetchFn),
      ])
      const githubOutcome = settledChannelOutcome(github)
      const gitcodeOutcome = settledChannelOutcome(gitcode)
      // github 成功恒用 github 结果：gitcode 是平台侧镜像，存在滞后窗口——按「先到
      // 先得」竞速（Promise.any 形态）可能拿到旧清单装旧版扩展；github 失败才消费
      // gitcode 成功结果。
      if (githubOutcome.ok) {
        selected = githubOutcome
      } else if (gitcodeOutcome.ok) {
        selected = gitcodeOutcome
      } else {
        // 两通道全失败：聚合双方原因（权威源细节在前，排障可归因是哪一侧断的）。
        return {
          ok: false,
          error: {
            code: 'unreachable',
            message: `资产清单不可达（github：${githubOutcome.detail}；gitcode：${gitcodeOutcome.detail}）。请检查网络后重试；清单恢复前不执行安装`,
          },
        }
      }
    }
    if (!selected.ok) {
      return {
        ok: false,
        error: {
          code: 'unreachable',
          message: `资产清单不可达（${selected.detail}）。请检查网络后重试；清单恢复前不执行安装`,
        },
      }
    }
    if (!isWoolAssetManifest(selected.raw)) {
      return { ok: false, error: { code: 'bad_shape', message: '资产清单格式损坏（schema 校验不过）。请稍后重试或检查 taiji 发布通道；清单修复前不执行安装' } }
    }
    this.manifestCache = { manifest: selected.raw, fetchedAt: this.now() }
    return { ok: true, manifest: selected.raw, fetchedAt: this.manifestCache.fetchedAt }
  }

  /**
   * 单 URL JSON GET 通道原语（github 直拉与 gitcode 两跳共用）：非 2xx / 网络异常 /
   * JSON 解析失败 → 失败 detail（不抛出）。超时按单请求计（AbortSignal.timeout）。
   */
  private async fetchChannelJson(fetchFn: typeof fetch, url: string): Promise<ManifestChannelOutcome> {
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS) })
      if (!response.ok) {
        return { ok: false, detail: `HTTP ${response.status}` }
      }
      return { ok: true, raw: await response.json() }
    } catch (e) {
      return { ok: false, detail: toErrorMessage(e) }
    }
  }

  /**
   * gitcode 国内备源通道（两跳）：releases 匿名 API 列发布 → 首个非 prerelease 发布的
   * 清单资产直链 → 拉取清单。任何一跳失败都折算通道失败。
   */
  private async fetchGitcodeChannel(fetchFn: typeof fetch): Promise<ManifestChannelOutcome> {
    const releases = await this.fetchChannelJson(fetchFn, GITCODE_RELEASES_API_URL)
    if (!releases.ok) return releases
    const assetUrl = pickGitcodeManifestAssetUrl(releases.raw)
    if (assetUrl === undefined) {
      return { ok: false, detail: 'releases 响应结构不符或缺 wool-manifest.json 资产' }
    }
    return this.fetchChannelJson(fetchFn, assetUrl)
  }

  // ── 安装编排（D2：清单钉版本 → 既有 installExtension 链）────────────────

  private async installFamily(family: WoolFamilyId): Promise<{ installedVersion: string }> {
    const fetched = await this.fetchManifest()
    if (!fetched.ok) {
      throw new WoolActionError(fetched.error.code, fetched.error.message)
    }
    const entry = fetched.manifest.families[family]
    if (!entry) {
      throw new WoolActionError('family_absent', `资产清单中没有 ${family} 家族条目。请升级 taiji 或等待清单更新后重试`)
    }
    // 本地已装且版本与清单一致 → 幂等短路：重复进入向导 / 授权失败重试不再重跑 npm
    // 安装链。缓存由 initialize（启动扫描）与安装后刷新维护——跨进程已装同样命中。
    // 版本不一致（含本地比清单新）仍重装——钉版本契约 = 本地版本收敛到清单版本。
    const cached = this.installedCache.get(family)
    if (cached?.installed && cached.version === entry.version) {
      return { installedVersion: cached.version }
    }
    // 钉版本安装（npm + isValidPiExtension 校验 + 失败回滚全在既有链内）。
    await this.deps.extensionService.installExtension(`npm:${entry.pkg}@${entry.version}`)
    await this.refreshInstalledCache()
    const installed = this.installedCache.get(family)
    if (!installed?.installed) {
      // 安装链成功但扫描未见 = 状态缓存异常，如实报（不假装成功）。
      throw new WoolActionError('install_failed', `扩展 ${entry.pkg}@${entry.version} 安装命令已执行但未在扩展列表中发现，请重试或查看扩展管理页`)
    }
    return { installedVersion: installed.version ?? entry.version }
  }

  private async refreshInstalledCache(): Promise<void> {
    const extensions = await this.deps.extensionService.scanExtensions()
    for (const family of ['qoder', 'trae', 'workbuddy'] as const) {
      const match = extensions.find((ext) => ext.name === `@zhushanwen/pi-wool-${family}`)
      if (match && match.enabled) {
        this.installedCache.set(family, { installed: true, version: match.version })
      } else {
        this.installedCache.delete(family)
      }
    }
  }

  // ── 管理专用会话（D6 ②：hidden 即起即收）─────────────────────────────

  /**
   * 一次管理编排 = spawn 一个 hidden 会话 → fn 内指令往返 → finally 回收销毁。
   * 超时上界兜底回收（回收层有界）；会话删除失败只 warn（进程死亡路径 delete 链
   * 自有收殓，不向调用方放大）。sid 入 liveManageSessions 集合（authorize URL 通知
   * 的合法来源判定）。
   * @param timeoutMs 本编排的回收上界（缺省 manageTimeoutMs；authorize 传授权窗上界）。
   */
  private async withManageSession<T>(
    family: WoolFamilyId,
    fn: (sessionId: string) => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    const summary = await this.deps.sessionService.create(
      this.deps.dataDir,
      `wool-manage-${family}`,
      { hidden: true },
    )
    this.liveManageSessions.add(summary.id)
    try {
      return await this.withTimeout(fn(summary.id), family, timeoutMs ?? this.manageTimeoutMs)
    } finally {
      this.liveManageSessions.delete(summary.id)
      try {
        await this.deps.sessionService.delete(summary.id)
      } catch (e) {
        // best-effort 降级：回收失败不向调用方放大（进程死亡路径 delete 链自有收殓），warn 留痕。
        console.warn(`[wool-manager] manage session dispose failed (sid=${summary.id}): ${toErrorMessage(e)}`)
      }
      // 树回收独立于 delete 结果（delete 对无主文件的命令-only 会话是零动作，见 deps 注释）。
      try {
        this.deps.reclaimSessionTree?.(summary.id)
      } catch (e) {
        // best-effort 降级：trash 失败不向调用方放大（残留 logs 域无碍主链），warn 留痕。
        console.warn(`[wool-manager] manage session tree reclaim failed (sid=${summary.id}): ${toErrorMessage(e)}`)
      }
    }
  }

  private withTimeout<T>(run: Promise<T>, family: WoolFamilyId, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new WoolActionError(
          'manage_unavailable',
          `管理会话编排超时（上界 ${timeoutMs}ms，family=${family}）。会话已回收，请稍后重试；持续超时请查看 runtime 日志`,
        ))
      }, timeoutMs)
      run.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (reason: unknown) => {
          clearTimeout(timer)
          reject(reason)
        },
      )
    })
  }

  /** 发送管理指令并等待响应 envelope（sendSystemCommand 正道 + get_entries 内存态拉取）。 */
  private async runManageCommand(
    sessionId: string,
    family: WoolFamilyId,
    action: string,
    params?: Record<string, unknown>,
    opts?: { responseWaitMs?: number },
  ): Promise<{ ok: true; data: unknown } | { ok: false; code: string; message: string }> {
    const envelope = { v: WOOL_MANAGE_PROTOCOL_VERSION, action, ...(params !== undefined ? { params } : {}) }
    const command = woolManageCommandName(family)
    // "/wool-<family> <json>"：pi 命令分发要求 "/" 前缀（agent-session prompt 主链
    // text.startsWith("/") 才尝试扩展命令——真机实证：无前缀的裸 "wool-qoder {...}"
    // 被当用户消息进 LLM turn，disposition=started，扩展 handler 永不执行；"/" 由
    // 调用方携带是 sendSystemCommand 契约（revoke-orchestrator TAIJI_NAV_COMMAND 同款）。
    const outcome = await this.deps.sessionService.sendSystemCommand(
      sessionId,
      `/${command} ${JSON.stringify(envelope)}`,
      command,
    )
    if (outcome.kind === 'extension-missing') {
      throw new WoolActionError(
        'extension_missing',
        `扩展命令 /${command} 未注册（扩展未安装、未启用或加载失败）。请先完成安装步骤后重试`,
      )
    }
    if (outcome.kind === 'pi-reclaimed' || outcome.kind === 'error') {
      throw new WoolActionError(
        'manage_unavailable',
        `管理会话指令送达失败（${outcome.kind}${outcome.message ? `：${outcome.message}` : ''}）。请稍后重试`,
      )
    }
    const client = this.deps.sessionService.getRpcClient(sessionId)
    if (!client) {
      throw new WoolActionError('manage_unavailable', '管理会话 RPC 通道不可达（会话已退出）。请重试')
    }
    // prompt resolve 是受理口径（rpc-client.ts：「resolves when pi acknowledges receipt」）——
    // 扩展命令 handler 在其后果执行，响应 entry 随后才出现在会话树。真机实证（A8 收口探针，
    // 2026-10-22）：prompt 发出到 handler entry 落树有百毫秒级窗口，受理后立即 getEntries
    // 拉空（pi 响应队列还在消化 spawn 批量初始化）。因此拉取必须轮询到 entry 出现为止：
    // 每次 getEntries 都是当前真值的同步查询（拉为主 ADR-0097），无时间推测——间隔常量
    // 只划定重试节奏，判定依据恒为「entry 是否已出现」这一确定性信号；等待上界
    // manageResponseWaitMs 耗尽 = 编排失败（超时上界另有 withTimeout 的
    // MANAGE_ORCHESTRATION_TIMEOUT_MS 兜底，两层粒度不同：本上界管单指令往返，
    // 后者管整个编排含 spawn）。
    const pollIntervalMs = this.deps.manageResponsePollIntervalMs ?? MANAGE_RESPONSE_POLL_INTERVAL_MS
    const waitMs = opts?.responseWaitMs ?? this.deps.manageResponseWaitMs ?? MANAGE_RESPONSE_WAIT_MS
    const deadline = this.now() + waitMs
    for (;;) {
      // port 尚未声明 getAvailableModels 之外的直读面（model-capability 先例）：getEntries 在
      // IPiEngine 公开面内，直接调用。
      const result = await client.getEntries() as GetEntriesResult
      const entries = result.data?.entries
      if (!Array.isArray(entries)) {
        throw new WoolActionError('internal', 'get_entries 响应缺少 entries 数组（协议异常）')
      }
      // 逆序取该家族最新一条管理响应 entry（append 追加在树尾）。
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]
        if (!isRecord(entry) || entry.type !== 'custom' || entry.customType !== WOOL_MANAGE_ENTRY_TYPE) continue
        const data = isRecord(entry.data) ? entry.data : undefined
        if (data?.family !== family) continue
        const response = data.response
        if (!isWoolManageResponseShape(response)) continue
        return response.ok
          ? { ok: true, data: response.data }
          : { ok: false, code: response.error.code, message: response.error.message }
      }
      if (this.now() >= deadline) {
        throw new WoolActionError(
          'internal',
          `管理命令已送达扩展但未收到响应 entry（action=${action}）。请重试；持续出现请查看扩展日志`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  }

  // ── 具体动作 ─────────────────────────────────────────────────────

  /** detect：凭据文件存在性一次检查（扩展侧只 stat 不读内容，设计 D3）。 */
  private async detectFamily(family: WoolFamilyId): Promise<WoolDetectResultView> {
    return this.withManageSession(family, async (sid) => {
      const response = await this.runManageCommand(sid, family, 'detect')
      if (!response.ok) {
        throw new WoolActionError(mapManageErrorCode(response.code), `登录态检测失败：${response.message}`)
      }
      if (!isWoolDetectData(response.data)) {
        // 扩展回包形态不符 = 检测不可用（不猜 detected 值）。
        throw new WoolActionError('internal', '登录态检测回包格式异常（扩展版本可能不匹配），请更新扩展后重试')
      }
      const view: WoolDetectResultView = { detected: response.data.detected, fetchedAt: this.now() }
      this.detectCache.set(family, view)
      return view
    })
  }

  /**
   * status 命令传参（wool-manage 协议 status params.apiKey）：models.json 羊毛条目
   * 凭据随命令传入扩展——管理会话每次动作新建 pi 进程（扩展进程内凭据缓存恒冷）、
   * pi auth.json 恒无羊毛条目（taiji 从不写它，凭据权威在宿主 models.json），不传参
   * 则扩展侧登录态校验恒报 not_logged_in（对话链经 options.apiKey 可用、状态链恒失效
   * 的双通道存储分裂由本传参缝合——与对话链同源）。无凭据返回 undefined（未接入语义，
   * 扩展回 not_logged_in 正确）。
   */
  private statusParams(family: WoolFamilyId): { apiKey: string } | undefined {
    const entry = this.deps.modelsEntry.readEntry(woolProviderId(family))
    const apiKey = entry?.apiKey
    return typeof apiKey === 'string' && apiKey.length > 0 ? { apiKey } : undefined
  }

  /** status：拉账号状态并更新缓存（not_logged_in 也是合法状态面，更新 loggedIn:false 后按错误回）。 */
  private async fetchAccountStatus(family: WoolFamilyId): Promise<WoolAccountStatusView> {
    return this.withManageSession(family, async (sid) => {
      const response = await this.runManageCommand(sid, family, 'status', this.statusParams(family))
      if (!response.ok) {
        if (response.code === 'not_logged_in') {
          const prev = this.accountCache.get(family)
          const view: WoolAccountStatusView = {
            loggedIn: false,
            fetchedAt: this.now(),
            ...(prev?.nickname !== undefined ? { nickname: prev.nickname } : {}),
          }
          this.accountCache.set(family, view)
          throw new WoolActionError('not_logged_in', '该家族暂无有效登录态。请重新执行接入流程（提取或授权）')
        }
        throw new WoolActionError(mapManageErrorCode(response.code), `账号状态拉取失败：${response.message}`)
      }
      if (!isWoolAccountStatusView(response.data)) {
        throw new WoolActionError('internal', '账号状态回包格式异常（扩展版本可能不匹配），请更新扩展后重试')
      }
      this.accountCache.set(family, response.data)
      return response.data
    })
  }

  /** checkin：一次编排 = 同会话内 checkin + status 两条指令（D6 ②「一批连续指令」形态），回收一次。 */
  private async checkinFamily(family: WoolFamilyId): Promise<unknown> {
    return this.withManageSession(family, async (sid) => {
      const checkinResponse = await this.runManageCommand(sid, family, 'checkin')
      if (!checkinResponse.ok) {
        throw new WoolActionError(mapManageErrorCode(checkinResponse.code), `签到执行失败：${checkinResponse.message}`)
      }
      // 签到后同会话拉一次 status（额度/签到徽标即时新鲜），status 失败不影响签到成功回执。
      let account: WoolAccountStatusView | undefined
      try {
        account = await this.fetchStatusInSession(sid, family)
      } catch (e) {
        // best-effort 降级：签到后状态拉取失败不影响签到成功回执（快照保留旧账号态）。
        console.warn(`[wool-manager] post-checkin status fetch failed (family=${family}): ${toErrorMessage(e)}`)
      }
      return { checkin: checkinResponse.data, ...(account !== undefined ? { account } : {}) }
    })
  }

  /** 会话内复用的 status 拉取（checkin 编排第二步；不走独立 withManageSession）。
   *  传参同 fetchAccountStatus（statusParams——同会话凭据与独立拉取同源）。 */
  private async fetchStatusInSession(sessionId: string, family: WoolFamilyId): Promise<WoolAccountStatusView> {
    const response = await this.runManageCommand(sessionId, family, 'status', this.statusParams(family))
    if (!response.ok) {
      throw new WoolActionError(mapManageErrorCode(response.code), response.message)
    }
    if (!isWoolAccountStatusView(response.data)) {
      throw new WoolActionError('internal', '账号状态回包格式异常')
    }
    this.accountCache.set(family, response.data)
    return response.data
  }

  /**
   * refresh：经管理会话读 pi registry 的羊毛模型清单（get_available_models 过滤
   * provider = wool-<family>）。pi registry 是唯一权威，本动作只做派生缓存刷新；
   * 带网强刷（force refresh）无 RPC 通道（设计↔实装差异，deviations 登记 =
   * 设计目录 wool-provider/deviations.md DEV-2）——目录新鲜度由扩展侧 refreshModels
   * 触发时机决定。
   */
  private async refreshCatalog(family: WoolFamilyId): Promise<WoolCatalogView> {
    return this.withManageSession(family, async (sid) => {
      const client = this.deps.sessionService.getRpcClient(sid)
      // 结构化窄化（model-capability ModelsSource 同款先例：port 未声明，运行时探测；
      // 经 unknown 中转——IPiEngine 公开面与探测目标无重叠成员，直接 as 被 tsc 拒绝）。
      const probe = client as unknown as { getAvailableModels?: unknown }
      const modelsSource = client && typeof probe.getAvailableModels === 'function'
        ? (probe as { getAvailableModels(): Promise<unknown> })
        : undefined
      if (!modelsSource) {
        throw new WoolActionError('manage_unavailable', '管理会话不支持模型清单读取（pi 引擎版本过旧）。请升级 taiji 后重试')
      }
      const providerId = woolProviderId(family)
      // registry 目录装载是 spawn 后的异步阶段（真机实证，A8 收口探针：persist 命中路径
      // 首查即值；persist 缺失的快照回落路径首查 0、约 1.5s 后稳定——与 u-qoder P5 探针
      // 「首轮 0 → 次轮 14」同款时序）。拉取语义（同 runManageCommand 轮询）：每次读都是
      // 当前真值，轮询只等「本家族条目出现」这一确定性信号；窗口耗尽按最后读值返回——
      // 合法空目录（扩展未注册任何模型）不被虚构，按空目录落缓存。
      const loadDeadline = this.now() + CATALOG_LOAD_WAIT_MS
      let allModels: unknown
      for (;;) {
        allModels = await modelsSource.getAvailableModels()
        const hasFamilyEntry = Array.isArray(allModels) &&
          allModels.some((m) => isRecord(m) && m.provider === providerId && typeof m.id === 'string')
        if (hasFamilyEntry || this.now() >= loadDeadline) break
        await new Promise((resolve) => setTimeout(resolve, CATALOG_LOAD_POLL_INTERVAL_MS))
      }
      const models: WoolCatalogModelView[] = []
      if (Array.isArray(allModels)) {
        for (const model of allModels) {
          if (!isRecord(model) || model.provider !== providerId || typeof model.id !== 'string') continue
          models.push({
            id: model.id,
            name: typeof model.name === 'string' ? model.name : model.id,
            ...(typeof model.api === 'string' ? { api: model.api } : {}),
            ...(model.reasoning === true ? { reasoning: true } : {}),
            ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
          })
        }
      }
      const view: WoolCatalogView = { models, fetchedAt: this.now() }
      this.catalogCache.set(family, view)
      this.persistCatalogCacheFile()
      return view
    })
  }

  private async setAutoCheckin(family: WoolFamilyId, enabled: boolean): Promise<{ autoCheckin: boolean }> {
    const settings = this.deps.settings.read()
    const families = { ...(settings.families ?? {}) }
    families[family] = { ...(families[family] ?? {}), autoCheckin: enabled }
    this.deps.settings.write({ ...settings, families })
    return { autoCheckin: enabled }
  }

  /**
   * invalid_request 语义分流（跨组契约：invalid_request 双载）：
   * - 「Unknown action」= 旧扩展协议词表未实装该动作 → <phase>_unavailable（更新扩展指引）；
   * - 其余 = 家族凭据策略不支持该动作（如 OAuth 家族请求 extract）→ action_not_supported
   *   （引导用对应接入动作）。判别锚 = wool-shared parseWoolManageRequest 的「Unknown
   *   action」文案；扩展侧若未来引入专用错误码，此处分流可改为按码判定。
   */
  private credentialActionError(phase: 'extract' | 'authorize', code: string, message: string): WoolActionError {
    const actionName = phase === 'authorize' ? 'authorize' : 'extract'
    if (code === 'invalid_request') {
      if (UNKNOWN_ACTION_RE.test(message)) {
        return new WoolActionError(
          phase === 'authorize' ? 'authorize_unavailable' : 'extract_unavailable',
          `${phase === 'authorize' ? '授权' : '提取'}动作通道未就绪（扩展版本可能过旧，协议词表无 ${actionName} 动作）。请更新羊毛扩展后重试`,
        )
      }
      return new WoolActionError(
        'action_not_supported',
        `该家族不支持「${phase === 'authorize' ? '授权' : '提取'}」动作（凭据来源策略不符）：${message}。请使用对应的接入动作`,
      )
    }
    // 授权取消终态（扩展 OAuth 取消路径 throw 的 message 含 cancelled，envelope 落
    // internal）→ 转译 cancelled（向导回待授权态，失败路径表 §3.1）。
    if (phase === 'authorize' && code === 'internal' && AUTH_CANCELLED_RE.test(message)) {
      return new WoolActionError('cancelled', '已取消授权')
    }
    return new WoolActionError(
      mapManageErrorCode(code),
      `${phase === 'authorize' ? '授权' : '提取'}失败：${message}`,
    )
  }

  /**
   * authorize：授权族凭据获取编排（凭据通道 D2）。动作透传扩展管理协议 authorize——
   * 扩展在授权窗内经 pi notify 发授权页 URL（noteExtensionNotify 拦截 → 浮层浏览器 +
   * authorizeCallback 登记），用户经 authorizeSignal(done/cancel) 驱动本机回调端点，
   * 扩展完成令牌交换后回凭据载荷。响应等待与编排回收上界 = 授权窗上界（管理会话在
   * 授权窗内保持存活，即起即收边界 = 编排完成含授权轮询完成或取消）。
   * 成功 = 凭据落 models.json 羊毛条目（applyCredentials）。
   */
  private async authorizeFamily(family: WoolFamilyId): Promise<unknown> {
    if (this.authorizeInFlight !== null) {
      throw new WoolActionError('invalid_request', '已有授权编排在途，请等待完成或稍后重试')
    }
    this.authorizeInFlight = family
    try {
      return await this.withManageSession(family, async (sid) => {
        const response = await this.runManageCommand(sid, family, 'authorize', undefined, {
          responseWaitMs: this.authorizeWindowMs,
        })
        if (!response.ok) {
          throw this.credentialActionError('authorize', response.code, response.message)
        }
        return this.applyCredentials(family, response.data, 'authorize')
      }, this.authorizeWindowMs)
    } finally {
      this.authorizeInFlight = null
      this.authorizeCallback = null
    }
  }

  /**
   * extract：提取族凭据获取编排（Qoder 钥匙串提取 / Trae 容器解密，D3 提取即登录）。
   * 动作透传扩展管理协议 extract；成功 = 凭据落 models.json 羊毛条目（applyCredentials）。
   */
  private async extractFamily(family: WoolFamilyId): Promise<unknown> {
    return this.withManageSession(family, async (sid) => {
      const response = await this.runManageCommand(sid, family, 'extract')
      if (!response.ok) {
        throw this.credentialActionError('extract', response.code, response.message)
      }
      return this.applyCredentials(family, response.data, 'extract')
    })
  }

  /**
   * 凭据载荷落库（extract/authorize 成功共用）：回包守卫（isWoolCredentialsData，读侧
   * 不信任扩展）→ models.json 羊毛条目幂等更新（最小形态 { name?, apiKey, headers? }，
   * baseUrl/api 由扩展注册侧承载）→ 账号缓存即时点亮（loggedIn/nickname/tokenExpiresAt）
   * → adopted 置位。回执只携安全摘要（不含 apiKey——凭据不出 models.json）。
   *
   * 生效链（无宿主显式刷新通道，D2 裁决链路）：models.json 落盘后，运行中 pi 会话由
   * provider-live-sync 扩展的 2s 内容轮询触发 registry refresh 自动可见；新 spawn 会话
   * spawn 时读盘即见——宿主无需等待动作（轮询周期内必然收敛）。
   */
  private applyCredentials(family: WoolFamilyId, data: unknown, phase: 'extract' | 'authorize'): unknown {
    if (!isWoolCredentialsData(data)) {
      throw new WoolActionError('internal', `${phase === 'authorize' ? '授权' : '提取'}成功但回包缺凭据载荷（扩展版本可能不匹配），请更新扩展后重试`)
    }
    const providerId = woolProviderId(family)
    try {
      this.writeCredentialEntry(family, providerId, data)
    } catch (e) {
      // models.json 写入被拒（损坏降级态拒入等 infra 防线）→ 凭据未落库，如实失败。
      throw new WoolActionError('internal', `凭据写入 models.json 失败（${providerId}）：${toErrorMessage(e)}。请按提示修复后重试${phase === 'authorize' ? '授权' : '提取'}`)
    }
    const displayName = data.account?.displayName
    this.accountCache.set(family, {
      loggedIn: true,
      fetchedAt: this.now(),
      ...(displayName !== undefined ? { nickname: displayName } : {}),
      ...(data.expiresAt !== undefined ? { tokenExpiresAt: data.expiresAt } : {}),
    })
    this.markAdopted(family)
    return {
      credentialsStored: true,
      ...(displayName !== undefined ? { account: { displayName } } : {}),
      ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}),
    }
  }

  /**
   * models.json 羊毛条目幂等更新：保留既有条目其余键（他方写入的 baseUrl 等不触碰），
   * 更新 name（清单显示名优先，回退回包账号名/家族 id）/ apiKey / refreshToken headers
   * 键（WOOL_REFRESH_TOKEN_HEADER；无 refreshToken 时删旧键——幂等语义 = 条目反映本次
   * 凭据集）。headers 空则省键（pi schema Record<string,string> 合法但空对象无信息量）。
   */
  private writeCredentialEntry(family: WoolFamilyId, providerId: string, data: WoolCredentialsData): void {
    const existing = this.deps.modelsEntry.readEntry(providerId) ?? {}
    const displayName = this.manifestCache?.manifest.families[family]?.displayName
      ?? data.account?.displayName
      ?? family
    const headers = { ...(isRecord(existing.headers) ? existing.headers as Record<string, string> : {}) }
    if (data.credentials.refreshToken !== undefined) {
      headers[WOOL_REFRESH_TOKEN_HEADER] = data.credentials.refreshToken
    } else {
      delete headers[WOOL_REFRESH_TOKEN_HEADER]
    }
    // headers 键显式置/删（不能靠条件展开省键——existing 里的旧 headers 会漏过）。
    const entry: Record<string, unknown> = { ...existing, name: displayName, apiKey: data.credentials.apiKey }
    if (Object.keys(headers).length > 0) {
      entry.headers = headers
    } else {
      delete entry.headers
    }
    this.deps.modelsEntry.writeEntry(providerId, entry)
  }

  /** 接入完成置位（settings 羊毛域 adopted=true；幂等——重复置位无副作用）。 */
  private markAdopted(family: WoolFamilyId): void {
    const settings = this.deps.settings.read()
    const families = { ...(settings.families ?? {}) }
    families[family] = { ...(families[family] ?? {}), adopted: true }
    this.deps.settings.write({ ...settings, families })
  }

  // ── 卸载编排（D3：clear 扩展侧副本 → 包卸载 → 羊毛域清除）────────────────

  /**
   * uninstall：D3 卸载 = 视为放弃接入，清理编排。① 扩展侧 clear（进程内凭据副本 +
   * persist 模型目录；不可达不阻断——扩展损坏形态，分层报告进回执）；② models.json
   * 羊毛条目删除（凭据清除宿主位——凭据通道 D2 后凭据落 models.json 条目，宿主自有
   * 删除通道，credentialsCleared 按删除结果如实判：条目删除成功或本就不存在 = true，
   * 写入被拒（models.json 损坏降级态）= false + 修复指引残留提示）；③ 既有
   * extension-service 卸载链（失败 = 动作整体失败回执）；④ settings 羊毛域清除 +
   * 全部缓存清理（目录缓存持久化文件同步重写，条目从选择器聚合源消失）。
   */
  private async uninstallFamily(family: WoolFamilyId): Promise<WoolUninstallResult> {
    const providerId = woolProviderId(family)
    // 分层报告素材：clear 往返成功时消费扩展侧如实回执（cleared=进程内副本已清，
    // persistCleared=pi persist 目录已删），组装进回执的已清项说明。
    let clearDelivered = false
    let clearData: Record<string, unknown> | undefined
    try {
      await this.withManageSession(family, async (sid) => {
        const response = await this.runManageCommand(sid, family, 'clear')
        if (!response.ok) {
          throw new WoolActionError(mapManageErrorCode(response.code), `凭据清除失败：${response.message}`)
        }
        clearData = isRecord(response.data) ? response.data : undefined
      })
      clearDelivered = true
    } catch (e) {
      // D3 降级形态：清理指令不可达（扩展未装/未启用/加载失败/损坏）不阻断卸载主链——
      // 分层事实进回执说明，由 renderer 呈现。
      console.warn(`[wool-manager] extension clear unreachable before uninstall (family=${family}): ${toErrorMessage(e)}`)
    }
    // models.json 羊毛条目删除（凭据清除宿主位）。删除失败（写入被拒）不阻断卸载主链
    // ——凭据残留经 credentialsCleared=false + residualHint 显式上呈（不静默残留）。
    let credentialsCleared = true
    let residualHint: string | undefined
    try {
      this.deps.modelsEntry.deleteEntry(providerId)
    } catch (e) {
      credentialsCleared = false
      residualHint = `扩展已卸载，但 models.json 羊毛条目（${providerId}）删除被拒：${toErrorMessage(e)}。请修复或删除该文件后重新执行卸载（或手动删除 ${providerId} 条目）。`
      console.warn(`[wool-manager] models.json entry removal rejected before uninstall (family=${family}): ${toErrorMessage(e)}`)
    }
    try {
      await this.deps.extensionService.uninstallExtension(`@zhushanwen/pi-wool-${family}`)
    } catch (e) {
      throw new WoolActionError(
        'uninstall_failed',
        `扩展卸载失败：${toErrorMessage(e)}。请到扩展管理页重试卸载；${credentialsCleared ? `models.json 凭据条目已清除（${providerId}）` : `models.json 凭据条目（${providerId}）删除被拒，见卸载完成后的残留提示`}`,
      )
    }
    // settings 羊毛域清除该家族条目（adopted/autoCheckin/nickname 全清 = 放弃接入语义）。
    const settings = this.deps.settings.read()
    const families = { ...(settings.families ?? {}) }
    delete families[family]
    this.deps.settings.write({ ...settings, families })
    // 缓存清理：安装态/账号/检测/目录四缓存 + 目录缓存文件重写（聚合源条目随之消失）。
    this.installedCache.delete(family)
    this.accountCache.delete(family)
    this.detectCache.delete(family)
    this.catalogCache.delete(family)
    this.persistCatalogCacheFile()
    const clearedParts: string[] = []
    if (clearData?.cleared === true) clearedParts.push('进程内凭据副本')
    if (clearData?.persistCleared === true) clearedParts.push('模型目录持久化缓存')
    if (!clearDelivered) {
      // 扩展侧 clear 不可达：分层事实进回执 message 素材（不阻断、不静默）。
      console.warn(`[wool-manager] extension-side residue may remain (family=${family}): clear undelivered, cleared=${JSON.stringify(clearedParts)}`)
    }
    // credentialsCleared=true 时无 residualHint（凭据已清 + 扩展已卸载 = 完整清理，无残留
    // 须呈现；扩展侧分层清理项仅日志留痕——失败面已由 credentialsCleared=false 单一承载）。
    return { credentialsCleared, ...(residualHint !== undefined ? { residualHint } : {}) }
  }

  // ── 目录缓存持久化（QuotaCache 同形态：<dataDir>/wool-catalog.json 原子写）──

  private catalogCachePath(): string {
    return join(this.deps.dataDir, CATALOG_CACHE_FILENAME)
  }

  private loadCatalogCacheFile(): void {
    const filePath = this.catalogCachePath()
    if (!existsSync(filePath)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (e) {
      console.warn(`[wool-manager] catalog cache parse failed (reset): ${toErrorMessage(e)}`)
      return
    }
    if (!isRecord(parsed) || !isRecord(parsed.families)) return
    for (const [family, view] of Object.entries(parsed.families)) {
      if (!isWoolFamilyId(family)) continue
      if (!isRecord(view) || typeof view.fetchedAt !== 'number' || !Array.isArray(view.models)) continue
      const models: WoolCatalogModelView[] = []
      for (const model of view.models) {
        if (!isRecord(model) || typeof model.id !== 'string' || typeof model.name !== 'string') continue
        models.push({
          id: model.id,
          name: model.name,
          ...(typeof model.api === 'string' ? { api: model.api } : {}),
          ...(model.reasoning === true ? { reasoning: true } : {}),
          ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
        })
      }
      this.catalogCache.set(family, { models, fetchedAt: view.fetchedAt })
    }
  }

  private persistCatalogCacheFile(): void {
    const families: WoolCatalogCacheFile['families'] = {}
    for (const [family, view] of this.catalogCache) {
      families[family] = view
    }
    const filePath = this.catalogCachePath()
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const tmpPath = `${filePath}.tmp`
      writeFileSync(tmpPath, JSON.stringify({ families }, null, CATALOG_CACHE_JSON_INDENT), 'utf8')
      renameSync(tmpPath, filePath)
    } catch (e) {
      // 持久化失败只损失「重启后离线可见」增量，内存缓存仍在（辅助功能降级不拖核心）。
      console.warn(`[wool-manager] catalog cache persist failed: ${toErrorMessage(e)}`)
    }
  }

  // ── 模型选择器聚合源（model-service 并入消费；纯内存读）────────────────

  /**
   * 羊毛条目 ProviderInfo 视图（model.list 聚合并入数据源）。只并入有目录缓存的家族
   * （数据驱动；无缓存 = 选择器无羊毛条目）。不进 config.providers 帧（S9 零回归——
   * 既有 provider 管理面零感知羊毛），kind 不标（羊毛条目不经 ProviderKind 消费方）。
   * apiKeySet 按 models.json 羊毛条目事实（凭据通道 D2：条目缺凭据 = false，选择器
   * 呈现未配置态而非假就绪）。
   */
  listWoolProviderInfos(): ProviderInfo[] {
    const infos: ProviderInfo[] = []
    for (const [family, catalog] of this.catalogCache) {
      if (catalog.models.length === 0) continue
      const manifestEntry = this.manifestCache?.manifest.families[family]
      const account = this.accountCache.get(family)
      const providerId = woolProviderId(family)
      infos.push({
        id: providerId as ProviderInfo['id'],
        name: manifestEntry?.displayName ?? family,
        apiKeySet: this.deps.modelsEntry.hasCredentials(providerId),
        status: account?.loggedIn === true ? 'connected' : 'not_configured',
        models: catalog.models.map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.api !== undefined ? { api: model.api } : {}),
          ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
          ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        })),
        enabled: true,
      })
    }
    return infos
  }
}
