/**
 * 插件入口文件 → 包根目录定位（唯一实现，三处消费点同源）：
 *  1. plugin-host-process（fork env TAIJI_PLUGIN_SANDBOX_DIR 注入——ESM loader 沙箱边界）
 *  2. plugin-bootstrap handleLoad（CJS require 拦截器的插件根目录入参）
 *  3. provider-write-proxy 的 createPluginManifestReader（包清单读取的包根定位）
 *
 * 语义：包根 = 自入口文件目录向上第一个含 package.json 的祖先（npm 生态通用语义）。
 * 此前各消费点各自 dirname(pluginPath)——入口在插件根（index.js 形态 fixture）时碰巧
 * 成立，真实发布形态子目录入口（manifest main = src/index.ts）会把沙箱边界错划成
 * <插件目录>/src，<插件目录>/node_modules 的裸导入被判越界，激活即炸（ISSUES-2 ⑤）。
 *
 * 找不到 package.json（无清单 fixture / 越界上溯到文件系统根）回落入口文件目录——与
 * 旧行为对齐，边界语义退化为「入口目录」，不放大也不缩小既有 fail-closed 面。
 */

import { existsSync } from 'node:fs'
import { dirname as pathDirname, join } from 'node:path'

/** 祖先遍历深度上界（entry → 包根通常 ≤3 层；上界防病态路径无限上溯）。 */
export const MAX_PACKAGE_ROOT_WALK_DEPTH = 8

export function findPackageRootDir(entryPath: string): string {
  const entryDir = pathDirname(entryPath)
  let dir = entryDir
  for (let depth = 0; depth < MAX_PACKAGE_ROOT_WALK_DEPTH; depth++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = pathDirname(dir)
    if (parent === dir) return entryDir
    dir = parent
  }
  // 深度耗尽仍未命中：回落入口目录（不是最后爬到的祖先——回落到高处会把沙箱边界
  // 放大到插件目录之外，界外 node_modules 的裸导入会被判界内放行）
  return entryDir
}
