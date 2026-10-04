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
/** hex 编码进制与每字节字符数 */
const HEX_RADIX = 16
const HEX_CHARS_PER_BYTE = 2
// RFC 4122 §4.1.2 位值：version 占 time_hi_and_version（第 7 字节）高 4 位、保留低 4 位，
// v4 = 0100；variant 占 clock_seq（第 9 字节）高 2 位、保留低 6 位，RFC 4122 形态 = 10。
const VERSION_LOW_NIBBLE_MASK = 0x0f
const VERSION_4_BITS = 0x40
const VARIANT_LOW_BITS_MASK = 0x3f
const VARIANT_RFC4122_BITS = 0x80

export function randomUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackUuidV4()
}

/** RFC 4122 §4.4：16 随机字节，version 位（0100）与 RFC 4122 variant 位（10）置位 */
function fallbackUuidV4(): string {
  const bytes = new Uint8Array(UUID_BYTE_COUNT)
  globalThis.crypto.getRandomValues(bytes)
  bytes[6]! = (bytes[6]! & VERSION_LOW_NIBBLE_MASK) | VERSION_4_BITS
  bytes[8]! = (bytes[8]! & VARIANT_LOW_BITS_MASK) | VARIANT_RFC4122_BITS
  const hex = Array.from(bytes, (b) => b.toString(HEX_RADIX).padStart(HEX_CHARS_PER_BYTE, '0')).join('')
  // §3 canonical 8-4-4-4-12 分组（§4.1.2 字段 hex 边界）：单行正则按字段切片插连字符
  return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
}
