/**
 * btw 域 —— btw 旁路线 3 个控制帧门面（btw-question 设计 D6，M2-a 协议根节点）。
 *
 * 依赖方向：transport + pending（经 request command() 统一发送并关联 Promise）。
 *
 * D6 契约要点：
 * - 仅 3 帧：btw.create（建线 + fork 主会话当前进度）/ btw.list { mainSid }（主会话名下
 *   线枚举）/ btw.remove（关线销毁，单线级联）。**不设 btw.send / btw.close**——线内发消息
 *   复用 chat.send（sessionId = btw vid）、销毁复用 btw.remove。
 * - ack 必回：三帧在 ReplyPayloadMap 全登记（create/list payload 消费型、remove ack 型
 *   void）；失败走统一 error envelope（pending reject，code 透传）。
 * - mock 同构：mock 门面（transport/mock/index.ts 的 `btw`，G4 类型锚定）签名全等，
 *   VITE_MOCK 轨道经 renderer api/index 三元切换接入。
 * - reply 类型经 `ServerMessageMap` 索引访问取形（BtwForkState / BtwThreadInfo 具名类型
 *   定义在 shared protocol.ts，包出口 index.ts 为选择性 re-export 未挂具名——与
 *   SegmentsMetadataEntry 等消费方同款 indexed-access 惯例）。
 * - 运行时接线（handler 注册 + btw.list 状态广播）归 M2-b btw-message-handler；本文件
 *   只是协议 SSOT 的类型化出口。
 */
import type { ServerMessageMap } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/**
 * 创建一条 btw 线（runtime BtwService fork 主会话当前进度；懒 spawn，设计预算 <600ms，
 * backstop 超时充裕）。reply 消费型：vid（新线虚拟 id）+ mainSid 回显 + forkState
 * （D3 源状态三分支 → 创建期 pill 数据源，仅创建时一次性携带）。
 */
export function create(mainSid: string): Promise<ServerMessageMap['btw.create']> {
  return command('btw.create', { mainSid }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 枚举主会话名下的 btw 线（drawer btw 面板线列表数据源，D4 关联枚举读——不靠 vid 前缀
 * 解析）。解包 .threads（与 session.list 解包 .groups 同模式）。
 */
export async function list(mainSid: string): Promise<ServerMessageMap['btw.list']['threads']> {
  const reply = await command('btw.list', { mainSid }, RPC_BACKSTOP_TIMEOUT_MS)
  return reply.threads
}

/**
 * 关线销毁（单线级联：线进程 + 派生资源；主会话删除的级联走 session.delete，不走本帧）。
 * ack 型（ReplyPayloadMap = void）：完成即 resolve，wire reply 回显 vid；失败 reject。
 */
export function remove(vid: string): Promise<void> {
  return command('btw.remove', { vid }, RPC_BACKSTOP_TIMEOUT_MS)
}
