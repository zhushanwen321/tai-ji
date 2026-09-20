/**
 * CLI WS client：连 runtime WebSocket，发 config.* 消息，等 reply。
 * 无业务逻辑，纯 transport。
 *
 * Design：one-shot connection per RPC（发完即 close）。CLI 场景单命令单连接，
 * 避免长连接管理（心跳/重连/超时）。批量操作请用脚本多次调用。
 *
 * S1-W1 auth（spec §3.3 D4）：CLI 是终端进程，无 electron IPC 通道——token 走
 * 分发通道②（<dataDir>/runtime-token 文件，supervisor spawn 时 0600 写入）。
 * 连接 open 后首条消息发 {type:'auth'}，等 auth.result ok 后才发实际命令
 * （runtime 对 auth 前的其他消息静默丢弃）。
 */
import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import { discoverPort } from './port-discovery.js'

export interface RpcOptions {
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5000

/**
 * 读 <dataDir>/runtime-token（token 分发通道②）。
 * @throws token 文件不存在/为空——taiji 未启动或版本过旧，抛用户可读错误
 */
function readToken(): string {
  let raw: string
  try {
    raw = readFileSync(join(getDataDir(), 'runtime-token'), 'utf-8').trim()
  } catch {
    throw new Error(
      'taiji runtime token not found (<dataDir>/runtime-token). Start the app first, then retry.'
    )
  }
  if (raw.length === 0) {
    throw new Error('taiji runtime token file is empty — restart the app, then retry.')
  }
  return raw
}

/**
 * 发一条 WS 消息给 runtime，等 reply（按 id 匹配）。
 * @param type ClientMessage type（如 'config.getProviders'）
 * @param payload 消息负载
 * @param options 超时配置
 * @returns runtime 的 reply 消息
 */
export async function rpc<T = Record<string, unknown>>(
  type: string,
  payload: Record<string, unknown>,
  options?: RpcOptions
): Promise<T> {
  const port = discoverPort()
  const token = readToken()
  const id = randomUUID()
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    let settled = false
    /** auth 握手完成标志：ok 之前不发实际命令（runtime 对 pre-auth 消息静默丢弃） */
    let authed = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        ws.close()
        reject(new Error(`WebSocket RPC timeout (${timeoutMs}ms): ${type}`))
      }
    }, timeoutMs)

    ws.on('open', () => {
      // 首条消息必须是 auth（S1-W1）
      ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
    })

    ws.on('message', (data) => {
      if (settled) return
      try {
        const msg = JSON.parse(data.toString())
        if (!authed) {
          // 握手期：只消费 auth.result，其余（不应出现）忽略
          if (msg.type === 'auth.result') {
            if (msg.payload?.ok === true) {
              authed = true
              ws.send(JSON.stringify({ type, id, payload }))
            } else {
              settled = true
              clearTimeout(timer)
              ws.close()
              reject(new Error(`runtime auth failed (${msg.payload?.reason ?? 'unknown'}) — restart the app, then retry`))
            }
          }
          return
        }
        if (msg.id === id) {
          settled = true
          clearTimeout(timer)
          ws.close()
          // RT-8#1（F1 假成功）：broker sendError 的 error envelope 复用请求 id
          // （{ type:'error', id, payload:{ code, message, ... } }）。此前此处无条件
          // resolve payload → set/delete-provider 失败仍打印 configured/deleted 且 exit 0，
          // 读命令显示空列表。error 帧必须 reject（对齐 renderer 侧 pending.resolveEnvelope
          // 的 envelope 语义：code 透传到 Error），经 index.ts 统一落 stderr + exit 1。
          if (msg.type === 'error') {
            const errPayload = (msg.payload ?? {}) as {
              code?: string
              message?: string
              details?: { hint?: string }
            }
            const code = typeof errPayload.code === 'string' ? errPayload.code : 'unknown'
            const hint = errPayload.details?.hint
            const recovery = hint ?? 'fix the issue above and retry, or check taiji runtime logs'
            reject(Object.assign(
              new Error(`${errPayload.message ?? 'request failed'} (${code}) — ${recovery}`),
              { code },
            ))
            return
          }
          // 信封解包：线上帧是 { type, id, payload }，全部调用方按 payload 字段读取
          // （reply.providers / reply.models / reply.success …）。曾在此 resolve 整个信封，
          // 所有 CLI 读命令对真实 runtime 静默返回空（单测 mock rpc 未覆盖信封层故不可见，
          // 2026-09-10 验收场景 7 实测发现）。
          resolve((msg.payload ?? {}) as T)
        }
      // eslint-disable-next-line taste/no-silent-catch -- ignore non-JSON heartbeat/keepalive frames
      } catch {
        /* ignore non-JSON messages (heartbeat etc.) */
      }
    })

    ws.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        ws.close()
        reject(new Error(`Cannot connect to taiji runtime: ${err.message}`))
      }
    })

    ws.on('close', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('WebSocket closed unexpectedly'))
      }
    })
  })
}
