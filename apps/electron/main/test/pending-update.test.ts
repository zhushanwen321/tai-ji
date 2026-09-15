/**
 * 升级提醒持久化标志 SSOT（pending-update）单元测试。
 *
 * 覆盖 pending-update.ts 全部导出：
 *   1. writePendingUpdate + readPendingUpdate 往返（currentVersion < pending.version → 有效）
 *   2. 版本比较清除（currentVersion >= pending.version → unlink + 返回 null）
 *   3. readPendingUpdate 文件不存在 → 返回 null
 *   4. readPendingUpdate 文件损坏（JSON 解析失败）→ 返回 null + 文件被清除
 *
 * Mock 策略参考 orchestrator.test.ts：用真实 fs（临时目录），经
 * TAIJI_AGENT_DATA_DIR 重定向 getPendingUpdateFile() 落点（路径延迟求值，
 * env 先设确保所有求值命中 tmp）。env 设好后动态 import 模块拿独立实例。
 *
 * 运行：cd apps/electron/main && npx vitest run test/pending-update.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { LatestReleaseInfo } from '@taiji/shared'

// ── env 先于一切路径求值设置（历史形态要求 import 前设，延迟求值后非硬约束）──
// constants.ts 现经 getPendingUpdateFile() 延迟求值（getDataDir 读 TAIJI_AGENT_DATA_DIR）。
// 赋值仍放最前（无害），下方模块经动态 import 在 env 就绪后加载。
const TMP_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'pending-update-'))
process.env.TAIJI_AGENT_DATA_DIR = TMP_DATA_DIR

interface PendingUpdateModule {
  writePendingUpdate: (release: LatestReleaseInfo) => void
  readPendingUpdate: (currentVersion: string) => LatestReleaseInfo | null
  clearPendingUpdate: () => void
}

// 动态 import：确保 env 赋值先生效
async function loadModule(): Promise<PendingUpdateModule> {
  return await import('../update/pending-update.js')
}

/** pending-update.json 落盘路径（与 constants.ts 推导一致） */
const PENDING_UPDATE_FILE = path.join(TMP_DATA_DIR, 'update', 'pending-update.json')

/** LatestReleaseInfo fixture（参考 orchestrator.test.ts 的 MAC_RELEASE） */
function makeRelease(version = '0.9.0'): LatestReleaseInfo {
  return {
    version,
    tagName: `v${version}`,
    releaseNotes: '## What changed\n- pending-update fixture',
    publishedAt: '2025-12-01T00:00:00Z',
    htmlUrl: 'https://github.com/zhushanwen321/tai-ji/releases/tag/v0.9.0',
    assets: {
      macArm64Dmg: {
        name: 'TaiJi-0.10.0-mac-arm64.dmg',
        downloadUrl: 'https://example.com/mac.dmg',
        size: 1000,
        sha256: 'a'.repeat(64),
      },
    },
  }
}

describe('pending-update (升级提醒持久化标志 SSOT)', () => {
  let mod: PendingUpdateModule

  beforeEach(async () => {
    mod = await loadModule()
    // 每个用例独立：清掉残留的 pending-update.json
    const dir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  afterEach(() => {
    const dir = path.join(TMP_DATA_DIR, 'update')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── 1. writePendingUpdate + readPendingUpdate 往返 ──────────────
  it('writePendingUpdate 后 readPendingUpdate 返回该 release（currentVersion < pending.version）', () => {
    const release = makeRelease('0.9.0')
    mod.writePendingUpdate(release)

    // 文件确实写到了 PENDING_UPDATE_FILE
    expect(existsSync(PENDING_UPDATE_FILE)).toBe(true)

    // currentVersion 0.8.0 < pending.version 0.9.0 → 仍有效，返回原 release
    const result = mod.readPendingUpdate('0.8.0')
    expect(result).not.toBeNull()
    expect(result!.version).toBe('0.9.0')
    expect(result!.tagName).toBe('v0.9.0')
    expect(result!.htmlUrl).toBe(release.htmlUrl)
    // assets 字段也完整保留
    expect(result!.assets.macArm64Dmg?.name).toBe('TaiJi-0.10.0-mac-arm64.dmg')
    // 文件仍存在（读取有效不清除）
    expect(existsSync(PENDING_UPDATE_FILE)).toBe(true)
  })

  // ── 2. 版本比较清除 ────────────────────────────────────────────
  it('readPendingUpdate：currentVersion >= pending.version → 返回 null + 删除文件', () => {
    const release = makeRelease('0.9.0')
    mod.writePendingUpdate(release)
    expect(existsSync(PENDING_UPDATE_FILE)).toBe(true)

    // currentVersion 0.9.0 >= pending.version 0.9.0（相等）→ 清除 + null
    const resultEqual = mod.readPendingUpdate('0.9.0')
    expect(resultEqual).toBeNull()
    // 文件被 unlink
    expect(existsSync(PENDING_UPDATE_FILE)).toBe(false)

    // 重新写入，验证 currentVersion 更高版本也清除（0.9.1 > 0.9.0）
    mod.writePendingUpdate(release)
    expect(existsSync(PENDING_UPDATE_FILE)).toBe(true)
    const resultHigher = mod.readPendingUpdate('0.9.1')
    expect(resultHigher).toBeNull()
    expect(existsSync(PENDING_UPDATE_FILE)).toBe(false)
  })

  // ── 3. readPendingUpdate 文件不存在 → 返回 null ─────────────────
  it('readPendingUpdate：文件不存在时返回 null（不抛错）', () => {
    expect(existsSync(PENDING_UPDATE_FILE)).toBe(false)
    const result = mod.readPendingUpdate('0.8.0')
    expect(result).toBeNull()
  })

  // ── 4. readPendingUpdate 文件损坏 → 返回 null + 清除 ────────────
  it('readPendingUpdate：文件损坏（非法 JSON）→ 返回 null + 删除残留文件', () => {
    // 手动写坏 JSON（直接落盘非法内容）
    const dir = path.dirname(PENDING_UPDATE_FILE)
    mkdirSync(dir, { recursive: true })
    writeFileSync(PENDING_UPDATE_FILE, 'this is not valid json {{{', 'utf-8')
    expect(existsSync(PENDING_UPDATE_FILE)).toBe(true)

    const result = mod.readPendingUpdate('0.8.0')
    expect(result).toBeNull()
    // 损坏残留被清除（避免每次启动都尝试解析失败）
    expect(existsSync(PENDING_UPDATE_FILE)).toBe(false)
  })

  // ── 额外：clearPendingUpdate 显式清除 ──────────────────────────
  it('clearPendingUpdate：显式清除已存在的标志文件', () => {
    mod.writePendingUpdate(makeRelease('0.9.0'))
    expect(existsSync(PENDING_UPDATE_FILE)).toBe(true)
    mod.clearPendingUpdate()
    expect(existsSync(PENDING_UPDATE_FILE)).toBe(false)
    // 再次清除不抛错（幂等）
    expect(() => mod.clearPendingUpdate()).not.toThrow()
  })

  // ── 额外：落盘结构含 at 时间戳 ─────────────────────────────────
  it('writePendingUpdate：落盘 JSON 含 release 与 at 时间戳字段', () => {
    const before = new Date().getTime()
    mod.writePendingUpdate(makeRelease('0.9.0'))
    const after = new Date().getTime()

    const raw = readFileSync(PENDING_UPDATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as { release: { version: string }, at: string }
    expect(parsed.release.version).toBe('0.9.0')
    // at 是合法 ISO 时间戳，介于写入前后之间
    const atMs = new Date(parsed.at).getTime()
    expect(atMs).toBeGreaterThanOrEqual(before)
    expect(atMs).toBeLessThanOrEqual(after)
  })
})
