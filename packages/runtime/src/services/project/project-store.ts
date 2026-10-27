/**
 * ProjectStore — project 列表持久化 + runtime 唯一写入口（connection-datasync-ssot §6.6）。
 *
 * 写通道两代并存（旧代由 u6b 拆除）：
 * - 命令通道（现行权威）：createProject / renameProject / removeProject / setActiveProject，
 *   经显式进程内串行队列执行（前提 4：消息派发是异步 fire-and-forget，偶然串行不作
 *   正确性依赖），命令携带期望 revision，校验一致才执行、执行后 +1，回执完整新状态；
 * - save 通道（legacy，renderer deep-watch 整表回写的旧载体）：全量替换原样保留，随 u6b 删除。
 *
 * revision = 文件写入代数水位：文件内 revision 字段每次写 +1；存量文件无该字段按 0 读。
 *
 * 对齐 recent-workspaces.json 模式（WriteBackCache write-back + debounce）：
 * 单分区（'global'），内键 = project id，值 = Project；activeProjectId 作为
 * 独立内存字段（非 cache 键），持久化时与 projects 一起写入。
 *
 * 不变量：
 * - INV-1: 文件损坏返空态，不抛
 * - INV-2: 路径从 configDir 动态推导，无硬编码
 * - INV-3: save 全量替换（legacy 通道，前端 store deep watch 变化后全量 save）
 * - INV-4: 归一化由 runtime 承载（§6.6①）：默认项目（DEFAULT_PROJECT_ID）存在 +
 *   activeProjectId 指向存在的 project。load 路径 = 读时修复（仅修返回视图不写盘，
 *   失配存量文件在首次编辑命令后自然收敛）；命令执行路径 = 随命令落盘一并承载修复
 *   （先保不变量再变更，修复不产生第二次写盘）
 */

import { join, dirname } from 'node:path'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import type { Project, ProjectCommandReply, ProjectStoreState } from '@taiji/shared'
import { DEFAULT_PROJECT_ID } from '@taiji/shared'
import { quarantineCorruptFile, WriteBackCache } from '../../utils/json-store.js'
import { atomicWrite } from '../../utils/fs-utils.js'
import { isEnoent } from '../../utils/errors.js'

const FILE_NAME = 'projects.json'
const JSON_INDENT = 2

/** 分区键常量：全局唯一分区 */
const PARTITION_KEY = 'global' as const

/** 错误码词表（handler 转 error envelope，renderer toast / 重拉消费） */
const ERR_REVISION_MISMATCH = 'project_revision_mismatch'
const ERR_INVALID_NAME = 'project_invalid_name'
const ERR_NOT_FOUND = 'project_not_found'
const ERR_DEFAULT_PROTECTED = 'project_default_protected'

/**
 * 命令拒绝（§6.6）：revision 失配或语义校验失败。handler catch 后转统一 error
 * envelope（失败显式上报——renderer 保持命令前状态 + toast，不设独立失败回执形态）。
 */
export class ProjectCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ProjectCommandError'
  }
}

/** projects.json 磁盘形态：状态整表 + revision 写入代数（存量文件无 revision 按 0 读）。 */
interface ProjectStoreFileState extends ProjectStoreState {
  revision: number
}

/** 默认 project 工厂（name 空 = 未命名默认项目，未归类 session 的兜底聚合）。 */
function makeDefaultProject(): Project {
  return { id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 }
}

/**
 * 归一化（§6.6① 自 renderer normalizeLoadedProjects 迁入，行为对齐）：
 * ① nameless 默认项缺失（legacy/外部编辑数据）→ 按 id 占用判定补插头部（按 nameless
 *    判占用会在默认项被改名时补插第二个同 id 项）；
 * ② activeProjectId 失配 → 回退链「nameless 默认项 → 首个 → DEFAULT_PROJECT_ID」。
 * 纯函数：load 路径只修返回视图（不写盘）；命令路径把结果施加回 cache/内存字段。
 */
function normalizeState(state: ProjectStoreState): ProjectStoreState {
  const projects = [...state.projects]
  if (!projects.some((p) => p.id === DEFAULT_PROJECT_ID)) {
    projects.unshift(makeDefaultProject())
  }
  let activeProjectId = state.activeProjectId
  if (!projects.some((p) => p.id === activeProjectId)) {
    activeProjectId = projects.find((p) => !p.name)?.id ?? projects[0]?.id ?? DEFAULT_PROJECT_ID
  }
  return { projects, activeProjectId }
}

export class ProjectStore {
  private readonly cache: WriteBackCache<typeof PARTITION_KEY, string, Project>
  private readonly filePath: string
  /** activeProjectId 内存态（非 cache 键，随 persistToFile 一起写入） */
  private activeProjectId = ''
  /** 文件写入代数水位（内存权威，随 flush 落盘；loadFromFile 读入，每次写 +1） */
  private revision = 0
  /** 同毫秒内多次 createProject 的 id 去重（对齐 renderer projectSeq 形态） */
  private projectSeq = 0
  /** 命令串行队列尾（见 enqueueCommand） */
  private commandQueueTail: Promise<unknown> = Promise.resolve()

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
   * INV-4 读时修复：返回视图恒满足不变量；失配仅存在于返回视图的变换，不写盘
   * （cache 无 dirty，load 前后文件字节一致）。
   */
  load(): ProjectStoreState {
    return normalizeState({ projects: this.listRaw(), activeProjectId: this.activeProjectId })
  }

  /** 当前 revision 水位（project.load 回执携带；触达 cache 使 revision 从盘读入）。 */
  getRevision(): number {
    this.cache.keys(PARTITION_KEY)
    return this.revision
  }

  /**
   * 全量保存（legacy 通道，renderer deep watch 变化后调用；随 u6b 拆除）。INV-3：替换式，幂等。
   * 删除的 project 必须从文件消失（cache 清空重建）。也是一次写 → revision +1。
   */
  save(state: ProjectStoreState): void {
    if (!state || !Array.isArray(state.projects)) return
    this.cache.keys(PARTITION_KEY)
    this.activeProjectId = state.activeProjectId ?? ''
    for (const key of this.cache.keys(PARTITION_KEY)) {
      this.cache.delete(PARTITION_KEY, key)
    }
    for (const p of state.projects) {
      if (p && typeof p.id === 'string' && p.id) {
        this.cache.set(PARTITION_KEY, p.id, p)
      }
    }
    this.revision += 1
  }

  /**
   * 立即持久化所有 dirty 数据（不等 debounce）。shutdown 用。
   */
  flushAll(): void {
    this.cache.flushAll()
  }

  // ── 命令通道（§6.6：runtime 唯一写入口，串行队列 + revision 校验） ────────

  /** 新建 project：生成 id、追加、设为活跃。对齐 renderer addProject 行为。 */
  createProject(name: string, expectedRevision: number): Promise<ProjectCommandReply> {
    return this.enqueueCommand(() => {
      this.assertRevision(expectedRevision)
      const trimmed = name.trim()
      if (!trimmed) {
        throw new ProjectCommandError(ERR_INVALID_NAME, 'project name 不能为空——输入非空名称后重试')
      }
      this.ensureInvariants()
      this.projectSeq += 1
      const id = `proj-${Date.now()}-${this.projectSeq}`
      this.cache.set(PARTITION_KEY, id, { id, name: trimmed, lastUsedAt: Date.now() })
      this.activeProjectId = id
      return this.commitCommand()
    })
  }

  /**
   * 重命名 project。nameless 默认项目禁改名（默认项目身份 = 未归类/孤儿 session 的
   * 兜底聚合，改名后孤儿无聚合可归）——判据对齐 renderer isDefaultProjectOf（!name）。
   */
  renameProject(projectId: string, name: string, expectedRevision: number): Promise<ProjectCommandReply> {
    return this.enqueueCommand(() => {
      this.assertRevision(expectedRevision)
      const trimmed = name.trim()
      if (!trimmed) {
        throw new ProjectCommandError(ERR_INVALID_NAME, 'project name 不能为空——输入非空名称后重试')
      }
      this.ensureInvariants()
      const target = this.cache.get(PARTITION_KEY, projectId)
      if (!target) {
        throw new ProjectCommandError(ERR_NOT_FOUND, `project 不存在：${projectId}——重新 project.load 后重试`)
      }
      if (!target.name) {
        throw new ProjectCommandError(ERR_DEFAULT_PROTECTED, '默认项目不可改名（未归类会话的兜底聚合）——改名请指定命名项目')
      }
      this.cache.set(PARTITION_KEY, projectId, { ...target, name: trimmed })
      return this.commitCommand()
    })
  }

  /**
   * 删除 project。默认项目不可删（兜底聚合，删除后未归类会话在任何命名 project 过滤
   * 下都匹配不到且无重建路径）；删的是活跃项 → 锚定回落默认项目（对齐 renderer 行为）。
   */
  removeProject(projectId: string, expectedRevision: number): Promise<ProjectCommandReply> {
    return this.enqueueCommand(() => {
      this.assertRevision(expectedRevision)
      this.ensureInvariants()
      if (projectId === DEFAULT_PROJECT_ID) {
        throw new ProjectCommandError(ERR_DEFAULT_PROTECTED, '默认项目不可删除（未归类会话的兜底聚合）')
      }
      const target = this.cache.get(PARTITION_KEY, projectId)
      if (!target) {
        throw new ProjectCommandError(ERR_NOT_FOUND, `project 不存在：${projectId}——重新 project.load 后重试`)
      }
      this.cache.delete(PARTITION_KEY, projectId)
      if (this.activeProjectId === projectId) {
        this.activeProjectId = DEFAULT_PROJECT_ID
      }
      return this.commitCommand()
    })
  }

  /** 锚定切换。不更新 lastUsedAt（排序键仅创建时写入，「顺序稳定不置顶」R6.2）。 */
  setActiveProject(projectId: string, expectedRevision: number): Promise<ProjectCommandReply> {
    return this.enqueueCommand(() => {
      this.assertRevision(expectedRevision)
      this.ensureInvariants()
      const target = this.cache.get(PARTITION_KEY, projectId)
      if (!target) {
        throw new ProjectCommandError(ERR_NOT_FOUND, `project 不存在：${projectId}——重新 project.load 后重试`)
      }
      this.activeProjectId = projectId
      return this.commitCommand()
    })
  }

  // ── Private（队列 / 校验 / 不变量 / WriteBackCache backing 回调） ──────────

  /**
   * 命令串行队列（§6.6 前提 4）：一条命令完整执行后才受理下一条。当前命令体是同步
   * 块，队列的价值在结构保证——处理链未来引入 await 或多入口并发到达时正确性不回退。
   * 前驱失败不阻断后继（reject 只传给该命令的调用方）。
   */
  private enqueueCommand<T>(op: () => T): Promise<T> {
    const run = this.commandQueueTail.then(op, op)
    this.commandQueueTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * revision 校验（§6.6 过时窗口保护）：命令 revision === 当前 revision 才执行。
   * 触达 cache 使分区在首访时从盘加载（revision 基线入内存）。
   */
  private assertRevision(expected: number): void {
    this.cache.keys(PARTITION_KEY)
    if (expected !== this.revision) {
      throw new ProjectCommandError(
        ERR_REVISION_MISMATCH,
        `revision 失配：当前 ${this.revision}，命令携带 ${expected}——重新 project.load 取最新状态与 revision 后重试`,
      )
    }
  }

  /**
   * 命令路径不变量修复（§6.6①）：变更前把 INV-4 施加到权威数据（cache + 内存字段）。
   * 修复产生的 dirty 与命令写盘同窗口 flush，不产生第二次写盘。
   */
  private ensureInvariants(): void {
    const projects = this.listRaw()
    if (!projects.some((p) => p.id === DEFAULT_PROJECT_ID)) {
      // 补插默认项取头部序（对齐 normalizeState 视图与 renderer unshift 语义）——
      // cache Map 只能追加，delete+set 重建键序；同一 flush 窗口，无第二次写盘。
      this.rewriteCache([makeDefaultProject(), ...projects])
    }
    const all = this.listRaw()
    if (!all.some((p) => p.id === this.activeProjectId)) {
      this.activeProjectId = all.find((p) => !p.name)?.id ?? all[0]?.id ?? DEFAULT_PROJECT_ID
    }
  }

  /** 按给定序整体重建分区（INV-3 save 同款清空重建形态）。 */
  private rewriteCache(projects: Project[]): void {
    for (const key of this.cache.keys(PARTITION_KEY)) {
      this.cache.delete(PARTITION_KEY, key)
    }
    for (const p of projects) {
      this.cache.set(PARTITION_KEY, p.id, p)
    }
  }

  /** 命令成功收尾：revision +1（随本窗口写盘），回执 = 归一化后完整新状态 + revision 新值。 */
  private commitCommand(): ProjectCommandReply {
    this.revision += 1
    return { state: this.load(), revision: this.revision }
  }

  /** cache 原始列表（保持文件写入顺序，未归一化）。 */
  private listRaw(): Project[] {
    return this.cache.keys(PARTITION_KEY)
      .map((key) => this.cache.get(PARTITION_KEY, key))
      .filter((p): p is Project => p != null)
  }

  /**
   * 从文件加载分区数据。INV-1：文件损坏返空 Map，不抛。
   * ENOENT（首启无文件）静默返空；其它错误（损坏/权限）console.warn 记录原因。
   * revision 一并读入（存量无该字段按 0）。
   */
  private loadFromFile(): Map<string, Project> {
    try {
      if (!existsSync(this.filePath)) return new Map()
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as ProjectStoreFileState
      if (!parsed || !Array.isArray(parsed.projects)) return new Map()
      this.activeProjectId = typeof parsed.activeProjectId === 'string' ? parsed.activeProjectId : ''
      this.revision =
        typeof parsed.revision === 'number' && Number.isInteger(parsed.revision) && parsed.revision >= 0
          ? parsed.revision
          : 0
      const map = new Map<string, Project>()
      for (const p of parsed.projects) {
        if (p && typeof p.id === 'string' && p.id) {
          map.set(p.id, p)
        }
      }
      return map
    } catch (e) {
      // ENOENT（首启无文件）静默返空；损坏必须隔离（对齐 JsonStore D1c 与
      // session-data-store/plugin-storage 同款）：静默空 Map 时 loadRevision = 损坏文件
      // 指纹，下一次 flush 指纹比对判「未变」→ 不触发冲突备份直接覆写，项目列表
      // 原始内容无痕丢失。quarantine 后 flush 走 ENOENT 放行重建，损坏数据保留
      // .corrupt-<ts> 副本供人工恢复。
      if (isEnoent(e)) return new Map()
      quarantineCorruptFile(this.filePath, {
        tag: 'project-store',
        reason: 'store file corrupt/unreadable',
        cause: e,
      })
      return new Map()
    }
  }

  /**
   * 持久化分区数据到文件（ProjectStoreFileState 结构：状态整表 + revision）。
   * sync atomicWrite（KB 级，event loop 无感）。
   */
  private persistToFile(data: Map<string, Project>): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const state: ProjectStoreFileState = {
      projects: Array.from(data.values()),
      activeProjectId: this.activeProjectId,
      revision: this.revision,
    }
    atomicWrite(this.filePath, JSON.stringify(state, null, JSON_INDENT))
  }
}
