/**
 * 插件业务能力词 → 内置模块放行集映射 SSOT（provider-plugin-access D3）
 *
 * D3 裁决：插件按 manifest 声明直接获得业务能力，运行时不做用户审批——授权时机在
 * 安装。本模块是「能力词 → sandbox 放行的内置模块集」的唯一登记处，与
 * plugin-permission-map.ts 分家：后者语义为「权限词 → RPC 方法名数组」（RPC 授权），
 * 本模块语义为「能力词 → Node 内置模块」（fork 放行），两者词表、消费链、执法点均不同。
 *
 * 模块名形态 = 无 `node:` 前缀裸名，与 plugin-blocked-builtins.cjs 黑名单基线同形态
 * （loader 侧归一化 `node:` 前缀后比对）。本表只登记「放行哪些模块」；两个独立执行
 * 机制不在本表语义内：
 *   - fs.read-user-data 的只读性 = ESM loader 的只读导出子集代理（读与元数据 API
 *     放行，写改 API 拒绝）——本表只记模块名，导出子集名单在 loader 侧；
 *   - 路径边界 = fork 侧路径检查（readPaths，manifest 独立字段）；
 *   - 永久封禁（vm / worker_threads / module / cluster / dgram / readline / v8）=
 *     黑名单基线（plugin-blocked-builtins.cjs），放行计算不得把基线内模块放进任何
 *     能力词的放行集（防退化断言由 sandbox 逃逸测试族承担，本表不复制封禁清单——
 *     单一事实源，复制即漂移）。
 *
 * 能力词常量（PluginCapabilityConstants）定义在此、经 plugin-sdk types.ts 值 re-export
 * 供插件作者消费——manifest 声明与放行计算共用同一词表，单一事实源。
 */

/** 业务能力词常量（manifest taijiPlugin.capabilities 的词表，SDK 契约面） */
export const PluginCapabilityConstants = Object.freeze({
  /** 发起网络请求（调上游查额度 / 拉模型目录） */
  NETWORK_HTTP: 'network.http',
  /** 读取用户数据文件（读 IDE 配置目录；只读导出子集 + readPaths 路径受限） */
  FS_READ_USER_DATA: 'fs.read-user-data',
  /** 使用加密库（解密凭据） */
  CRYPTO: 'crypto',
  /** 启动子进程（调 `security` 读钥匙串） */
  PROCESS_SPAWN: 'process.spawn',
} as const)

export type PluginCapability =
  (typeof PluginCapabilityConstants)[keyof typeof PluginCapabilityConstants]

/**
 * 能力词 → 放行内置模块集（D3 表逐项）：
 *
 * | 能力词             | 放行模块                              |
 * |--------------------|---------------------------------------|
 * | network.http       | http / https / net / dns / tls        |
 * | fs.read-user-data  | fs / fs/promises（只读子集 + 路径受限）|
 * | crypto             | crypto                                |
 * | process.spawn      | child_process                         |
 */
const CAPABILITY_MODULES: Readonly<Record<PluginCapability, readonly string[]>> = {
  [PluginCapabilityConstants.NETWORK_HTTP]: ['http', 'https', 'net', 'dns', 'tls'],
  [PluginCapabilityConstants.FS_READ_USER_DATA]: ['fs', 'fs/promises'],
  [PluginCapabilityConstants.CRYPTO]: ['crypto'],
  [PluginCapabilityConstants.PROCESS_SPAWN]: ['child_process'],
}

/** 全部已登记能力词（映射完整性断言的遍历基准） */
export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = Object.values(
  PluginCapabilityConstants,
)

/** 单个能力词的放行模块集；未知词返回 undefined（调用方按未授权处置） */
export function getCapabilityModules(capability: string): readonly string[] | undefined {
  return (CAPABILITY_MODULES as Readonly<Record<string, readonly string[] | undefined>>)[capability]
}

export interface ResolvedCapabilityModules { // oe-exempt:20261024:framework:capability-map 返回契约类型，resolveAllowedModules 单实现为映射表常态（单数据源）
  /** 放行模块集（多能力词并集，去重保序——首次出现顺序） */
  allowed: readonly string[]
  /** 未登记能力词（宿主安装期校验 / 告警的判定输入；不参与放行） */
  unknown: readonly string[]
}

/**
 * 按 manifest 声明计算放行模块集（fork env 注入放行清单的数据源，D3）。
 *
 * 未知词不抛错、单独返回——安装期是否因未知词拒绝安装是安装器编排的裁决
 * （词表演进兼容性），放行计算只忠实登记「认识的放行、不认识的挑出来」。
 */
export function resolveAllowedModules(capabilities: readonly string[]): ResolvedCapabilityModules {
  const allowed: string[] = []
  const seen = new Set<string>()
  const unknown: string[] = []
  for (const capability of capabilities) {
    const modules = getCapabilityModules(capability)
    if (modules === undefined) {
      if (!unknown.includes(capability)) unknown.push(capability)
      continue
    }
    for (const moduleName of modules) {
      if (!seen.has(moduleName)) {
        seen.add(moduleName)
        allowed.push(moduleName)
      }
    }
  }
  return { allowed, unknown }
}
