/**
 * Pi 资源维护 helper（自 pi-provider-store.ts 抽出，控 max-lines 500）。
 *
 * 职责：
 * - syncBundledResources：打包模式 bundled skills/extensions 同步（直挂 runtime 启动，
 *   全仓唯一 bundled skills 同步点，打包版全新安装依赖）
 * - cleanLeakedPackages / isLeakedPackage / getPiGlobalAgentDir：settings.json.packages
 *   泄漏到 pi 全局目录的相对路径清理（架构约定 #1 taiji/pi 数据隔离）
 */
import { cpSync, existsSync } from 'node:fs'
import { join, resolve as pathResolve, sep } from 'node:path'
import { getDataDir } from '@taiji/shared/paths'
import { isPackaged } from '../../utils/runtime-env.js'
import { getPiAgentDir, getExtensionsDir } from './pi-paths.js'
import { updateSettingsFields } from './pi-settings-store.js'

/**
 * 打包模式：从 bundled 资源同步 skills/extensions（直挂
 * runtime 启动）。全仓唯一 bundled skills 同步点，打包版全新安装依赖，不得丢失。
 *
 * bundled 源 `join(process.cwd(), 'pi', 'agent')` 是 app 资源布局（打包时 stage 进
 * Resources 目录），非用户数据布局，不随路径 SSOT 切换变化。
 * 幂等：目标目录已存在则跳过。
 */
export function syncBundledResources(): void {
  if (!isPackaged()) return
  const piAgentDir = getPiAgentDir()
  const bundledAgentDir = join(process.cwd(), 'pi', 'agent')
  // skills 仍在 pi/agent/skills（bundled pi 自带 skill）；extensions 落 dataDir 根层
  for (const [subDir, destDir] of [
    ['extensions', getExtensionsDir()],
    ['skills', join(piAgentDir, 'skills')],
  ] as const) {
    const src = join(bundledAgentDir, subDir)
    if (!existsSync(src)) {
      // 打包产物 bundled 源缺失从静默跳过变可观测（缺目录 = 打包链断裂信号，排查入入口）
      console.warn(`[provider-store] bundled source missing, skip sync: ${src}`)
      continue
    }
    if (!existsSync(destDir)) {
      try {
        cpSync(src, destDir, { recursive: true })
        console.log(`[provider-store] synced bundled ${subDir} → ${destDir}`)
      // eslint-disable-next-line taste/no-silent-catch -- bundled sync: error logged, non-critical
      } catch (e) {
        console.error(`[provider-store] failed to sync bundled ${subDir}:`, e)
      }
    }
  }
}

// ── settings.json.packages 泄漏路径清理（架构约定 #1：taiji/pi 数据隔离）──────
//
// 背景：早期从 pi 导入 settings.json 时，packages[] 带入了泄漏到 pi 全局目录
// （~/.pi/agent/）的相对路径项（如 ../../../.pi/agent/extensions/pending-notifications），
// 违反隔离原则。runtime 启动时（index.ts syncBundledResources 之后）一次性清理。

/**
 * pi 全局 agent 目录，泄漏路径的判定目标。
 *
 * 结构性推导：从 getDataDir() 向上 1 层再下 .pi/agent，即「taiji 数据目录的
 * 兄弟 .pi/agent」。生产（TAIJI_AGENT_DATA_DIR=~/.taiji）下返回 ~/.pi/agent。
 *
 * [HISTORICAL] 为何不从 homedir() 推导：vitest globalSetup 把 TAIJI_AGENT_DATA_DIR 指向 tmp，
 * homedir()/.pi/agent 落在真实家目录，两者不同分区——相对路径解析后永远无法从 tmp 跨到
 * 真实家目录，导致 isLeakedPackage 不可测。从 getDataDir() 同源推导后，泄漏路径
 * ../../../.pi/agent/x 的解析与本函数天然同分区，任意 dataDir 位置均成立。
 *
 * [2026-09-10] 推导基点从 getPiAgentDir() 改为 getDataDir()（布局对齐 v9，设计 §6.11
 * U15②）：旧推导「向上 3 层」锚定 getPiAgentDir 的 pi/agent 子树层数，SSOT 切换为
 * `<dataDir>/agent` 后向上 3 层会落到 dataDir 的 grandparent，cleanLeakedPackages
 * 静默失效。从 getDataDir() 起向上 1 层与「dataDir 的兄弟 .pi/agent」语义恒等，
 * 不再依赖 getPiAgentDir 的内部层数。
 */
export function getPiGlobalAgentDir(): string {
  return pathResolve(getDataDir(), '..', '.pi', 'agent')
}

/**
 * 判定 packages 项是否为泄漏到 pi 全局目录的相对路径。
 *
 * 泄漏特征：以 '../' 开头（相对路径），且相对 settings.json 所在目录（getPiAgentDir()）
 * 解析后落在 pi 全局目录（~/.pi/agent/）内。
 *
 * 合法项不被误杀：npm:@xxx 不以 ../ 开头；extensions/xxx 不以 ../ 开头；
 * ./local-ext 不以 ../ 开头；../../../other-dir 解析后不在 ~/.pi/agent/ 内。
 *
 * @param pkg packages 数组的一项
 * @returns true = 泄漏项（应删除）
 */
export function isLeakedPackage(pkg: string): boolean {
  if (!pkg.startsWith('../')) return false
  const resolved = pathResolve(getPiAgentDir(), pkg)
  return resolved.startsWith(getPiGlobalAgentDir() + sep)
}

/**
 * 清理 settings.json.packages 中泄漏到 pi 全局目录的相对路径项。
 *
 * 启动时一次性调用（index.ts 的 syncBundledResources 之后）。幂等：filter 后无变化不触发写。
 *
 * @returns { removed: string[] } 被删除的项列表（供调用方 log）
 */
export function cleanLeakedPackages(): { removed: string[] } {
  try {
    let removed: string[] = []
    // full scope 白名单调用点（D1b）：启动迁移在无并发 pi 进程窗口运行，且迁移可能
    // 触及任意字段，故允许全量覆盖。新代码禁止使用 full scope——用具体字段域
    //（model/skills/extension），review 按 data-source-registry.md 登记表检查。
    updateSettingsFields('full', s => {
      const packages = s.packages ?? []
      const filtered = packages.filter(p => !isLeakedPackage(p))
      removed = packages.filter(p => isLeakedPackage(p))
      if (removed.length > 0) {
        s.packages = filtered
      }
    })
    if (removed.length > 0) {
      console.log(`[provider-store] cleaned ${removed.length} leaked package(s) from settings.json:`, removed)
    }
    return { removed }
  } catch (e) {
    // settings.json 读取失败不阻塞启动（ES1）
    console.warn('[provider-store] cleanLeakedPackages failed:', e)
    return { removed: [] }
  }
}
