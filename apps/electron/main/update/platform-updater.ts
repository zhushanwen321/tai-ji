/**
 * 三平台升级替换器。
 *
 * 对应 slice auto-update-and-install w3：根据 process.platform 选择对应 Updater，
 * 生成替换脚本/参数，触发替换动作（mac/linux spawn detached bash，win 返回 NSIS 参数）。
 *
 * [HISTORICAL] 不变量：
 * - mac：detached bash 脚本（staging 状态机，含 sha256 二次校验），prepareUpdate 内已 spawn
 * - linux：AppImage 走 detached 脚本（与 mac 一致，避免双实例）；deb 包（APPIMAGE undefined）走 unsupported
 * - win：cmd wrapper（设计 §3.4 批次 2）——prepareUpdate 内写盘 updater.cmd +
 *   detached spawn，返回 detached-script（三平台统一语义）；sha256 缺失 throw
 *   （RM4/m5）。orchestrator 的 win spawn-installer 延迟分支由批次 2 u2b 删除
 * - dev 模式（!app.isPackaged）一律拒绝自更新（避免覆盖 dev 环境）
 * - .app bundle 路径推导：process.execPath（.../TaiJi.app/Contents/MacOS/TaiJi）
 *   向上 3 层 dirname 得到 .app 目录
 *
 * 依赖方向：platform-updater → electron(app) + node:child_process/fs + updater-script
 *           + constants + types + @taiji/shared
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { LatestReleaseInfo } from '@taiji/shared'
import { buildOutboundChildEnv } from '@taiji/shared'
import {
  getLinuxUpdaterLogPath,
  getLinuxUpdaterScriptPath,
  getUpdateDir,
  getUpdateResultFile,
  getUpdaterLogPath,
  getUpdaterPidFile,
  getUpdaterScriptPath,
  getWinUpdaterLogPath,
  getWinUpdaterScriptPath,
} from './constants.js'
import { buildLinuxUpdaterScript, buildUpdaterScript } from './updater-script.js'
import { buildWinUpdaterCmd } from './win-updater-cmd.js'
import { UpdateError, UpdateUnsupportedError } from './types.js'
import type { UpdateScriptRef } from './types.js'

/** updater 脚本文件权限（rwxr-xr-x）：写盘 + chmod 共用，确保 detached bash 可执行。 */
const UPDATER_SCRIPT_MODE = 0o755

/**
 * 写 updater.pid（批次 5 互斥 §3.7.1，接线收口 #13）。
 *
 * 写入语义对齐 mac/linux：脚本启动即写、退出即删。差异在写入方——
 * mac/linux 由脚本模板自写 `$$`（`trap 'rm -f "$PID_FILE"' EXIT` 负责退出清理），
 * win 的 cmd wrapper 无内建变量可廉价自取 PID（PowerShell `$PID` 是其自身进程而非
 * wrapper），故由 main 侧在 spawn 后写 `child.pid`。
 *
 * **win 退出清理未覆盖**：cmd wrapper 不含删 pid 文件的逻辑（模板不在本单元领地），
 * 残留在退出后由读侧 `update-self-healer` 的死 PID 自愈清理兜底（kill(pid,0) 失败
 * 即 unlink）——cmd 进程退出后 pid 即死，自愈必然触发，不会永久残留。
 *
 * best-effort：写失败只告警不阻断。pid 文件是互斥辅助信号，写失败退回 u5a 之前的
 * 现状（无互斥探测），远优于因为一个辅助文件而让整次升级失败。
 */
function writeUpdaterPid(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    writeFileSync(getUpdaterPidFile(), String(pid))
  } catch (err) {
    // 降级策略：pid 文件是互斥辅助信号，写失败退回 u5a 之前的现状（无互斥探测），
    // 远优于因为一个辅助文件而让整次升级失败——故只告警不重抛。
    console.warn('[update] failed to write updater.pid (mutex degrades to no-op):', err)
  }
}

/** 平台升级器接口 */
export interface PlatformUpdater {
  /**
   * 准备替换动作。
   *
   * @param downloadedFilePath download-asset 返回的已下载文件路径（通过 sha256 校验）
   * @param release 当前 release 信息（取 sha256 / version / htmlUrl）
   * @returns 替换动作描述（三平台统一 detached-script：脚本/写盘 spawn 均在
   *          prepareUpdate 内完成；orchestrator 只透传触发重启）
   */
  prepareUpdate(downloadedFilePath: string, release: LatestReleaseInfo): UpdateScriptRef
}

/**
 * mac 升级器。
 *
 * 流程：生成 detached bash 脚本 → 写盘 + chmod 755 → spawn detached（unref，不阻塞 app.quit）。
 */
export class MacUpdater implements PlatformUpdater {
  prepareUpdate(downloadedFilePath: string, release: LatestReleaseInfo): UpdateScriptRef {
    if (!app.isPackaged) throw new UpdateError('dev mode does not support self-update', 'replacing')
    // 推导 .app bundle 路径：execPath = .../TaiJi.app/Contents/MacOS/TaiJi
    // dirname×3 = .../TaiJi.app
    const appBundle = path.dirname(path.dirname(path.dirname(process.execPath)))
    // 布局守卫：dirname×3 假设标准 .app/Contents/MacOS/<binary> 布局。若 execPath 不符
    // （如开发期改了 cwd、或将来改成非 .app 打包），appBundle 不以 .app 结尾，后续
    // ditto/unlink 会破坏意外路径。提前 fail-fast 比静默写错更安全。
    if (!appBundle.endsWith('.app')) {
      throw new UpdateError(`unexpected app bundle path (not .app): ${appBundle}`, 'replacing')
    }
    // toLowerCase：GitHub digest 可能返回大写 hex，而 updater.sh 的 `shasum -a 256`
    // 输出小写。注入前统一小写，避免 [ "$ACTUAL" != "$SHA256" ] 字符串比较大写 vs 小写
    // 误判为不匹配（导致正确下载被错误回滚）。download-asset.ts 的下载期校验已小写化。
    const sha256 = release.assets.macArm64Dmg?.sha256?.toLowerCase()
    if (!sha256) throw new UpdateError('mac asset missing sha256', 'downloading')
    const script = buildUpdaterScript({
      appBundle,
      dmgPath: downloadedFilePath,
      sha256,
      logPath: getUpdaterLogPath(),
      resultPath: getUpdateResultFile(),
      appName: 'TaiJi',
      targetVersion: release.version,
      // u1a 模板契约：脚本用 kill -0 等待本进程退出（PID 制，上限 60s）；
      // 缺失时 buildUpdaterScript 直接 throw，不静默跳过等待。
      parentPid: String(process.pid),
    })
    mkdirSync(getUpdateDir(), { recursive: true })
    writeFileSync(getUpdaterScriptPath(), script, { mode: UPDATER_SCRIPT_MODE })
    chmodSync(getUpdaterScriptPath(), UPDATER_SCRIPT_MODE)
    spawn('bash', [getUpdaterScriptPath()], {
      detached: true,
      stdio: 'ignore',
      // C-proc-09：出站契约构建器组装 env（与 win NSIS 路径对齐），deny 兜底剥
      // TAIJI_AGENT_PACKAGED 等 dev-shell 残留标志，防拉起的新 app 实例被污染判定
      env: buildOutboundChildEnv({ parentEnv: process.env }),
    }).unref()
    return { kind: 'detached-script', scriptPath: getUpdaterScriptPath() }
  }
}

/**
 * win NSIS 升级器（cmd wrapper，设计 §3.4 批次 2）。
 *
 * 与 mac/linux 同构：prepareUpdate 内生成 updater.cmd 写盘升级工作目录
 * （getUpdateDir()）并 detached spawn（cmd /c，detached + ignore stdio），返回 detached-script。
 * sha256 强制（RM4/m5）：win 侧缺 sha256 直接 throw（对齐 mac/linux 语义），
 * 关闭「size-only 内容错的 exe 被执行」窗口——download 降级 size-only 仍可能发生，
 * 但 install 侧强制拒绝；wrapper 内 certutil 二次复验（见 win-updater-cmd.ts）。
 */
export class WinUpdater implements PlatformUpdater {
  prepareUpdate(downloadedFilePath: string, release: LatestReleaseInfo): UpdateScriptRef {
    if (!app.isPackaged) throw new UpdateError('dev mode does not support self-update', 'replacing')
    // win 安装目录 = execPath 的 dirname（electron-builder NSIS 默认布局）
    const installDir = path.dirname(process.execPath)
    const sha256 = release.assets.winX64Exe?.sha256?.toLowerCase()
    if (!sha256) throw new UpdateError('win asset missing sha256', 'downloading')
    const script = buildWinUpdaterCmd({
      installerPath: downloadedFilePath,
      installDir,
      // 重启目标：当前可执行文件同名落位（NSIS /D= 同目录覆盖安装，exe 名不变）
      targetExePath: process.execPath,
      resultPath: getUpdateResultFile(),
      logPath: getWinUpdaterLogPath(),
      parentPid: String(process.pid),
      sha256,
      targetVersion: release.version,
    })
    const scriptPath = getWinUpdaterScriptPath()
    mkdirSync(getUpdateDir(), { recursive: true })
    writeFileSync(scriptPath, script)
    // cmd /c detached + ignore stdio：与 app.quit 解耦（Node 侧定时器随进程消亡，
    // 等待逻辑全部前移进 wrapper，不可信 Node 延迟 spawn）
    const child = spawn('cmd', ['/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      env: buildOutboundChildEnv({ parentEnv: process.env }),
    })
    child.unref()
    writeUpdaterPid(child.pid)
    return { kind: 'detached-script', scriptPath }
  }
}

/**
 * linux AppImage 升级器。
 *
 * AppImage 走 detached 脚本（与 mac 一致，避免双实例）。
 * deb 包（APPIMAGE 环境变量 undefined）走 unsupported，前端跳 release 页降级。
 */
export class LinuxAppImageUpdater implements PlatformUpdater {
  prepareUpdate(downloadedFilePath: string, release: LatestReleaseInfo): UpdateScriptRef {
    const appImage = process.env.APPIMAGE
    if (!appImage) {
      throw new UpdateUnsupportedError('deb package does not support self-update', release.htmlUrl)
    }
    // toLowerCase + 缺失抛 UpdateError：与 mac 路径一致。linux updater 脚本里
    // sha256sum 输出小写，统一小写避免字符串比较大小写误判。
    const sha256 = release.assets.linuxX64AppImage?.sha256?.toLowerCase()
    if (!sha256) throw new UpdateError('linux asset missing sha256', 'downloading')
    const script = buildLinuxUpdaterScript({
      appImagePath: appImage,
      newFilePath: downloadedFilePath,
      sha256,
      logPath: getLinuxUpdaterLogPath(),
      resultPath: getUpdateResultFile(),
      targetVersion: release.version,
      // 与 mac 同契约：脚本 kill -0 等待本进程退出
      parentPid: String(process.pid),
    })
    mkdirSync(getUpdateDir(), { recursive: true })
    writeFileSync(getLinuxUpdaterScriptPath(), script, { mode: UPDATER_SCRIPT_MODE })
    chmodSync(getLinuxUpdaterScriptPath(), UPDATER_SCRIPT_MODE)
    spawn('bash', [getLinuxUpdaterScriptPath()], {
      detached: true,
      stdio: 'ignore',
      // C-proc-09：同 mac 路径，出站契约构建器组装 env + deny 兜底
      env: buildOutboundChildEnv({ parentEnv: process.env }),
    }).unref()
    return { kind: 'detached-script', scriptPath: getLinuxUpdaterScriptPath() }
  }
}

/**
 * 按当前平台创建升级器。
 *
 * @throws UpdateUnsupportedError 未知平台
 */
export function createPlatformUpdater(): PlatformUpdater {
  switch (process.platform) {
    case 'darwin': return new MacUpdater()
    case 'win32': return new WinUpdater()
    case 'linux': return new LinuxAppImageUpdater()
    default: throw new UpdateError(`unsupported platform: ${process.platform}`, 'replacing')
  }
}
