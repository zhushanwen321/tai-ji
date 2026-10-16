/**
 * Canvas 域装配（problem-solve-canvas U3）：CanvasService（U2 领域权威）与
 * CanvasMessageHandler 的构造封装——从 transport/server.ts 拆出（server.ts 行数红线，
 * 装配体与 SessionManagerHandler 同款形态自包含于本文件）。
 */
import type { ServerMessage } from '@taiji/shared'
import { CanvasService } from '../services/canvas/canvas-service.js'
import type { ISessionService } from '../interfaces.js'
import type { MessageHandlerContext } from './message-context.js'
import { CanvasMessageHandler } from './canvas-message-handler.js'

export interface CanvasAssemblyDeps { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  messaging: MessageHandlerContext
  sessionService: ISessionService
  /** canvas.updated 全局广播通道（broker.broadcast——无 sid 全局帧）。 */
  broadcast: (msg: ServerMessage) => void
  nextPushId: () => string
}

export interface CanvasAssembly { // oe-exempt:20261015:framework:画布域类型契约（数据形状/端口/测试 harness，非抽象接口单实现）
  canvasService: CanvasService
  canvasHandler: CanvasMessageHandler
}

/**
 * 构造 CanvasService（构造期扫描 <dataDir>/canvases 重建）与 CanvasMessageHandler，
 * 并接广播线（service.onUpdated → handler.broadcastUpdated，闭包晚绑定：handler 构造
 * 后即就绪，广播只发生在 mutate 成功路径）。
 */
export function assembleCanvas(deps: CanvasAssemblyDeps): CanvasAssembly {
  // 晚绑定 holder：service 构造先于 handler，广播回调经 holder 转发（handler 构造后即就绪）。
  const handlerRef: { current?: CanvasMessageHandler } = {}
  const canvasService = new CanvasService({ onUpdated: (u) => handlerRef.current?.broadcastUpdated(u) })
  const canvasHandler = new CanvasMessageHandler({
    ...deps.messaging,
    sessionService: deps.sessionService,
    canvasService,
    // marker 应答写回：requestId 只在发起方 pi 进程的 pending 表有效——按 sessionId 直发，
    // 不能遍历找「第一个可用 client」（session-manager 装配同款约束）。
    sendExtensionUiResponse: (sessionId, requestId, response, method) =>
      deps.sessionService.getRpcClient(sessionId)?.sendExtensionUiResponse(requestId, response, method) ?? false,
    broadcast: deps.broadcast,
    nextPushId: deps.nextPushId,
  })
  handlerRef.current = canvasHandler
  return { canvasService, canvasHandler }
}
