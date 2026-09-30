/**
 * TTS 音频格式与缓存治理纯函数（ai-voice-tts 设计 §7.4 步骤 3/4/6/7 的无状态部分）。
 *
 * 从 tts-service 按变化原因拆出：本模块只承载「文本切分 / PCM→WAV 封装 / 缓存键序列化 /
 * 缓存目录 FIFO 封顶」四件无 IO 依赖（除封顶的删除通道注入）的确定性计算，与编排服务
 * （配置读写、Key 联动、协议面）分开演化。全部导出为纯函数，单测直调。
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../infra/logger.js'
import { toErrorMessage } from '../utils/errors.js'

/** 分句句边界字符（设计 §7.4 步骤 4：中文句号/问号/叹号/换行优先；ASCII ? ! 一并算句尾）。 */
const SENTENCE_BOUNDARY_CHARS = new Set(['。', '！', '？', '!', '?', '\n'])

/**
 * canonical 序列化：递归键排序后 JSON 化——同配置恒同串（D5 缓存键的稳定性前提：
 * JSON.stringify 对对象键序敏感，passthrough/vendor 子树不经排序会因键序漂移换哈希）。
 * undefined 值字段剔除（与「字段缺席」等价，可选字段有无不产生虚假键差）。
 */
export function canonicalSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(',')}]`
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalSerialize(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 分句（设计 §7.4 步骤 4）：每段 ≤ maxChars 约束下句边界优先贪心打包——文本未超限时
 * 整段单发（段数 = 厂商请求数 = 额度消耗，不超限不多切）；需切时在句边界断开、超长句硬切。
 * 边界符归前段（朗读停顿跟随标点）。输入已清洗（无换行残留），换行边界仅作兜底。
 */
export function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return text.length > 0 ? [text] : []
  // 句边界一级切分 + 超长句硬切，得到一组 ≤ maxChars 的边界对齐片段
  const pieces: string[] = []
  let current = ''
  for (let i = 0; i < text.length; i++) {
    current += text[i]
    if (SENTENCE_BOUNDARY_CHARS.has(text[i])) {
      pieces.push(current)
      current = ''
    }
  }
  if (current) pieces.push(current)
  const bounded: string[] = []
  for (const piece of pieces) {
    if (piece.length <= maxChars) {
      bounded.push(piece)
      continue
    }
    for (let i = 0; i < piece.length; i += maxChars) bounded.push(piece.slice(i, i + maxChars))
  }
  // 二级贪心打包：相邻片段尽量合入同段，直到再加会越限（最少段数 = 最少厂商请求）
  const chunks: string[] = []
  let packed = ''
  for (const piece of bounded) {
    if (packed.length + piece.length > maxChars) {
      chunks.push(packed)
      packed = piece
      continue
    }
    packed += piece
  }
  if (packed) chunks.push(packed)
  return chunks.filter((chunk) => chunk.length > 0)
}

// ── WAV 头布局常量（RIFF/PCM 44 字节标准头，D9）——字段偏移逐一命名，消魔数 ──

const WAV_HEADER_BYTES = 44
const WAV_FMT_CHUNK_BYTES = 16
const WAV_PCM_FORMAT = 1
const WAV_BITS_PER_SAMPLE = 16
/** 位深→字节的换算基数（16 bit = 2 byte）。 */
const BITS_PER_BYTE = 8
/** RIFF size 字段语义 = 整个文件字节数减去其前 8 字节（'RIFF' 四字节 tag + size 字段自身）。 */
const RIFF_SIZE_EXCLUDES = 8
const WAV_OFFSET_RIFF_SIZE = 4
const WAV_OFFSET_WAVE_TAG = 8
const WAV_OFFSET_FMT_TAG = 12
const WAV_OFFSET_FMT_SIZE = 16
const WAV_OFFSET_FORMAT = 20
const WAV_OFFSET_CHANNELS = 22
const WAV_OFFSET_SAMPLE_RATE = 24
const WAV_OFFSET_BYTE_RATE = 28
const WAV_OFFSET_BLOCK_ALIGN = 32
const WAV_OFFSET_BITS = 34
const WAV_OFFSET_DATA_TAG = 36
const WAV_OFFSET_DATA_SIZE = 40

/**
 * PCM 裸流封装 44 字节标准 WAV 头（D9）：16-bit PCM、numChannels/采样率取 driver 回报
 * 实际值（多段不一致以第一段为准——同一 speak 内配置恒定，调用方保证只传首段值）。
 */
export function wrapWavHeader(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bytesPerSample = WAV_BITS_PER_SAMPLE / BITS_PER_BYTE
  const blockAlign = channels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const header = Buffer.alloc(WAV_HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(WAV_HEADER_BYTES - RIFF_SIZE_EXCLUDES + pcm.length, WAV_OFFSET_RIFF_SIZE)
  header.write('WAVE', WAV_OFFSET_WAVE_TAG, 'ascii')
  header.write('fmt ', WAV_OFFSET_FMT_TAG, 'ascii')
  header.writeUInt32LE(WAV_FMT_CHUNK_BYTES, WAV_OFFSET_FMT_SIZE)
  header.writeUInt16LE(WAV_PCM_FORMAT, WAV_OFFSET_FORMAT)
  header.writeUInt16LE(channels, WAV_OFFSET_CHANNELS)
  header.writeUInt32LE(sampleRate, WAV_OFFSET_SAMPLE_RATE)
  header.writeUInt32LE(byteRate, WAV_OFFSET_BYTE_RATE)
  header.writeUInt16LE(blockAlign, WAV_OFFSET_BLOCK_ALIGN)
  header.writeUInt16LE(WAV_BITS_PER_SAMPLE, WAV_OFFSET_BITS)
  header.write('data', WAV_OFFSET_DATA_TAG, 'ascii')
  header.writeUInt32LE(pcm.length, WAV_OFFSET_DATA_SIZE)
  return Buffer.concat([header, pcm])
}

export interface TtsCacheFifoCapOptions {
  maxFiles: number
  maxBytes: number
  /**
   * 文件删除通道（默认 rmSync force——只忽略 ENOENT，目标已被并发窗口删除时不抛）。
   * 注入点仅供单测注入失败形态（EBUSY/EACCES / 并发已删），生产不传。
   */
  remove?: (filePath: string) => void
}

/**
 * 双条件 FIFO 封顶（设计 §7.4 步骤 7）：文件数 > maxFiles **或** 总字节 > maxBytes 时
 * 按修改时间删最旧，直至两条件均满足（或队列耗尽）。磁盘治理而非正确性约束——
 * - 单文件删除失败（Windows 对播放中文件的 EBUSY/EACCES；force 只忽略 ENOENT，其余仍抛）
 *   记 warn 跳过、继续队列与主流程：删最旧可能命中正在播放的缓存（mtime 老恰为候选），
 *   POSIX unlink 后播放继续（已打开 fd 不受影响），Windows 留待下次封顶重试（目录可能
 *   暂超上限，下次写入收敛）。
 * - 并发幂等：多窗口并发触发封顶时各自删同一批最旧文件，后到者对已删目标按 force 语义
 *   静默成功（「对方窗口已完成清理」），不视为错误。
 * - 删除失败的目标不递减计数（文件仍在盘上，账实相符），循环在队列耗尽后自然终止。
 * 永不抛出（内部全捕获）——speak 主流程的最后一步，封顶失败不构成朗读失败。
 */
export function enforceTtsCacheFifoCap(cacheDir: string, opts: TtsCacheFifoCapOptions): void {
  const remove = opts.remove ?? ((filePath: string) => rmSync(filePath, { force: true }))
  let entries: { path: string; size: number; mtimeMs: number }[]
  try {
    entries = readdirSync(cacheDir)
      .filter((name) => name.endsWith('.wav'))
      .map((name) => {
        const filePath = join(cacheDir, name)
        // 并发窗口可能在 readdir 与 stat 之间已删掉该文件：按「对方已清理」跳过
        const st = statSync(filePath)
        return { path: filePath, size: st.size, mtimeMs: st.mtimeMs }
      })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return // 目录尚不存在：无物可封顶
    logger.warn('[tts] cache cap scan failed', { cacheDir, error: toErrorMessage(err) })
    return
  }
  let fileCount = entries.length
  let totalBytes = entries.reduce((sum, e) => sum + e.size, 0)
  if (fileCount <= opts.maxFiles && totalBytes <= opts.maxBytes) return
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs) // 最旧在前
  for (const entry of entries) {
    if (fileCount <= opts.maxFiles && totalBytes <= opts.maxBytes) break
    try {
      remove(entry.path)
      fileCount--
      totalBytes -= entry.size
    } catch (err) {
      logger.warn('[tts] cache cap: failed to remove cached file, skipped', {
        filePath: entry.path,
        error: toErrorMessage(err),
      })
    }
  }
}
