/**
 * local-file 网关：白名单前缀解析（单一来源）+ servable 预检 IPC（chat-html-support §6.9 D9）。
 *
 * 两个消费方共用本模块：
 * ① main.ts 的 `protocol.handle('local-file')` 协议 handler
 * ② 本模块注册的 `localFile:servable` 预检 IPC（卡片 + 抽屉渲染态挂载前准入检查）
 *
 * **白名单成员集静态不变**（本设计不新增成员、不新增白名单输入方，§3.5 聚合不变量②）：
 * 产物目录落在既有成员 `<dataDir>` 内，前缀构造仍由 computeLocalFilePrefixes 纯函数裁决。
 *
 * servable 谓词与协议 handler 复用 utils/local-file-prefixes 的同一模块函数（非两份平行
 * 实现）；本模块只负责「取当次白名单前缀」与「IPC 边界输入防御」。
 *
 * 依赖方向：gateway/local-file-handlers → electron(app/ipcMain) + @taiji/shared(getDataDir /
 *   LOCAL_FILE_SERVABLE 通道名 SSOT) + utils/local-file-prefixes + utils/error-message +
 *   logs/main-logger（探测异常旁路）+ interfaces
 */
import { ipcMain, app } from 'electron'
import { tmpdir } from 'node:os'
import { getDataDir } from '@taiji/shared/paths'
import { LOCAL_FILE_READ, LOCAL_FILE_SERVABLE } from '@taiji/shared'
import type { IpcHandlerDeps } from '../interfaces.js'
import { mainLogger } from '../logs/main-logger.js'
import { toErrorMessage } from '../utils/error-message.js'
import {
  computeLocalFilePrefixes,
  probeLocalFileServable,
  readLocalFileContent,
  type LocalFileReadResult,
  type LocalFileServableResult,
} from '../utils/local-file-prefixes.js'

/**
 * 取当次 local-file 白名单前缀（main.ts 协议 handler 与 servable IPC 的单一来源）。
 *
 * [HISTORICAL] W3 → D2a：打包态剔除 cwd（Finder/Dock 启动时 cwd 是 /，前缀匹配
 * startsWith('/') 对任意绝对路径恒真，白名单塌缩为全盘，「绝不放行 ~ 本身」的护栏被
 * 运行时环境击穿）。不变量守护在单测：main/test/local-file-prefixes.test.ts
 * （打包态不含文件系统根 / 不含 homedir 本身）。
 *
 * projectRoot：仅 dev + dev-instance.mjs 装配器注入 TAIJI_DEV_PROJECT_ROOT 时生效
 * （dev 装配的 electron cwd/appPath 都指向 apps/electron，白名单需要 worktree 根成员
 * 才能放行 session cwd 下的用户文件）。打包态 env 不会被装配器注入，isDev 判断再显式
 * 防一层泄漏（isPackaged 时不传）。各成员取舍见 utils/local-file-prefixes.ts 文件头。
 */
export function getAllowedLocalFilePrefixes(isDev: boolean): string[] {
  return computeLocalFilePrefixes({
    isPackaged: app.isPackaged,
    cwd: process.cwd(),
    appPath: app.getAppPath(),
    dataDir: getDataDir(),
    tmpdir: tmpdir(),
    ...(isDev && process.env.TAIJI_DEV_PROJECT_ROOT
      ? { projectRoot: process.env.TAIJI_DEV_PROJECT_ROOT }
      : {}),
  })
}

/**
 * 注册 localFile:servable 预检 IPC 与 localFile:read 源码读取 IPC（形态对齐 privileged-handlers.ts
 * 的 ipcMain.handle）。
 *
 * 通道名 SSOT = `@taiji/shared` 的 `LOCAL_FILE_SERVABLE` / `LOCAL_FILE_READ`
 * （packages/shared/src/ipc-channels.ts），preload.ts 同 import——禁止两侧字面量分叉。
 *
 * 出参 = `{ servable, reason?, size? }`；检查顺序（白名单先行短路 → 存在性 → 目录性）
 * 由 probeLocalFileServable 保证——越界路径不触 fs，不构成任意路径的存在性探测通道。
 * IPC 边界防御：非 string / 空串直接拒（与越界同形返回，不给探测量）。
 */
export function registerLocalFileHandlers(deps: IpcHandlerDeps): void {
  ipcMain.handle(
    LOCAL_FILE_SERVABLE,
    (_event, rawPath: unknown): LocalFileServableResult => {
      if (typeof rawPath !== 'string' || rawPath.length === 0) {
        return { servable: false, reason: 'out_of_whitelist' }
      }
      const probe = probeLocalFileServable(rawPath, getAllowedLocalFilePrefixes(deps.isDev), {
        // EACCES/EIO 等真异常的就地映射仍是 not_found（三值 reason 枚举不扩）——真因由
        // main 日志承载（§6.4 D4 子决策③），与协议 handler 同一旁路形态
        onError: (err, filePath) =>
          mainLogger.warn(`[main] local-file servable probe failed (${filePath}): ${toErrorMessage(err)}`),
      })
      if (!probe.servable) return { servable: false, reason: probe.reason }
      return { servable: true, size: probe.size }
    },
  )

  // localFile:read：DetailPane 「源码」态读内容（chat-html-support §8.2 S3「切换『源码』看到
  // shiki 高亮」）。产物目录 `<dataDir>/artifacts/<sessionId>` 在 session cwd 外（§6.7 D7），
  // runtime file.read 的 cwd 守门对主要产物路径不可达——本条与 servable 预检复用同一白名单
  // 谓词（§6.9 D9「同一谓词」），准入不放宽；读取失败不抛错，回结构化原因。
  ipcMain.handle(LOCAL_FILE_READ, (_event, rawPath: unknown): LocalFileReadResult => {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      return { ok: false, reason: 'out_of_whitelist' }
    }
    return readLocalFileContent(rawPath, getAllowedLocalFilePrefixes(deps.isDev), {
      onError: (err, filePath) =>
        mainLogger.warn(`[main] local-file read probe failed (${filePath}): ${toErrorMessage(err)}`),
    })
  })
}
