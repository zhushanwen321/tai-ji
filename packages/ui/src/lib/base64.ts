/**
 * 字节数组 → base64（分块 binary 字符串 + 单次 btoa）。
 *
 * 分块必要性：每块 0x8000 字节（低于 Function.prototype.apply 参数个数下限，
 * Safari 65536），防大 buffer 直接展开爆栈/RangeError；
 * 单次 btoa 必要性：base64 以 3 字节为一组，逐块 btoa 会在块长非 3 倍数时错位，
 * 必须拼完整 binary 字符串后整体编码。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(binary)
}
