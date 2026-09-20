/**
 * sqlite 双驱动适配层（设计 D3：bun/node 运行时探测，方案 A）。
 *
 * - 运行时探测：bun 全局在场 → `bun:sqlite`，否则 `node:sqlite`（探测读
 *   `globalThis.Bun`——与 `typeof Bun !== 'undefined'` 同义，TS 无 bun-types
 *   依赖下的合法形态）。bun:sqlite 只在 bun 运行时存在（F2：node 下加载
 *   bun:sqlite 模块失败），node:sqlite 只在 node ≥22.13 存在；两端经
 *   同一公共子集消费。
 * - **变量间接是硬要求**：动态 import 的模块 id 必须经变量传入（sqlite-access.ts
 *   既有先例，2026-08-25 P5 实测）——esbuild bundle 会把 node:sqlite 字面量形态
 *   的动态 import 规约成裸名（external 化 node builtin 时前缀剥离），Node 动态
 *   import 裸名不走内置模块 fallback → ERR_MODULE_NOT_FOUND；且 ext 侧
 *   bundle-extensions.mjs 的 esbuild external 清单不含 `bun:sqlite`，字面量形态
 *   会被当作静态依赖解析失败。非字面量 specifier esbuild 无法静态分析，动态
 *   import 保持运行期解析。
 * - 适配层只暴露 `open / prepare / all / get / close` 公共子集（F3：bun 的
 *   `db.all` 不存在，统一走 prepare）；readonly 选项名两端微异（node `readOnly` /
 *   bun `readonly`），在 open 内吸收，调用方无感。
 * - 所有连接只读打开：转换/查询全程不写库（readonly 语义 = 只开自己的 WAL
 *   read-mark slot，不写 db/-wal 用户数据）。
 */

/** prepare 产出的语句的最小消费面（结构类型，驱动返回 unknown，禁 any）。 */
export interface SqliteStatement {
  all: (...args: unknown[]) => unknown[]
  get: (...args: unknown[]) => unknown
}

/** 已打开连接的最小消费面。 */
export interface SqliteDb {
  prepare: (sql: string) => SqliteStatement
  close: () => void
}

export interface SqliteOpenOptions {
  /** 恒 true：本包只读打开（readonly 语义 = 只开自己的 WAL read-mark slot）。 */
  readOnly: true
  /** immutable=1（sqlite URI）：仅当开库前确认 -wal 不存在时可用——有内容 -wal 下 immutable 静默丢行（F25）。 */
  immutable?: boolean
}

/** 驱动适配器：id 用于结构化日志与断言（'node:sqlite' | 'bun:sqlite'）。 */
export interface SqliteDriver {
  readonly id: string
  open: (path: string, opts: SqliteOpenOptions) => SqliteDb
}

interface SqliteModuleLike {
  DatabaseSync?: unknown
  Database?: unknown
}

/** node:sqlite 的 DatabaseSync 构造形态（readOnly 选项）。 */
interface DatabaseSyncLike {
  new (path: string, opts: { readOnly: boolean }): SqliteDb
}

/** bun:sqlite 的 Database 构造形态（readonly 选项）。 */
interface BunDatabaseLike {
  new (path: string, opts: { readonly: boolean }): SqliteDb
}

async function importSqliteModule(): Promise<SqliteModuleLike> {
  // 探测读 globalThis.Bun（与设计原文 `typeof Bun !== 'undefined'` 同义——
  // Bun 全局即挂载于 globalThis，TS 无 bun-types 依赖下的合法写法）
  const bunGlobal = (globalThis as { Bun?: unknown }).Bun
  if (typeof bunGlobal !== 'undefined') {
    // [HISTORICAL] 变量间接（硬要求）：见模块头注——esbuild 无法静态分析变量 specifier。
    const bunSqliteModuleId = 'bun:sqlite'
    const mod = (await import(bunSqliteModuleId)) as SqliteModuleLike
    if (typeof mod.Database !== 'function') {
      throw new Error('bun:sqlite 可用但缺 Database 导出（bun 版本异常）')
    }
    return mod
  }
  const nodeSqliteModuleId = 'node:sqlite'
  const mod = (await import(nodeSqliteModuleId).catch(() => undefined)) as SqliteModuleLike | undefined
  if (typeof mod?.DatabaseSync !== 'function') {
    throw new Error('当前 node 运行时不支持 node:sqlite（需 >=22.13），且宿主非 bun 运行时')
  }
  return mod
}

let cachedDriver: SqliteDriver | undefined

/**
 * 加载当前运行时可用的 sqlite 驱动（进程内缓存——驱动探测是一次性事实）。
 * 宿主既无 bun:sqlite 也无 node:sqlite 时抛 Error（理论态）：调用方按降级契约
 * 处理（zcode 读取面整体降级为错误指引，pi 链路不受影响）。
 */
export async function loadSqliteDriver(): Promise<SqliteDriver> {
  if (cachedDriver) return cachedDriver
  const mod = await importSqliteModule()
  const bunGlobal = (globalThis as { Bun?: unknown }).Bun
  if (typeof bunGlobal !== 'undefined') {
    const Database = mod.Database as BunDatabaseLike
    cachedDriver = {
      id: 'bun:sqlite',
      open(path, opts) {
        // bun 选项名是全小写 readonly（与 node 的 readOnly 微异，F3；拼错 bun 1.3.8
        // 直接抛 TypeError，选项名已实测核真）。
        const db = new Database(path, { readonly: opts.readOnly })
        // get() 未命中 bun 返回 null（node 返回 undefined，bun 1.3.8 实测）——
        // 公共子集语义对齐（P-api-parity 面）：统一归一为 undefined
        const rawPrepare = db.prepare.bind(db)
        return {
          prepare(sql: string) {
            const stmt = rawPrepare(sql)
            return {
              all: (...args: unknown[]) => stmt.all(...args),
              get: (...args: unknown[]) => {
                const row = stmt.get(...args)
                return row === null ? undefined : row
              },
            }
          },
          close: () => db.close(),
        }
      },
    }
  } else {
    const DatabaseSync = mod.DatabaseSync as DatabaseSyncLike
    cachedDriver = {
      id: 'node:sqlite',
      open(path, opts) {
        return new DatabaseSync(path, { readOnly: opts.readOnly })
      },
    }
  }
  return cachedDriver
}

/**
 * 把 db 绝对路径转为 sqlite `file:` URI。immutable 开库走 URI 形态；路径中的
 * URI 结构字符（`%` `?` `#`）须百分号编码，否则会被解析为 query/fragment
 * （实测：路径含 `?` 时 immutable 开库解析到错误路径）。仅处理路径组件的这三个
 * 字符——正斜杠是分隔符，其余字符按 sqlite URI 规范原样保留。
 */
export function toSqliteFileUri(dbPath: string, immutable: boolean): string {
  const encoded = dbPath.replaceAll('%', '%25').replaceAll('?', '%3F').replaceAll('#', '%23')
  return immutable ? `file:${encoded}?immutable=1` : `file:${encoded}`
}
