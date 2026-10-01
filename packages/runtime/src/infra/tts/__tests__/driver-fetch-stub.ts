/**
 * TTS driver 测试共享夹具（三家 driver 单测的 fetch 桩 / 网络异常注入）。
 * 仅测试消费（infra/tts/*.test.ts）；生产代码禁止 import 本文件。
 */
import { vi } from 'vitest'

/** 被 stub 的 fetch 捕获的单次请求（URL / headers / 解析后的 JSON body；纯数据形状用 type 别名）。 */
export type CapturedRequest = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/**
 * fetch 桩：捕获请求并转交 handler 产出响应（driver 单测唯一注入点；
 * 用例收尾须自行 vi.unstubAllGlobals()）。
 */
export function stubFetch(handler: (init: RequestInit) => Response | Promise<Response>): { calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = []
  vi.stubGlobal(
    'fetch',
    async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: String(_url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return await handler(init ?? {})
    },
  )
  return { calls }
}

/** 网络异常注入：fetch 恒 throw（基座归类 tts_network_error 用例共用；异常形态按用例指定）。 */
export function stubFetchFailure(throwable: unknown): void {
  vi.stubGlobal('fetch', async () => {
    throw throwable
  })
}
