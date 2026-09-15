/**
 * 集合工具（C9）。
 */

/**
 * Map get-or-create：键不存在时用 make() 构造并存入，返回值。
 *
 * 统一 plugin-rpc-client.onNotification 等 2-3 处
 * `let v = map.get(k); if (!v) { v = make(); map.set(k, v) }` 样板。
 *
 * 注：不强行收编 plugin-activator 的图构建初始化——那里的 `if (!adjList.has(k))`
 * 带「不要覆盖」语义注释（依赖遍历时可能已添加），getOrCreate 会掩盖该意图。
 */
export function getOrCreate<K, V>(
  map: Map<K, V>,
  key: K,
  make: () => V,
): V {
  let value = map.get(key)
  if (value === undefined) {
    value = make()
    map.set(key, value)
  }
  return value
}
