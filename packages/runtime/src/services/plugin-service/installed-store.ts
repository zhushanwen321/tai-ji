/**
 * InstalledStore —— <pluginsDir>/installed.json 读写（provider-plugin-access U4 / D11）。
 *
 * 只记安装事实时间：{ [pluginId]: { installedAt } }。版本与命名空间**均不落盘**——
 * 版本唯一事实 = 插件目录内 package.json 的 version（registry scan 直读），命名空间 =
 * 包名纯函数推导（plugin-namespace.ts）。两个候选持久化字段都没有已发生问题支撑，
 * 第二份事实只引入失真面（可派生状态不落第二份，ADR-0122）。
 *
 * 登记缺失无碍安装判定：安装与否的唯一事实 = 插件目录存在且 package.json 合法
 * （registry scan 口径），installed.json 只承载 installedAt 展示。文件损坏按空表容错
 * （warn fail-visible），不阻断安装/卸载编排。
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWriteAsync } from '../../utils/fs-utils.js'

/** 单个插件的安装登记条目。schema 冻结：只含 installedAt（ISO 时间串）。 */
export interface InstalledPluginEntry { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  installedAt: string
}

export type InstalledPluginsFile = Record<string, InstalledPluginEntry>

const INSTALLED_FILE = 'installed.json'
/** 登记文件序列化缩进（人读 diff 友好；纯展示选择非逻辑参数） */
const JSON_INDENT = 2

export class InstalledStore {
  private readonly filePath: string

  /** @param pluginsDir 插件安装根目录（与 NpmPluginInstaller 同一注入值）。 */
  constructor(pluginsDir: string) {
    this.filePath = join(pluginsDir, INSTALLED_FILE)
  }

  /** installed.json 绝对路径（测试断言用）。 */
  get path(): string {
    return this.filePath
  }

  /** 读全部登记；文件缺失或 JSON 损坏 → 空表（warn 留痕，不抛）。 */
  async load(): Promise<InstalledPluginsFile> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf-8')
    } catch {
      return {}
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn(`[installed-store] ${INSTALLED_FILE} has unexpected shape, treating as empty`)
        return {}
      }
      const result: InstalledPluginsFile = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const installedAt =
          typeof value === 'object' && value !== null && typeof (value as { installedAt?: unknown }).installedAt === 'string'
            ? (value as { installedAt: string }).installedAt
            : undefined
        // 条目形状不合（缺 installedAt / 非对象）按损坏丢弃该条，不影响其余条目
        if (installedAt !== undefined) result[key] = { installedAt }
      }
      return result
    } catch (err) {
      console.warn(`[installed-store] failed to parse ${INSTALLED_FILE}, treating as empty:`, err)
      return {}
    }
  }

  /** 登记安装时间（installedAt = 当前时刻 ISO 串）。幂等覆盖。 */
  async recordInstalled(pluginId: string, installedAt: string = new Date().toISOString()): Promise<void> {
    const all = await this.load()
    all[pluginId] = { installedAt }
    await this.write(all)
  }

  /** 移除登记（卸载编排收尾）。条目不存在时 no-op。 */
  async recordUninstalled(pluginId: string): Promise<void> {
    const all = await this.load()
    if (!(pluginId in all)) return
    delete all[pluginId]
    await this.write(all)
  }

  private async write(all: InstalledPluginsFile): Promise<void> {
    // pluginsDir 可能尚不存在（首次登记先于任何安装落盘的调用形态），写入原语
    // 不自建父目录——先确保目录在（fail-safe：登记写失败由调用方 catch 呈报）
    await mkdir(dirname(this.filePath), { recursive: true })
    await atomicWriteAsync(this.filePath, JSON.stringify(all, null, JSON_INDENT))
  }
}
