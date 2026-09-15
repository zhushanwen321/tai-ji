/**
 * 预下载产物元信息 SSOT（Single Source Of Truth）。
 *
 * 后台预下载成功后记录已下载文件信息（version/assetName/filePath/downloadedAt + 完整性），
 * 用户点击更新时 update:install handler 以它为安装权威源：读出 release + filePath
 * 直接 installUpdate（版本守卫 + 完整性校验在读取路径完成，见 readPreloadedUpdateRaw）。
 *
 * 清除时机：
 *   - 版本不匹配（pending.version 与本次要安装的 release.version 不一致）→ 清除
 *   - asset name 不匹配（同版本但平台 asset 变更）→ 清除
 *   - 产物文件已不存在 → 清除
 *   - 完整性校验失败（size/sha256 不匹配）→ 清除
 *
 * 依赖方向：preloaded-update → constants + pick-platform-asset + hash + @taiji/shared + node:fs/path
 *   （hash 为无网络依赖的纯函数叶子模块，见 hash.ts / review S#13）
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { compare } from 'compare-versions'
import type { LatestReleaseInfo } from '@taiji/shared'
import { getPreloadedUpdateFile } from './constants.js'
import { pickPlatformAsset, pickPlatformAssetName } from './pick-platform-asset.js'
import { hashFileSha256 } from './hash.js'

/**
 * preloaded-update.json 落盘结构。
 */
interface PreloadedUpdateData {
  /** 预下载的目标版本（与 release.version 比较以判断产物是否仍有效） */
  version: string
  /** 下载产物文件名（与 release asset name 比较以判断 asset 是否变更） */
  assetName: string
  /** 下载产物绝对路径（installUpdate 直接用） */
  filePath: string
  /** 预下载完成时间戳（诊断用） */
  downloadedAt: string
  /** 产物文件大小（完整性校验） */
  size: number
  /** 产物 sha256 hex（完整性校验，可选兜底） */
  sha256?: string
  /** 完整 release 信息（installUpdate 权威源：update:install 不接收前端 release，
   *  从 preloaded 读取以堵装错版本漏洞） */
  release: LatestReleaseInfo
}

/**
 * 类型守卫：逐字段校验反序列化结果是否为合法的 PreloadedUpdateData。
 *
 * JSON.parse 结果类型为 any，直接 `as PreloadedUpdateData` 断言后 TS 不再保护，
 * 缺字段运行时拿到 undefined。这里用 unknown + typeof 逐字段校验，
 * 与 update-settings.ts 的 SSOT 反序列化范式一致（见 review S#5 / I#4）。
 *
 * size 必填（writePreloadedUpdate 写 asset.size ?? 0，恒为 number）；
 * sha256 可选（asset.sha256 可能缺失，readPreloadedUpdate 无 sha256 时跳过该项校验）。
 */
function isPreloadedUpdateData(x: unknown): x is PreloadedUpdateData {
  if (!x || typeof x !== 'object') return false
  const obj = x as Record<string, unknown>
  return (
    typeof obj.version === 'string' &&
    typeof obj.assetName === 'string' &&
    typeof obj.filePath === 'string' &&
    typeof obj.downloadedAt === 'string' &&
    typeof obj.size === 'number' &&
    (typeof obj.sha256 === 'string' || obj.sha256 === undefined) &&
    typeof obj.release === 'object' &&
    obj.release !== null
  )
}

/**
 * 写入预下载产物元信息。预下载成功后调用。
 * best-effort：写入失败仅 warn（快路径降级为完整下载，不影响升级）。
 */
export function writePreloadedUpdate(release: LatestReleaseInfo, filePath: string): void {
  // 取平台对应 asset 的 name/size/sha256（与 orchestrator pickPlatformAsset 同源）
  const asset = pickPlatformAsset(release)
  if (!asset?.name) {
    console.warn('[preloaded-update] cannot determine assetName, skip writing')
    return
  }
  try {
    mkdirSync(path.dirname(getPreloadedUpdateFile()), { recursive: true })
    const data: PreloadedUpdateData = {
      version: release.version,
      assetName: asset.name,
      filePath,
      downloadedAt: new Date().toISOString(),
      size: asset.size ?? 0,
      sha256: asset.sha256,
      release,
    }
    // eslint-disable-next-line no-magic-numbers -- 2 = JSON 缩进空格数（人类可读）
    writeFileSync(getPreloadedUpdateFile(), JSON.stringify(data, null, 2))
  } catch (err) {
    // best-effort：写元信息失败不影响已下载的文件，快路径降级为完整下载
    console.warn('[preloaded-update] write failed:', err)
  }
}

/**
 * 读取预下载产物元信息，校验有效性（version + assetName + 文件存在 + 完整性）。
 *
 * @param release 当前要安装的 release（用其 version + asset name 校验产物是否仍匹配）
 * @returns 有效的产物文件路径；无效或不存在返回 null
 */
export async function readPreloadedUpdate(release: LatestReleaseInfo): Promise<string | null> {
  if (!existsSync(getPreloadedUpdateFile())) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(getPreloadedUpdateFile(), 'utf-8')) as unknown
  } catch (err) {
    console.warn('[preloaded-update] parse failed, clearing:', err)
    clearPreloadedUpdate()
    return null
  }

  // 类型守卫逐字段校验：缺字段/类型错误 → 视为损坏，清除后返回 null（见 S#5）
  if (!isPreloadedUpdateData(parsed)) {
    console.warn('[preloaded-update] invalid schema, clearing')
    clearPreloadedUpdate()
    return null
  }
  const data: PreloadedUpdateData = parsed

  // 版本不匹配（release 已更新或降级）→ 产物失效，清除
  if (data.version !== release.version) {
    console.log(`[preloaded-update] version mismatch (${data.version} vs ${release.version}), clearing`)
    clearPreloadedUpdate()
    return null
  }

  // asset name 不匹配（同版本但平台 asset 变更，极少见）→ 清除
  const expectedAssetName = pickPlatformAssetName(release)
  if (expectedAssetName && data.assetName !== expectedAssetName) {
    console.log(`[preloaded-update] assetName mismatch, clearing`)
    clearPreloadedUpdate()
    return null
  }

  // 产物文件已被外部清理（用户手动删 / 磁盘清理）→ 清除元信息
  if (!existsSync(data.filePath)) {
    console.log(`[preloaded-update] file ${data.filePath} no longer exists, clearing`)
    clearPreloadedUpdate()
    return null
  }

  // 完整性校验：先比对 size（便宜），再比对 sha256（若元信息里有）
  const actualSize = statSync(data.filePath).size
  if (data.size > 0 && actualSize !== data.size) {
    console.log(`[preloaded-update] size mismatch (expected ${data.size}, got ${actualSize}), clearing`)
    clearPreloadedUpdate()
    return null
  }
  if (data.sha256) {
    const actualSha = await hashFileSha256(data.filePath)
    if (actualSha !== data.sha256.toLowerCase()) {
      console.log(`[preloaded-update] sha256 mismatch, clearing`)
      clearPreloadedUpdate()
      return null
    }
  }

  return data.filePath
}

/**
 * 读取预下载产物元信息（原始，不做版本匹配），返回 { release, filePath } 或 null。
 *
 * 与 {@link readPreloadedUpdate} 区别：本函数不需调用方传 release 做版本匹配，
 * 而是信任元信息里的 release 字段（writePreloadedUpdate 时写入的完整 release）。
 * 供 update:install handler 使用——install 不接收前端传入的 release（堵装错版本漏洞），
 * 而是以 preloaded 记录的 release 为权威源。也供 update:getPreloaded 透传给前端。
 *
 * 仍做完整性校验（文件存在 + size + sha256），但不做 version/assetName 匹配
 * （版本由读取到的 release 字段本身决定）。
 *
 * 版本比较（与 readPendingUpdate 对称）：currentVersion >= preloaded.version 说明 app
 * 已升级到该版本（或更高），产物失效 → unlink + 返回 null。对齐 readPendingUpdate 的
 * 「版本比较是升级成功的终极真相」策略，防止启动恢复路径误恢复「已下载」态。
 *
 * @param currentVersion app.getVersion() 返回的当前版本
 * @returns 有效的 { release, filePath }；文件不存在/损坏/旧格式/版本已过期返回 null
 */
export async function readPreloadedUpdateRaw(
  currentVersion: string,
): Promise<{ release: LatestReleaseInfo; filePath: string } | null> {
  if (!existsSync(getPreloadedUpdateFile())) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(getPreloadedUpdateFile(), 'utf-8')) as unknown
  } catch (err) {
    console.warn('[preloaded-update] parse failed, clearing:', err)
    clearPreloadedUpdate()
    return null
  }

  // 类型守卫含 release 字段校验：旧格式（无 release）isPreloadedUpdateData 返回 false → 清除
  if (!isPreloadedUpdateData(parsed)) {
    console.warn('[preloaded-update] invalid schema, clearing')
    clearPreloadedUpdate()
    return null
  }
  const data: PreloadedUpdateData = parsed

  // 产物文件已被外部清理（用户手动删 / 磁盘清理）→ 清除元信息
  if (!existsSync(data.filePath)) {
    console.log(`[preloaded-update] file ${data.filePath} no longer exists, clearing`)
    clearPreloadedUpdate()
    return null
  }

  // 完整性校验：先比对 size（便宜），再比对 sha256（若元信息里有）
  const actualSize = statSync(data.filePath).size
  if (data.size > 0 && actualSize !== data.size) {
    console.log(`[preloaded-update] size mismatch (expected ${data.size}, got ${actualSize}), clearing`)
    clearPreloadedUpdate()
    return null
  }
  if (data.sha256) {
    const actualSha = await hashFileSha256(data.filePath)
    if (actualSha !== data.sha256.toLowerCase()) {
      console.log(`[preloaded-update] sha256 mismatch, clearing`)
      clearPreloadedUpdate()
      return null
    }
  }

  // 版本比较清除策略：currentVersion >= preloaded.version 说明已升级，产物失效。
  // 与 readPendingUpdate 对称（见该函数注释），版本比较是升级成功的终极真相。
  // 非 semver 版本号 catch 后保守保留（不误删），与 readPendingUpdate 一致。
  try {
    if (compare(currentVersion, data.release.version, '>=')) {
      console.log(
        `[preloaded-update] current ${currentVersion} >= preloaded ${data.release.version}, clearing`,
      )
      clearPreloadedUpdate()
      return null
    }
  } catch (err) {
    // best-effort：版本号非 semver 无法比较 → 保守保留产物（不误删），让用户自行决定是否升级
    console.warn('[preloaded-update] version compare failed, keeping:', err)
  }

  return { release: data.release, filePath: data.filePath }
}

/**
 * 清除预下载产物元信息。best-effort：失败仅 warn。
 */
export function clearPreloadedUpdate(): void {
  try {
    if (existsSync(getPreloadedUpdateFile())) {
      unlinkSync(getPreloadedUpdateFile())
    }
  } catch (err) {
    // best-effort：清除失败只留残留元信息，下次 read 校验失败会再清
    console.warn('[preloaded-update] clear failed:', err)
  }
}
