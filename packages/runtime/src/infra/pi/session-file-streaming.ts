/**
 * Session 文件流式归一化 IO 骨架（D5⑤，crash-resilience §3.3；u4c 从 session-file-utils.ts
 * 拆出——该文件 max-lines 预算由 sidecar/扫描家族占据，流式骨架成模块后各安其位）。
 *
 * 职责单一：「分块正序读 → 行界拼接 → 行级纯变换 → 临时名写入 → rename-over 原子替换」
 * 的 IO 形态，不耦合任何归一化业务语义（session_end 识别 / header cwd 修复全部在调用方
 * 的 transformLine 回调）。消费方 = restore-seeding（restore 附着最小规范化，D5⑤ 降级形态）。
 *
 * [R1 豁免形态约束] tmpPath 构造（'.tmp-migrate-' 字面量单跳赋值链）与全部写盘语句
 * （openSync(tmpPath,'w') / writeSync(out,…)）收拢在本模块函数内——写盘职责不外泄给
 * 回调，回调只做行级纯变换（R1 直写检查 exempt_tmp_migrate_target 的可判定形态；
 * 本文件无 sessions 路径推导痕迹，条件 A 本就不命中，双保险）。
 *
 * 内存界声明：任意时刻驻留 = 单块 buffer（默认 1MB）+ 跨块 pending 行，与文件总体积无关。
 */
import { openSync, readSync, closeSync, fstatSync, writeSync, unlinkSync, renameSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
// 块大小复用 u4b 逆序读工具的 D5② 标定值（1MB），不另设常量。infra → services 依赖倒挂
// 豁免（同 session-file-utils.ts 的 D5③ import，无循环引用——工具零业务依赖）。
import { DEFAULT_REVERSE_CHUNK_BYTES } from '../../utils/history-reverse-read.js'

/**
 * 分块流式归一化并原子替换原文件（D5⑤ 变换腿的落盘骨架）。
 *
 * 变换产物不经全文件字符串构造——分块正序读原文件、按行交给 transformLine 回调做纯
 * 行变换（返回 null = 剔除该行），变换结果直接写入临时文件后 rename-over 原子替换，
 * 任意时刻驻留 = 单块 + pending 行（大文件归一化不构成内存尖峰）。
 *
 * isFirstKeptLine 游标由本骨架维护（首个未被剔除的行 = true，回调产出非 null 后翻
 * false），语义 = 「strip 后产物首行」，与全量路径「先 strip 再对产物首行应用变换」的
 * 行游标一致（restore-seeding 的 cwd fallback 依赖此语义）。
 *
 * tmp 命名 / rename-over 原子替换 / 失败回滚 / scanner 排除语义与字符串版
 * normalizeSessionFileInPlace（session-file-utils.ts）同源：临时名 = basename +
 * '.tmp-migrate-' + 时间戳 + '.jsonl'（登记表 §4 ⑨，scanner 按 TMP_RESIDUE_MARKERS
 * 排除）；rename 失败回滚删除临时文件，原文件未触碰仍完整。
 *
 * @param filePath      原 session JSONL 绝对路径（内容被原子覆盖，路径不变）
 * @param transformLine 行级纯变换（line, isFirstKeptLine）→ 变换行 | null（剔除）
 * @param chunkBytes    读块字节数（默认 1MB，D5② 标定；测试注入小值覆盖跨块/多字节分支）
 */
export function normalizeSessionFileStreamingInPlace(
  filePath: string,
  transformLine: (line: string, isFirstKeptLine: boolean) => string | null,
  chunkBytes = DEFAULT_REVERSE_CHUNK_BYTES,
): void {
  // 临时名形态 = basename + '.tmp-migrate-' + 时间戳 + '.jsonl'（登记表 §4 ⑨；
  // R1 检查的豁免锚点 = '.tmp-migrate-' 字面量后缀，经写目标单跳赋值链回溯判定）
  const tmpPath = join(dirname(filePath), basename(filePath) + '.tmp-migrate-' + Date.now() + '.jsonl')
  const src = openSync(filePath, 'r')
  const out = openSync(tmpPath, 'w')
  try {
    const size = fstatSync(src).size
    const buf = Buffer.alloc(chunkBytes)
    let offset = 0
    let pending = '' // 跨块残行前缀（块边界切断的行，下一块拼接后交付）
    let isFirstKeptLine = true
    while (offset < size) {
      const bytesRead = readSync(src, buf, 0, Math.min(buf.length, size - offset), offset)
      if (bytesRead === 0) break
      const usable = trimToUtf8Boundary(buf, bytesRead)
      // 防御：usable===0 仅在块首即 continuation byte 时出现（上游错位，正常流程不可达）——
      // 放行整块避免死循环，接受该块一次 U+FFFD 污染（该块行被判非目标行的代价
      // 是多保留一行，方向安全）。
      offset += usable === 0 ? bytesRead : usable
      const text = pending + buf.toString('utf-8', 0, usable)
      const segs = text.split('\n')
      pending = segs.pop() ?? '' // 尾段 = 被切断的残行前缀（下一块续）或 EOF 终止行
      const kept: string[] = []
      for (const line of segs) {
        const transformed = transformLine(line, isFirstKeptLine)
        if (transformed === null) continue // 剔除（空行 / 调用方判定的目标行）
        kept.push(transformed)
        isFirstKeptLine = false
      }
      if (kept.length > 0) {
        writeSync(out, kept.join('\n') + '\n')
      }
    }
    if (pending !== '') {
      // EOF 终止行（文件末尾无 \n 的最后一行；strip 语义会为其补回 \n）
      const transformed = transformLine(pending, isFirstKeptLine)
      if (transformed !== null) {
        writeSync(out, transformed + '\n')
      }
    }
    renameSync(tmpPath, filePath)
  } catch (e) {
    // rename / 读取 / 写入失败回滚（差距复审 suggestion 6 同责）：删除临时文件不留孤儿——
    // 原文件未被触碰仍完整；回滚删除自身失败时仅残留一个被 scanner 排除的孤儿，
    // 附着前清扫 / delete 链清扫兜底。
    try { unlinkSync(tmpPath) } catch { void 0 }
    throw e
  } finally {
    closeSync(src)
    closeSync(out)
  }
}

/**
 * 块尾 UTF-8 多字节截断防御：返回块内可安全 toString('utf-8') 的字节长度。
 *
 * 块边界可能落在多字节序列中间——直接 toString 会把残缺序列替换为 U+FFFD 污染行内容
 * （行内容进调用方判定（如 session_end 识别）/ JSON parse，污染 = 判定失真）。本函数从
 * 块尾向前跳过 continuation bytes（10xxxxxx）定位 lead byte，若其声明的序列长度超出块尾
 * 则把该序列整体留给下一块（readSync 按 offset 重读，不丢失）。块首恒为字符边界
 * （offset 按上一块的返回值对齐，offset=0 天然对齐）。
 */
/* eslint-disable no-magic-numbers -- UTF-8 位级判定：掩码 0xc0/0x80 与序列长度 2/3/4 是
 * RFC 3629 协议常量（lead/continuation 字节形态），命名抽象反而掩盖位语义 */
function trimToUtf8Boundary(buf: Buffer, len: number): number {
  let end = len
  // UTF-8 序列最长 4 字节 → 块尾最多回退 3 个 continuation byte
  let check = 0
  while (check < 3 && end > 0 && (buf[end - 1] & 0xc0) === 0x80) {
    end--
    check++
  }
  if (end > 0 && (buf[end - 1] & 0x80) !== 0) {
    // buf[end-1] 是 lead byte（110xxxxx/1110xxxx/11110xxxx）
    const lead = buf[end - 1]
    const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2
    if (end - 1 + seqLen > len) {
      return end - 1 // 序列被块尾截断 → 截到 lead 前（残字节随下一块 readSync 重读）
    }
    return len // 序列完整落在块内 → 全块可用（[end, len) 的 continuation 属于该序列）
  }
  return end // 块尾是 ASCII 或整块都是序列中段（不可达防御）：按原长放行
}
/* eslint-enable no-magic-numbers */
