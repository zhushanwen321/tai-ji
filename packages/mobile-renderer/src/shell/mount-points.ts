// MountPointRegistrar —— 壳本地挂载点注册（§6.3 mobile B+D 子集）。
//
// §6.3 核心设计：挂载点不在 ExtensionHost 硬编码，由壳注册。mobile 只支持
// B（对话流：message-stream）+ D（命令：slash）+ companion（B 对话流伴随），
// 共三个挂载点，是桌面 16 挂载点的子集。
//
// pre-P4 形态：注册站点在壳（语义正确），存储用模块级 Map。P4 ExtensionHost
// 的 MountPointRegistry 落地后，壳的 registerMountPoint 调用改为对接 core
// ExtensionHost 的 mountPoints.register，存储收敛到 core（届时本文件顶部
// TODO(P4) 接缝被消费）。
//
// 设计依据：renderer-package-topology.md §6.3、slice plan IF1。

// MobileMountPointName —— mobile 壳注册的挂载点名（§6.3 B+D 子集 + companion）。
export type MobileMountPointName = 'message-stream' | 'slash' | 'companion'

// MOBILE_MOUNT_POINTS —— §6.3 mobile 子集常量声明（与桌面 16 挂载点的差异在此体现）。
export const MOBILE_MOUNT_POINTS: readonly MobileMountPointName[] = [
  'message-stream',
  'slash',
  'companion',
] as const

// MountPointHost —— 挂载点宿主占位类型。
// TODO(P4): 替换为 core ExtensionHost 的 MountPointHost 类型（P4 s2 ExtensionHost
// core 落地后）。pre-P4 用空接口占位，注册时传 {} 即可。
export type MountPointHost = unknown

// 模块级注册表（pre-P4 本地存储）。
const registry = new Map<MobileMountPointName, MountPointHost>()

// registerMountPoint —— 注册挂载点（幂等：同名重复注册覆盖旧 host，不抛错）。
// mobile bootstrap 重渲染时安全调用。P4 后改为对接 core ExtensionHost。
export function registerMountPoint(name: MobileMountPointName, host: MountPointHost): void {
  registry.set(name, host)
}

// getRegisteredMountPoints —— 返回当前已注册挂载点名集合的只读快照。
// 用于 AC5 结构断言（三挂载点均注册）+ 未来 plugin 查询当前平台可用挂载点。
export function getRegisteredMountPoints(): ReadonlySet<MobileMountPointName> {
  return new Set(registry.keys())
}

// __resetMountPointsForTesting —— 仅测试用：清空注册表（单测隔离，避免跨用例污染）。
export function __resetMountPointsForTesting(): void {
  registry.clear()
}
