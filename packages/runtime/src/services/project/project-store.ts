/**
 * ProjectStore — project 列表持久化（D14，2026-08-04 迁 runtime projects.json）。
 *
 * 对齐 recent-workspaces.json 模式（WriteBackCache write-back + debounce）：
 * 单分区（'global'），内键 = project id，值 = Project；activeProjectId 作为
 * 独立内存字段（非 cache 键），持久化时与 projects 一起写入。
 *
 * 文件格式 = ProjectStoreState（{ projects: Project[], activeProjectId: string }），
 * 与前端 store 的持久化结构一致，load/save 零转换。
 *
 * 不变量：
 * - INV-1: 文件损坏返空态，不抛
 * - INV-2: 路径从 configDir 动态推导，无硬编码
 * - INV-3: save 全量替换（前端 store 是权威内存，deep watch 变化后全量 save）
 * - INV-4: activeProjectId 指向不存在的 project 时由前端兜底（回退首个/默认）
 */

import { join, dirname } from 'node:path'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import type { Project, ProjectStoreState } from '@taiji/shared'
import { WriteBackCache } from '../../utils/json-store.js'
import { atomicWrite } from '../../utils/fs-utils.js'
import { isEnoent } from '../../utils/errors.js'

const FILE_NAME = 'projects.json'
const JSON_INDENT = 2

/** 分区键常量：全局唯一分区 */
const PARTITION_KEY = 'global' as const

export class ProjectStore {
  private readonly cache: WriteBackCache<typeof PARTITION_KEY, string, Project>
  private readonly filePath: string
  /** activeProjectId 内存态（非 cache 键，随 persistToFile 一起写入） */
  private activeProjectId = ''

  /**
   * @param configDir taiji 配置根（~/.taiji/），由组合根注入，不硬编码。
   */
  constructor(configDir: string) {
    this.filePath = join(configDir, FILE_NAME)
    this.cache = new WriteBackCache<typeof PARTITION_KEY, string, Project>(
      {
        partitionPath: () => this.filePath,
        loadPartition: () => this.loadFromFile(),
        persistPartition: (_k, data) => this.persistToFile(data),
      },
      { flushMs: 500 },
    )
  }

  /**
   * 全量加载 project 列表（前端启动 init 用）。
   * 文件不存在（首启）→ 空态 { projects: [], activeProjectId: '' }，前端兜底默认 project。
   */
  load(): ProjectStoreState {
    const projects = this.cache.keys(PARTITION_KEY)
      .map((key) => this.cache.get(PARTITION_KEY, key))
      .filter((p): p is Project => p != null)
    // 稳定顺序：保持文件写入顺序（cache Map 插入序）
    return { projects, activeProjectId: this.activeProjectId }
  }

  /**
   * 全量保存（前端 deep watch 变化后调用）。INV-3：替换式，幂等。
   * 删除的 project 必须从文件消失（cache 清空重建）。
   */
  save(state: ProjectStoreState): void {
    if (!state || !Array.isArray(state.projects)) return
    this.activeProjectId = state.activeProjectId ?? ''
    for (const key of this.cache.keys(PARTITION_KEY)) {
      this.cache.delete(PARTITION_KEY, key)
    }
    for (const p of state.projects) {
      if (p && typeof p.id === 'string' && p.id) {
        this.cache.set(PARTITION_KEY, p.id, p)
      }
    }
  }

  /**
   * 立即持久化所有 dirty 数据（不等 debounce）。shutdown 用。
   */
  flushAll(): void {
    this.cache.flushAll()
  }

  // ── Private（WriteBackCache backing 回调） ──────────────────

  /**
   * 从文件加载分区数据。INV-1：文件损坏返空 Map，不抛。
   * ENOENT（首启无文件）静默返空；其它错误（损坏/权限）console.warn 记录原因。
   */
  private loadFromFile(): Map<string, Project> {
    try {
      if (!existsSync(this.filePath)) return new Map()
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as ProjectStoreState
      if (!parsed || !Array.isArray(parsed.projects)) return new Map()
      this.activeProjectId = typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : ''
      const map = new Map<string, Project>()
      for (const p of parsed.projects) {
        if (p && typeof p.id === 'string' && p.id) {
          map.set(p.id, p)
        }
      }
      return map
    } catch (e) {
      if (isEnoent(e)) return new Map()
      console.warn('[project-store] load failed, starting fresh:',
        e instanceof Error ? e.message : e)
      return new Map()
    }
  }

  /**
   * 持久化分区数据到文件（ProjectStoreState 结构）。sync atomicWrite（KB 级，event loop 无感）。
   */
  private persistToFile(data: Map<string, Project>): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const state: ProjectStoreState = {
      projects: Array.from(data.values()),
      activeProjectId: this.activeProjectId,
    }
    atomicWrite(this.filePath, JSON.stringify(state, null, JSON_INDENT))
  }
}
