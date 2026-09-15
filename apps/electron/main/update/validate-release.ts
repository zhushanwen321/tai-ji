/**
 * Release payload 安全校验（防 SSRF / 路径遍历 / shell 注入）。
 *
 * 对应 BLOCKER 3：不可信来源的 release 对象可能携带
 * downloadUrl: 'file:///etc/passwd' 或 name: '../../evil' 之类的恶意值。
 * 本模块在安装前做严格白名单校验，拒绝任何非法输入。
 * 现行调用点：update:install handler 对 preloaded-update.json 读出的 release
 * 做防御纵深校验（m11）——preloaded 是磁盘写入面，可能被绕过 download 路径篡改。
 *
 * [HISTORICAL] 设计要点：
 * - downloadUrl 白名单：只允许两源 release 下载域（GitHub：github.com +
 *   objects.githubusercontent.com；AtomGit：gitcode.com——多源改造 D6）的 https URL
 *   （防 SSRF + file:// + 内网探测）。域集合消费 release-sources 的
 *   ALLOWED_DOWNLOAD_HOSTS 单一来源（D1 防漂移：白名单与适配器产物落域同源，
 *   本模块不再各自维护副本）
 * - asset.name 白名单字符集 [\w.\-]：防路径遍历（../）+ shell 元字符注入
 *   （name 会被拼进 spawn 脚本路径，含 `;`/`$`/空格 会触发命令注入）
 * - version 严格数字格式：version 也会出现在脚本上下文，必须无特殊字符
 * - sha256 若存在必须是 64 位 hex：防注入到 bash 脚本
 * - 缺失的 asset（undefined）跳过，不强制每平台都存在（按平台分流，单平台 release 合法）
 *
 * 依赖方向：validate-release → @taiji/shared + ./types + ./release-sources（域常量）
 */
import { URL } from 'node:url'
import type { LatestReleaseInfo, ReleaseAsset } from '@taiji/shared'
import { UpdateError } from './types.js'
import { ALLOWED_DOWNLOAD_HOSTS } from './release-sources.js'

/** asset name 只允许字母/数字/下划线/点/横线（防路径遍历 + shell 注入） */
const ASSET_NAME_RE = /^[\w.\-]+$/

/** 严格版本号：3 或 4 段纯数字（防 shell 注入） */
const VERSION_RE = /^\d+\.\d+\.\d+(?:\.\d+)?$/

/** sha256 hex（64 位，大小写不敏感） */
const SHA256_RE = /^[0-9a-f]{64}$/i

/**
 * 校验 renderer 传来的 LatestReleaseInfo payload。
 *
 * 防 SSRF（downloadUrl 必须是白名单域（两源下载域，见 ALLOWED_DOWNLOAD_HOSTS）的 https）、
 * 路径遍历（name 无 / 或 ..）、shell 注入（name / version / sha256 严格白名单字符集）。
 *
 * @param release renderer 经 IPC 传来的 release payload
 * @throws UpdateError('downloading') 校验失败
 */
export function validateRelease(release: LatestReleaseInfo): void {
  if (!VERSION_RE.test(release.version)) {
    throw new UpdateError(`invalid version: ${release.version}`, 'downloading')
  }
  const assets = release.assets
  for (const key of ['macArm64Dmg', 'winX64Exe', 'linuxX64AppImage'] as const) {
    const asset = assets[key]
    if (!asset) continue
    validateAsset(asset)
  }
}

/**
 * 校验单个 ReleaseAsset（name / downloadUrl / sha256）。
 *
 * @throws UpdateError('downloading') 校验失败
 */
function validateAsset(asset: ReleaseAsset): void {
  if (!ASSET_NAME_RE.test(asset.name)) {
    throw new UpdateError(`invalid asset name: ${asset.name}`, 'downloading')
  }
  let url: URL
  try {
    url = new URL(asset.downloadUrl)
  } catch {
    throw new UpdateError(`invalid download url: ${asset.downloadUrl}`, 'downloading')
  }
  if (url.protocol !== 'https:') {
    throw new UpdateError(`download url must be https: ${asset.downloadUrl}`, 'downloading')
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new UpdateError(`download url host not allowed: ${url.hostname}`, 'downloading')
  }
  // sha256 若存在必须是 64 位 hex（防注入到 bash 脚本）
  if (asset.sha256 && !SHA256_RE.test(asset.sha256)) {
    throw new UpdateError('invalid sha256 format', 'downloading')
  }
}
