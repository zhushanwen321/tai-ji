import { readFile, readdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'

import type { ZcodeAnchor } from './entry-anchor.js'
import type { ZcodeFamilyNode } from '../core/family.js'

/**
 * zcode manifest 直读与枚举（design session-reader-shared-core §3.1 第①步 / D5 / D5-1）。
 *
 * 背景（F21）：pi 路径的 `isRecordManifest` 三必填含 `sessionFile`，而 zcode manifest
 * 落盘时该键被 JSON.stringify 丢弃（subagent-core record-store-rebuild.ts:665/725 投影
 * 照写 `sessionFile: undefined`）→ `listRecordManifests` 对 zcode manifest 恒返回 []。
 * 本单元另开一条**不经过该守卫**的独立路径：
 * - **定点直读**（`readZcodeManifest`）：manifest 文件名由 sa-id 完全确定（写侧
 *   `path.join(recordsDir, \`${record.id}.json\`)`，manifest-store.ts:141/153），按确定性
 *   文件名 `<sa-id>.json` 在 `<agentDir>/subagents/<cwd>/records/` 下**窄 walk（命中即止，
 *   不读不解析任何其他 manifest）**→ JSON.parse → `engine === 'zcode'` ∧
 *   `engineHandle.sessionRef` 双键（sessionId/dbPath 均非空 string）→ 取锚。
 * - **全量枚举**（`listZcodeManifests`，family 用）：扫同布局下全部 .json，逐条
 *   parse + 谓词过滤，只返回 zcode 形态（pi manifest / 坏 JSON 跳过）。
 *
 * **对 pi 行为零影响（本方案的定义性质）**：`isRecordManifest` / `RecordManifest` /
 * `listRecordManifests`（subagents.ts）一行不改——pi manifest 仍走原扫描路径，本单元
 * 的谓词**不走** isRecordManifest。判别规则与 runtime `transcriptAnchorOf` 同构
 * （F8：`engine === 'zcode'` 第一判据 + sessionRef 双键齐）。用 `engine` 判别而非
 * 「engineHandle 存在性」的理由见 D5 被否项 ②（pi record 提升后 engineHandle 仍持久化，
 * 存在性判别会误路由）。
 */

/**
 * zcode manifest 的读取记录（枚举产出，family 消费）。
 *
 * 富字段（slug/task/model/status/agentName）从 manifest 顶层透传（旧 manifest 缺省
 * → undefined）；slug 的 `m.slug ?? m.agentName ?? ''` 兜底在枚举组装时完成（与 pi
 * 孤儿链 appendOrphanIdentities 同款，core 层直接透传）。
 */
export interface ZcodeManifestRecord extends ZcodeFamilyNode {
  /** 写侧盖章的引擎 id（枚举谓词保证 === 'zcode'） */
  engine: string
}

/**
 * 定点直读的结果三态（discriminated result——错误码映射归路由单元 U9，本单元只给
 * 归因信号，§3.4 检查顺序第 0 段「定位链」）：
 * - `zcode`：engine==='zcode' ∧ sessionRef 双键齐 → 携带锚，继续 zcode 链（白名单闸 → 开库）；
 * - `not-zcode`：文件不存在 / 坏 JSON / `engine` 缺省或 `'pi'`（或非 string id）——
 *   该 sa-id 不是「zcode 单子」，交回调用方走今天的 pi 现路径（sessionFile + JSONL）；
 * - `anchor-missing`：engine==='zcode' 但 `engineHandle` 整体缺席或 `sessionRef` 缺键
 *   ——路由映射 `zcode_anchor_missing`（§3.4；缺失键名的归因由结构化日志承载）。
 */
export type ZcodeManifestLookup =
  | { kind: 'zcode'; anchor: ZcodeAnchor }
  | { kind: 'not-zcode' }
  | { kind: 'anchor-missing' }

/** manifest 顶层 JSON 的读取视图（守卫输入） */
type ManifestJson = Record<string, unknown>

function asObject(v: unknown): ManifestJson | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  return v as ManifestJson
}

/** 第一判据：`engine === 'zcode'`（缺省 / 'pi' / 其他引擎均非 zcode 形态） */
function isZcodeEngine(m: ManifestJson): boolean {
  return m.engine === 'zcode'
}

/**
 * 第二判据：`engineHandle.sessionRef` 双键（sessionId/dbPath）均为非空 string → 锚。
 * （F8 判据的锚字段部分；pi record 的 sessionRef 无 dbPath → 天然不齐。）
 */
function zcodeAnchorOf(m: ManifestJson): ZcodeAnchor | undefined {
  const handle = asObject(m.engineHandle)
  if (!handle) return undefined
  const ref = asObject(handle.sessionRef)
  if (!ref) return undefined
  const { sessionId, dbPath } = ref
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  if (typeof dbPath !== 'string' || dbPath === '') return undefined
  return { sessionId, dbPath }
}

/** manifest 顶层富字段（旧 manifest 缺省 → undefined，不伪造） */
interface ManifestRichFields {
  agentName?: string
  task?: string
  model?: string
  status?: string
}

function richFieldsOf(m: ManifestJson): ManifestRichFields {
  const out: ManifestRichFields = {}
  if (typeof m.agentName === 'string') out.agentName = m.agentName
  if (typeof m.task === 'string') out.task = m.task
  if (typeof m.model === 'string') out.model = m.model
  if (typeof m.status === 'string') out.status = m.status
  return out
}

/** stat 存在性（任意路径无安全面——D5-1 只查「文件在不在」，不开库） */
function fileExists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * manifest JSON → zcode 记录（枚举产出形状）。非 zcode 形态 → undefined。
 * slug 兜底 m.slug ?? m.agentName ?? ''（与 pi 孤儿链同款）。
 */
function toZcodeManifestRecord(m: ManifestJson): ZcodeManifestRecord | undefined {
  if (!isZcodeEngine(m)) return undefined
  const anchor = zcodeAnchorOf(m)
  if (!anchor) return undefined
  if (typeof m.id !== 'string' || m.id === '') return undefined
  if (typeof m.rootSessionId !== 'string' || m.rootSessionId === '') return undefined
  const rich = richFieldsOf(m)
  const slug = typeof m.slug === 'string' ? m.slug : (rich.agentName ?? '')
  return {
    id: m.id,
    rootSessionId: m.rootSessionId,
    slug,
    agentName: rich.agentName,
    task: rich.task,
    model: rich.model,
    status: rich.status,
    dbPath: anchor.dbPath,
    dbFileExists: fileExists(anchor.dbPath),
    engine: 'zcode',
  }
}

/** `<agentDir>/subagents` 布局常量（与写侧 path-encoding/manifest-store 布局对齐） */
const SUBAGENTS_DIR = 'subagents'
const RECORDS_DIR = 'records'

/**
 * 逐条解析一个 manifest 文件为三态结果（直读用）。
 * 坏 JSON / 非 string id → not-zcode（残缺 manifest 交回 pi 现路径——与今天的
 * tryReadManifest 丢弃行为等价，只是换了显式信号）。
 */
function parseManifestLookup(raw: string): ZcodeManifestLookup {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return { kind: 'not-zcode' } // 坏 JSON
  }
  const m = asObject(v)
  if (!m || !isZcodeEngine(m)) return { kind: 'not-zcode' } // engine 缺省 / 'pi' / 其他
  const anchor = zcodeAnchorOf(m)
  if (!anchor) return { kind: 'anchor-missing' } // engineHandle 缺席 / sessionRef 缺键
  return { kind: 'zcode', anchor }
}

/**
 * 定点直读（§3.1 第①步主路径）：按确定性文件名 `<sa-id>.json` 在
 * `<agentDir>/subagents/<cwd>/records/` 下窄 walk，**命中即止——不读不解析任何其他
 * manifest**（对比 listRecordManifests 的全量 walk + 逐条 parse）。
 *
 * 无会话边界（§3.1）：manifest 文件名由 sa-id 确定性推出，任何会话中都可直读。
 * 根目录不可读 / 无候选目录 → not-zcode（调用方交回 pi 现路径，与今天行为一致）。
 */
export async function readZcodeManifest(
  agentDir: string,
  saId: string,
): Promise<ZcodeManifestLookup> {
  const root = join(agentDir, SUBAGENTS_DIR)
  let slugs: DirentLike[]
  try {
    slugs = await readdir(root, { withFileTypes: true })
  } catch {
    return { kind: 'not-zcode' } // subagents 根不存在/不可读 → 无 manifest
  }
  for (const e of slugs) {
    if (!e.isDirectory()) continue
    const file = join(root, e.name, RECORDS_DIR, `${saId}.json`)
    let raw: string
    try {
      // 命中即止：只读这一个文件（文件名由 sa-id 确定），坏内容同样终止（见 parseManifestLookup）
      raw = await readFile(file, 'utf8')
    } catch {
      continue // 该 cwd 目录下无此 manifest → 下一候选目录
    }
    return parseManifestLookup(raw)
  }
  return { kind: 'not-zcode' }
}

/** readdir(withFileTypes) 条目的最小结构视图（便于类型标注） */
interface DirentLike {
  isDirectory(): boolean
  isFile(): boolean
  name: string
}

/**
 * zcode manifest 全量枚举（family 用，D5-1 的节点列表来源）：扫
 * `<agentDir>/subagents/<cwd>/records/` 全部 .json，逐条 JSON.parse + 谓词过滤
 * （engine==='zcode' ∧ sessionRef 双键齐 ∧ id/rootSessionId 非空 string），
 * 只返回 zcode 形态——**pi manifest 与坏 JSON 直接跳过，不走 isRecordManifest
 * （那条链零改动）**。每个返回记录已携带 dbFileExists（statSync 预计算）。
 *
 * 单条 manifest 不可达（坏 JSON / 残缺 / stat 失败）不中断枚举、不抛异常——
 * family 是列表视图，单节点不可达不炸整屏（D5-1 GC 语义）。
 */
export async function listZcodeManifests(agentDir: string): Promise<ZcodeManifestRecord[]> {
  const root = join(agentDir, SUBAGENTS_DIR)
  const out: ZcodeManifestRecord[] = []
  let slugs: DirentLike[]
  try {
    slugs = await readdir(root, { withFileTypes: true })
  } catch {
    return out // 根不存在/不可读 → 空（无 zcode 节点，不报错）
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const recordsDir = join(root, slug.name, RECORDS_DIR)
    let files: DirentLike[]
    try {
      files = await readdir(recordsDir, { withFileTypes: true })
    } catch {
      continue // 该 cwd 目录无 records/ → 跳过
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue
      let raw: string
      try {
        raw = await readFile(join(recordsDir, f.name), 'utf8')
      } catch {
        continue // 单文件读失败 → 跳过
      }
      let v: unknown
      try {
        v = JSON.parse(raw)
      } catch {
        continue // 坏 JSON → 跳过
      }
      const m = asObject(v)
      if (!m) continue
      const rec = toZcodeManifestRecord(m)
      if (rec) out.push(rec)
    }
  }
  return out
}
