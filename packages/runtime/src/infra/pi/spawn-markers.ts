/**
 * pi spawn 清单写入（方案 B / 设计 §6.12，U16；u17 reap 四条合取的数据源）。
 *
 * 为什么存在：B1 删除 `--session-dir` 后，reap-orphan-pi 旧判据「argv --session-dir 值
 * ≡ getSessionsDir()」失效（SIP 下拿不到他进程 env，env 判据已被在案否决）。替代方案 =
 * spawn 时把实际传入的 `--extension` / `--skill` 值中位于「staged 专属三根」之一的子集
 * 覆盖写到 `<dataDir>/run/pi-spawn-markers.json`，reap 侧要求「argv 任一
 * --extension/--skill 值 ∈ 清单精确相等」。run/ 目录先例：relay socket（relay-paths.ts）。
 *
 * 三根登记规则（值位于其一才登记；用户配置来源一律排除，设计 §6.12 + D-11 裁定）：
 *   ① 打包资源根      `*.app/Contents/Resources/extensions/`（electron-builder
 *                      extraResources 产物，打包版 builtin staged 集）
 *   ② dev 两形态（同源分流，D-11：V10① dev 正向收殓场景以清单非空为前提）
 *      ②-a dev 仓库资源根  `<repoRoot>/apps/electron/resources/extensions/`
 *                          （prepare 脚本 staged 产物；relay 脚本路径同源形态）
 *      ②-b dev 仓库源码根  `<repoRoot>/extensions/<group>/<pkg>`
 *                          （resolver dev 分支 scanBundledExtensions 的实际产出——
 *                          分组层恒在，故以「extensions 段后 ≥2 段」词法判定；
 *                          用户世界 `.pi/extensions/<pkg>` 无子层天然排除）
 *   ③ `<dataDir>` 下 ExtensionResolver 管理的 `extensions/` 与 `npm/` 子树
 *                      （子目录名 SSOT = @taiji/shared/paths，pi-paths
 *                      getExtensionsDir/getNpmDir 同源派生）
 * 原理性极限（设计 §6.12 已声明接受）：任何「与 taiji spawn 同形的 argv」词法上不可
 * 区分——如用户自有仓库的 `<proj>/extensions/<group>/<pkg>` 三层形态会命中 ②-b，
 * 由 reap 四条合取的 `--no-extensions` 主判别位兜底（裸用户 pi 不带该 flag）。
 * TaiJi spawn 的 argv 实测混有用户世界路径（~/.pi/agent/extensions/…、项目
 * .pi/extensions/…、~/.agents/skills 等）——均不在三根之下，构造上被排除；登记它们
 * = 为误杀用户进程开门（v5 原案被活体证据否决，见设计 §6.12「被否」）。
 *
 * 写语义：每次 spawn 全量重算并覆盖写（同目录 tmp + rename 原子替换），不 append——
 * 覆盖写天然清理已禁用 extension 的历史值；并发 spawn 各写各的全量集（tmp 名含
 * pid/时戳/序号不互撞），mandatory builtin 恒传保证最小集稳定（§11.11）。写入失败不阻断
 * spawn：console.error 出声后返回（宁漏不崩——reap 侧对清单缺失本就跳过收殓，
 * fail-safe 方向 = 宁漏不误杀）。
 *
 * 文件格式：JSON 字符串数组（本次 spawn 收录的路径全集，保序去重；空数组合法——
 * 零 staged 值的 spawn 仍须写文件，§11.11）。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { getConfigDir } from './pi-paths.js'

/** 清单文件名（<dataDir>/run/pi-spawn-markers.json）。 */
export const SPAWN_MARKERS_FILE_NAME = 'pi-spawn-markers.json'

/** run/ 目录名（先例：relay socket，relay-paths.ts getRelayRunDir 同款 <dataDir>/run 派生）。 */
const RUN_DIR_NAME = 'run'

/**
 * 读侧降级 warn 的统一前缀（u17 reap 消费读侧：null = 清单缺失/坏 → services 侧
 * fail-safe 跳过收殓，宁漏不误杀）。原因细节（io error / 格式坏）随参数拼在后面。
 */
const READ_SKIP_WARN_PREFIX = '[spawn-markers] read pi-spawn-markers.json failed, consumer must skip marker matching (fail-safe: prefer missed reap over mis-kill):'

/** ① 打包资源根段链（macOS .app bundle 布局；`*.app` 为任意 bundle 名——.app 是目录名后缀）。 */
const PACKAGED_APP_EXTENSIONS_RE = /\/[^/]+\.app\/Contents\/Resources\/extensions(?:\/|$)/
/** ②-a dev 仓库资源根段链（<repoRoot>/apps/electron/resources/extensions）。 */
const DEV_REPO_EXTENSIONS_CHAIN = '/apps/electron/resources/extensions'
/**
 * ②-b dev 仓库源码根（<repoRoot>/extensions/<group>/<pkg>，D-11）。
 * 判据 = extensions 段后 ≥2 段：resolver dev 分支产出恒带分组层（scanDirectory 只扫
 * 分组目录下的包），而用户世界 `.pi/extensions/<pkg>`（extensions 后无子层）与
 * 裸两层 `<root>/extensions/<pkg>`（taiji 不产出）天然排除，收紧误吸面。
 */
const DEV_SOURCE_EXTENSIONS_RE = /\/extensions\/[^/]+\/[^/]+/

/** 清单文件路径：<dataDir>/run/pi-spawn-markers.json。 */
export function getSpawnMarkersPath(dataDir: string): string {
  return join(dataDir, RUN_DIR_NAME, SPAWN_MARKERS_FILE_NAME)
}

/**
 * 读 spawn 清单（写侧 recordSpawnMarkers 全量覆盖写的读侧对称面，u17 reap 判据③数据源）。
 *
 * 分层：infra 唯一持有清单文件 io（services 层 IO 须经 port，D6c——reap-orphan-pi 经
 * 组合根注入本函数，不直接 import infra）。
 *
 * 返回 null = 清单缺失/读不到/坏 JSON/格式非字符串数组——消费方（reap）跳过本轮
 * marker 匹配（fail-safe：宁漏不误杀），原因已在此记 warn 日志（console 经 logger
 * tee 落盘，同写侧 recordSpawnMarkers 惯例）。文件不存在属常态分支（首启前 / 从未
 * spawn 过），warn 保留路径信息便于排障但语义是「跳过」不是「错误」。
 */
export function readSpawnMarkerList(dataDir: string): string[] | null {
  const markersPath = getSpawnMarkersPath(dataDir)
  let raw: string
  try {
    raw = readFileSync(markersPath, 'utf-8')
  } catch (e) {
    console.warn(`${READ_SKIP_WARN_PREFIX} unreadable (${markersPath}):`, e instanceof Error ? e.message : e)
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.some(v => typeof v !== 'string')) {
      throw new Error('expected a JSON string array')
    }
    return parsed
  } catch (e) {
    console.warn(`${READ_SKIP_WARN_PREFIX} malformed (${markersPath}):`, e instanceof Error ? e.message : e)
    return null
  }
}

/** win32 反斜杠归一为斜杠（段链判定统一按 posix 形态做，跨平台一致）。 */
function toSlashPath(value: string): string {
  return value.split('\\').join('/')
}

/** 值是否位于 root 子树内（词法判定；root 自身也算命中）。 */
function isPathUnder(value: string, root: string): boolean {
  if (!isAbsolute(value) || !isAbsolute(root)) return false
  const rel = relative(root, value)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 值是否为 staged 专属路径（三根之一，见模块头注释）——是则应登记进清单。
 * 纯词法判定（不触盘、不 realpath）：值由 resolver 以 join 产出，与判定基同进程词法一致。
 * 非绝对路径一律 false（无法锚定三根，pi 侧会按其 cwd 解析，登记无意义）。
 */
export function isStagedMarkerPath(value: string, dataDir: string): boolean {
  if (!value || !isAbsolute(value)) return false
  const normalized = toSlashPath(value)
  // ①：`.app` 是 bundle 目录名的后缀（TaiJi.app），段内任意名 + 精确段界；
  // ②-a：段链必须精确成界（chain + '/' 为后代、endsWith(chain) 为根目录自身），
  // 防 'fake-apps/…'（无段边界）与 '…/extensionsExtra/…'（前缀延伸）之类字符串误吸
  if (PACKAGED_APP_EXTENSIONS_RE.test(normalized)) return true
  if (normalized.includes(`${DEV_REPO_EXTENSIONS_CHAIN}/`) || normalized.endsWith(DEV_REPO_EXTENSIONS_CHAIN)) return true
  // ②-b：dev 源码根三层形态（分组层恒在），见常量注释
  if (DEV_SOURCE_EXTENSIONS_RE.test(normalized)) return true
  // ③：<dataDir> 下 ExtensionResolver 管理的两子树（extensions/ + npm/，tmp/ 不在登记规则内）
  return isPathUnder(value, join(dataDir, 'extensions')) || isPathUnder(value, join(dataDir, 'npm'))
}

/**
 * 从本次 spawn 的 --skill/--extension 值全集（调用方按 argv 顺序拼好：skillPaths 在前）
 * 挑出应登记的 staged 子集：保序 + 去重（同值跨两类 flag 只登记一次）。
 */
export function selectSpawnMarkerPaths(
  values: ReadonlyArray<string | undefined> | undefined,
  dataDir: string,
): string[] {
  const selected: string[] = []
  const seen = new Set<string>()
  for (const value of values ?? []) {
    if (!value || seen.has(value) || !isStagedMarkerPath(value, dataDir)) continue
    seen.add(value)
    selected.push(value)
  }
  return selected
}

/**
 * fs 依赖注入口（R3 纯 DI：原子调用序列 / 失败降级用例以桩注入断言，不 vi.mock 全局
 * node:fs——避免覆盖 fs-guard 的全局 mock）。窄化签名即可满足实现调用形态。
 */
export interface SpawnMarkerFsDeps {
  mkdirSync: (path: string, options: { recursive: true }) => void
  writeFileSync: (path: string, data: string, options: { encoding: 'utf-8' }) => void
  renameSync: (from: string, to: string) => void
  rmSync: (path: string, options: { force: true }) => void
}

const defaultFsDeps: SpawnMarkerFsDeps = { mkdirSync, writeFileSync, renameSync, rmSync }

/** 清单 JSON 缩进（人读友好；消费方只 JSON.parse，缩进值无契约意义）。 */
const MARKERS_JSON_INDENT = 2

let tmpSeq = 0

/**
 * 全量覆盖写清单（终态文件的唯一写法）。同目录 tmp + rename：rename 在同一文件系统内
 * 原子生效，中断/失败不产生半写终态——reap 读侧只见旧全量或新全量，无脏读窗口。
 * io 失败原样上抛，降级语义（不阻断 spawn）归 recordSpawnMarkers 裁决。
 */
export function writeSpawnMarkersFile(
  paths: readonly string[],
  dataDir: string,
  fsDeps: SpawnMarkerFsDeps = defaultFsDeps,
): void {
  const finalPath = getSpawnMarkersPath(dataDir)
  // run/ 不存在时自建（recursive 幂等；首启时 <dataDir>/run 尚未产生——先例 relay socket 同款）
  fsDeps.mkdirSync(dirname(finalPath), { recursive: true })
  // tmp 必须与终态文件同目录（跨文件系统 rename 不原子）；名含 pid/时戳/序号防并发 spawn 互撞
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${tmpSeq++}`
  try {
    fsDeps.writeFileSync(tmpPath, `${JSON.stringify([...paths], null, MARKERS_JSON_INDENT)}\n`, { encoding: 'utf-8' })
    fsDeps.renameSync(tmpPath, finalPath)
  } catch (e) {
    try {
      fsDeps.rmSync(tmpPath, { force: true })
    // eslint-disable-next-line taste/no-silent-catch -- tmp 残片清理尽力而为；原始 io 错误才是要上抛的真因，下次覆盖写换新 tmp 名不会被残片影响
    } catch {
      // 残片清理失败不掩盖原始错误
    }
    throw e
  }
}

/** recordSpawnMarkers 的入参形状（结构化最小面，避免与 rpc-client 循环 import）。 */
export interface SpawnMarkerOptions {
  skillPaths?: string[]
  extensionPaths?: string[]
}

/**
 * rpc-client start() 的清单登记入口：挑出本次 spawn 的 staged 子集并全量覆盖写。
 * 任何失败只 console.error 不抛（写入失败不阻断 spawn——清单缺失时 reap 跳过收殓，
 * 宁漏不误杀）；零 staged 值也写（空数组文件，§11.11：清单文件仍须写入）。
 */
export function recordSpawnMarkers(
  options: SpawnMarkerOptions,
  dataDir: string = getConfigDir(),
  fsDeps: SpawnMarkerFsDeps = defaultFsDeps,
): void {
  try {
    const selected = selectSpawnMarkerPaths(
      [...(options.skillPaths ?? []), ...(options.extensionPaths ?? [])],
      dataDir,
    )
    writeSpawnMarkersFile(selected, dataDir, fsDeps)
  } catch (e) {
    // 降级策略（宁漏不崩，设计 §6.12）：清单写入失败不阻断 spawn——reap 侧对清单缺失
    // 本就跳过收殓（fail-safe = 宁漏不误杀）；console.error 经 logger tee 进 runtime 日志出声
    console.error('[rpc] write pi-spawn-markers.json failed (reap will skip this spawn, fail-safe):', e)
  }
}
