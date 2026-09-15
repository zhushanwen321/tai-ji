/**
 * 升级提醒持久化标志 SSOT（Single Source Of Truth）。
 *
 * 解决「升级提醒是一次性内存态，app 重启后丢失」的问题：检测到新版时把完整 release
 * 信息落盘，下次启动读取以立即恢复「可升级」提醒（含点更新按钮要用的 latestRelease），
 * 不必等 30s 联网检测、离线也能常驻。
 *
 * 清除策略（版本比较，最稳健）：读取时比较 currentVersion 与 pending.version，
 * currentVersion >= pending.version 说明已升级到该版本（或更高），unlinkSync 清除并返回 null。
 * 这覆盖所有「升级成功」场景——实际安装发生在 app.quit() 后的 detached 脚本里
 * （见 orchestrator.ts handleScriptRef），main 进程不在场，安装回调不可靠；
 * 版本比较是终极真相，不依赖任何安装流程的回调点。
 *
 * 写入时机：gateway/update-handlers.ts 的 update:check handler 检测到新版（info 非 null）时
 * 调 writePendingUpdate，best-effort（失败仅 warn，不阻断检测响应）。
 * 读取时机：useAppUpdate 启动时调 update:getPending handler → readPendingUpdate。
 *
 * 依赖方向：pending-update → constants + @taiji/shared + compare-versions + node:fs
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { compare } from 'compare-versions'
import type { LatestReleaseInfo } from '@taiji/shared'
import { getPendingUpdateFile } from './constants.js'

/**
 * pending-update.json 落盘结构。
 *
 * release 为检测到新版时 checkForLatestRelease 返回的完整 LatestReleaseInfo，
 * 启动恢复时直接填充 state.latestRelease（含 version/releaseNotes/htmlUrl/assets）。
 * at 为写入时间戳，便于诊断（当前不参与逻辑）。
 */
interface PendingUpdateData {
  release: LatestReleaseInfo
  at: string
}

/**
 * 类型守卫：逐字段校验反序列化结果是否为合法的 PendingUpdateData。
 *
 * JSON.parse 结果类型为 any，直接 `as PendingUpdateData` 断言后 TS 不再保护，
 * `data.release` 缺失时运行时拿到 undefined，下游当 LatestReleaseInfo 用会崩。
 * 这里用 unknown + typeof 逐字段校验 release 的必要标量字段（version/tagName 等
 * 是启动恢复时直接读取/渲染的字段），与 preloaded-update / update-settings 的
 * SSOT 反序列化范式一致（见 review S#6 / I#4）。
 *
 * 校验范围：release 顶层标量字段 + assets 为对象。ReleaseAsset 细节字段
 * （name/downloadUrl/size/sha256）由下游 pickPlatformAsset 等按平台可选读取，
 * 缺失平台返回 undefined 已是其契约，故不在此强校验。
 */
function isPendingUpdateData(x: unknown): x is PendingUpdateData {
  if (!x || typeof x !== 'object') return false
  const obj = x as Record<string, unknown>
  const release = obj.release
  if (!release || typeof release !== 'object') return false
  const rel = release as Record<string, unknown>
  return (
    typeof obj.at === 'string' &&
    typeof rel.version === 'string' &&
    typeof rel.tagName === 'string' &&
    typeof rel.releaseNotes === 'string' &&
    typeof rel.publishedAt === 'string' &&
    typeof rel.htmlUrl === 'string' &&
    typeof rel.assets === 'object'
  )
}

/**
 * 写入升级提醒持久化标志。
 *
 * 检测到新版时调用：把完整 release 信息 + 时间戳落盘。
 * best-effort：写入失败仅 console.warn，不抛错（持久化是优化项，不应阻断检测响应）。
 */
export function writePendingUpdate(release: LatestReleaseInfo): void {
  try {
    mkdirSync(path.dirname(getPendingUpdateFile()), { recursive: true })
    const data: PendingUpdateData = { release, at: new Date().toISOString() }
    // eslint-disable-next-line no-magic-numbers -- 2 = JSON 缩进空格数（人类可读）
    writeFileSync(getPendingUpdateFile(), JSON.stringify(data, null, 2))
  } catch (err) {
    // best-effort：写标志失败不应阻断检测响应，下次检测会再次尝试写入
    console.warn('[pending-update] write failed:', err)
  }
}

/**
 * 读取升级提醒持久化标志。
 *
 * 启动恢复时调用。返回 null 的三种情况：
 *   1. 文件不存在（从未检测到新版 / 已清除）→ null
 *   2. 文件损坏（JSON 解析失败）→ 清除残留 + null
 *   3. 版本比较 currentVersion >= pending.version（已升级到该版本或更高）→ 清除 + null
 *
 * 版本比较是「升级成功」的终极真相：实际安装在 app 退出后的 detached 脚本里完成，
 * main 进程不在场无法可靠回调；只要 app 版本已 >= 待升级版本，标志即失效。
 *
 * @param currentVersion app.getVersion() 返回的当前版本
 * @returns 仍有效的 pending release（有新版待升级），否则 null
 */
export function readPendingUpdate(currentVersion: string): LatestReleaseInfo | null {
  if (!existsSync(getPendingUpdateFile())) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(getPendingUpdateFile(), 'utf-8')) as unknown
  } catch (err) {
    // 文件损坏：清除残留避免每次启动都尝试解析失败
    console.warn('[pending-update] parse failed, clearing:', err)
    clearPendingUpdate()
    return null
  }

  // 类型守卫逐字段校验：缺 release 或必要字段 → 视为损坏，清除后返回 null（见 S#6）
  if (!isPendingUpdateData(parsed)) {
    console.warn('[pending-update] invalid schema, clearing')
    clearPendingUpdate()
    return null
  }
  const data: PendingUpdateData = parsed

  // 版本比较清除策略：currentVersion >= pending.version 说明已升级，清除标志。
  // compare 返回 >= 0 表示 currentVersion 不小于 pending.version（相等或更高）。
  try {
    if (compare(currentVersion, data.release.version, '>=')) {
      console.log(
        `[pending-update] current ${currentVersion} >= pending ${data.release.version}, clearing`,
      )
      clearPendingUpdate()
      return null
    }
  } catch (err) {
    // 版本号格式异常（非语义化版本）：保守保留标志，让用户自行决定是否升级
    console.warn('[pending-update] version compare failed, keeping flag:', err)
  }

  return data.release
}

/**
 * 显式清除升级提醒持久化标志。
 *
 * 供 self-healer 等场景显式调用（当前 readPendingUpdate 的版本比较已覆盖主要清除路径）。
 * best-effort：清除失败仅 warn。
 */
export function clearPendingUpdate(): void {
  try {
    if (existsSync(getPendingUpdateFile())) {
      unlinkSync(getPendingUpdateFile())
    }
  } catch (err) {
    // best-effort：清除失败只留残留文件，下次 read 会 parse 失败再清
    console.warn('[pending-update] clear failed:', err)
  }
}
