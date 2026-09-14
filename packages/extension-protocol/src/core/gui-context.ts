/**
 * helpers 需要的 ctx 最小接口。
 * pi 的 ExtensionContext 天然满足此结构（有 mode/hasUI/ui 字段）。
 * 用结构化类型而非 import pi SDK，保持协议包零依赖。
 */
export interface GuiContext {
  mode: 'tui' | 'rpc' | 'json' | 'print'
  hasUI: boolean
  ui?: {
    setWidget?: (key: string, lines: string[] | undefined) => void
    select?: (header: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>
    input?: (header: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>
    confirm?: (header: string, prompt: string, opts?: { signal?: AbortSignal }) => Promise<boolean | undefined>
    custom?: (factory: unknown, opts?: unknown) => Promise<Record<string, string | string[]> | undefined>
  }
}
