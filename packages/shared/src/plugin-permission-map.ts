/**
 * 插件权限词汇 ↔ RPC 方法名映射 SSOT
 *
 * 权限字符串在生态里有三种形态，历史上互不相通（check 收完整方法名、granted 存
 * 声明形 → has() 永不命中，守规矩的 sandbox 插件全部 RPC 恒被拒）：
 *  1. SDK `PermissionConstants` 能力词汇（`storage.access` / `sessions.readState` /
 *     `notify` 等）——能力不是方法名，机械加前缀会得到不存在的方法
 *  2. manifest 声明形（去前缀形如 `hooks.register`，或直接写完整方法名
 *     `plugin.hooks.register`）
 *  3. legacy 形态（demo 插件的 `workspace:file:search`）
 *
 * 本模块把三口径统一归一化为**完整 RPC 方法名数组**（granted 集合统一存完整方法名，
 * check 直接 has(method)）。方法名全集与 plugin-rpc-setup.ts / plugin-service/api/
 * 各 register*RpcHandlers 的 rpcServer.registerMethod 调用一一对应；
 * `plugin-permission-map.test.ts`（AC-I6）以真实注册表做集合相等校验防漂移——
 * 新增 RPC 方法或 SDK 权限常量时必须同步更新本文件，否则测试红。
 */

/**
 * 主线程 PluginRpcServer 实际注册的全部 RPC 方法名（来源：逐文件收集
 * plugin-rpc-setup.ts / api/*.ts / tool-api.ts / hook-api.ts 的 registerMethod 调用）。
 *
 * 未被任何能力映射覆盖的方法族（views / commands / config / sessionData /
 * ui 对话框 / workspace 只读 / agent 等）当前无 SDK 权限常量可声明——sandbox
 * 插件无法获得授权（fail-closed），trusted 插件不受影响。这不是遗漏：
 * 能力词汇表的扩展属 SDK 契约变更，须与 PermissionConstants 同步评审。
 */
export const PLUGIN_RPC_METHODS = [
  // agent 域（api/agent-api.ts，5 个）
  'plugin.agent.getModel',
  'plugin.agent.setModel',
  'plugin.agent.getThinkingLevel',
  'plugin.agent.setThinkingLevel',
  'plugin.agent.getActiveTools',
  // commands 域（api/commands-api.ts，3 个）
  'plugin.commands.register',
  'plugin.commands.unregister',
  'plugin.commands.invoke.result',
  // config 域（api/config-api.ts，3 个）
  'plugin.config.get',
  'plugin.config.getAll',
  'plugin.config.set',
  // hooks 域（hook-api.ts，2 个）
  'plugin.hooks.register',
  'plugin.hooks.unregister',
  // notify 域（api/notify-api.ts，1 个）
  'plugin.notify',
  // sessionData 域（api/session-data-api.ts，4 个）
  'plugin.sessionData.get',
  'plugin.sessionData.set',
  'plugin.sessionData.delete',
  'plugin.sessionData.keys',
  // sessions 域（api/session-api.ts，8 个——含 S3-W2 生命周期事件注册 4 个）
  'plugin.sessions.list',
  'plugin.sessions.get',
  'plugin.sessions.getActive',
  'plugin.sessions.sendMessage',
  'plugin.sessions.registerCreate',
  'plugin.sessions.registerDestroy',
  'plugin.sessions.unregisterCreate',
  'plugin.sessions.unregisterDestroy',
  // storage 域（api/storage-api.ts，global + workspace 两 scope × 4 操作 = 8 个）
  'plugin.storage.global.get',
  'plugin.storage.global.set',
  'plugin.storage.global.delete',
  'plugin.storage.global.keys',
  'plugin.storage.workspace.get',
  'plugin.storage.workspace.set',
  'plugin.storage.workspace.delete',
  'plugin.storage.workspace.keys',
  // tools 域（tool-api.ts，2 个）
  'plugin.tools.register',
  'plugin.tools.unregister',
  // ui 域（api/ui-api.ts，6 个——uiRequestExpired 是 Worker→host 到期取消 notification
  // （D2），复用无 id dispatch 通路故也在注册表内；未被任何能力映射覆盖 → sandbox
  // 不可授权（fail-closed），到期取消由 queue 防泄漏兜底收尾，trusted 不受影响）
  'plugin.ui.showSelect',
  'plugin.ui.showConfirm',
  'plugin.ui.showInput',
  'plugin.ui.notify',
  'plugin.ui.updateStatusBarItem',
  'plugin.ui.uiRequestExpired',
  // views 域（api/views-api.ts，2 个）
  'plugin.views.update',
  'plugin.views.listMountPoints',
  // workspace 域（api/workspace-api.ts，3 个）
  'plugin.workspace.rootPath',
  'plugin.workspace.name',
  'plugin.workspace.findFiles',
] as const

/** 完整 RPC 方法名类型 */
export type PluginRpcMethodName = (typeof PLUGIN_RPC_METHODS)[number]

const RPC_METHOD_SET: ReadonlySet<string> = new Set<string>(PLUGIN_RPC_METHODS)

/** 全部 8 个 storage 方法（storage.access 能力映射用） */
const ALL_STORAGE_METHODS: readonly PluginRpcMethodName[] = [
  'plugin.storage.global.get',
  'plugin.storage.global.set',
  'plugin.storage.global.delete',
  'plugin.storage.global.keys',
  'plugin.storage.workspace.get',
  'plugin.storage.workspace.set',
  'plugin.storage.workspace.delete',
  'plugin.storage.workspace.keys',
]

/**
 * 能力词汇 / legacy 形态 → 方法名集合的**显式**映射表。
 *
 * 注册类能力（tools/hooks.register）连带 unregister：unregister 只能移除注册表
 * 条目，单独授予无意义；成对授予避免「能注册不能注销」的半授权态。
 */
const CAPABILITY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  // ── SDK PermissionConstants 能力词汇（plugin-sdk/src/types.ts）─────────
  'tools.register': ['plugin.tools.register', 'plugin.tools.unregister'],
  'hooks.register': ['plugin.hooks.register', 'plugin.hooks.unregister'],
  'sessions.sendMessage': ['plugin.sessions.sendMessage'],
  // sessions.readState 含生命周期事件订阅（S3-W2）：onDidCreateSession/
  // onDidDestroySession 的注册/注销方法并入读侧能力（通知型，无写语义；
  // 注册类连带 unregister 的既有成对授予模式）。不新增 SDK 常量（能力词汇表
  // 扩展属 SDK 契约变更，须与 PermissionConstants 同步评审）。
  'sessions.readState': [
    'plugin.sessions.list',
    'plugin.sessions.get',
    'plugin.sessions.getActive',
    'plugin.sessions.registerCreate',
    'plugin.sessions.registerDestroy',
    'plugin.sessions.unregisterCreate',
    'plugin.sessions.unregisterDestroy',
  ],
  'storage.access': ALL_STORAGE_METHODS,
  'notify': ['plugin.notify', 'plugin.ui.notify'],
  // ── manifest 常用操作粒度短形（如设计验收 A4 的 permissions: ["storage.set"]）──
  'storage.get': ['plugin.storage.global.get', 'plugin.storage.workspace.get'],
  'storage.set': ['plugin.storage.global.set', 'plugin.storage.workspace.set'],
  'storage.delete': ['plugin.storage.global.delete', 'plugin.storage.workspace.delete'],
  'storage.keys': ['plugin.storage.global.keys', 'plugin.storage.workspace.keys'],
  // ── legacy 形态（demo 插件 manifest/package.json 声明的 workspace:file:search）──
  'workspace:file:search': ['plugin.workspace.findFiles'],
}

/**
 * 把任意口径的权限字符串归一化为完整 RPC 方法名数组。
 *
 * 解析顺序：
 *  1. 能力映射表精确命中（SDK 常量值 / storage 短形 / legacy 形态）→ 映射集
 *  2. 本身就是完整方法名（`plugin.hooks.register`）→ 原样返回（幂等：granted
 *     集合已是完整方法名时二次归一不变形）
 *  3. 去前缀形（`hooks.register` / `sessions.list` / `storage.global.set`）→
 *     补 `plugin.` 前缀后命中方法名全集 → 返回
 *  4. 未命中 → 空数组（调用方按未授权处理：grant 存不进任何方法，check 恒 false；
 *     getUnapproved 将其排除——未知词无从审批，不应阻断激活，执法点在 RPC 层）
 *
 * @param permission 任意口径的权限字符串
 * @returns 完整 RPC 方法名数组；未知/空白输入返回空数组
 */
export function normalizePermissionInput(permission: string): readonly string[] {
  if (typeof permission !== 'string') return []
  const trimmed = permission.trim()
  if (!trimmed) return []

  const alias = CAPABILITY_ALIASES[trimmed]
  if (alias) return alias

  // 已是完整方法名（幂等透传）
  if (RPC_METHOD_SET.has(trimmed)) return [trimmed]

  // 去前缀形：补 plugin. 前缀后命中（如 'hooks.register' 之外的 'sessions.list'、
  // 'storage.global.set'、'config.get' 等——alias 表优先，未覆盖的短形走此规则）
  const withPrefix = `plugin.${trimmed}`
  if (RPC_METHOD_SET.has(withPrefix)) return [withPrefix]

  return []
}
