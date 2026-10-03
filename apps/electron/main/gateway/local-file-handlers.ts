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
 * 依赖方向：gateway/local-file-handlers → electron(app/ipcMain) + @taiji/shared/paths(getDataDir)
 *   + utils/local-file-prefixes + interfaces
 */
import { ipcMain, app } from 'electron'
import { tmpdir } from 'node:os'
import { getDataDir } from '@taiji/shared/paths'
import type { IpcHandlerDeps } from '../interfaces.js'
import {
  computeLocalFilePrefixes,
  probeLocalFileServable,
  type LocalFileServableResult,
} from '../utils/local-file-prefixes.js'

/** 预检 IPC 通道名（preload.ts 同字面量；main 侧唯一注册点） */
export const LOCAL_FILE_SERVABLE_CHANNEL = 'localFile:servable'

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
 * 注册 localFile:servable 预检 IPC（形态对齐 privileged-handlers.ts 的 ipcMain.handle）。
 *
 * 出参 = `{ servable, reason?, size? }`；检查顺序（白名单先行短路 → 存在性 → 目录性）
 * 由 probeLocalFileServable 保证——越界路径不触 fs，不构成任意路径的存在性探测通道。
 * IPC 边界防御：非 string / 空串直接拒（与越界同形返回，不给探测量）。
 */
export function registerLocalFileHandlers(deps: IpcHandlerDeps): void {
  ipcMain.handle(
    LOCAL_FILE_SERVABLE_CHANNEL,
    (_event, rawPath: unknown): LocalFileServableResult => {
      if (typeof rawPath !== 'string' || rawPath.length === 0) {
        return { servable: false, reason: 'out_of_whitelist' }
      }
      const probe = probeLocalFileServable(rawPath, getAllowedLocalFilePrefixes(deps.isDev))
      if (!probe.servable) return { servable: false, reason: probe.reason }
      return { servable: true, size: probe.size }
    },
  )
}
