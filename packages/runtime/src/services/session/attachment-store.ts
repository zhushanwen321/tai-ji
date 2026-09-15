/**
 * AttachmentStore — session 附件存储域（S1 从 SessionService 迁出，零耦合域先行）。
 *
 * writeImage / migrateImage / writeSegmentsMetadata 与 sessions Map、messageBus、
 * 子模块零共享状态（探针 P1/P2 已验），独立成模块。SessionService 保留一行委托
 * （ISessionService 对外契约不变）。
 *
 * 安全校验语义（原样搬自 main privileged-handlers，TC3 零削弱）随方法体迁移：
 * 20MB 上限 / mimeType image/* / name sanitize 防目录穿越 / fromPath 白名单 /
 * segments.json 原子写 + 损坏隔离。回归保护在 test/session-service.test.ts
 * 「业务持久化写安全守卫」（经 Facade 委托，行为等价 = P3）与
 * src/services/session/__tests__/attachment-store.test.ts（模块直接测试面）。
 *
 * 日志前缀保留 `[session-service]`（G3 行为等价：错误诊断流也是可观察行为，
 * 迁出不改写日志归属——与 quarantineCorruptFile 的 tag 同理）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { SegmentsMetadataEntry, SegmentsMetadataFile } from '@taiji/shared'
import { IMAGE_LIMITS } from '@taiji/shared'
// paths.ts 是 Node-only 模块，刻意不从 shared barrel 导出（见 shared/src/index.ts L32 注释），
// Node 端从子路径 import
import { getAttachmentsDir } from '@taiji/shared/paths'
import { isStrictlyUnder } from '../../utils/path-utils.js'
import { quarantineCorruptFile } from '../../utils/json-store.js'

export class AttachmentStore {
  // ── wave:runtime-patch ipc-converge-a3 W2：业务持久化写（从 main privileged-handlers 原样搬，安全校验 TC3 零削弱）──
  /**
   * 写入粘贴截图（base64 → attachments 文件）。
   *
   * sessionId 非空 → <dataDir>/attachments/<sessionId>/（持久化，persisted=true）；
   * 空 → OS tmpdir（landing 降级，session 创建后需 migrateImage，persisted=false）。
   *
   * 安全校验（原样搬自 main privileged-handlers，TC3 零削弱）：
   * - mimeType 必须以 image/ 开头（防借道写任意文件）
   * - base64 解码后 <= IMAGE_LIMITS.SINGLE_MAX_BYTES（20MB，防超大输入撑爆内存/磁盘）
   * - name sanitize 剥离路径分隔符 + 控制字符（防目录穿越），uuid 前缀保证唯一性
   */
  async writeImage(
    sessionId: string,
    base64: string,
    mimeType: string,
    name: string,
  ): Promise<{ path: string; fileName: string; displayName: string; id: string; persisted: boolean }> {
    if (!mimeType.startsWith('image/')) {
      throw new Error('mimeType must start with image/')
    }
    // 解码前按 base64 长度估算解码字节数（3/4 比例），超 SINGLE_MAX_BYTES 拒绝。
    // eslint-disable-next-line no-magic-numbers -- 3/4 是 base64 编码比例的协议常量，非业务魔数
    const decodedBytes = Math.ceil((base64.length * 3) / 4)
    if (decodedBytes > IMAGE_LIMITS.SINGLE_MAX_BYTES) {
      // eslint-disable-next-line no-magic-numbers -- 1024² 为字节→MB 单位换算常量，非业务魔数
      const sizeMB = Math.round(decodedBytes / 1024 / 1024)
      throw new Error(`图片过大（${sizeMB}MB），上限 20MB`)
    }
    const extByMime: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
    }
    const ext = extByMime[mimeType] ?? 'png'
    // sanitize name：剥离路径分隔符（/ \ :）和控制字符防目录穿越，trim 首尾空白。
    const extRegExp = new RegExp(`\\.${ext}$`, 'i')
    const sanitized = name.replace(/[/\\:\x00-\x1f]/g, '').trim().replace(extRegExp, '') || 'image'
    try {
      const dir = sessionId ? getAttachmentsDir(sessionId) : tmpdir()
      if (sessionId) mkdirSync(dir, { recursive: true })
      const filename = `${randomUUID()}-${sanitized}.${ext}`
      const fullPath = join(dir, filename)
      writeFileSync(fullPath, Buffer.from(base64, 'base64'))
      const isPlaceholder = sanitized === 'image'
      const displayName = isPlaceholder
        ? `截图-${formatTimestamp()}.${ext}`
        : `${sanitized}.${ext}`
      return { path: fullPath, fileName: filename, displayName, id: randomUUID(), persisted: !!sessionId }
    } catch (err) {
      console.error('[session-service] writeImage failed:', err)
      throw new Error('write-session-image failed')
    }
  }

  /**
   * 迁移 landing 态 tmpdir 图片到 attachments 持久化目录。
   *
   * 安全校验（原样搬自 main，TC3 零削弱）：
   * - sessionId 非空 + fromPath 存在
   * - fileName sanitize 剥离路径分隔符 + 控制字符（防逃逸 attachments 目录）
   * - fromPath 白名单：只允许从 OS tmpdir 或目标 session attachments 目录迁移（防 XSS move 敏感文件外泄）
   *   复用 runtime isStrictlyUnder（比 main isUnderPrefix 多一道 !isAbsolute 跨盘符防线，R1 增强非削弱）
   */
  async migrateImage(
    fromPath: string,
    sessionId: string,
    fileName: string,
  ): Promise<{ path: string }> {
    if (!sessionId) throw new Error('migrate-session-image requires non-empty sessionId')
    if (!existsSync(fromPath)) {
      throw new Error(`source file not found: ${fromPath}`)
    }
    try {
      // getAttachmentsDir 内已校验 sessionId 字符集（防路径穿越）
      const dir = getAttachmentsDir(sessionId)
      mkdirSync(dir, { recursive: true })
      const sanitized = fileName.replace(/[/\\:\x00-\x1f]/g, '').trim() || 'image'
      const newPath = join(dir, sanitized)
      // fromPath 白名单：只允许从 OS tmpdir 或目标 session attachments 迁移。
      const allowedSources = [tmpdir(), dir]
      const resolvedFrom = resolve(fromPath)
      if (!allowedSources.some((prefix) => isStrictlyUnder(prefix, resolvedFrom))) {
        throw new Error(`migrate-session-image fromPath outside allowed sources: ${fromPath}`)
      }
      renameSync(fromPath, newPath)
      return { path: newPath }
    } catch (err) {
      console.error('[session-service] migrateImage failed:', err)
      throw new Error('migrate-session-image failed')
    }
  }

  /**
   * 追加/覆盖一条 segments 元数据到 sidecar（segments.json）。
   *
   * 去重（[defer segments 化 / D-A1-2] 双 key 扩展）：同 clientUuid 重发（editAndResend）
   * → 后者覆盖前者（按 clientUuid 去重）；defer 条目按 deferEntryId 同款去重（flush
   * 重试重提交同条目 → 覆盖）。两条 key 空间互斥（直发链 u-<uuid> / defer 链裸 uuid），
   * 写入方二选一——按写入方自己的 key 匹配，不交叉。
   * atomic 写（tmp + rename），Windows EPERM/ENOTEMPTY 兜底 unlink+retry（原样搬自 main，TC3 零削弱）。
   */
  async writeSegmentsMetadata(sessionId: string, entry: SegmentsMetadataEntry): Promise<void> {
    if (!sessionId) throw new Error('write-segments-metadata requires non-empty sessionId')
    try {
      const dir = getAttachmentsDir(sessionId)
      mkdirSync(dir, { recursive: true })
      const filePath = join(dir, 'segments.json')
      // 读已有（文件不存在 → 空；损坏 → 隔离现场后降级为空，best-effort 不阻断写入）
      let file: SegmentsMetadataFile = { version: 1, entries: [] }
      if (existsSync(filePath)) {
        try {
          const raw = readFileSync(filePath, 'utf-8')
          const parsed = JSON.parse(raw) as SegmentsMetadataFile
          if (parsed && Array.isArray(parsed.entries)) file = parsed
        } catch (e) {
          // D1c 损坏隔离（integrity-hardening.md §3.1）：半截文件先 rename .corrupt-<ts>
          // 保留取证再降级为空——否则下方写入把「半截」合法化成「全空」，历史 segments
          // 永久丢失且不可恢复（与 JsonStore 共用同一 quarantine 实现，避免行为漂移）
          quarantineCorruptFile(filePath, { tag: 'session-service', reason: 'segments.json malformed', cause: e })
        }
      }
      // 去重按写入方自己的 key（两条 key 空间互斥）：defer 条目（deferEntryId 存在）按
      // deferEntryId 匹配覆盖；直发条目按 clientUuid 匹配覆盖；新 key 追加。
      const idx = entry.deferEntryId !== undefined
        ? file.entries.findIndex((e) => e.deferEntryId === entry.deferEntryId)
        : file.entries.findIndex((e) => e.clientUuid !== undefined && e.clientUuid === entry.clientUuid)
      if (idx >= 0) file.entries[idx] = entry
      else file.entries.push(entry)
      // atomic 写：临时文件 + rename。POSIX 同文件系统 rename 原子；
      // Windows 目标已存在时 renameSync 抛 EPERM/ENOTEMPTY → unlink 后重试。
      const JSON_INDENT = 2
      const tmpPath = filePath + '.tmp'
      writeFileSync(tmpPath, JSON.stringify(file, null, JSON_INDENT), 'utf-8')
      try {
        renameSync(tmpPath, filePath)
      } catch {
        // eslint-disable-next-line taste/no-silent-catch -- 目标不存在属预期（首次写入）；非 enoent 也无法恢复（后续 rename 会抛）
        try { unlinkSync(filePath) } catch { /* 目标不存在，忽略 */ }
        try {
          renameSync(tmpPath, filePath)
        } catch (retryErr) {
          // eslint-disable-next-line taste/no-silent-catch -- tmpPath 可能已被 rename 消费（并发竞争）；retryErr 才是要抛的真错误
          try { unlinkSync(tmpPath) } catch { /* tmpPath 可能已被 rename 消费，忽略 */ }
          throw retryErr
        }
      }
    } catch (err) {
      console.error('[session-service] writeSegmentsMetadata failed:', err)
      throw new Error('write-segments-metadata failed')
    }
  }
}

/** 生成 YYYYMMDD-HHMM 时间戳（displayName 用，本地时区；原样搬自 main privileged-handlers） */
function formatTimestamp(): string {
  const d = new Date()
  const PAD_WIDTH = 2
  const JANUARY_OFFSET = 1
  const pad = (n: number) => String(n).padStart(PAD_WIDTH, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + JANUARY_OFFSET)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}
