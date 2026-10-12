/**
 * 会话 JSONL 导出 IPC handler（2026-10-12 立项）。
 *
 * 经 SESSION_EXPORT_JSONL（'session:export-jsonl'）通道把「复制会话 JSONL 到用户自选
 * 位置」暴露为 renderer 入口（SessionItemContextMenu 右键菜单「导出 JSONL」）：main 先经
 * dialog.showSaveDialog 让用户确认保存位置（对齐 diagnostics-export-ipc 先例），取消返回
 * canceled，校验/复制失败归一进 result.error（零 rejection 面，invoke 无 rejection 面）。
 *
 * **路径安全校验（本模块核心）**：payload.sessionFile 是 renderer 半可信输入（渲染层被
 * 破解时任意路径可经此读取），复制前必须校验 resolve 后位于会话文件三棵树
 * `<piAgentDir>/sessions|subagents|btw` 之内——piAgentDir 经 @taiji/shared/paths
 * getPiAgentDir() 推导（与 runtime pi-paths.ts 同一 SSOT，三树布局定义见该文件：
 * sessions = 主会话 / subagents = 子代理会话 / btw = btw 线会话）。越界拒绝并报错
 * （EPATH），不 fallback。树内文件不存在（ENOENT）交由 copyFile 的具体 errno 报错。
 *
 * 写盘用 fs.promises.copyFile（内核级直复制，不读入内存缓冲——会话文件可能数十 MB）。
 * suggestedName 只影响保存对话框预填名，仍按不信任输入处理：剥目录成分 + 清洗非法
 * 文件名字符 + 保证 .jsonl 后缀，清洗后为空回退 sessionId。
 *
 * 先例 = diagnostics/diagnostics-export-ipc.ts：ipcMain.handle 注册幂等（registered 标志
 * 防 Electron「second handler」炸启动）+ 零抛错 + deps 注入可测 + 注册失败不炸 main 启动。
 */
import { ipcMain, dialog, BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { copyFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import type { SessionJsonlExportPayload, SessionJsonlExportResult } from '@taiji/shared'
import { SESSION_EXPORT_JSONL } from '@taiji/shared'
import { getPiAgentDir } from '@taiji/shared/paths'
import { mainLogger } from '../logs/main-logger.js'

/** 保存对话框返回形态（diagnostics-export-ipc 的 SaveDialogResult 同款测试最小投影）。 */
export interface SessionExportSaveDialogResult { // oe-exempt:20261012:framework:deps 注入契约面——生产 dialog 返回投影 + 测试桩单消费位，接口先立防测试走真 electron 通道（对齐 diagnostics-export-ipc 先例形态）
  canceled: boolean
  filePath?: string
}

/** 依赖注入面：测试注入对话框桩 / 复制桩 / piAgentDir 桩，生产用 electron 与真实实现。 */
export interface SessionExportIpcDeps { // oe-exempt:20261012:framework:deps 注入契约面——生产实现 + 测试桩双消费位，单实现常态（对齐 diagnostics-export-ipc DiagnosticsExportIpcDeps 先例形态）
  /** 保存对话框；缺省 dialog.showSaveDialog（聚焦窗口，无聚焦窗口直接 canceled） */
  showSaveDialog?: (options: { title: string; defaultPath?: string }) => Promise<SessionExportSaveDialogResult>
  /** 复制主体；缺省 fs.promises.copyFile（内核直复制，不读入内存缓冲） */
  copyFile?: (src: string, dest: string) => Promise<void>
  /** piAgentDir 来源；缺省 @taiji/shared/paths getPiAgentDir()（env 权威推导） */
  piAgentDir?: () => string
}

/**
 * 会话文件三棵树目录段（`<piAgentDir>/sessions|subagents|btw`）。
 * 布局权威 = runtime infra/pi/pi-paths.ts（getSessionsDir / getSubagentSessionDir /
 * getBtwRoot）；main 不 import runtime（包边界），经 shared getPiAgentDir 同构推导。
 */
const SESSION_TREE_SEGMENTS = ['sessions', 'subagents', 'btw'] as const

/**
 * 校验候选路径位于会话文件三棵树之内（树内包含判定，双侧 casefold——大小写不敏感卷
 * （macOS/Windows 默认）上路径大小写变体命中同一物理文件，对齐 shared paths.ts
 * assertNotLeakedProdDataDir 的 casefold 先例；双侧都经 resolve 词法消解，不做 realpath
 * ——源路径与树根同源自同一 env 推导，词法比较即一致，单侧 realpath 反而会在 macOS
 * /var → /private/var 类 symlink 前缀下把合法路径误判为越界）。
 */
export function isInsideSessionTrees(candidate: string, piAgentDir: string): boolean {
  if (!isAbsolute(candidate)) return false
  const resolvedCandidate = resolve(candidate).toLowerCase()
  const resolvedAgentDir = resolve(piAgentDir).toLowerCase()
  return SESSION_TREE_SEGMENTS.some((segment) => {
    const treeRoot = join(resolvedAgentDir, segment)
    return resolvedCandidate.startsWith(treeRoot + sep)
  })
}

/** Windows/Unix 通吃的非法文件名字符（含控制字符），清洗为下划线。 */
const ILLEGAL_FILENAME_CHARS = /[/\\:*?"<>|\u0000-\u001f]/g

/**
 * 构造保存对话框默认文件名：优先 suggestedName（剥目录成分 + 清洗非法字符），剥洗后
 * 为空回退 sessionId，仍为空回退 'session'；统一保证 .jsonl 后缀。
 * suggestedName 来自 renderer（半可信），只影响对话框预填名——用户仍需在对话框里确认，
 * 但按不信任输入处理，不给预填目录逃逸面（basename 剥 `..` 等目录成分）。
 */
export function buildDefaultFileName(sessionId: string, suggestedName?: string): string {
  const suggested = typeof suggestedName === 'string' ? basename(suggestedName).replace(ILLEGAL_FILENAME_CHARS, '_').trim() : ''
  const sessionIdClean = sessionId.replace(ILLEGAL_FILENAME_CHARS, '_').trim()
  const stem = suggested || sessionIdClean || 'session'
  return stem.endsWith('.jsonl') ? stem : `${stem}.jsonl`
}

let registered = false

/**
 * 注册 SESSION_EXPORT_JSONL handler。ipc-handlers.ts 聚合点调用一次；幂等
 * （对齐 diagnostics-export-ipc：重复注册 Electron 会 throw，标志位防重复注册炸启动）。
 */
export function registerSessionExportHandler(deps: SessionExportIpcDeps = {}): void {
  if (registered) return
  registered = true
  const showSave =
    deps.showSaveDialog ??
    (async (options: { title: string; defaultPath?: string }): Promise<SessionExportSaveDialogResult> => {
      // 无聚焦窗口直接 canceled（diagnostics-export-ipc 先例：降级目标对称，不弹后台窗口）
      const focusedWin = BrowserWindow.getFocusedWindow()
      if (!focusedWin) return { canceled: true }
      const result = await dialog.showSaveDialog(focusedWin, {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: [{ name: 'JSONL', extensions: ['jsonl'] }],
      })
      return { canceled: result.canceled, filePath: result.filePath }
    })
  const copy = deps.copyFile ?? copyFile
  const piAgentDirOf = deps.piAgentDir ?? getPiAgentDir

  try {
    ipcMain.handle(
      SESSION_EXPORT_JSONL,
      async (_event: IpcMainInvokeEvent, payload?: SessionJsonlExportPayload): Promise<SessionJsonlExportResult> => {
        // payload 畸形防御（renderer 菜单对 sessionFile 缺失态已禁用入口，此处是纵深：
        // 缺失/非绝对路径直接报错可消费，不静默、不 fallback）
        const sessionFile = typeof payload?.sessionFile === 'string' ? payload.sessionFile : undefined
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
        if (!sessionFile) {
          return {
            status: 'error',
            error: { code: 'EINVALID', message: '会话文件缺失：该会话尚未产生记录文件（首条消息落盘前不可导出）' },
          }
        }
        // 路径安全校验（核心）：源路径必须在三树之内，越界拒绝不 fallback
        if (!isInsideSessionTrees(sessionFile, piAgentDirOf())) {
          mainLogger.warn(`[session-export-ipc] sessionFile outside session trees, rejected: ${sessionFile}`)
          return {
            status: 'error',
            error: { code: 'EPATH', message: '会话文件路径不在会话数据目录内，已拒绝导出' },
          }
        }
        let save: SessionExportSaveDialogResult
        try {
          save = await showSave({ title: '导出会话 JSONL', defaultPath: buildDefaultFileName(sessionId, payload?.suggestedName) })
        } catch (err) {
          // 对话框崩溃同样降级为可判定的错误三态（不向 renderer 抛 invoke rejection）
          mainLogger.warn(`[session-export-ipc] save dialog failed: ${err instanceof Error ? err.message : String(err)}`)
          return { status: 'error', error: { code: 'EDIALOG', message: '保存对话框打开失败' } }
        }
        if (save.canceled || save.filePath === undefined) return { status: 'canceled' }
        try {
          // 先 stat 取源大小（作 bytes 汇报；不存在在此处得到具体 ENOENT），再内核直复制
          const { size } = await stat(sessionFile)
          await copy(sessionFile, save.filePath)
          mainLogger.info('[session-export-ipc] session jsonl exported', {
            sessionId,
            src: sessionFile,
            dest: save.filePath,
            bytes: size,
          })
          return { status: 'exported', path: save.filePath, bytes: size }
        } catch (err) {
          // errno 提取经局部变量（as 断言表达式不参与跨表达式 narrow，直接三元会让
          // true 支保持 string | undefined，TS2322）
          const errno: string | undefined = (err as NodeJS.ErrnoException).code
          const code = typeof errno === 'string' ? errno : 'EUNKNOWN'
          const message = err instanceof Error ? err.message : String(err)
          mainLogger.warn(`[session-export-ipc] export failed (${code}): ${message}`)
          return { status: 'error', error: { code, message } }
        }
      },
    )
    mainLogger.debug('[session-export-ipc] registered', { channel: SESSION_EXPORT_JSONL })
  // eslint-disable-next-line taste/no-silent-catch -- 注册失败（极端：channel 被占）不能炸 main 启动；导出入口缺席只影响右键菜单导出项（对齐 diagnostics-export-ipc）
  } catch {
    // no-op
  }
}
