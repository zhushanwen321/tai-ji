/**
 * auth.json 凭据存储（OAuth 路径 B 自实现）。
 *
 * 镜像 pi FileAuthStorageBackend 的 RMW 语义（写前重读最新文件，防丢更新），
 * 跨进程锁用统一 mkdir 锁 @zhushanwen/pi-file-lock/core（磁盘协议与 pi 内嵌锁兼容，
 * 同一把锁、同一路径语义：<auth.json>.lock）——
 * pi 侧 resolveStoredOAuth 在 token 过期时持锁刷新并写回 auth.json，与 taiji
 * login 写入是真实跨进程并发写场景；进程内 mutex 只能串行化本进程写入，无跨进程锁时
 * RMW 后写者基于陈旧读覆盖先写者，轮换后的 refresh_token 会丢失（anthropic 等
 * 轮换 refresh token 的 provider 掉登录）。
 *
 * 安全约束：文件内容是 OAuth token，权限 0600；任何路径不得打印 credential。
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { withFileLockAsync } from '../../utils/file-lock.js'

/** auth.json 凭据文件权限：0600 = 仅 owner 可读写（文件内容是 OAuth token，见文件头安全约束） */
const OWNER_READ_WRITE_MODE = 0o600

export interface ApiKeyCredential {
  type: 'api_key'
  key: string
  env?: Record<string, string>
}

export interface OAuthCredential {
  type: 'oauth'
  access: string
  refresh?: string
  expires: number
  [k: string]: unknown
}

export type Credential = ApiKeyCredential | OAuthCredential

/**
 * auth.json 凭据写通道（A1-4 收口）：全 runtime 对 auth.json 的写入唯一入口是
 * AuthService.saveCredential（内部调 authStorage.set），其余消费方（setProvider 的
 * catalog apiKey / provider 导入 / legacy 迁移）经此窄接口注入，不再直接持有
 * authStorage.set——单一写入口保证与 pi 侧 refresh 写回的互斥语义可审计
 *（provider-config-quota 架构 §3.4 三 Store 收口表）。
 */
export interface CredentialWriter {
  saveCredential(providerId: string, credential: Credential): Promise<void>
}

/**
 * 跨进程写锁：锁协议（统一 mkdir 锁参数 + 指数退避重试）单点在
 * utils/file-lock.ts 的 withFileLockAsync，与 pi FileAuthStorageBackend.withLockAsync
 * 互斥同一把锁（<auth.json>.lock）；旧版锁的 onCompromised 保活检测已随锁统一移除
 * （无 compromise 检测，行为变化声明见 file-lock.ts 模块头）。
 * ensure 钩子按 pi 同款 ensureFileExists 惯例在建锁前物化空文件（0600）——统一锁
 * realpath:false、锁的是 <auth.json>.lock 目录，加锁不依赖目标文件存在，此处为
 * 对齐 pi 侧惯例而非加锁前置条件。
 */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  return withFileLockAsync(filePath, { ensure: () => ensureFileExists(filePath), logTag: 'auth-storage' }, fn)
}

/** 与 pi FileAuthStorageBackend.ensureFileExists 同款：锁前保证文件存在（对齐 pi 侧惯例，见 withFileLock 注释） */
function ensureFileExists(filePath: string): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, '{}', { encoding: 'utf-8', mode: OWNER_READ_WRITE_MODE })
    chmodSync(filePath, OWNER_READ_WRITE_MODE)
  }
}

/**
 * 原子写：tmp 文件（同目录保证 rename 同文件系统）→ fsync → rename → chmod 0600。
 * open 时即指定 0600，rename 后再 chmod 一次兜底（rename 保留 tmp 的 mode，
 * 但显式 chmod 使权限位不依赖实现细节）。
 */
function writeFileAtomic(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`
  const fd = openSync(tmpPath, 'w', OWNER_READ_WRITE_MODE)
  try {
    writeFileSync(fd, content, 'utf-8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, filePath)
  chmodSync(filePath, OWNER_READ_WRITE_MODE)
}

/**
 * 读并解析 auth.json。文件不存在按空对象（首次写入前 get 是合法路径）。
 *
 * JSON 损坏时按调用方语义分叉：
 * - 读路径（degradeOnCorrupt=true，get/getAll/hasCredentialSync/listCredentialIds/hasOAuth*）：
 *   降级为空对象 + warn。前提「损坏意味着外部篡改」不成立——pi 的
 *   FileAuthStorageBackend 写 auth.json 是原地 writeFileSync+chmodSync（无 tmp+rename，
 *   已核对 pi 源码），刷新 token 时进程被杀即留截断文件；且同步读不持锁，pi 持锁
 *   原地写期间并发读可读到撕裂 JSON。单文件损坏不应打挂整个 provider 列表
 *   （listProviders / composer 模型聚合 / config.hasOAuth 都经此读）。
 * - 写路径（degradeOnCorrupt=false，set/remove 的 RMW 锁内重读）：保留抛错。
 *   静默覆盖会基于空对象写回，丢掉损坏文件中仍可恢复的部分，且掩盖磁盘异常。
 */
function readAuthFile(filePath: string, degradeOnCorrupt: boolean): Record<string, Credential> {
  if (!existsSync(filePath)) return {}
  const raw = readFileSync(filePath, 'utf-8')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw) as Record<string, Credential>
  } catch (cause) {
    if (degradeOnCorrupt) {
      console.warn(`[auth-storage] auth.json 损坏，按空凭据处理（pi 原地写/撕裂读可致，可重新登录恢复）: ${filePath}`)
      return {}
    }
    throw new Error(`auth.json 损坏: ${filePath}`, { cause })
  }
}

export class AuthStorage {
  constructor(private readonly filePath: string) {}

  async get(providerId: string): Promise<Credential | undefined> {
    return readAuthFile(this.filePath, true)[providerId]
  }

  async getAll(): Promise<Record<string, Credential>> {
    return readAuthFile(this.filePath, true)
  }

  /** RMW：锁内重读最新文件 → merge 单 provider → 原子写回 */
  async set(providerId: string, credential: Credential): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const data = readAuthFile(this.filePath, false)
      data[providerId] = credential
      // eslint-disable-next-line no-magic-numbers -- 缩进 2 空格，与 pi FileAuthStorageBackend 输出格式一致
      writeFileAtomic(this.filePath, JSON.stringify(data, null, 2))
    })
  }

  /** 幂等：provider 不存在时跳过写（避免无谓的磁盘 IO）。文件不存在时直接返回——
   * 没有可读可删的内容，且避免 withFileLock 的 ensureFileExists 在 remove 路径物化空
   * auth.json（从未使用过 OAuth 的用户目录每次保存 API Key 都会走 remove，不该产生文件）。
   * 注意：set() 等其余走锁路径仍会经 ensureFileExists 物化文件（对齐 pi 侧惯例，
   * get/getAll 纯读不持锁不经 ensure）。 */
  async remove(providerId: string): Promise<void> {
    if (!existsSync(this.filePath)) return
    await withFileLock(this.filePath, async () => {
      const data = readAuthFile(this.filePath, false)
      if (!(providerId in data)) return
      delete data[providerId]
      // eslint-disable-next-line no-magic-numbers -- 缩进 2 空格，与 pi FileAuthStorageBackend 输出格式一致
      writeFileAtomic(this.filePath, JSON.stringify(data, null, 2))
    })
  }

  /**
   * 同步判 auth.json 内存快照中有该 providerId 的任意 type 条目（api_key 或 oauth）。
   * 用于 listProviders 替代 hasOAuthSync 的 oauth-only 判定。
   * 注意：写路径是原子 rename，读永远拿到完整文件——但该保证只对 taiji 自写成立
   * （pi 侧 FileAuthStorageBackend 原地写，撕裂读/截断文件仍可能；损坏时降级为空）。
   */
  hasCredentialSync(providerId: string): boolean {
    return providerId in readAuthFile(this.filePath, true)
  }

  /**
   * 同步列出 auth.json 顶层所有 providerId（provider key 列表）。
   * wave2 listProviders 双源聚合 catalog 源用（C4 推荐方案）：聚合 (auth.json keys ∪
   * models.json catalog keys) ∩ builtinData，修复 F1（catalog 凭据在 auth.json 但
   * models.json 无该条目时也能显示）。文件不存在/空 → []，与 hasCredentialSync 同源
   * （复用 readAuthFile 私有核心）。文件不存在/空/损坏 → []，与 hasCredentialSync 同源。
   * 注意：写路径原子 rename 的完整性保证只对 taiji 自写成立（pi 原地写可致撕裂）。
   */
  listCredentialIds(): string[] {
    return Object.keys(readAuthFile(this.filePath, true))
  }

  /** @deprecated 用 hasCredentialSync 替代（支持 api_key + oauth 联合类型） */
  async hasOAuth(providerId: string): Promise<boolean> {
    return readAuthFile(this.filePath, true)[providerId]?.type === 'oauth'
  }

  /**
   * @deprecated 用 hasCredentialSync 替代（支持 api_key + oauth 联合类型）。
   * 同步版 hasOAuth（listProviders 是同步契约，M6 status 派生用）。
   * 与异步版读同一 readAuthFile（同步核心）；损坏时降级为空（与读路径语义一致）。
   */
  hasOAuthSync(providerId: string): boolean {
    return readAuthFile(this.filePath, true)[providerId]?.type === 'oauth'
  }
}
