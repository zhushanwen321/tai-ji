// ── Plugin 领域 DTO（runtime ↔ renderer 之间流转的插件相关 payload）──
// 迁移自 protocol.ts 第 3 块。protocol.ts 仅保留 type→payload 映射（SSOT），
// 领域形状归此处便于读者一查到底。

export interface PluginInfo {
  pluginId: string
  version: string
  displayName: string
  description: string
  status: 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed'
  trustLevel: 'trusted' | 'sandbox'
  enabled: boolean
}

export interface StatusBarItem {
  id: string
  pluginId: string
  text: string
  tooltip?: string
  commandId?: string
  priority: number
  scope: 'per-session' | 'global'
  sessionId?: string
}
