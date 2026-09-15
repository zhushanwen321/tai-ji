/**
 * 插件依赖图算法（纯函数）
 *
 * 从 plugin-activator.ts 抽取的拓扑排序、循环检测与缺失依赖检查。
 * 这些函数不依赖任何实例状态——只接收描述符列表并返回结果，
 * 因此可独立单元测试（无需构造 PluginActivator / mock host）。
 */

import type { PluginDescriptor } from './plugin-types.js'

/**
 * 对插件列表进行拓扑排序（Kahn's algorithm）。
 *
 * 按 extensionDependencies 建立有向无环图，输出依赖顺序的插件列表。
 * 依赖在前，依赖者在后。
 *
 * @param descriptors - 待排序的插件列表
 * @returns 按拓扑顺序排列的插件列表
 */
export function topologicalSort(descriptors: PluginDescriptor[]): PluginDescriptor[] {
  const inDegree = new Map<string, number>()
  const adjList = new Map<string, string[]>()
  const descMap = new Map<string, PluginDescriptor>()

  for (const desc of descriptors) {
    const deps = desc.extensionDependencies ?? []
    inDegree.set(desc.pluginId, deps.length)
    // 不要覆盖 adjList：该 pluginId 可能已在依赖遍历时被添加
    if (!adjList.has(desc.pluginId)) {
      adjList.set(desc.pluginId, [])
    }
    descMap.set(desc.pluginId, desc)

    for (const dep of deps) {
      if (!adjList.has(dep)) adjList.set(dep, [])
      adjList.get(dep)!.push(desc.pluginId)
    }
  }

  const queue: string[] = []
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id)
  }

  const result: PluginDescriptor[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    result.push(descMap.get(id)!)

    for (const neighbor of adjList.get(id) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) queue.push(neighbor)
    }
  }

  return result
}

/**
 * 检测插件依赖图中的循环依赖。
 *
 * 利用 Kahn's algorithm 的特性：拓扑排序结果长度小于输入列表时，
 * 未被排序的节点参与循环。
 *
 * @param descriptors - 待检测的插件列表
 * @returns 参与循环的 pluginId 数组，无循环则返回 null
 */
export function detectCycle(descriptors: PluginDescriptor[]): string[] | null {
  const sorted = topologicalSort(descriptors)
  if (sorted.length === descriptors.length) return null

  const sortedIds = new Set(sorted.map(d => d.pluginId))
  return descriptors
    .map(d => d.pluginId)
    .filter(id => !sortedIds.has(id))
}

/**
 * 检查缺失依赖：返回所有被引用但不存在于给定描述符集合中的插件 ID。
 *
 * @param descriptors - 待检查的插件列表
 * @returns 缺失的依赖 pluginId 数组（已去重），无缺失则返回空数组
 */
export function findMissingDependencies(descriptors: PluginDescriptor[]): string[] {
  const availableIds = new Set(descriptors.map(d => d.pluginId))
  const missing = new Set<string>()

  for (const desc of descriptors) {
    for (const dep of desc.extensionDependencies ?? []) {
      if (!availableIds.has(dep)) {
        missing.add(dep)
      }
    }
  }

  return [...missing]
}
