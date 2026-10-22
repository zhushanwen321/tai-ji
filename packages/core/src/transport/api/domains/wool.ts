/**
 * Wool 域 —— 羊毛 provider 宿主编排 RPC 封装（wool-provider 设计 D6 renderer 侧）。
 *
 * 形态分类：
 * - 请求-响应：getState（拉运行态快照；reply = wool.state，与状态广播同名同形）
 * - 动作-回执：action（install/detect/status/checkin/refresh/setAutoCheckin/authorize/
 *   extract/uninstall；词表见 shared WOOL_ACTION_TYPES；
 *   reply 两态信封 WoolActionReply——结构化错误是设计内领域回执，不 reject）
 * - 订阅-推送：onWoolState（wool.state 广播；payload 无 sessionId → global 通道自动路由）、
 *   onWoolAuthorizeUrl（wool.authorize_url 一次性广播；authorize 编排在途时授权页 URL，
 *   向导消费驱动浮层浏览器打开）
 *
 * 超时校准：action 单命令可能承载 npm 安装（extension.install 同链，65s 量级）、管理
 * 会话编排（runtime 侧回收上界 120s，crash-forensics 附录 E）或 authorize 授权窗
 * （runtime 侧上界 300s，用户浏览器完成授权），统一 330s（最大上界 + 余量）。
 */
import type { WoolActionReply, WoolActionRequest, WoolAuthorizeUrlPayload, WoolRuntimeSnapshot } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'
import * as events from '../events'

/** wool.action 单命令超时（见文件头校准说明；getState 是纯内存读走 backstop）。 */
const WOOL_ACTION_RPC_TIMEOUT_MS = 330_000

/** 拉羊毛域全量运行态快照（family 安装/接入/账号/目录缓存视图）。 */
export async function getState(): Promise<WoolRuntimeSnapshot> {
  const reply = await command('wool.getState', {}, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.snapshot
}

/**
 * 触发宿主编排动作。reply 两态信封原样返回（ok=false 是设计内领域回执——renderer 按
 * error.code 分流恢复指引，不作为 transport 异常处理）。
 */
export function action(req: WoolActionRequest): Promise<WoolActionReply> {
  return command('wool.action', req, WOOL_ACTION_RPC_TIMEOUT_MS)
}

/** 订阅 wool.state 状态变化广播（含 getState reply 同名帧），返回取消函数。 */
export function onWoolState(handler: (snapshot: WoolRuntimeSnapshot) => void): () => void {
  return events.onGlobalType('wool.state', (msg) => {
    handler(msg.payload.snapshot)
  })
}

/**
 * 订阅 wool.authorize_url 授权页 URL 广播（authorize 编排在途时 runtime 拦截扩展 notify
 * 后下发；无 sessionId → global 通道）。一次性事件不进快照——向导在 authorize running
 * 期间订阅、收到后驱动浮层浏览器打开授权页。
 */
export function onWoolAuthorizeUrl(handler: (payload: WoolAuthorizeUrlPayload) => void): () => void {
  return events.onGlobalType('wool.authorize_url', (msg) => {
    handler(msg.payload)
  })
}
