/**
 * 健康检查器（TCP 端口探测 + HTTP /health 探活）。
 *
 * 对应 spec §4.2 M2 子职责「健康检查」。W5 后拆为两种探测语义：
 *
 * [HISTORICAL] 不变量：
 * - isPortInUse：纯 TCP（net.createConnection），仅检测「端口有人占」。
 *   保留给 port-discoverer 在选端口时探测是否被占用（语义不变）。
 * - checkHealthEndpoint：HTTP /health（fetch），验证「runtime 已完成启动、
 *   HTTP 服务就绪」。2xx 视为健康，非 2xx 或 fetch reject 视为未就绪。
 *   W5 修复：旧 waitForHealth 走 TCP，会在 listen 之后但业务 handler 注册
 *   完成之前就返回 true，导致前端过早连接丢消息。
 *
 * 两种探测不能互相替代：
 * - TCP 探测快但不准确（listen != ready）
 * - HTTP 探测准确但要求 runtime 已起 HTTP 服务
 *   port-discoverer 选端口时 runtime 还没起，只能用 TCP；
 *   supervisor 等运行时 ready 时必须用 HTTP。
 *
 * 依赖方向：health-checker → node:net + 全局 fetch（Electron/Node 18+ 内置）
 */
import { createConnection } from 'node:net'

/** 健康检查重试次数（默认） */
export const HEALTH_RETRY_COUNT = 30

/** 健康检查重试间隔（默认） */
export const HEALTH_INTERVAL_MS = 200

/** TCP 连接超时 */
export const CONNECT_TIMEOUT_MS = 500

/** 健康检查端点 URL 模板（仅本地回环，绝不连外网） */
const HEALTH_ENDPOINT = (port: number) => `http://127.0.0.1:${port}/health`

/**
 * 检测端口是否被监听（TCP socket 连接尝试）。
 *
 * 仅用于 port-discoverer 探测候选端口是否已被占用（不验证业务就绪）。
 *
 * @param port 目标端口
 * @param timeoutMs 连接超时，默认 CONNECT_TIMEOUT_MS
 * @returns true=端口在监听 / false=空闲或连接失败
 */
export function isPortInUse(port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/**
 * 调 HTTP /health 端点验证 runtime 业务就绪状态。
 *
 * [HISTORICAL] W5：相比纯 TCP 探测，能区分「端口已 listen」与「HTTP 服务就绪」。
 * - 2xx → true（健康）
 * - 非 2xx → false（服务起来了但未就绪，如 503）
 * - fetch reject（ECONNREFUSED / 超时）→ false（端口卡死或 runtime 还没 listen）
 *
 * 不向调用方抛错（waitForHealth 据此累计重试，而非崩溃）。
 *
 * @param port runtime 监听端口
 * @returns true=HTTP 服务就绪 / false=未就绪或连不上
 */
export async function checkHealthEndpoint(port: number): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_ENDPOINT(port))
    return response.ok
  } catch {
    // fetch reject：连接拒绝/超时/DNS 失败等，均视为「未就绪」而非异常
    return false
  }
}

/**
 * waitForHealth 的可选参数（W5：支持测试缩短轮询间隔，避免用例过慢）。
 */
export interface WaitForHealthOptions {
  /** 轮询间隔 ms，默认 HEALTH_INTERVAL_MS */
  intervalMs?: number
  /** 最大重试次数，默认 HEALTH_RETRY_COUNT */
  retryCount?: number
}

/**
 * 轮询健康检查：直到 HTTP /health 返回 2xx 或重试耗尽。
 *
 * [HISTORICAL] W5：从 isPortInUse 改为 checkHealthEndpoint，
 * 确保 runtime 已完成 HTTP 服务初始化（而非仅 listen 端口）。
 *
 * @param port 目标端口
 * @param opts 可选参数：intervalMs / retryCount
 * @throws 重试耗尽仍不就绪
 */
export async function waitForHealth(
  port: number,
  opts?: WaitForHealthOptions,
): Promise<void> {
  const intervalMs = opts?.intervalMs ?? HEALTH_INTERVAL_MS
  const retryCount = opts?.retryCount ?? HEALTH_RETRY_COUNT
  for (let i = 0; i < retryCount; i++) {
    if (await checkHealthEndpoint(port)) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Runtime health check timed out on port ${port}`)
}
