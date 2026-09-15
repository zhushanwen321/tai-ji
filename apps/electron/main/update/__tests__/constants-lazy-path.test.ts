/**
 * constants 延迟求值回归守护（module-eager-binding 修复）。
 *
 * 背景 bug：UPDATE_DIR 等原为模块级常量（import 期经 getDataDir 求值），
 * 而 main.ts 的 dev 钉死 env（TAIJI_AGENT_DATA_DIR 无条件 = ~/.taiji-dev）在模块
 * import 链之后才执行——无 env 启动的 dev 实例（keeper 自动重启）会把全部升级
 * 路径烤死到真实目录 ~/.taiji/update，升级产物误写生产数据。
 *
 * 三个守护点：
 *   1. 行为守护：import 之后才设置/变更 env，路径函数必须跟随运行时 env
 *      （既证明无 import 期求值，也证明无首调期缓存）
 *   2. 结构守护：全部派生路径位于 getUpdateDir() 之下（SSOT 派生结构不漂移）
 *   3. 源码守护：constants.ts 不得再出现模块级路径常量（直接防回潮）
 *
 * 运行：cd apps/electron/main && npx vitest run update/__tests__/constants-lazy-path.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 顶层静态 import 刻意为之：若有人改回模块级常量，此刻求值即烤死 import 期环境，
// 用例 1 的「后设 env 仍跟随」断言转红——这正是 bug 的复现形态。
import {
  getUpdateDir,
  getUpdateResultFile,
  getPendingUpdateFile,
  getPreloadedUpdateFile,
  getUpdateSettingsFile,
  getUpdaterScriptPath,
  getLinuxUpdaterScriptPath,
  getUpdaterLogPath,
  getLinuxUpdaterLogPath,
  getWinUpdaterScriptPath,
  getWinUpdaterLogPath,
  getUpdateErrorLog,
  getUpdaterPidFile,
} from '../constants.js'
import { getManualAssetDir } from '../manual-claim.js'

const CONSTANTS_SRC = path.resolve(__dirname, '..', 'constants.ts')

describe('constants 延迟求值（module-eager-binding 回归守护）', () => {
  const originalEnv = process.env.TAIJI_AGENT_DATA_DIR
  const tempDirs: string[] = []

  function newTempDataDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'lazy-path-'))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
    else process.env.TAIJI_AGENT_DATA_DIR = originalEnv
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('import 后才设置/变更 env：路径跟随运行时 env（无 import 期求值、无首调缓存）', () => {
    // 模拟 main.ts 时序：import 链先执行（本文件顶层静态 import），dev 兜底 env 后到位
    const dirA = newTempDataDir()
    const dirB = newTempDataDir()

    process.env.TAIJI_AGENT_DATA_DIR = dirA
    expect(getUpdateDir()).toBe(path.join(dirA, 'update'))
    expect(getUpdateErrorLog()).toBe(path.join(dirA, 'update', 'update-error.log'))
    expect(getManualAssetDir()).toBe(path.join(dirA, 'update', 'manual'))

    // env 再变更（换数据目录）也跟随——证明不是首次调用时缓存
    process.env.TAIJI_AGENT_DATA_DIR = dirB
    expect(getUpdateDir()).toBe(path.join(dirB, 'update'))
    expect(getUpdateResultFile()).toBe(path.join(dirB, 'update', 'update-result.json'))
  })

  it('全部派生路径位于 getUpdateDir() 之下（SSOT 派生结构）', () => {
    process.env.TAIJI_AGENT_DATA_DIR = newTempDataDir()
    const prefix = getUpdateDir() + path.sep
    const derived = [
      getUpdateResultFile(),
      getPendingUpdateFile(),
      getPreloadedUpdateFile(),
      getUpdateSettingsFile(),
      getUpdaterScriptPath(),
      getLinuxUpdaterScriptPath(),
      getUpdaterLogPath(),
      getLinuxUpdaterLogPath(),
      getWinUpdaterScriptPath(),
      getWinUpdaterLogPath(),
      getUpdateErrorLog(),
      getUpdaterPidFile(),
      getManualAssetDir(),
    ]
    expect(derived).toHaveLength(13)
    for (const p of derived) {
      expect(p.startsWith(prefix)).toBe(true)
    }
  })

  it('源码守护：constants.ts 不得出现模块级路径常量（防回潮）', () => {
    const src = readFileSync(CONSTANTS_SRC, 'utf-8')
    expect(src).not.toMatch(
      /export const (UPDATE_DIR|UPDATE_RESULT_FILE|PENDING_UPDATE_FILE|PRELOADED_UPDATE_FILE|UPDATE_SETTINGS_FILE|UPDATER_SCRIPT_PATH|LINUX_UPDATER_SCRIPT_PATH|UPDATER_LOG_PATH|LINUX_UPDATER_LOG_PATH|WIN_UPDATER_SCRIPT_PATH|WIN_UPDATER_LOG_PATH|UPDATE_ERROR_LOG|UPDATER_PID_FILE)\b/,
    )
    // 派生结构必须经 getUpdateDir（而非各自独立 join(getDataDir(), 'update') 双写）：
    // 12 = 13 个路径函数中除 getUpdateDir 自身（经 getDataDir）外的全部派生函数
    expect(src.match(/path\.join\(getUpdateDir\(\),/g)).toHaveLength(12)
  })
})
