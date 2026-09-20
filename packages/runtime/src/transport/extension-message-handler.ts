/**
 * Extension message handler for extension.* message types.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@taiji/shared'
import type { ISessionService, IExtensionService } from '../interfaces.js'
import type { ExtensionTimeoutManager } from '../services/extension-timeout-manager.js'
import { ExtensionInstallError } from '../services/extension-service.js'
import { toErrorMessage } from '../utils/errors.js'
import { sendHandlerError } from './handler-utils.js'
import type { MessageHandlerContext } from './message-context.js'

/** Interface for server methods needed by this handler */
export interface ExtensionHandlerContext extends MessageHandlerContext {
  sessionService: ISessionService
  extensionService: IExtensionService | undefined
  extensionTimeoutMgr: ExtensionTimeoutManager
}

/**
 * extension.* case 路由表类型：每个消息 type 映射到对应 case 处理器，msg 参数按
 * key 窄化（Extract 收窄与 switch narrowing 行为一致——见 shared protocol.ts 的
 * ClientMessage 派生注释）。表驱动取代原 ~13 分支 switch：主函数只留「查表 + 命中调用」，
 * 每个 case 体是独立私有 helper（行为保持提取，复杂度债务偿还 W1）。
 */
type ExtensionCaseRoutes = {
  [K in ClientMessageType]?: (msg: Extract<ClientMessage, { type: K }>, ws: WsType) => Promise<void>
}

export class ExtensionMessageHandler {
  constructor(private ctx: ExtensionHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = [
    'extension.ui_response', 'extension.list', 'extension.toggle', 'extension.install', 'extension.uninstall',
    'extension.installDir', 'extension.installGit', 'extension.finishInstall', 'extension.cancelInstall',
    'extension.recommended',
    'extension.upgrade', 'extension.setAutoUpgrade',
    'extension.getPendingRequests',
  ]

  /**
   * case 路由表：key 集合与原 switch case 一一对应。未知 type 查表落空即返回
   * （不发任何消息，同原 switch 无 default 的落空行为）。
   */
  private readonly routes: ExtensionCaseRoutes = {
    'extension.ui_response': (msg, ws) => this.handleExtensionUiResponse(msg, ws),
    'extension.list': (msg, ws) => this.handleExtensionList(msg, ws),
    'extension.recommended': (msg, ws) => this.handleExtensionRecommended(msg, ws),
    'extension.toggle': (msg, ws) => this.handleExtensionToggle(msg, ws),
    'extension.install': (msg, ws) => this.handleExtensionInstall(msg, ws),
    'extension.uninstall': (msg, ws) => this.handleExtensionUninstall(msg, ws),
    'extension.installDir': (msg, ws) => this.handleExtensionInstallDir(msg, ws),
    'extension.installGit': (msg, ws) => this.handleExtensionInstallGit(msg, ws),
    'extension.finishInstall': (msg, ws) => this.handleExtensionFinishInstall(msg, ws),
    'extension.cancelInstall': (msg, ws) => this.handleExtensionCancelInstall(msg, ws),
    'extension.upgrade': (msg, ws) => this.handleExtensionUpgrade(msg, ws),
    'extension.setAutoUpgrade': (msg, ws) => this.handleExtensionSetAutoUpgrade(msg, ws),
    'extension.getPendingRequests': (msg, ws) => this.handleExtensionGetPendingRequests(msg, ws),
  }

  async handleExtensionMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    const handler = this.routes[msg.type]
    if (!handler) return
    // 路由表 key 与 msg.type 字面量同源（上方 routes 逐 key 登记），查表命中即类型匹配；
    // TS 无法静态关联索引访问与 key（correlated types，microsoft/TypeScript#30581），
    // `as never` 是该不变式下的类型层收口，运行时分发行为与原 switch 完全一致。
    await handler(msg as never, ws)
  }

  // ── case handlers（原 switch case 体逐一提取；语句与注释原样保留，行为保持）──

  private async handleExtensionUiResponse(msg: Extract<ClientMessage, { type: 'extension.ui_response' }>, ws: WsType): Promise<void> {
    const { sessionId: extSid, requestId, method, result: extResult } = msg.payload

    if (this.ctx.extensionTimeoutMgr.isBridgeRequest(requestId)) {
      this.ctx.extensionTimeoutMgr.removeBridgeRequest(requestId)
      this.ctx.extensionTimeoutMgr.removePendingRequest(extSid, requestId)
      return
    }

    const client = this.ctx.sessionService.getRpcClient(extSid)
    if (!client) {
      this.ctx.extensionTimeoutMgr.clearTimeout(requestId)
      this.ctx.extensionTimeoutMgr.removePendingRequest(extSid, requestId)
      return this.ctx.sendError(ws, 'handler_error', `No active session for extension response: ${extSid}`, msg.id, { sessionId: extSid })
    }
    // M1/RT-1#4：sendRaw 返 false（pi 进程不在/已退出或 stdin 写失败）时该应答已无法
    // 送达——rpc client 绑定当前进程，pi 重启后是全新 pending 表、旧 requestId 永不可
    // 投递，runtime 侧没有重投通道，故选「立即终结」而非保留 pending：摘跟踪 + 带码
    // error envelope 上行（无 msg.id 的 fire-and-forget，renderer 经 route-inbound D6b
    // onSessionError 兜底进消息流 + toast，用户作答不再石沉大海）。
    const delivered = client.sendExtensionUiResponse(requestId, extResult ?? null, method)
    this.ctx.extensionTimeoutMgr.clearTimeout(requestId)
    this.ctx.extensionTimeoutMgr.removePendingRequest(extSid, requestId)
    if (!delivered) {
      return this.ctx.sendError(
        ws,
        'extension_response_send_failed',
        `Extension response for request ${requestId} was not delivered to pi (process not running or stdin write failed)`,
        msg.id,
        { sessionId: extSid, hint: '回复未送达 pi（进程不在或写入失败），该请求已终结；请检查会话状态后重试操作。' },
      )
    }
    return
  }

  private async handleExtensionList(msg: Extract<ClientMessage, { type: 'extension.list' }>, ws: WsType): Promise<void> {
    if (!this.ctx.extensionService) {
      return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions: [] })
    }
    const extensions = await this.ctx.extensionService.scanExtensions()
    return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions })
  }

  private async handleExtensionRecommended(msg: Extract<ClientMessage, { type: 'extension.recommended' }>, ws: WsType): Promise<void> {
    if (!this.ctx.extensionService) {
      return this.ctx.reply(ws, msg.id, 'extension.recommended', { recommended: [] })
    }
    const recommended = await this.ctx.extensionService.getRecommendedExtensions()
    return this.ctx.reply(ws, msg.id, 'extension.recommended', { recommended })
  }

  private async handleExtensionToggle(msg: Extract<ClientMessage, { type: 'extension.toggle' }>, ws: WsType): Promise<void> {
    const ext = this.requireExt(ws, msg.id)
    if (!ext) return
    try {
      await ext.toggleExtension(msg.payload.name, msg.payload.enabled)
      const extensions = await ext.scanExtensions()
      return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions })
    } catch (e) {
      // 透传 ExtensionInstallError 的 code/hint（如 infrastructure_cannot_disable），
      // 与 install 路径对称；非领域错误 fallback 到 toggle_failed。
      return sendHandlerError(this.ctx, ws, ExtensionInstallError, 'toggle_failed', e, msg.id, (matched) => matched.hint ? { hint: matched.hint } : undefined)
    }
  }

  private async handleExtensionInstall(msg: Extract<ClientMessage, { type: 'extension.install' }>, ws: WsType): Promise<void> {
    const ext = this.requireExt(ws, msg.id)
    if (!ext) return
    try {
      await ext.installExtension(msg.payload.source)
    } catch (e) {
      return this.sendInstallError(ws, msg.id, e)
    }
    const installed = await ext.scanExtensions()
    return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions: installed })
  }

  private async handleExtensionUninstall(msg: Extract<ClientMessage, { type: 'extension.uninstall' }>, ws: WsType): Promise<void> {
    const ext = this.requireExt(ws, msg.id)
    if (!ext) return
    try {
      await ext.uninstallExtension(msg.payload.name)
    } catch (e) {
      // 透传 ExtensionInstallError 的 code/hint（如 builtin_cannot_uninstall），
      // 与 install/toggle 路径对称；非领域错误 fallback 到 uninstall_failed。
      return sendHandlerError(this.ctx, ws, ExtensionInstallError, 'uninstall_failed', e, msg.id, (matched) => matched.hint ? { hint: matched.hint } : undefined)
    }
    const uninstalled = await ext.scanExtensions()
    return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions: uninstalled })
  }

  // ── Local directory / Git / finish install ────────────────────
  private async handleExtensionInstallDir(msg: Extract<ClientMessage, { type: 'extension.installDir' }>, ws: WsType): Promise<void> {
    const ext = this.requireExt(ws, msg.id)
    if (!ext) return
    try {
      const { path: sourcePath } = msg.payload as { path: string }
      if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
        return this.ctx.sendError(ws, 'invalid_payload', 'extension.installDir requires a non-empty "path" string', msg.id)
      }
      const result = await ext.installLocalDirectory(sourcePath)
      return this.ctx.reply(ws, msg.id, 'extension.discovered', { tempDir: result.tempDir, candidates: result.candidates })
    } catch (e) {
      return this.sendInstallError(ws, msg.id, e)
    }
  }

  private async handleExtensionInstallGit(msg: Extract<ClientMessage, { type: 'extension.installGit' }>, ws: WsType): Promise<void> {
    const ext = this.requireExt(ws, msg.id)
    if (!ext) return
    try {
      const { url } = msg.payload as { url: string }
      if (typeof url !== 'string' || url.length === 0) {
        return this.ctx.sendError(ws, 'invalid_payload', 'extension.installGit requires a non-empty "url" string', msg.id)
      }
      const result = await ext.installGitRepository(url)
      return this.ctx.reply(ws, msg.id, 'extension.discovered', { tempDir: result.tempDir, candidates: result.candidates })
    } catch (e) {
      return this.sendInstallError(ws, msg.id, e)
    }
  }

  private async handleExtensionFinishInstall(msg: Extract<ClientMessage, { type: 'extension.finishInstall' }>, ws: WsType): Promise<void> {
    const ext = this.requireExt(ws, msg.id)
    if (!ext) return
    try {
      const { tempDir, selected } = msg.payload as { tempDir: string; selected: string[] }
      if (typeof tempDir !== 'string' || !Array.isArray(selected)) {
        return this.ctx.sendError(ws, 'invalid_payload', 'extension.finishInstall requires tempDir (string) and selected (string[])', msg.id)
      }
      const failures = await ext.finishInstall(tempDir, selected)
      if (failures.length > 0) {
        // RT-6#1 逐包隔离失败聚合上报：成功包已落盘（列表随刷新可见），失败清单经
        // ExtensionInstallError 透传（code/hint），前端 catch 显示——不吞失败回假成功。
        const names = failures.map((f) => f.dirName).join(', ')
        throw new ExtensionInstallError(
          'finish_partial_failed',
          `Failed to install extension(s): ${names}`,
          '部分扩展安装失败，已成功的扩展已保留、失败扩展的旧版本不受影响，可重试安装。',
        )
      }
      const extensions = await ext.scanExtensions()
      return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions })
    } catch (e) {
      return this.sendInstallError(ws, msg.id, e)
    }
  }

  private async handleExtensionCancelInstall(msg: Extract<ClientMessage, { type: 'extension.cancelInstall' }>, ws: WsType): Promise<void> {
    const ext = this.requireExt(ws, msg.id)
    if (!ext) return
    try {
      const { tempDir } = msg.payload as { tempDir: string }
      if (typeof tempDir !== 'string' || tempDir.length === 0) {
        return this.ctx.sendError(ws, 'invalid_payload', 'extension.cancelInstall requires a non-empty "tempDir" string', msg.id)
      }
      await ext.cancelInstall(tempDir)
      return this.ctx.reply(ws, msg.id, 'extension.installCancelled', {})
    } catch (e) {
      return this.sendInstallError(ws, msg.id, e)
    }
  }

  private async handleExtensionUpgrade(msg: Extract<ClientMessage, { type: 'extension.upgrade' }>, ws: WsType): Promise<void> {
    const ext = this.requireExt(ws, msg.id)
    if (!ext) return
    try {
      const { name } = msg.payload as { name: string }
      if (typeof name !== 'string' || name.length === 0) {
        return this.ctx.sendError(ws, 'invalid_payload', 'extension.upgrade requires a non-empty "name" string', msg.id)
      }
      const result = await ext.upgradeExtension(name)
      const extensions = await ext.scanExtensions()
      return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions, upgradeResult: result })
    } catch (e) {
      return this.sendInstallError(ws, msg.id, e)
    }
  }

  private async handleExtensionSetAutoUpgrade(msg: Extract<ClientMessage, { type: 'extension.setAutoUpgrade' }>, ws: WsType): Promise<void> {
    const ext = this.requireExt(ws, msg.id)
    if (!ext) return
    try {
      const { name, autoUpgrade } = msg.payload as { name: string; autoUpgrade: boolean }
      if (typeof name !== 'string' || name.length === 0) {
        return this.ctx.sendError(ws, 'invalid_payload', 'extension.setAutoUpgrade requires a non-empty "name" string', msg.id)
      }
      if (typeof autoUpgrade !== 'boolean') {
        return this.ctx.sendError(ws, 'invalid_payload', 'extension.setAutoUpgrade requires "autoUpgrade" to be a boolean', msg.id)
      }
      await ext.setAutoUpgrade(name, autoUpgrade)
      const extensions = await ext.scanExtensions()
      return this.ctx.reply(ws, msg.id, 'config.extensions', { extensions })
    } catch (e) {
      return this.ctx.sendError(ws, 'set_auto_upgrade_failed', toErrorMessage(e), msg.id)
    }
  }

  private async handleExtensionGetPendingRequests(msg: Extract<ClientMessage, { type: 'extension.getPendingRequests' }>, ws: WsType): Promise<void> {
    const { sessionId } = msg.payload as { sessionId: string }
    if (!sessionId) {
      return this.ctx.sendError(ws, 'invalid_payload', 'extension.getPendingRequests requires "sessionId"', msg.id)
    }
    const pendingRequests = this.ctx.extensionTimeoutMgr.getPendingRequests(sessionId)
    return this.ctx.reply(ws, msg.id, 'extension.pendingRequests', { sessionId, requests: pendingRequests })
  }

  /**
   * D3: service-not-available 前置守卫（此前 7 处同形 inline）。
   * 返回窄化后的 IExtensionService；service 缺席时已发送 handler_error 并返回 undefined，
   * 调用方 `if (!svc) return` 即可。类型守卫必须留在调用方——TS 不收窄 `this.ctx.X`
   * 的属性访问，但能收窄函数返回值。
   */
  private requireExt(ws: WsType, id?: string): IExtensionService | undefined {
    if (!this.ctx.extensionService) {
      this.ctx.sendError(ws, 'handler_error', 'Extension service not available', id)
      return undefined
    }
    return this.ctx.extensionService
  }

  /**
   * install/Dir/Git/finish/cancel 失败的统一错误回复（D10/P0-B）。
   * 此前 5 处各自 reply('extension.installError', extractExtensionError(e))；
   * 现统一走 error envelope，hint 进 details.hint。
   * Primary: instanceof check. Fallback: branded property check (handles cross-bundle scenarios).
   */
  private sendInstallError(ws: WsType, id: string | undefined, e: unknown): void {
    // matched 分支透传 e.hint；fallback 分支不带 details（保持既有行为）。
    sendHandlerError(this.ctx, ws, ExtensionInstallError, 'install_failed', e, id, (matched) => matched.hint ? { hint: matched.hint } : undefined)
  }
}
