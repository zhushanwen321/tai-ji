/**
 * 手动产物认领（G1 零网络逃生通道，设计 update-network-resilience D1/D2/D3）。
 *
 * 用户用浏览器/其他机器下载的安装包放入手动投放目录 getManualAssetDir()
 * （`<update>/manual/`），升级入口在 download 短路② / getPreloaded miss 后调本
 * 模块认领：与基准 release 的当前平台 asset 做 name + size + sha256 三重校验，
 * 通过后 move 到升级工作目录（getUpdateDir()）并
 * writePreloadedUpdate 落登记——认领后与 app 自下载产物不可区分，install 链既有
 * 防线全量复用。全程零网络依赖、零进程 spawn（认领场景恰恰是网络不可用）。
 *
 * 版本基准（D3）：由调用方传入 pending release（含完整 assets + sha256），
 * 本模块不做版本比较（download 入口短路②已保证 pending.version === payload.version）。
 *
 * 落盘噪音控制（D2）：目录不存在/无同名候选（常态）不落盘；存在同名候选但
 * size/sha256 校验失败才落 `source: 'manual-claim'` 具因。
 *
 * 并发幂等（D2）：Electron 同 channel handler 可并发，认领内 renameSync 抛 ENOENT
 * （源文件已被并发认领移走）视为「已被认领」按成功处理，不落 mismatch。
 *
 * 依赖方向：manual-claim → constants + pick-platform-asset + hash + error-log +
 *   preloaded-update + node:fs/path
 */
import { existsSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import type { LatestReleaseInfo } from '@taiji/shared'
import { getUpdateDir } from './constants.js'
import { appendUpdateError } from './error-log.js'
import { hashFileSha256 } from './hash.js'
import { pickPlatformAsset } from './pick-platform-asset.js'
import { writePreloadedUpdate } from './preloaded-update.js'

/**
 * 手动下载产物的固定投放目录（D9 UI 引导展示同一约定）。
 * 延迟求值：调用时经 getUpdateDir 解析（见 constants.ts，防 import 期烤死真实目录）。
 */
export function getManualAssetDir(): string {
  return path.join(getUpdateDir(), 'manual')
}

/** 认领失败落盘（size/sha256 具因，D8）。best-effort，不抛出。 */
function logClaimFailure(rawCause: string): void {
  appendUpdateError({
    at: new Date().toISOString(),
    source: 'manual-claim',
    stage: 'downloading',
    rawCause,
  })
}

/**
 * 尝试认领手动投放的安装包产物。
 *
 * @param release 认领基准 release（pending-update.json 读出的完整 release）
 * @returns 认领成功（含并发幂等）返回产物最终绝对路径（已 move 至升级工作目录 getUpdateDir()）；
 *   无平台 asset / 无同名候选 / 校验失败返回 null
 */
export async function tryClaimManualAsset(release: LatestReleaseInfo): Promise<string | null> {
  // 基准 = 当前平台 asset（跨平台包不参与匹配，D2）；无基准无从校验，静默不认领
  const asset = pickPlatformAsset(release)
  if (!asset?.name) return null

  const candidatePath = path.join(getManualAssetDir(), asset.name)
  // 无同名候选（含目录不存在）→ 常态噪音，不落盘
  if (!existsSync(candidatePath)) return null

  // 三重校验 ①/②：size（便宜的先校验）。size 缺失按 0 处理，任何实际文件必不匹配
  // → 按 size mismatch 拒绝（宁拒不猜，与 writePreloadedUpdate 的 ?? 0 口径一致）
  const expectedSize = asset.size ?? 0
  const actualSize = statSync(candidatePath).size
  if (actualSize !== expectedSize) {
    logClaimFailure(`size mismatch (expected ${expectedSize}, got ${actualSize})`)
    return null
  }

  // 三重校验 ③：sha256。基准缺失时无法证明内容与官方产物一致 → 拒绝认领（宁拒不猜）
  const expectedSha = asset.sha256
  if (!expectedSha) {
    logClaimFailure('sha256 missing')
    return null
  }
  const actualSha = await hashFileSha256(candidatePath)
  if (actualSha !== expectedSha.toLowerCase()) {
    logClaimFailure(`sha256 mismatch (expected ${expectedSha}, got ${actualSha})`)
    return null
  }

  // 三重通过 → move 到升级工作目录 getUpdateDir()（与 app 自下载产物同位）
  const finalPath = path.join(getUpdateDir(), asset.name)
  try {
    renameSync(candidatePath, finalPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // 并发认领已把源文件移走：幂等视为已认领成功（并发胜者负责写登记），不落 mismatch
      return finalPath
    }
    throw err
  }

  // 落 preloaded 登记。writePreloadedUpdate 自身 best-effort（内部仅 warn）：
  // move 已成功的前提下不因登记失败否定认领——快路径 miss 时下次重下，可接受的降级
  writePreloadedUpdate(release, finalPath)
  return finalPath
}
