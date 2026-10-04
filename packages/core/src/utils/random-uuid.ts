/**
 * Secure-context 安全的 UUID v4 生成（core 内唯一入口，禁止直调 crypto.randomUUID）。
 *
 * crypto.randomUUID 是 Web API，仅在 secure context（https / file:// / localhost）暴露：
 * LAN http 访问（http://<lan-ip>:<port>）下 isSecureContext=false 时该方法为 undefined，
 * 直接调用抛 TypeError（U1.6 真机验收发现的 P0：移动壳首个 RPC 即炸）。桌面无感
 * （file:// 属 secure context）。crypto.getRandomValues 无 secure context 限制，
 * 作为 fallback 手拼 RFC 4122 v4（版本位 / 变体位按 spec 置位）。
 */

/** RFC 4122 §4.1：uuid 由 16 字节（128 位）构成 */
const UUID_BYTE_COUNT = 16
/** §4.1.2 字段布局（字节边界）：time_low(0-3) / time_mid(4-5) / time_hi_and_version(6-7) / clock_seq(8-9) / node(10-15) */
const TIME_LOW_END_BYTE = 4
const TIME_MID_END_BYTE = 6
const TIME_HI_END_BYTE = 8
const CLOCK_SEQ_END_BYTE = 10
const NODE_END_BYTE = 16
const FIELD_END_BYTES = [
  TIME_LOW_END_BYTE,
  TIME_MID_END_BYTE,
  TIME_HI_END_BYTE,
  CLOCK_SEQ_END_BYTE,
  NODE_END_BYTE,
] as const
/** version 字段 = time_hi_and_version 高 4 位（第 7 字节） */
const VERSION_BYTE_INDEX = 6
/** variant 字段 = clock_seq 高 2 位（第 9 字节） */
const VARIANT_BYTE_INDEX = 8
/** version 字节保留低 4 位的掩码 */
const VERSION_LOW_NIBBLE_MASK = 0x0f
/** v4 版本值：高 4 位 = 0100 */
const VERSION_4_BITS = 0x40
/** variant 字节保留低 6 位的掩码 */
const VARIANT_LOW_BITS_MASK = 0x3f
/** RFC 4122 变体值：高 2 位 = 10 */
const VARIANT_RFC4122_BITS = 0x80
/** hex 编码每字节 2 字符 */
const HEX_CHARS_PER_BYTE = 2
/** hex 编码进制 */
const HEX_RADIX = 16

export function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackUuidV4()
}

/** RFC 4122 §4.4：16 随机字节，version 位（0100）与 RFC 4122 variant 位（10）置位 */
function fallbackUuidV4(): string {
  const bytes = new Uint8Array(UUID_BYTE_COUNT)
  globalThis.crypto.getRandomValues(bytes)
  bytes[VERSION_BYTE_INDEX]! = (bytes[VERSION_BYTE_INDEX]! & VERSION_LOW_NIBBLE_MASK) | VERSION_4_BITS
  bytes[VARIANT_BYTE_INDEX]! = (bytes[VARIANT_BYTE_INDEX]! & VARIANT_LOW_BITS_MASK) | VARIANT_RFC4122_BITS
  const hex = Array.from(bytes, (b) => b.toString(HEX_RADIX).padStart(HEX_CHARS_PER_BYTE, '0')).join('')
  // §3 canonical 8-4-4-4-12 分组：按字段字节边界切片后连字符拼接
  const groups: string[] = []
  let start = 0
  for (const endByte of FIELD_END_BYTES) {
    const end = endByte * HEX_CHARS_PER_BYTE
    groups.push(hex.slice(start, end))
    start = end
  }
  return groups.join('-')
}
