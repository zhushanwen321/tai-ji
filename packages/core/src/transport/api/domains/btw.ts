/**
 * btw 域 —— btw 旁路线控制帧门面（btw-question 设计 D6，M2-a 协议根节点）。
 *
 * 依赖方向：transport + pending（经 request command() 统一发送并关联 Promise）。
 *
 * D6 契约要点：
 * - 控制帧：btw.create（建线 + fork 主会话当前进度）/ btw.remove（关线销毁，单线级联）。
 *   **不设 btw.send / btw.close**——线内发消息复用 chat.send（sessionId = 线 pi 真实会话 id）、
 *   销毁复用 btw.remove。
 * - 线枚举（btw.list）随 W4b 退役：btw 线进通用列表（session.list，设计 §3.3.1/§5-W4b），
 *   本域不再有 list 成员（mock 门面同批删除，G4 类型锚定两侧同构）。
 * - ack 必回：两帧在 ReplyPayloadMap 全登记（create payload 消费型、remove ack 型 void）；
 *   失败走统一 error envelope（pending reject，code 透传）。
 * - mock 同构：mock 门面（transport/mock/index.ts 的 `btw`，G4 类型锚定）签名全等，
 *   VITE_MOCK 层道经 renderer api/index 三元切换接入。
 * - reply 类型经 `ServerMessageMap` 索引访问取形（BtwForkState 具名类型定义在 shared
 *   protocol.ts，包出口 index.ts 为选择性 re-export 未挂具名——与 SegmentsMetadataEntry
 *   等消费方同款 indexed-access 惯例）。
 * - 运行时接线（handler 注册 + 线列表状态广播）归 btw-message-handler；本文件只是协议
 *   SSOT 的类型化出口。
 */
import type { ServerMessageMap } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/**
 * 创建一条 btw 线（runtime BtwService fork 主会话当前进度；懒 spawn，设计预算 <600ms，
 * backstop 超时充裕）。reply 消费型：sessionId（新线 pi 真实会话 id，W4a 键统一后唯一键）
 * + mainSid 回显 + forkState（D3 源状态三分支 → 创建期 pill 数据源，仅创建时一次性携带）。
 */
export function create(mainSid: string): Promise<ServerMessageMap['btw.create']> {
  return command('btw.create', { mainSid }, RPC_BACKSTOP_TIMEOUT_MS)
}

// 线枚举（btw.list）已随 W4b 退役（btw 进通用列表，设计 §3.3.1/§5-W4b）：线列表改走
// session.list { surface:'btw', mainSessionId }（session 域 listSessions，与 config.sessions
// 同形的通用查询）。本域不再暴露 list——mock 门面同批删除（G4 类型锚定两侧同构）。

/**
 * 关线销毁（单线级联：线进程 + 派生资源；主会话删除的级联走 session.delete，不走本帧）。
 * ack 型（ReplyPayloadMap = void）：完成即 resolve，wire reply 回显 sessionId；失败 reject。
 * W4a 键统一：入参 vid → sessionId（线 pi 真实会话 id；存在性校验 = runtime 注册表成员查询）。
 */
export function remove(sessionId: string): Promise<void> {
  return command('btw.remove', { sessionId }, RPC_BACKSTOP_TIMEOUT_MS)
}
