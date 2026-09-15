/**
 * minimal zip 容器——writer + central directory 读取器（零依赖，crash-forensics u3a）。
 *
 * 【为什么手写】apps/electron 既有依赖无 zip 容器能力（extract-zip / unzipper 只解压；
 * tar 是 tar 容器非 zip；electron-builder 的 zip 能力在 app-builder-bin 内部 CLI，非
 * 运行时库），而 main bundle 策略是「第三方 npm 包一律打进 main.cjs」
 * （vite.config.main.ts [HISTORICAL]），新增 zip 库会直接进产物且需动 lock。zip 容器
 * 格式（PKWARE APPNOTE）是稳定规范，本实现只覆盖诊断包所需子集：deflate
 * （node:zlib 内置）+ store 回退、非 zip64（产物 ≪ 4GB 上限）、受控 ASCII 条目名。
 *
 * 【纯函数】无 fs / electron 依赖——字节进字节出；落盘由调用方 writeFileSync 承担。
 * listZipEntries 既是测试的反向验证面（A2「用实现反向验证列条目」），也供消费方
 * 无需解包即可核对包内容。
 */
import { deflateRawSync } from 'node:zlib'

// zip 容器布局常量（PKWARE APPNOTE 字段偏移）——命名常量即布局文档，禁止行内裸数字。
// 三段结构：每条目 local file header + 数据；尾部 central directory（每条目一条）+ EOCD。
const ZIP_LOCAL_HEADER_SIG = 0x04034b50
const ZIP_CENTRAL_HEADER_SIG = 0x02014b50
const ZIP_EOCD_SIG = 0x06054b50
/** 压缩方法（APPNOTE §4.4.5）：8 = deflate，0 = store（不压缩）。 */
const ZIP_METHOD_DEFLATE = 8
const ZIP_METHOD_STORE = 0
/** 通用位标志 bit 11（APPNOTE §4.4.4）：文件名 UTF-8 编码。 */
const ZIP_FLAG_UTF8 = 0x0800
/** 解压所需最低版本 2.0（APPNOTE §4.4.3，deflate 的要求）。 */
const ZIP_VERSION_NEEDED = 20
/** deflate 压缩级别（zlib 默认档）。 */
const ZIP_DEFLATE_LEVEL = 6

// Local file header 固定段 30 字节内的字段偏移（APPNOTE §4.3.7）。
const LOCAL_FIXED_LEN = 30
const LOCAL_SIG = 0, LOCAL_VERSION_NEEDED = 4, LOCAL_FLAGS = 6, LOCAL_METHOD = 8
const LOCAL_MOD_TIME = 10, LOCAL_MOD_DATE = 12, LOCAL_CRC32 = 14
const LOCAL_COMPRESSED_SIZE = 18, LOCAL_UNCOMPRESSED_SIZE = 22
const LOCAL_NAME_LEN = 26, LOCAL_EXTRA_LEN = 28

// Central directory file header 固定段 46 字节内的字段偏移（APPNOTE §4.3.12）。
const CENTRAL_FIXED_LEN = 46
const CENTRAL_SIG = 0, CENTRAL_VERSION_MADE_BY = 4, CENTRAL_VERSION_NEEDED = 6, CENTRAL_FLAGS = 8
const CENTRAL_METHOD = 10, CENTRAL_MOD_TIME = 12, CENTRAL_MOD_DATE = 14, CENTRAL_CRC32 = 16
const CENTRAL_COMPRESSED_SIZE = 20, CENTRAL_UNCOMPRESSED_SIZE = 24
const CENTRAL_NAME_LEN = 28, CENTRAL_EXTRA_LEN = 30, CENTRAL_COMMENT_LEN = 32
const CENTRAL_DISK_START = 34, CENTRAL_INTERNAL_ATTRS = 36, CENTRAL_EXTERNAL_ATTRS = 38
const CENTRAL_LOCAL_HEADER_OFFSET = 42

// End of central directory record 固定 22 字节内的字段偏移（APPNOTE §4.3.16）。
const EOCD_FIXED_LEN = 22
const EOCD_SIG = 0, EOCD_DISK_NUMBER = 4, EOCD_CD_START_DISK = 6
const EOCD_ENTRIES_THIS_DISK = 8, EOCD_ENTRIES_TOTAL = 10
const EOCD_CD_SIZE = 12, EOCD_CD_OFFSET = 16, EOCD_COMMENT_LEN = 20
/** EOCD 倒序扫描窗上限（comment 最长 0xFFFF 字节）。 */
const EOCD_MAX_COMMENT_BYTES = 0xffff

// CRC-32（IEEE 反射多项式）参数：256 项查表、每字节移位 8 次；init/xor-out 为全 1。
const CRC32_TABLE_SIZE = 256
const CRC32_POLYNOMIAL = 0xedb88320
const CRC32_INIT = 0xffffffff, CRC32_XOR_OUT = 0xffffffff
const CRC32_BYTE_MASK = 0xff, CRC32_SHIFTS_PER_BYTE = 8

// MS-DOS 日期时间位布局（APPNOTE §4.4.6/§4.4.7）：2 秒粒度、1980 纪元。
const DOS_SECONDS_PER_UNIT = 2
const DOS_TIME_HOUR_SHIFT = 11, DOS_TIME_MINUTE_SHIFT = 5
const DOS_DATE_YEAR_SHIFT = 9, DOS_DATE_MONTH_SHIFT = 5
const DOS_EPOCH_YEAR = 1980

/** zip 条目输入（archivePath 用 POSIX 分隔符；ASCII 名——诊断包条目名全部受控）。 */
export interface ZipEntryInput {
  archivePath: string
  /** ArrayBufferLike：接受 readFileSync 的 Buffer 与 subarray 零复制视图 */
  data: Buffer<ArrayBufferLike>
  mtime?: Date
}

const CRC32_TABLE: readonly number[] = (() => {
  const table: number[] = new Array(CRC32_TABLE_SIZE)
  for (let n = 0; n < CRC32_TABLE_SIZE; n++) {
    let c = n
    for (let k = 0; k < CRC32_SHIFTS_PER_BYTE; k++) c = (c & 1) !== 0 ? CRC32_POLYNOMIAL ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer<ArrayBufferLike>): number {
  let c = CRC32_INIT
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]!) & CRC32_BYTE_MASK]! ^ (c >>> CRC32_SHIFTS_PER_BYTE)
  return (c ^ CRC32_XOR_OUT) >>> 0
}

/** MS-DOS 日期时间（zip 规范字段：2 秒精度、1980 年起）。 */
function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    (d.getHours() << DOS_TIME_HOUR_SHIFT) |
    (d.getMinutes() << DOS_TIME_MINUTE_SHIFT) |
    Math.floor(d.getSeconds() / DOS_SECONDS_PER_UNIT)
  const date =
    ((d.getFullYear() - DOS_EPOCH_YEAR) << DOS_DATE_YEAR_SHIFT) |
    ((d.getMonth() + 1) << DOS_DATE_MONTH_SHIFT) |
    d.getDate()
  return { time, date }
}

/**
 * 构造 zip 容器字节（minimal writer：无 zip64 / 加密 / 多盘；deflate 压缩率不优于
 * store 时回退 store）。输出可直接 writeFileSync——产物可被任何标准解压器打开。
 */
export function buildZipArchive(entries: readonly ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.archivePath, 'utf8')
    const crc = crc32(entry.data)
    let method = ZIP_METHOD_DEFLATE
    let payload: Buffer<ArrayBufferLike> = deflateRawSync(entry.data, { level: ZIP_DEFLATE_LEVEL })
    if (payload.length >= entry.data.length) {
      method = ZIP_METHOD_STORE
      payload = entry.data
    }
    const { time, date } = dosDateTime(entry.mtime ?? new Date())

    const local = Buffer.alloc(LOCAL_FIXED_LEN + nameBuf.length)
    local.writeUInt32LE(ZIP_LOCAL_HEADER_SIG, LOCAL_SIG)
    local.writeUInt16LE(ZIP_VERSION_NEEDED, LOCAL_VERSION_NEEDED)
    local.writeUInt16LE(ZIP_FLAG_UTF8, LOCAL_FLAGS)
    local.writeUInt16LE(method, LOCAL_METHOD)
    local.writeUInt16LE(time, LOCAL_MOD_TIME)
    local.writeUInt16LE(date, LOCAL_MOD_DATE)
    local.writeUInt32LE(crc, LOCAL_CRC32)
    local.writeUInt32LE(payload.length, LOCAL_COMPRESSED_SIZE)
    local.writeUInt32LE(entry.data.length, LOCAL_UNCOMPRESSED_SIZE)
    local.writeUInt16LE(nameBuf.length, LOCAL_NAME_LEN)
    local.writeUInt16LE(0, LOCAL_EXTRA_LEN)
    nameBuf.copy(local, LOCAL_FIXED_LEN)
    localParts.push(local, payload)

    const central = Buffer.alloc(CENTRAL_FIXED_LEN + nameBuf.length)
    central.writeUInt32LE(ZIP_CENTRAL_HEADER_SIG, CENTRAL_SIG)
    // version made by 高字节平台位（APPNOTE §4.4.2）：0 = FAT/无平台特化属性，最低版本同 needed
    central.writeUInt16LE(ZIP_VERSION_NEEDED, CENTRAL_VERSION_MADE_BY)
    central.writeUInt16LE(ZIP_VERSION_NEEDED, CENTRAL_VERSION_NEEDED)
    central.writeUInt16LE(ZIP_FLAG_UTF8, CENTRAL_FLAGS)
    central.writeUInt16LE(method, CENTRAL_METHOD)
    central.writeUInt16LE(time, CENTRAL_MOD_TIME)
    central.writeUInt16LE(date, CENTRAL_MOD_DATE)
    central.writeUInt32LE(crc, CENTRAL_CRC32)
    central.writeUInt32LE(payload.length, CENTRAL_COMPRESSED_SIZE)
    central.writeUInt32LE(entry.data.length, CENTRAL_UNCOMPRESSED_SIZE)
    central.writeUInt16LE(nameBuf.length, CENTRAL_NAME_LEN)
    central.writeUInt16LE(0, CENTRAL_EXTRA_LEN)
    central.writeUInt16LE(0, CENTRAL_COMMENT_LEN)
    central.writeUInt16LE(0, CENTRAL_DISK_START)
    central.writeUInt16LE(0, CENTRAL_INTERNAL_ATTRS)
    central.writeUInt32LE(0, CENTRAL_EXTERNAL_ATTRS)
    central.writeUInt32LE(offset, CENTRAL_LOCAL_HEADER_OFFSET)
    nameBuf.copy(central, CENTRAL_FIXED_LEN)
    centralParts.push(central)

    offset += local.length + payload.length
  }

  const centralBuf = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(EOCD_FIXED_LEN)
  eocd.writeUInt32LE(ZIP_EOCD_SIG, EOCD_SIG)
  eocd.writeUInt16LE(0, EOCD_DISK_NUMBER)
  eocd.writeUInt16LE(0, EOCD_CD_START_DISK)
  eocd.writeUInt16LE(entries.length, EOCD_ENTRIES_THIS_DISK)
  eocd.writeUInt16LE(entries.length, EOCD_ENTRIES_TOTAL)
  eocd.writeUInt32LE(centralBuf.length, EOCD_CD_SIZE)
  eocd.writeUInt32LE(offset, EOCD_CD_OFFSET)
  eocd.writeUInt16LE(0, EOCD_COMMENT_LEN)
  return Buffer.concat([...localParts, centralBuf, eocd])
}

/**
 * 从 zip 字节解析条目名清单（central directory 读取器）。
 * 容忍尾部 comment：EOCD 从缓冲区末尾向前扫签名。解析不出 EOCD 返回 null（非抛错）。
 */
export function listZipEntries(zip: Buffer<ArrayBufferLike>): string[] | null {
  const eocdStart = findEocdOffset(zip)
  if (eocdStart === null) return null
  const entryCount = zip.readUInt16LE(eocdStart + EOCD_ENTRIES_TOTAL)
  const cdOffset = zip.readUInt32LE(eocdStart + EOCD_CD_OFFSET)
  const names: string[] = []
  let cursor = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (cursor + CENTRAL_FIXED_LEN > zip.length || zip.readUInt32LE(cursor + CENTRAL_SIG) !== ZIP_CENTRAL_HEADER_SIG) return null
    const nameLen = zip.readUInt16LE(cursor + CENTRAL_NAME_LEN)
    const extraLen = zip.readUInt16LE(cursor + CENTRAL_EXTRA_LEN)
    const commentLen = zip.readUInt16LE(cursor + CENTRAL_COMMENT_LEN)
    names.push(zip.subarray(cursor + CENTRAL_FIXED_LEN, cursor + CENTRAL_FIXED_LEN + nameLen).toString('utf8'))
    cursor += CENTRAL_FIXED_LEN + nameLen + extraLen + commentLen
  }
  return names
}

/** EOCD 倒序扫描（容忍尾部 comment，扫描窗 = 固定 22 字节 + comment 上限）。 */
function findEocdOffset(zip: Buffer<ArrayBufferLike>): number | null {
  const min = Math.max(0, zip.length - EOCD_FIXED_LEN - EOCD_MAX_COMMENT_BYTES)
  for (let i = zip.length - EOCD_FIXED_LEN; i >= min; i--) {
    if (zip.readUInt32LE(i) === ZIP_EOCD_SIG) return i
  }
  return null
}
