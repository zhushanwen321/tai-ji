/**
 * pi-semantics 探针族共享装置：dist 源码文本净化 + 按函数头提取函数体。
 *
 * 漂移语义与 pi-semantics-probe.ts 同口径：提取返回 null = 函数消失/改名/改形，
 * 调用方须按「装置漂移」fail（禁静默放行），各探针的装置用例即锚定这一点。
 */

/**
 * 源码扫描净化：去掉行注释/块注释；字符串字面量按 keepStrings 分流——
 * false = 整个字面量占位为一个空格（花括号配对不受字面量内未配对括号干扰），
 * true = 原样保留（字面量内容本身是断言对象时用，如 wire 协议事件串的语义缺席断言）。
 */
function scanCode(src: string, keepStrings: boolean): string {
  const n = src.length
  let out = ''
  let i = 0
  while (i < n) {
    const c = src[i]
    const d = i + 1 < n ? src[i + 1] : ''
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && i + 1 < n && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      if (keepStrings) {
        const q = c
        out += c
        i++
        while (i < n) {
          if (src[i] === '\\') {
            out += src[i] + (i + 1 < n ? src[i + 1] : '')
            i += 2
            continue
          }
          out += src[i]
          const closed = src[i] === q
          i++
          if (closed) break
        }
      } else {
        i++
        while (i < n) {
          if (src[i] === '\\') {
            i += 2
            continue
          }
          i++
          if (src[i - 1] === c) break
        }
        out += ' '
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/** 去注释并剥离字符串字面量内容（占位为空串），后续花括号配对基于净化文本。 */
export function stripToCode(src: string): string {
  return scanCode(src, false)
}

/** 只去注释，保留字符串字面量原文——注释里提及的效应词不构成命中，字面量内容参与断言。 */
export function stripComments(src: string): string {
  return scanCode(src, true)
}

/** 从 start（指向 '{'）做花括号配对，返回块文本与闭合后下标；字符串已剥离故无字面量干扰。 */
function matchBrace(src: string, start: number): { text: string; end: number } | null {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return { text: src.slice(start, i + 1), end: i + 1 }
    }
  }
  return null
}

/**
 * 在净化文本上按函数头（含 function 关键字与参数开括号，如
 * 'function createDialogPromise(' / 'async function executePreparedToolCall('）
 * 定位函数体；未命中返回 null（= 形态漂移，由调用方 fail）。
 */
export function extractFunctionBody(code: string, fnHeader: string): string | null {
  const head = code.indexOf(fnHeader)
  if (head === -1) return null
  const brace = code.indexOf('{', head)
  if (brace === -1) return null
  return matchBrace(code, brace)?.text ?? null
}
