/**
 * JSONL 序列化原语：canonical entries → session JSONL 文本。
 *
 * 字节契约（P-serializer，与 pi 产物逐字节兼容）：每行 = `JSON.stringify(entry) + '\n'`
 * （pi session-manager `_persist` 同款）；键序责任在 Entry 对象构造方——pi appendMessage
 * 与 converter emitEntry 均按 `{type, id, parentId, timestamp, ...payload}` 顺序构造，
 * 本函数不重排键、不丢接口外字段。空值处理由 JSON.stringify 原生承担：undefined 值
 * 字段不落盘，`parentId: null` 落盘为 `"parentId":null`（root entry 语义，pi 同款）。
 */

import type { Entry } from './types.js'

export function serializeSession(entries: readonly Entry[]): string {
  let out = ''
  for (const entry of entries) {
    out += `${JSON.stringify(entry)}\n`
  }
  return out
}
