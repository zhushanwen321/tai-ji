/**
 * Providers API 模块（provider-plugin-access D4 插件侧消费面）
 *
 * Worker 侧代理对象：providers.write / providers.delete / providers.credential 三 RPC
 * 转发到主线程。宿主 handler 注册在 services/provider-write-proxy.ts（身份收窄、命名
 * 空间前缀校验、network.http 能力前提、写策略链与唯一读通道全在宿主侧）——本代理零
 * 校验直传，线协议契约类型单源 = taiji-plugin-sdk（插件作者可见面）。
 */

import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { ProviderCredentialReply, ProviderWriteParams } from '../plugin-types.js'

/**
 * 创建 Worker 侧 Providers API 代理对象（pluginId 随载荷传递：sandbox 通道宿主以通道
 * 身份为准（自报值不采信），trusted 共享 Worker 无唯一身份时宿主 fail-closed 拒绝——
 * 传与不传均被宿主身份判定覆盖，保持与其他 Worker 侧 API 同款「自报 pluginId」先例）。
 */
export function createProvidersApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  write(params: ProviderWriteParams): Promise<{ written: true; providerId: string }>
  delete(providerId: string): Promise<{ deleted: boolean; providerId: string }>
  credential(providerId: string | { providerId: string }): Promise<ProviderCredentialReply>
} {
  return {
    write: (params: ProviderWriteParams) =>
      rpcClient
        .request('providers.write', { pluginId, ...params })
        .then(v => v as { written: true; providerId: string }),

    delete: (providerId: string) =>
      rpcClient
        .request('providers.delete', { pluginId, providerId })
        .then(v => v as { deleted: boolean; providerId: string }),

    credential: (providerId: string | { providerId: string }) => {
      // ⑦ 调用形态归一：SDK 声明形是裸字符串，wool 系插件按其自持契约以 { providerId }
      // 对象调用（真机 d3-r10 实测：对象直传使 wire 载荷 providerId 变成对象，宿主
      // 非空字符串校验拒以 INVALID_PAYLOAD，插件 catch 后呈现「未接入」且零留痕——
      // 提取成功但回读链全断）。两种形态在此归一为 wire 契约形（params.providerId =
      // 非空字符串）；畸形载荷（对象缺 providerId）不在此拦，由宿主既有校验拒绝。
      const id = typeof providerId === 'string' ? providerId : providerId.providerId
      return rpcClient
        .request('providers.credential', { pluginId, providerId: id })
        .then(v => v as ProviderCredentialReply)
    },
  }
}
