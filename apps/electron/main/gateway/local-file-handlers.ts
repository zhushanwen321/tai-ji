/**
 * local-file 网关：白名单前缀解析（单一来源）+ servable 预检 / 源码读取 IPC（chat-html-support
 * §6.9 D9）。
 *
 * 三个消费面共用本模块，准入分两面：
 * ① main.ts 的 `protocol.handle('local-file')` 协议 handler——渲染面（图片/iframe 服务），
 *   准入 = 全量白名单 getAllowedLocalFilePrefixes
 * ② `localFile:servable` 预检 IPC（内联预览容器 HtmlPreviewInline 挂载前准入检查，经 deps
 *   probeArtifact?——v16 唯一渲染面）
 * ③ `localFile:read` 源码读取 IPC（容器源码态 + useDetailPane 抽屉产物源码读取）
 *   ②③ 读/预检通道的准入 = 产物子树 getReadChannelPrefixes（收窄面）——通道入参含模型
 *   消息文本承载的路径载荷（html-preview fence），全量白名单含 `<dataDir>` 整前缀（含
 *   `<dataDir>/agent/auth.json` 等凭据文件），文本读取/预检面必须限定在实际消费域
 *   `<dataDir>/artifacts/**`
 *
 * **白名单成员集静态不变**（本设计不新增成员、不新增白名单输入方，§3.5 聚合不变量②）：
 * 产物目录落在既有成员 `<dataDir>` 内，前缀构造仍由 computeLocalFilePrefixes 纯函数裁决。
 *
 * 谓词与协议 handler 复用 utils/local-file-prefixes 的同一模块函数（非两份平行实现）；
 * 本模块只负责「取当次准入前缀」与「IPC 边界输入防御」。
 *
 * 依赖方向：gateway/local-file-handlers → electron(app/ipcMain) + @taiji/shared(getDataDir /
 *   LOCAL_FILE_SERVABLE 通道名 SSOT) + utils/local-file-prefixes + utils/error-message +
 *   logs/main-logger（探测异常旁路）+ interfaces
 */
import { ipcMain, app } from 'electron'
import { tmpdir } from 'node:os'
import { getDataDir } from '@taiji/shared/paths'
import { LOCAL_FILE_READ, LOCAL_FILE_SERVABLE } from '@taiji/shared'
import { mainLogger } from '../logs/main-logger.js'
import { toErrorMessage } from '../utils/error-message.js'
import {
  computeLocalFilePrefixes,
  computeLocalFileReadPrefixes,
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
 * localFile:servable / localFile:read 两条 IPC 通道的当次准入前缀（读/预检收窄面）。
 *
 * 只放行会话产物子树 `<dataDir>/artifacts/**`（computeLocalFileReadPrefixes），不复用
 * 协议 handler 的全量白名单——见文件头「准入分两面」。cwd 外非产物路径拿
 * `out_of_whitelist`，消费方回落既有通道（useDetailPane cwd 通道 / 容器降级占位）。
 */
function getReadChannelPrefixes(): string[] {
  return computeLocalFileReadPrefixes(getDataDir())
}

/**
 * 注册 localFile:servable 预检 IPC 与 localFile:read 源码读取 IPC（形态对齐 privileged-handlers.ts
 * 的 ipcMain.handle）。准入只依赖 getDataDir()（产物子树收窄面，与 dev/prod 无关），不注入
 * IpcHandlerDeps。
 *
 * 通道名 SSOT = `@taiji/shared` 的 `LOCAL_FILE_SERVABLE` / `LOCAL_FILE_READ`
 * （packages/shared/src/ipc-channels.ts），preload.ts 同 import——禁止两侧字面量分叉。
 *
 * 出参 = `{ servable, reason?, size? }`；检查顺序（白名单先行短路 → 存在性 → 目录性）
 * 由 probeLocalFileServable 保证——越界路径不触 fs，不构成任意路径的存在性探测通道。
 * IPC 边界防御：非 string / 空串直接拒（与越界同形返回，不给探测量）。
 */
export function registerLocalFileHandlers(): void {
  ipcMain.handle(
    LOCAL_FILE_SERVABLE,
    (_event, rawPath: unknown): LocalFileServableResult => {
      if (typeof rawPath !== 'string' || rawPath.length === 0) {
        return { servable: false, reason: 'out_of_whitelist' }
      }
      const probe = probeLocalFileServable(rawPath, getReadChannelPrefixes(), {
        // EACCES/EIO 等真异常的就地映射仍是 not_found（三值 reason 枚举不扩）——真因由
        // main 日志承载（§6.4 D4 子决策③），与协议 handler 同一旁路形态
        onError: (err, filePath) =>
          mainLogger.warn(`[main] local-file servable probe failed (${filePath}): ${toErrorMessage(err)}`),
      })
      if (!probe.servable) return { servable: false, reason: probe.reason }
      return { servable: true, size: probe.size }
    },
  )

  // localFile:read：内联容器源码态与 DetailPane 变更集/文件树产物源码读取（useDetailPane
  // loadPreviewContent；chat-html-support §8.2 S3「切换『源码』看到 shiki 高亮」）。产物目录
  // `<dataDir>/artifacts/<sessionId>` 在 session cwd 外（§6.7 D7），runtime file.read 的
  // cwd 守门对主要产物路径不可达——与 servable 预检同谓词函数（probeLocalFileServable），
  // 准入前缀集 = 产物子树（读通道收窄，与协议 handler 全量白名单分面）；读取失败不抛错，
  // 回结构化原因。
  ipcMain.handle(LOCAL_FILE_READ, (_event, rawPath: unknown): LocalFileReadResult => {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      return { ok: false, reason: 'out_of_whitelist' }
    }
    return readLocalFileContent(rawPath, getReadChannelPrefixes(), {
      onError: (err, filePath) =>
        mainLogger.warn(`[main] local-file read probe failed (${filePath}): ${toErrorMessage(err)}`),
    })
  })
}
