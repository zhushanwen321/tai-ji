/**
 * PluginDescriptor → PluginInfo 协议映射（从 plugin-service.ts 迁出，max-lines
 * 拆分——纯函数无 this 依赖，逻辑不变）。
 */
import type { PluginInfo } from '@taiji/shared'
import type { PluginDescriptor } from './plugin-types.js'

/** 将内部 PluginState（UPPER_CASE）映射为协议层展示状态（lower_case，模块内 toPluginInfo 消费） */
function mapStateForProtocol(state: string): PluginInfo['status'] {
  switch (state) {
    case 'ACTIVE': return 'active'
    case 'CRASHED': return 'crashed'
    case 'LOADING':
    case 'UNLOADED':
      return 'discovered'
    default:
      return 'inactive'
  }
}

/**
 * PluginDescriptor（runtime 内部，PluginInfo 超集）→ PluginInfo（WS 协议契约）。
 *
 * 字段挑选 + status 经 mapStateForProtocol 转 lower_case + enabled 推导。
 * 这是 config.plugins 协议债的正式收口点：之前 transport 层用 `as unknown as PluginInfo[]`
 * 强转（仅类型缝合、不改运行时序列化），现在下沉到 service 层做真实的字段裁剪。
 *
 * enabled 语义：runtime 无独立「启用」持久化（togglePlugin 直接驱动激活/停用），
 * 故以激活态推导——ACTIVE 视为 enabled，其余 disabled。
 */
function toPluginInfo(descriptor: PluginDescriptor): PluginInfo {
  const status = mapStateForProtocol(descriptor.status)
  return {
    pluginId: descriptor.pluginId,
    version: descriptor.version,
    displayName: descriptor.displayName,
    description: descriptor.description,
    status,
    trustLevel: descriptor.trustLevel,
    enabled: status === 'active',
  }
}

export function toPluginInfos(descriptors: PluginDescriptor[]): PluginInfo[] {
  return descriptors.map(d => toPluginInfo(d))
}
