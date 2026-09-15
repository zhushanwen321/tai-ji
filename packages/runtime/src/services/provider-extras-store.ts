/**
 * TaijiProviderStore — taiji 扩展域 providers.json 的唯一读写者。
 *
 * 文件：`<piAgentDir>/config/providers.json`（路径 SSOT = pi-paths.getProviderExtrasPath）。
 * 承载自 pi models.json 迁出的 taiji 私有字段（provider 级 quota/authMethod、
 * models[].enabled 转化的 modelStates），models.json 只留 pi schema 内字段——
 * pi 升级收紧 schema 时 taiji 配置零迁移风险（provider-config-quota 架构 G3/D4）。
 *
 * 并发安全：读-改-写全程统一 mkdir 锁 @zhushanwen/pi-file-lock/core（与 auth-storage.ts
 * 的 AuthStorage 同模式、磁盘协议与 pi 内嵌锁兼容——pi 侧/多实例并发写 providers.json
 * 时 RMW 后写者基于陈旧读覆盖先写者）；
 * 写走 atomicWrite（tmp + rename）。损坏容错复用 quarantineCorruptFile（rename 为
 * `<path>.corrupt-<ts>` 保留取证 + 按空配置继续，与 JsonStore 隔离行为同源）。
 *
 * 注意：本文件不存放凭证明文（cookieSet/apiKeySet 只是布尔标记），无需 0600。
 * 实例模式（构造传 filePath），组合根创建单例注入消费方——与 AuthStorage 同构。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { QuotaCredentialSource } from '@taiji/shared'
import { withFileLockAsync } from '../utils/file-lock.js'
import { atomicWrite } from '../utils/fs-utils.js'
import { quarantineCorruptFile } from '../utils/json-store.js'

/** providers.json 文件结构（version 留未来迁移钩子，当前恒 1）。 */
export interface ProviderExtrasFile {
  version: 1
  providers: Record<string, ProviderExtras>
  /** 顶层 scopedModels（模型白名单 + 有序列表，scoped-model design §3.2）。可选：缺失 = 空。 */
  scopedModels?: string[]
}

/** 单 provider 的 taiji 扩展数据（全部字段自 models.json 寄生字段迁出，语义不变）。 */
export interface ProviderExtras {
  /** 凭证形态标注（自 models.json providers.<id>.authMethod 迁入）。 */
  authMethod?: 'api_key' | 'oauth' | 'env_var' | 'ambient'
  /** 套餐额度绑定（自 models.json providers.<id>.quota 迁入，含 cookieSet/apiKeySet 布尔态）。 */
  quota?: {
    fetcher?: string
    enabled: boolean
    cookieSet?: boolean
    apiKeySet?: boolean
    /**
     * 凭证来源（D3，coding-plan-quota-config-ux §7.3 改动 6）：恒由 configure payload
     * 显式值经继承链落盘（键缺省 = 继承既存），写侧禁止调 resolveQuotaCredentialSource
     * 补默认——那是读侧推断（**显式值优先**），补默认的危害不是覆盖显式值，而是把未设置的
     * 字段**物化**成推断值：setEnabled 式缺省 payload 会静默写入用户从未选择过的来源，
     * 此后该 provider 不再跟随推断（专属 Key 被清后 apiKeySet 变 false，读侧本应回落
     * provider，冻结的显式值会让查询走向 no-credential）。未设置时读侧按
     * resolveQuotaCredentialSource 推断（兼容历史数据：apiKeySet=true → exclusive）。
     */
    credentialSource?: QuotaCredentialSource
    /**
     * 资源维度 fetcher（opencode）的 workspace 归一化地址（规范 URL，非凭证明文存储——
     * 用户浏览器地址栏可见的同一 URL，timeout-audit-hygiene-batch D1-1）。
     */
    workspace?: string
  }
  /** 模型启停（自 models.json providers.<id>.models[].enabled 迁入，key = modelId）。 */
  modelStates?: Record<string, { enabled: boolean }>
  /**
   * 用户网关标记（catalog provider 的 models.json provider 级 baseUrl 属用户显式设置时写入，
   * 与 authMethod 同域显式标注先例）。
   *
   * 仅作 D2 存量清洗判定锚：清洗时**仅存在性判定**（键在 = 用户网关 → 保留 models.json 键；
   * 键不在 = 历史冻结 artifact → 剥除），禁按值比对（标记值 stale 不影响判定）。
   * 不参与任何展示/取值的推导——网关展示与取值的唯一来源是 models.json override 非空 baseUrl
   * （避免「键已剥、标记待清」窗口展示 stale 标注）。
   */
  gatewayBaseUrl?: string
}

const EMPTY_FILE: ProviderExtrasFile = { version: 1, providers: {} }

/** JSON 序列化缩进（与 pi models.json / auth.json 输出格式一致，2 空格）。 */
const JSON_INDENT = 2
/** 损坏 shape 诊断消息中的 JSON 快照截断长度（防超长内容刷屏日志）。 */
const SCHEMA_SNIPPET_MAX = 120

/**
 * 跨进程写锁：锁协议（统一 mkdir 锁 @zhushanwen/pi-file-lock/core 参数 + 指数退避
 * 重试）单点在 utils/file-lock.ts 的 withFileLockAsync（与 AuthStorage 同模式，
 * 磁盘协议与 pi 内嵌锁兼容同一把锁）——pi 侧/多实例并发写 providers.json 时 RMW
 * 后写者基于陈旧读覆盖先写者。旧版锁的 onCompromised 保活检测已随锁统一移除
 * （无 compromise 检测，行为变化声明见 file-lock.ts 模块头）。锁前 ensureFileExists
 * 建空结构（写路径专用；读路径不持锁不物化文件）。
 */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  return withFileLockAsync(
    filePath,
    { ensure: () => ensureFileExists(filePath), logTag: 'provider-extras-store' },
    fn,
  )
}

/** 锁前保证文件存在（统一锁 realpath:false、加锁不依赖目标文件存在，物化空结构是
 * 对齐 pi 侧 ensureFileExists 惯例而非加锁前置条件，见 withFileLock 注释）。
 * 同时确保 config/ 父目录存在。 */
function ensureFileExists(filePath: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(filePath)) {
    writeFileSync(filePath, JSON.stringify(EMPTY_FILE, null, JSON_INDENT), 'utf-8')
  }
}

/** scopedModels 条目格式契约（provider/modelId）：写侧校验（settings-message-handler
 * config.setScopedModels）与读侧 sanitize（sanitizeScopedModels）共用同一正则。 */
export const SCOPED_MODEL_REGEX = /^[^/]+\/.+$/

/**
 * scopedModels 读侧独立容错（design §3.2 兼容性 / §风险矩阵）：非 string[] 或条目非
 * `x/y` 格式 → 过滤非法条目 + log warning，**不隔离文件、providers 域不受影响**。
 *
 * 与 providers 域「形态不符 → 整文件 quarantine」刻意不同（scopedModels 不参与
 * readInternal 的整文件隔离判定）：scopedModels 是独立新增顶层字段，损坏时连坐
 * quota/modelStates 一起按空配置继续会扩大爆炸半径——白名单失效但 provider 配置全丢。
 * 非数组（过滤无从谈起）→ 返回 []。
 *
 * 去重保序（首见保留）：手改 providers.json 写入重复条目是合法输入路径（design §1.3），
 * 读侧唯一入口在此收敛去重——否则重复条目直达 aggregateModels 输出重复模型，模型选择器
 * 渲染重复项。写侧去重（settings-message-handler）只是第一道防线，读侧兜底不可省。
 */
function sanitizeScopedModels(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    console.warn('[provider-extras-store] scopedModels: not an array, ignoring:', JSON.stringify(value)?.slice(0, SCHEMA_SNIPPET_MAX))
    return []
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') {
      console.warn('[provider-extras-store] scopedModels: non-string entry filtered out:', entry)
      continue
    }
    if (!SCOPED_MODEL_REGEX.test(entry)) {
      console.warn('[provider-extras-store] scopedModels: invalid entry format (expected provider/modelId):', entry)
      continue
    }
    if (seen.has(entry)) {
      console.warn('[provider-extras-store] scopedModels: duplicate entry dropped (first occurrence kept):', entry)
      continue
    }
    seen.add(entry)
    result.push(entry)
  }
  return result
}

/**
 * 读并解析 providers.json。文件不存在返回空结构（读路径不物化文件）。
 * 损坏（非法 JSON / version 非 1）→ quarantineCorruptFile 隔离为
 * `<path>.corrupt-<ts>` 后按空配置继续（设计文档 §3.4 错误规格：按空配置启动，
 * 备份坏文件供人工恢复——隔离是 rename 语义，原位置不会被后续写覆盖坏文件内容）。
 */
function readInternal(filePath: string): ProviderExtrasFile {
  if (!existsSync(filePath)) return { version: 1, providers: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (cause) {
    quarantineCorruptFile(filePath, { tag: 'provider-extras-store', reason: 'parse failed', cause })
    return { version: 1, providers: {} }
  }
  const file = parsed as ProviderExtrasFile
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || file.version !== 1
    // providers: null 必须显式排除：typeof null === 'object' 会让下方类型检查穿透，
    // null 原样返回后消费方（readAllExtrasWithFallback 的 merged[key] 赋值）TypeError
    // 且不触发隔离自愈（round 1 review must-fix #5）
    || file.providers === null
    // providers: [] 同理穿透：typeof [] === 'object'，数组形态原样返回后 modify 对其
    // 赋字符串键属性，JSON.stringify 序列化数组只留索引项 → 写盘静默丢弃、文件永久
    // 停留损坏形态无自愈（round 2 review must-fix）
    || Array.isArray(file.providers)
    || typeof file.providers !== 'object'
    // 条目级形态：providers: {"foo": null} 穿透后 getExtrasSync('foo') 返回 null 与
    // 签名 ProviderExtras | undefined 失实，消费方 !== undefined 判定被 null 欺骗
    // （round 2 review suggestion）
    || !Object.values(file.providers).every(
      entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    )) {
    quarantineCorruptFile(filePath, {
      tag: 'provider-extras-store',
      reason: 'schema mismatch (expect { version: 1, providers: {} })',
      cause: new Error(`unexpected shape: ${JSON.stringify(parsed).slice(0, SCHEMA_SNIPPET_MAX)}`),
    })
    return { version: 1, providers: {} }
  }
  return file
}

/** 原子写（tmp + rename）+ 确保父目录。恒写 version: 1。 */
function writeInternal(filePath: string, file: ProviderExtrasFile): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  atomicWrite(filePath, JSON.stringify({ ...file, version: 1 }, null, JSON_INDENT))
}

/** providers.json 的唯一读写者。所有写入必须经 modify/delete（RMW 锁内）。 */
export class TaijiProviderStore {
  constructor(private readonly filePath: string) {}

  /**
   * 同步读全部扩展数据。同步契约的消费方（listProviders 聚合层，
   * IConfigService 同步接口）用；读路径不持锁、不缓存，每次调用读盘
   * ——先例：AuthStorage.hasCredentialSync / listCredentialIds。
   */
  readAllSync(): Record<string, ProviderExtras> {
    return readInternal(this.filePath).providers
  }

  /** 同步读单 provider 扩展数据（getExtras 的同步版，无条目 → undefined）。 */
  getExtrasSync(providerId: string): ProviderExtras | undefined {
    return readInternal(this.filePath).providers[providerId]
  }

  /**
   * RMW 单入口：锁内重读最新文件 → fn(current) 计算新值 → 原子写回。
   * current 是该 provider 当前扩展数据（无条目时 undefined）；返回值整条替换。
   * 并发 modify 同 provider 由锁串行化（后者基于前者的结果计算）。
   */
  async modify(
    providerId: string,
    fn: (current: ProviderExtras | undefined) => ProviderExtras,
  ): Promise<ProviderExtras> {
    let result: ProviderExtras | undefined
    await withFileLock(this.filePath, async () => {
      const file = readInternal(this.filePath)
      result = fn(file.providers[providerId])
      file.providers[providerId] = result
      writeInternal(this.filePath, file)
    })
    return result!
  }

  /**
   * 删除 provider 扩展条目。幂等：条目不存在时跳过写；文件不存在时直接返回
   * （不物化 providers.json——对齐 AuthStorage.remove 的「无内容不产生文件」语义）。
   */
  async delete(providerId: string): Promise<void> {
    if (!existsSync(this.filePath)) return
    await withFileLock(this.filePath, async () => {
      const file = readInternal(this.filePath)
      if (!(providerId in file.providers)) return
      delete file.providers[providerId]
      writeInternal(this.filePath, file)
    })
  }

  /**
   * 读取顶层 scopedModels 字段（模型白名单 + 有序列表）。
   * 文件不存在或字段缺失返回空数组（读路径不物化文件）。
   * 损坏值（非 string[] / 条目非 x/y 格式）独立容错：过滤 + warn，不隔离文件
   * （providers 域不受影响），返回合法子集——aggregateModels 消费方永不接触损坏值。
   */
  getScopedModelsSync(): string[] {
    return sanitizeScopedModels(readInternal(this.filePath).scopedModels)
  }

  /**
   * RMW 顶层 scopedModels 字段：锁内重读 → fn(current) → 原子写回。
   * current 是当前 scopedModels（无字段/损坏时 []——sanitize 后 caller 永不接触
   * 损坏值）；返回值整条替换。
   */
  async modifyScopedModels(
    fn: (current: string[]) => string[],
  ): Promise<string[]> {
    let result: string[] | undefined
    await withFileLock(this.filePath, async () => {
      const file = readInternal(this.filePath)
      result = fn(sanitizeScopedModels(file.scopedModels))
      file.scopedModels = result
      writeInternal(this.filePath, file)
    })
    return result!
  }

  /**
   * 清理 scopedModels 中某 provider 的残留条目（deleteProvider/removeProviderByKind 后调用）。
   * 过滤掉 `providerId/` 前缀条目；无变化时跳过写。
   */
  async cleanScopedModelsResidue(providerId: string): Promise<void> {
    if (!existsSync(this.filePath)) return
    const prefix = `${providerId}/`
    await withFileLock(this.filePath, async () => {
      const file = readInternal(this.filePath)
      const current = sanitizeScopedModels(file.scopedModels)
      const remaining = current.filter(m => !m.startsWith(prefix))
      if (remaining.length === current.length) return // 幂等
      file.scopedModels = remaining
      writeInternal(this.filePath, file)
    })
  }
}
