/**
 * 本地 OAuth 回调服务器（OAuth 路径 B 自实现）。
 *
 * 参考 pi-ai dist/auth/oauth/anthropic.js:83-133 startCallbackServer 语义，差异：
 * - path 可配置（anthropic 固定 /callback；openrouter 动态 /oauth/callback/<uuid>）
 * - state 校验可选（expectedState 不传则跳过校验）
 * - 超时 + abort 主动 close，waitForCallback reject { code: 'timeout' | 'aborted' }
 * - 单次消费：首个到达的请求（无论成败）消费掉本次回调，后续请求 409
 *
 * 设计取舍：query 中的授权码属于敏感信息，本模块不落日志、不打印请求 URL。
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface CallbackServerOptions {
  /** 监听地址，默认 127.0.0.1（本地回调，不暴露到局域网） */
  host?: string
  /** 固定端口（anthropic 53692）或 0（动态分配，单测用） */
  port: number
  /** 回调路径（anthropic '/callback'；openrouter '/oauth/callback/<uuid>'） */
  path: string
  /** state 校验：不匹配返回 400 + reject state_mismatch */
  expectedState?: string
  /** 等待回调超时，默认 5min，到期 close + reject { code: 'timeout' } */
  timeoutMs?: number
  /** abort 时 close + reject { code: 'aborted' } */
  signal?: AbortSignal
}

export interface CallbackServerResult {
  code: string
  state?: string
}

/** 带错误码的 reject 载体：code 供调用方区分 timeout/aborted/provider_error 等分支 */
export interface CallbackServerError extends Error {
  code: string
}

export interface CallbackServerHandle {
  /** 完整回调 URL（含 path），调用方直接拼 query 即可 */
  url: string
  port: number
  /** 等待回调结果（单次消费）；失败 reject CallbackServerError */
  waitForCallback(): Promise<CallbackServerResult>
  /** 关闭服务器并释放 timer/signal 监听；幂等 */
  close(): void
}

function makeError(code: string, message: string): CallbackServerError {
  const err = new Error(message) as CallbackServerError
  err.code = code
  return err
}

/**
 * listen 失败错误转译为可操作文案（原始 ErrnoException 技术信息直接进 auth.error
 * 广播，用户无法据此恢复）。EADDRINUSE = 端口被占（双实例是文档承认的常态）。
 */
function describeListenError(port: number, err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE') {
    return `端口 ${port} 被占用，请关闭另一个 TaiJi 实例后重试`
  }
  const message = err instanceof Error ? err.message : String(err)
  return `无法启动本地回调服务: ${message}`
}

const SUCCESS_HTML =
  '<!doctype html><html><body><h1>Login successful</h1><p>You can close this window and return to the app.</p></body></html>'
const ERROR_HTML =
  '<!doctype html><html><body><h1>Login failed</h1><p>Authentication did not complete. Return to the app for details.</p></body></html>'

// HTTP 状态码常量：writeHead 裸数字触发 no-magic-numbers，常量兼作语义注释
const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_NOT_FOUND = 404
const HTTP_CONFLICT = 409
const HTTP_INTERNAL_ERROR = 500

export async function startCallbackServer(opts: CallbackServerOptions): Promise<CallbackServerHandle> {
  const host = opts.host ?? '127.0.0.1'
  // eslint-disable-next-line no-magic-numbers -- 默认 5min 回调超时
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1_000

  let settled = false
  let claimed = false
  let serverClosed = false
  let timer: NodeJS.Timeout | undefined

  let resolveWait!: (result: CallbackServerResult) => void
  let rejectWait!: (err: CallbackServerError) => void
  const waitPromise = new Promise<CallbackServerResult>((resolve, reject) => {
    resolveWait = resolve
    rejectWait = reject
  })
  // 挂 noop handler 防 unhandled rejection：waitPromise 可能在消费者 await 之前
  // 就被 reject（fetch 响应先于测试断言到达），真实消费者不受影响
  void waitPromise.catch(() => {})

  const onAbort = (): void => {
    fail(makeError('aborted', 'Login cancelled'), true)
  }

  // 结束状态机的唯一出口：先清理资源（timer/signal/server），再 settle，
  // 保证任何路径都不会留下悬挂的 timer 或监听器。
  // closeServer=false（回调已到达）：保持监听以响应后续 409 claimed；
  // closeServer=true（超时/abort/主动 close）：调用方不再需要 server
  const teardown = (closeServer: boolean): void => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    opts.signal?.removeEventListener('abort', onAbort)
    if (closeServer && !serverClosed) {
      serverClosed = true
      // 未 listen 的 server close() 会抛 ERR_SERVER_NOT_RUNNING（aborted signal 分支）
      if (server.listening) server.close()
    }
  }

  const succeed = (result: CallbackServerResult): void => {
    if (settled) return
    settled = true
    teardown(false)
    resolveWait(result)
  }

  const fail = (err: CallbackServerError, closeServer: boolean): void => {
    if (settled) return
    settled = true
    teardown(closeServer)
    rejectWait(err)
  }

  const server = createServer((req, res) => {
    // 已消费：本次回调状态机已结束，任何新请求都是异常流量
    if (claimed) {
      res.writeHead(HTTP_CONFLICT, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Callback already claimed')
      return
    }
    try {
      const url = new URL(req.url ?? '/', `http://${host}`)
      // 路径不匹配不消费回调：可能是探活/误请求，waitForCallback 继续等待
      if (url.pathname !== opts.path) {
        res.writeHead(HTTP_NOT_FOUND, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ERROR_HTML)
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      if (error) {
        claimed = true
        res.writeHead(HTTP_BAD_REQUEST, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ERROR_HTML)
        fail(makeError('provider_error', `Provider error: ${error}`), false)
        return
      }
      if (!code) {
        claimed = true
        res.writeHead(HTTP_BAD_REQUEST, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ERROR_HTML)
        fail(makeError('missing_params', 'Missing code parameter'), false)
        return
      }
      // state 校验与 expectedState 绑定：传了 expectedState 才要求 state 存在且匹配
      // （openrouter 回调只有 code，无 state——authorize 端不生成 state）
      if (opts.expectedState !== undefined && state !== opts.expectedState) {
        claimed = true
        res.writeHead(HTTP_BAD_REQUEST, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(ERROR_HTML)
        fail(makeError('state_mismatch', 'OAuth state mismatch'), false)
        return
      }
      claimed = true
      res.writeHead(HTTP_OK, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(SUCCESS_HTML)
      succeed({ code, state: state ?? undefined })
    } catch {
      res.writeHead(HTTP_INTERNAL_ERROR, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Internal error')
    }
  })

  if (opts.signal) {
    if (opts.signal.aborted) {
      // 调用方已取消：立即拒绝（server 已创建，teardown 引用安全）；
      // startCallbackServer 仍 resolve（handle 可正常拿到），waitForCallback 直接拿到 aborted
      fail(makeError('aborted', 'Login cancelled'), true)
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  // 超时兜底：用户可能永远不完成浏览器授权，不能无限挂起
  if (timeoutMs > 0 && !settled) {
    timer = setTimeout(() => {
      fail(makeError('timeout', 'Timed out waiting for OAuth callback'), true)
    }, timeoutMs)
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.on('error', (err) => {
      server.off('error', rejectListen)
      // listen 失败（EADDRINUSE 等）：teardown 清 5min 超时 timer + abort 监听再 reject
      // ——否则 timer 保持进程事件循环存活至到期，abort 监听残留。
      // 注意：此时 server 未 listening，teardown 的 close() 分支安全跳过。
      teardown(true)
      rejectListen(makeError('listen_failed', describeListenError(opts.port, err)))
    })
    server.listen(opts.port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const addr = server.address() as AddressInfo
  return {
    url: `http://${host}:${addr.port}${opts.path}`,
    port: addr.port,
    waitForCallback: () => waitPromise,
    // 已 settle（成功/失败已消费）时仍需关 server——succeed/fail 保持监听以响应 409
    close: () => {
      if (!settled) {
        fail(makeError('closed', 'Callback server closed'), true)
      } else {
        teardown(true)
      }
    },
  }
}
