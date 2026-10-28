#!/usr/bin/env node
/**
 * check-test-blind-wait.mjs — 测试盲等形态检查（CPU 并发时序偶发防再发）。
 *
 * 拦什么：「sleep 固定毫秒后断言异步效果」（盲等）——CPU 忙时事件循环延迟吃掉
 * 预留余量，断言在条件成立前执行，表现为「单跑绿、并发挂」的偶发假红
 * （v0.11.9 ui 包偶发失败的根因形态；2026-10-20 全仓清理 16 处后加本检查防再发）。
 *
 * 判定形态（测试文件，且文件不含 useFakeTimers）：
 *   1. await new Promise((r) => setTimeout(r, N))，N >= 50（resolve 形态盲等）
 *   2. sleep(N) / delay(N) / waitForMs(N)，N >= 50（毫秒级 helper 盲等调用）
 * 范围外：仓根 e2e/（Playwright 真机 真实进程层——串行空载跑、非 CI 门禁线，其盲等
 * 治理另行安排，见 docs/todo/）；行内 // 注释后缀剥除后匹配（防注释文字误报，
 * 字符串中的 https:// 被切坏只可能漏报不会误报，可接受）。
 * 已知盲区：resolve 在箭头体外调用的复杂形态（setTimeout(() => resolve(), N) 内联
 * 体目前不匹配）——靠 review 兜底，出现后再扩形态。
 *
 * 用法：
 *   node .githooks/check-test-blind-wait.mjs <file...>   # pre-commit：只查传入文件
 *   node .githooks/check-test-blind-wait.mjs             # 无参：全仓扫描（CI / 手动）
 *
 * 豁免：BLIND_WAIT_EXEMPT（下方登记表，唯一登记处，逐条附理由）——仅限形态性
 * 误报（条件轮询的循环间隔先查条件再 sleep、被静态分析的 fixture 字符串）。
 * 新增豁免须先确认不是真盲等；豁免按文件级登记（行号会漂移，不作 key）。
 *
 * 规则正反例：docs/TEST-STRATEGY.md「异步等待写法」节。
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { isAbsolute, join, relative } from 'node:path'

/** 文件级豁免登记表（唯一登记处）：路径 → 理由。新增逐条附理由，禁止整类放宽。 */
const BLIND_WAIT_EXEMPT = {
  // waitForTerminal helper：每轮先查 isRunSettled 条件再 sleep，超时带 run 状态诊断——条件轮询间隔，非盲等
  'packages/subagent-core/src/orchestration/__tests__/non-cloneable-return-e2e.test.ts':
    'waitForTerminal 条件轮询的循环间隔（先查条件再 sleep，超时抛错带状态快照）',
  // L233 的 setTimeout 在被 lintScript 静态分析的 fixture 源码字符串里，永不执行——测试输入数据
  'packages/subagent-core/src/orchestration/__tests__/script-lint.test.ts':
    'setTimeout 出现在被静态分析的 fixture 源码字符串中（测试输入，非执行代码）',
  // CDP 轮询循环间隔，且用例被 it.skipIf(TAIJI_E2E_HOST_PROJECTION_CDP) 门控默认跳过
  'extensions/universal/subagent-workflow/src/__tests__/scenario-25-host-projection.test.ts':
    'CDP 条件轮询间隔 + 用例经 it.skipIf 门控',
  // waitFor helper：每轮先查条件再 sleep，超时预算 + flake 归因注释——仓内条件轮询标准形态
  'apps/electron/main/test/updater.test.ts': 'waitFor helper 条件轮询间隔（updater-script-integration 并入产物后随迁，round5-g）',
  // waitUntil helper：先查谓词再 sleep，超时抛错带状态快照（文件头声明「事件同步，禁固定 sleep」）
  'packages/runtime/src/__tests__/equivalence/delivery-compaction-window-e2e.test.ts':
    'waitUntil 条件轮询的循环间隔',
  'packages/runtime/src/__tests__/equivalence/send-queue-e2e.test.ts': 'waitUntil 条件轮询的循环间隔',
}

const TEST_FILE_RE = /\.(test|spec)\.tsx?$/
// 形态 1：resolve 形态盲等（反向引用保证 resolve 变量与 setTimeout 首参一致）
const RESOLVE_WAIT_RE =
  /await\s+new\s+Promise(?:<[^>(]*)?\(\s*\(?([A-Za-z_$][\w$]*)\)?\s*=>\s*setTimeout\(\s*\1\s*,\s*(\d+)\s*\)/
// 形态 2：毫秒级 helper 盲等调用
const HELPER_WAIT_RE = /\b(?:sleep|delay|waitForMs)\(\s*(\d+)\s*\)/
const WAIT_PATTERNS = [
  { re: RESOLVE_WAIT_RE, msGroup: 2 },
  { re: HELPER_WAIT_RE, msGroup: 1 },
]
const BLIND_WAIT_MIN_MS = 50

function scanFile(relPath, absPath) {
  if (BLIND_WAIT_EXEMPT[relPath.replaceAll('\\', '/')]) return []
  const src = readFileSync(absPath, 'utf8')
  if (src.includes('useFakeTimers(')) return [] // 假时钟文件内的 timer 是确定性推进，非盲等
  const hits = []
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    const code = line.split('//')[0] // 剥行内注释后缀，防注释文字里的形态示例误报
    for (const { re, msGroup } of WAIT_PATTERNS) {
      const m = code.match(re)
      if (m && Number(m[msGroup]) >= BLIND_WAIT_MIN_MS) {
        hits.push({ line: i + 1, ms: Number(m[msGroup]), text: line.trim().slice(0, 120) })
        break
      }
    }
  })
  return hits
}

function collectAllTestFiles() {
  const out = execSync('git ls-files', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\n').filter((f) => TEST_FILE_RE.test(f))
}

const args = process.argv.slice(2).filter(Boolean)
// 仓根 e2e/ = Playwright 真机 真实进程层域，不在本检查范围（见文件头「范围外」）
const files = (args.length > 0 ? args : collectAllTestFiles())
  .filter((f) => TEST_FILE_RE.test(f))
  .filter((f) => !f.replaceAll('\\', '/').startsWith('e2e/'))

const failures = []
for (const rel of files) {
  const abs = isAbsolute(rel) ? rel : join(process.cwd(), rel)
  // 豁免表 key 是仓根相对路径——绝对路径输入规范化回 cwd 相对形态再查表
  const relKey = isAbsolute(rel) ? relative(process.cwd(), rel) : rel
  let hits
  try {
    hits = scanFile(relKey, abs)
  } catch {
    continue // 文件已删除或不可读（staged 列表与磁盘竞态），跳过
  }
  for (const h of hits) failures.push({ file: relKey, ...h })
}

if (failures.length > 0) {
  console.error(`[check-test-blind-wait] 命中 ${failures.length} 处盲等形态（sleep >= ${BLIND_WAIT_MIN_MS}ms 后断言异步效果）：`)
  for (const f of failures) {
    console.error(`  ${f.file}:${f.line}  (${f.ms}ms)  ${f.text}`)
  }
  console.error('[FIX] 盲等在 CPU 忙时偶发假红（事件循环延迟吃掉余量，断言先于条件成立执行）。改法：')
  console.error('[FIX]   等条件成立 → vi.waitFor(() => expect(条件).toBe(...))，条件成立即返回')
  console.error('[FIX]   有确定性信号（事件/回调/mock 调用/文件出现）→ 直接 await 该信号')
  console.error('[FIX]   负向断言（验证未发生，无完成信号）→ 分片采样：多次 sleep(10) 每片断言一次')
  console.error('[FIX] 确属形态性误报（条件轮询的循环间隔 / fixture 字符串）→ 在本脚本')
  console.error('[FIX]   BLIND_WAIT_EXEMPT 登记文件路径与理由后重试；规则正反例见 docs/TEST-STRATEGY.md「异步等待写法」节')
  process.exit(1)
}
console.log(`[check-test-blind-wait] 通过（检查 ${files.length} 个测试文件）`)
