/**
 * z 基线扫描器（测试基建，非产物）——§6.7 完备性判据的机器对账眼。
 *
 * 扫描口径（与 modal-surface-registry/manifest.ts 文件头一致）：
 * - 三类字面形态 + CSS 声明形：class token 形（形如 z 方括号 var 形）/ 裸数字 class 形 /
 *   inline style zIndex 形 / 样式表 z-index 声明形；
 * - `var(--z-*)` 按全仓 .css 的 `--z-*: <n>` token 表解析成数值，**解析值 ≥ 1000 才入基线**
 *   （--z-overlay: 20 故 PlanCommentPopover 的低 z 面不入基线；HoverCard z-[90] 同理豁免）；
 * - 注释/散文行按行首/行尾注释标记过滤（仓内有三处文档注释提及 z 字面量、非表面）；
 * - 排除：测试文件（*.test.* / *.spec.* / __tests__）、node_modules/dist 等产物目录、
 *   登记表模块自身（manifest 字面量是数据不是表面）。
 *
 * 一次性验证脚本纪律：本文件是 z-surface-baseline.test.ts 的常驻依赖（对照基线每次跑测
 * 重扫全仓），非一次性脚本，随测试资产留存。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/** 扫描根（仓库一级源码目录） */
const SCAN_ROOTS = ['packages', 'apps', 'extensions']
/** 跳过的产物/依赖目录 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test-results', 'coverage', '.git', '.turbo', '.vite'])
/** 参与扫描的源文件后缀 */
const SCAN_EXTS = new Set(['.vue', '.ts', '.tsx', '.css'])
/** 登记表模块自身（字面量是数据不是表面，防自指误报）；esc 扫描无自指面，传 null 不排除 */
const SELF_DIR_FRAGMENT = 'modal-surface-registry'

export type ZForm = 'class-token' | 'class-raw' | 'inline-style' | 'css-decl'

export interface ZOccurrence { // oe-exempt:20261003:test:测试夹具/扫描器数据形态 // oe-exempt:20261003:test:z 基线扫描测试夹具数据形态
  /** 仓库根相对路径 */
  file: string
  form: ZForm
  /** 字面量：token 名（var 形）或裸数字（字符串形态） */
  literal: string
  /** 解析后的 z 数值（≥ 1000 才会被收录） */
  value: number
}

/** 从 cwd 向上找仓库根（含 pnpm-workspace.yaml 的目录） */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir)
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`z-scan: 从 ${startDir} 向上未找到 pnpm-workspace.yaml（仓库根）`)
}

/** 递归收集扫描面内的源文件（排序稳定，报错信息可复现）；selfDirFragment = null 时不排除登记目录 */
function collectFiles(root: string, dir: string, out: string[], selfDirFragment: string | null = SELF_DIR_FRAGMENT): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    const rel = relative(root, full)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (selfDirFragment !== null && rel.includes(selfDirFragment)) continue
      if (rel.includes('__tests__')) continue
      collectFiles(root, full, out, selfDirFragment)
      continue
    }
    if (!entry.isFile()) continue
    const dotIdx = entry.name.lastIndexOf('.')
    if (dotIdx < 0) continue
    const ext = entry.name.slice(dotIdx)
    if (!SCAN_EXTS.has(ext)) continue
    if (/\.(test|spec|d)\.[^.]+$/.test(entry.name)) continue
    out.push(full)
  }
}

/** 注释/散文行判定（行首注释标记或行尾块注释收尾）——文档注释提及 z 字面量不算表面 */
function isProseLine(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed.startsWith('<!--')
    || trimmed.startsWith('//')
    || trimmed.startsWith('*')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('*/')
    || trimmed.endsWith('*/')
  )
}

/** 全仓 `--z-*: <n>` token 表（多定义同值合法；同名不同值会在此暴露） */
export function readZTokenTable(root: string): Map<string, number> {
  const files: string[] = []
  for (const scanRoot of SCAN_ROOTS) {
    const dir = join(root, scanRoot)
    if (existsSync(dir)) collectFiles(root, dir, files)
  }
  const tokens = new Map<string, number>()
  for (const file of files) {
    if (!file.endsWith('.css')) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      const m = /^\s*(--z-[a-z0-9-]+):\s*(\d+)\s*;/.exec(line)
      if (!m) continue
      const value = Number(m[2])
      const prev = tokens.get(m[1])
      if (prev !== undefined && prev !== value) {
        throw new Error(`z-scan: token ${m[1]} 定义冲突（${prev} vs ${value}，${file}）`)
      }
      tokens.set(m[1], value)
    }
  }
  return tokens
}

function resolveLiteral(literal: string, tokens: Map<string, number>): number {
  if (/^\d+$/.test(literal)) return Number(literal)
  const m = /^var\((--z-[a-z0-9-]+)\)$/.exec(literal)
  if (m) {
    const value = tokens.get(m[1])
    if (value === undefined) throw new Error(`z-scan: 字面量 ${literal} 引用的 token 未定义——先在 style.css 定义或改用数值`)
    return value
  }
  throw new Error(`z-scan: 无法解析的 z 字面量 '${literal}'`)
}

/**
 * 扫描全仓 z ≥ 1000 表面字面量（多重集，按 (file, form, literal) 归并由调用方处理）。
 * 同一文件同一字面量出现多次会产出多条（count 语义由登记表侧承载）。
 */
export function scanZSurfaces(root: string): ZOccurrence[] {
  const tokens = readZTokenTable(root)
  const files: string[] = []
  for (const scanRoot of SCAN_ROOTS) {
    const dir = join(root, scanRoot)
    if (existsSync(dir)) collectFiles(root, dir, files)
  }
  const occurrences: ZOccurrence[] = []
  for (const file of files) {
    const rel = relative(root, file)
    const lines = readFileSync(file, 'utf8').split('\n')
    const isCss = file.endsWith('.css')
    for (const line of lines) {
      if (isProseLine(line)) continue
      const push = (form: ZForm, literal: string): void => {
        const value = resolveLiteral(literal, tokens)
        if (value >= 1000) occurrences.push({ file: rel, form, literal, value })
      }
      // ① class token 形：z 方括号 var(--z-x) 形
      for (const m of line.matchAll(/z-\[var\((--z-[a-z0-9-]+)\)\]/g)) push('class-token', `var(${m[1]})`)
      // ② 裸数字 class 形：z 方括号数字形
      for (const m of line.matchAll(/z-\[(\d{2,})\]/g)) push('class-raw', m[1])
      // ③ inline style zIndex 形：行内 zIndex 赋值取全部 var 引用与 3-4 位裸数字
      if (line.includes('zIndex')) {
        for (const m of line.matchAll(/var\((--z-[a-z0-9-]+)\)/g)) push('inline-style', `var(${m[1]})`)
        for (const m of line.matchAll(/(?<![\w-])(\d{3,4})(?![\w-])/g)) push('inline-style', m[1])
      }
      // ④ CSS 声明形：z-index: <值>
      if (isCss) {
        const m = /^\s*z-index:\s*([^;]+);/.exec(line)
        if (m) push('css-decl', m[1].trim())
      }
    }
  }
  return occurrences.sort((a, b) =>
    a.file === b.file ? (a.literal < b.literal ? -1 : a.literal > b.literal ? 1 : 0) : a.file < b.file ? -1 : 1)
}

/** Esc 消费方命中（局部表面两档对照基线的扫描面，§6.7） */
export interface EscConsumerOccurrence { // oe-exempt:20261003:test:esc 基线扫描测试夹具数据形态
  /** 仓库根相对路径 */
  file: string
  /** 形态：'template-modifier'（@keydown.esc/.escape）/ 'string-literal'（'Escape'） */
  form: 'template-modifier' | 'string-literal'
  /** 行内命中片段（报错信息可定位） */
  snippet: string
}

/**
 * 扫描全仓 Esc 消费点（**三形态**，2026-10-03 F1-15 补盲：早期仅扫 'Escape' 字面量，
 * 结构性漏掉 Vue 模板 .esc/.escape 修饰符形态——ProjectSwitcher 创建输入漏登即此盲区）：
 * ① 模板修饰符形 `@keydown.esc` / `@keydown.escape`（可带 .prevent 等后续修饰符链）；
 * ② 字符串字面量形 `'Escape'`（window/document/元素级 keydown 判定的 JS/TS 形态）。
 * 注释/散文行过滤同 scanZSurfaces；排除测试文件与产物目录。
 */
export function scanEscConsumers(root: string): EscConsumerOccurrence[] {
  const files: string[] = []
  for (const scanRoot of SCAN_ROOTS) {
    const dir = join(root, scanRoot)
    if (existsSync(dir)) collectFiles(root, dir, files, null)
  }
  const occurrences: EscConsumerOccurrence[] = []
  for (const file of files) {
    if (!file.endsWith('.vue') && !file.endsWith('.ts')) continue
    const rel = relative(root, file)
    // 登记表数据文件自身非消费点（entry basis 字符串提及形态字面量属数据，防自指误报）
    if (rel.endsWith('local-esc-consumers.ts')) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      if (isProseLine(line)) continue
      for (const m of line.matchAll(/@keydown\.esc(?:ape)?[.="'\s]/g)) {
        occurrences.push({ file: rel, form: 'template-modifier', snippet: m[0].trim() })
      }
      if (line.includes("'Escape'")) {
        occurrences.push({ file: rel, form: 'string-literal', snippet: "'Escape'" })
      }
    }
  }
  return occurrences.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}
