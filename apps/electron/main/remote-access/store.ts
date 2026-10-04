/**
 * remote-access.json 配置存储（main 写侧 SSOT）。
 *
 * remote-access D2：main 是该文件的唯一写入方（生成/轮换 token、开关状态落盘），
 * runtime 是热读方（每次 WS auth 握手读 remote token 入鉴权集合）——因此本模块的
 * 写入形态（原子写 + 0600 + 字段契约）直接构成 runtime 读侧行为的前置：
 * - 原子写（同目录 `.tmp` 临时文件 + renameSync）：rename 的目标 inode 要么是完整
 *   旧内容要么是完整新内容，runtime 热读永不撕裂；
 * - 0600：token 等同远程控制凭据，禁 group/other 读取（与 runtime-token 同级）；
 * - 字段契约：@taiji/shared 的 RemoteAccessConfig + REMOTE_ACCESS_FILENAME，
 *   shape 判据（对象 + enabled boolean + token string）复用 shared 的
 *   isRemoteAccessConfigShape 单源（与 runtime 读侧 parseRemoteAccessToken
 *   import 同一谓词）；本侧从严策略层（token 64 位 hex 小写 + createdAt 非空
 *   字符串恒校验）叠加其上——从严 vs runtime 读侧 fail-closed 条件校验的
 *   不对称是刻意的双侧策略差异，不上收。
 *
 * E10 main 侧：读取时发现文件损坏（非法 JSON / 字段不合法）→ 重建默认配置写回 +
 * 响亮日志（含恢复指引）。轮换是现成的人工恢复通道（重写文件）。
 *
 * 依赖方向：store → node:crypto/fs/path + @taiji/shared（契约与 getDataDir）。
 * dataDir 参数注入（测试用），缺省 getDataDir() 动态推导——禁硬编码数据目录。
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRemoteAccessConfigShape, REMOTE_ACCESS_FILENAME, REMOTE_TOKEN_HEX64, type RemoteAccessConfig } from '@taiji/shared'
import { getDataDir } from '@taiji/shared/paths'

/** remote token 熵：32 字节 = 256 bit（hex 编码后 64 字符），对齐 runtime-token 量级。 */
const REMOTE_TOKEN_BYTES = 32

/**
 * remote-access.json 文件权限：owner 读写（0600）。文件承载 remote token（LAN 上
 * 完全控制 taiji 的凭据），禁 group/other 读取（D2：与 dataDir 内其他凭据同级）。
 */
const REMOTE_ACCESS_FILE_MODE = 0o600

/** 配置文件 JSON 缩进（人类可读落盘，与 dataDir 内其他 JSON 配置文件一致）。 */
const CONFIG_JSON_INDENT = 2

/** 生成 remote token：32 字节随机值的 hex 编码（64 位小写 hex）。 */
export function generateRemoteAccessToken(): string {
  return randomBytes(REMOTE_TOKEN_BYTES).toString('hex')
}

/** 默认配置工厂：关态 + 新 token + 当前时刻（缺文件/E10 重建共用）。 */
function createDefaultRemoteAccessConfig(): RemoteAccessConfig {
  return { enabled: false, token: generateRemoteAccessToken(), createdAt: new Date().toISOString() }
}

/**
 * 结构守卫（禁 any 红线：unknown 经 shape 收窄后才按契约消费）。
 * shape 判据（对象 + enabled boolean + token string）复用 shared 的
 * isRemoteAccessConfigShape 单源（runtime 读侧 import 同一谓词，判据不可能分叉）；
 * 本侧在其上叠加写侧从严策略：token 恒须 64 位 hex 小写（REMOTE_TOKEN_HEX64）+
 * createdAt 恒须非空字符串——不合法的配置不会被本模块写出。runtime 读侧只强校验
 * enabled/token（hex 校验在 enabled=true 分支），从严差是刻意的双侧策略差异。
 */
export function isValidRemoteAccessConfig(value: unknown): value is RemoteAccessConfig {
  if (!isRemoteAccessConfigShape(value)) return false
  const record = value as Record<string, unknown>
  return (
    REMOTE_TOKEN_HEX64.test(value.token) &&
    typeof record.createdAt === 'string' &&
    record.createdAt.length > 0
  )
}

/** 配置文件绝对路径（dataDir 注入优先，缺省 getDataDir() 动态推导）。 */
function resolveRemoteAccessFilePath(dataDir?: string): string {
  return join(dataDir ?? getDataDir(), REMOTE_ACCESS_FILENAME)
}

/** Node 错误形态收窄（unknown → ErrnoException：携带 string code 的 Error，运行时守卫替代 any）。 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string'
}

/**
 * 读取当前配置。
 *
 * - 缺文件（ENOENT）→ 默认关态配置（内存返回，不落盘——首次开启/轮换时才产生文件）；
 * - 其他读失败（EACCES/EISDIR 等路径异常）→ 响亮日志照记（降级 ≠ 吞错，对齐 E10 处理
 *   强度）+ 按缺文件同形态降级为默认关态（fail-closed 不变，文件未被改动，不写回）；
 * - 文件损坏 → E10 重建：写回默认配置 + 响亮日志（ensureRemoteAccessIntegrity）。
 *
 * @param dataDir 可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function readRemoteAccessConfig(dataDir?: string): RemoteAccessConfig {
  let raw: string
  try {
    raw = readFileSync(resolveRemoteAccessFilePath(dataDir), 'utf-8')
  } catch (error) {
    // 缺文件是首次启动的正常形态：静默降级，不报错不落盘
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return createDefaultRemoteAccessConfig()
    }
    const detail = isErrnoException(error) ? `${error.code}: ${error.message}` : String(error)
    console.error(
      `[remote-access] ${REMOTE_ACCESS_FILENAME} 读取失败（${detail}）— 按缺文件降级为默认关态配置（本进程内生效，原文件未被改动）。` +
        '恢复：检查文件权限/占用（权限异常时 chmod 600 归位）后重启应用；或回桌面端 设置 → 远程访问面板 重新开启（将重写文件并重启 runtime 生效）',
    )
    return createDefaultRemoteAccessConfig()
  }
  return ensureRemoteAccessIntegrity(raw, dataDir)
}

/**
 * E10 main 侧：损坏配置重建。
 *
 * JSON.parse 失败或字段不合法（含 token 非 64 位 hex）→ 重建默认配置（关态 + 新 token）
 * 写回文件 + console.error 响亮日志（含恢复指引）。开态下损坏被重建为关态是刻意的
 * fail-closed：宁可让用户回面板重新开启，不可默认带着未知来源的 token 绑 LAN。
 *
 * @param raw 文件原始内容
 * @param dataDir 可选数据根目录（测试注入）
 */
function ensureRemoteAccessIntegrity(raw: string, dataDir?: string): RemoteAccessConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined // 非法 JSON 走统一重建分支
  }
  if (isValidRemoteAccessConfig(parsed)) return parsed
  console.error(
    `[remote-access] ${REMOTE_ACCESS_FILENAME} 内容损坏（非法 JSON 或字段不合法）— 已重建为默认关态配置（新 token）。` +
      '恢复：回桌面端 设置 → 远程访问面板 重新开启（将按新 token 重写文件并重启 runtime 生效）',
  )
  const rebuilt = createDefaultRemoteAccessConfig()
  writeRemoteAccessConfig(rebuilt, dataDir)
  return rebuilt
}

/**
 * 原子写配置（同目录 `.tmp` 临时文件 + renameSync）+ 0600。
 *
 * 原子性：rename 是同目录内的 inode 原子替换，runtime 热读侧要么读到完整旧内容
 * 要么读到完整新内容，无半截 JSON 窗口（D2 配套规格①）。
 * 权限：writeFileSync 的 mode 只在创建文件时生效且受 umask 影响；`.tmp` 每次都是
 * 新建文件（mode 生效），rename 后再 chmodSync 兜底（对齐 process-control
 * issueRuntimeToken 的 writeFileSync + chmodSync 双保险形态）。
 *
 * @param config 待写配置（调用方保证字段合法；本模块产出的配置均经结构守卫）
 * @param dataDir 可选数据根目录（测试注入）；缺省读 getDataDir()
 */
export function writeRemoteAccessConfig(config: RemoteAccessConfig, dataDir?: string): void {
  const dir = dataDir ?? getDataDir()
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, REMOTE_ACCESS_FILENAME)
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(config, null, CONFIG_JSON_INDENT)}\n`, { mode: REMOTE_ACCESS_FILE_MODE })
  renameSync(tmpPath, filePath)
  chmodSync(filePath, REMOTE_ACCESS_FILE_MODE)
}

/**
 * 轮换 remote token：保留 enabled 与 createdAt，仅替换 token 并重写文件。
 *
 * 写文件即生效（D2）：runtime 每次握手热读，下一次新握手起旧 token 失效——
 * 不触发 runtime 重启、不中断在途 turn。存量已认证连接不随轮换踢除（D2 显式判定：
 * 完整处置 = 轮换 + 关开开关触发重启）。
 *
 * @param dataDir 可选数据根目录（测试注入）
 * @returns 轮换后的完整配置
 */
export function rotateRemoteAccessToken(dataDir?: string): RemoteAccessConfig {
  const current = readRemoteAccessConfig(dataDir)
  const rotated: RemoteAccessConfig = { ...current, token: generateRemoteAccessToken() }
  writeRemoteAccessConfig(rotated, dataDir)
  return rotated
}

/**
 * 切换开关状态：保留 token 与 createdAt，仅改 enabled 并重写文件。
 *
 * listen host（127.0.0.1 ↔ 0.0.0.0）是 runtime 启动期一次性决策（D9 argv 判据），
 * 本函数只落盘——重启 runtime 由调用方（IPC handler）触发。关态后文件留存（D2
 * 配套规格③），再开启复活原 token。
 *
 * @param enabled 目标开关状态
 * @param dataDir 可选数据根目录（测试注入）
 * @returns 更新后的完整配置
 */
export function setRemoteAccessEnabled(enabled: boolean, dataDir?: string): RemoteAccessConfig {
  const current = readRemoteAccessConfig(dataDir)
  const updated: RemoteAccessConfig = { ...current, enabled }
  writeRemoteAccessConfig(updated, dataDir)
  return updated
}
