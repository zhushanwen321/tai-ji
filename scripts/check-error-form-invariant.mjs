#!/usr/bin/env node
/**
 * check-error-form-invariant.mjs — error 终态消息形态统一守卫（M2 形态统一，机器护栏）。
 *
 * 不变量：凡对象字面量声明 `role: 'assistant'` 且 `status: 'error'`（Message 构造），
 * 必须同时含 `error:` 键（错误文本只住 error 字段，content 恒为崩溃前正文）。
 * 违规形态 = 历史上「纯 error 靠 content 承载错误文本 / 收口漏写 error 字段」的复发面
 * ——渲染端以 error 字段有无决定「正文原色 + 独立 danger 行」，缺 error 键的消息要么
 * 错误不可见、要么倒退回「正文整条染红」的旧 bug（2026-09 变红事故根因形态）。
 *
 * 覆盖范围（静态字面量判定）：
 *   - 扫描 packages/core/src、packages/ui/src、packages/renderer/src 的 .ts/.vue（生产码）；
 *   - 豁免测试（*.test.ts / __tests__/ 目录）：测试可构造防御形态做负向断言。
 *
 * 边界（已知不覆盖，由单测不变量补位）：
 *   - 动态 status（如 `status: isErrorStop ? 'error' : 'complete'`）静态扫描不判定——
 *     两个动态终态出口（finalizeStreamingMessage / terminalMessagePatch）经共享
 *     REASON_FALLBACK_ERROR_TEXT 兜底，由 streaming-state-machine.test / effects.test 锁定。
 *
 * 用法：node scripts/check-error-form-invariant.mjs（缺省扫仓库根，exit 1 = 违规）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const SCAN_ROOTS = [
  'packages/core/src',
  'packages/ui/src',
  'packages/renderer/src',
]
const SCAN_SUFFIXES = ['.ts', '.vue']
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'test-results', '__tests__'])

/**
 * 提取源码中所有配平的对象字面量块（花括号配平；字符串/模板字面量内的花括号与
 * 注释内容不参与配平、不参与检测——防注释示例与字符串内容误报）。
 * 返回 [{ text, line }]（line = 块起始行，1-based）。
 */
function extractObjectLiterals(source) {
  const blocks = []
  const stack = [] // 每项：块起始 index
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]
    // 行注释
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    // 块注释
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    // 字符串（单/双/模板）：跳过整段，内部 {} 不配平、内容不检测
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i++
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i] === quote) { i++; break }
        i++
      }
      continue
    }
    if (c === '{') {
      stack.push(i)
      i++
      continue
    }
    if (c === '}') {
      const start = stack.pop()
      if (stack.length === 0 && start !== undefined) {
        // 顶层配平块（嵌套块的属性值对象由最外层块原文一并覆盖，正则按「块内出现」判定）
        blocks.push({ text: source.slice(start, i + 1), line: source.slice(0, start).split('\n').length })
      }
      i++
      continue
    }
    i++
  }
  return blocks
}

const RE_ROLE_ASSISTANT = /role\s*:\s*['"]assistant['"]/
const RE_STATUS_ERROR = /status\s*:\s*['"]error['"]/
const RE_ERROR_KEY = /\berror\s*:/

const violations = []
let scanned = 0

function scanFile(absPath) {
  scanned++
  const source = readFileSync(absPath, 'utf8')
  for (const block of extractObjectLiterals(source)) {
    if (RE_ROLE_ASSISTANT.test(block.text) && RE_STATUS_ERROR.test(block.text) && !RE_ERROR_KEY.test(block.text)) {
      violations.push(`${path.relative(ROOT, absPath)}:${block.line}`)
    }
  }
}

function walk(absDir) {
  let entries
  try {
    entries = readdirSync(absDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (EXCLUDED_DIR_NAMES.has(name)) continue
    const abs = path.join(absDir, name)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(abs)
    } else if (SCAN_SUFFIXES.some((s) => name.endsWith(s)) && !name.endsWith('.test.ts')) {
      scanFile(abs)
    }
  }
}

for (const rel of SCAN_ROOTS) {
  walk(path.join(ROOT, rel))
}

if (violations.length > 0) {
  console.error(`[error-form-invariant] 违规 ${violations.length} 处：role:'assistant' + status:'error' 的消息字面量必须含 error: 键（错误文本只住 error 字段，content 恒为崩溃前正文——见 scripts/check-error-form-invariant.mjs 头注）`)
  for (const v of violations) {
    console.error(`  ${v}`)
  }
  console.error('[FIX] 把错误文本移入 error 字段（content 留崩溃前正文，无则为空串），或经 finalizeSession/terminalMessagePatch 收口（自带兜底）。')
  process.exit(1)
}
console.log(`[error-form-invariant] OK：${scanned} 个文件扫描通过（${SCAN_ROOTS.join(' / ')}）`)
