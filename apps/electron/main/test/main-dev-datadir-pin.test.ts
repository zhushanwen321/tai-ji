/**
 * dev 数据目录解析接线守护（R-13 修复：受控采信）。
 *
 * [HISTORICAL] 2026-09-08 Gate B 泄漏事故：宿主 shell 的 TAIJI_AGENT_DATA_DIR=~/.taiji
 * 泄漏进 dev Electron，旧实现（`env ?? ~/.taiji-dev`）只在 undefined 兜底、泄漏值被
 * 采信 → dev app 整个跑在用户 prod 数据目录上。修复后语义（受控采信）：外部值仅当
 * 解析后位于 ~/.taiji-dev 树内才采信（装配器 per-worktree 实例目录），其余钉死回
 * ~/.taiji-dev——行为矩阵守护 = test/dev-data-dir.test.ts（纯函数直测）。
 *
 * 本文件守护 **main.ts 的接线**（2026-09-19 起解析逻辑提取到 utils/dev-data-dir.ts
 * 纯函数，原「提取 main.ts 赋值语句执行」的行为守护随之退役，由直测纯函数替代）：
 *   ① isDev 块经 resolveDevDataDir 解析（不回归自赋值 / 裸 ?? 采信形态）
 *   ② 赋值时序早于一切 getDataDir() 消费者（initMainLogger / initCrashJournal）
 *      与单实例锁（userData 派生自它）——晚于任一消费者 = 隔离失效面
 *   ③ userData 从 TAIJI_AGENT_DATA_DIR 派生（不硬编码 .taiji-dev——多 worktree 并行
 *      dev 的单实例锁隔离前提）
 *   ④ TAIJI_AGENT_PORT_OFFSET 刻意保持 ?? 语义（无泄漏风险面，不随本次修复改动）
 *   ⑤ utils/dev-data-dir.ts 的 e2e 豁免双条件形态（flag === '1' 且外部值非空，防豁免
 *      被弱化为无条件采信）+ 包含判定 sep 边界形态
 *
 * 运行：cd apps/electron/main && npx vitest run test/main-dev-datadir-pin.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mainSource = readFileSync(path.resolve(__dirname, '../main.ts'), 'utf-8')
const utilSource = readFileSync(path.resolve(__dirname, '../utils/dev-data-dir.ts'), 'utf-8')

describe('main.ts dev 数据目录接线（受控采信，R-13 修复守护）', () => {
  it('源码守护：isDev 块经 resolveDevDataDir 解析 TAIJI_AGENT_DATA_DIR', () => {
    expect(mainSource).toMatch(
      /process\.env\.TAIJI_AGENT_DATA_DIR = resolveDevDataDir\(process\.env, homedir\(\)\)/,
    )
  })

  it('源码守护：不得回归「自赋值 / 裸 ?? 采信外部值」事故形态', () => {
    expect(mainSource).not.toMatch(
      /process\.env\.TAIJI_AGENT_DATA_DIR = process\.env\.TAIJI_AGENT_DATA_DIR/,
    )
    expect(mainSource).not.toMatch(
      /TAIJI_AGENT_DATA_DIR = process\.env\.TAIJI_AGENT_DATA_DIR \?\?/,
    )
  })

  it('时序守护：TAIJI_AGENT_DATA_DIR 解析早于 getDataDir() 消费者与单实例锁', () => {
    // 消费锚（真实调用形态，非 import 行）：initMainLogger / initCrashJournal 内部经
    // shared getDataDir() 动态读 env；单实例锁按 userData（自 TAIJI_AGENT_DATA_DIR 派生）
    // 区分。任一锚早于赋值 = 该消费者读到未隔离目录。
    const assignIdx = mainSource.indexOf('process.env.TAIJI_AGENT_DATA_DIR = resolveDevDataDir')
    const consumerAnchors = [
      mainSource.indexOf('initMainLogger({'),
      mainSource.indexOf('initCrashJournal()'),
      mainSource.indexOf('app.requestSingleInstanceLock()'),
    ]
    expect(assignIdx).toBeGreaterThan(-1)
    for (const anchor of consumerAnchors) {
      expect(anchor).toBeGreaterThan(-1)
      expect(assignIdx).toBeLessThan(anchor)
    }
  })

  it('源码守护：userData 从 TAIJI_AGENT_DATA_DIR 派生（不硬编码 .taiji-dev）', () => {
    expect(mainSource).toMatch(
      /app\.setPath\('userData', path\.join\(process\.env\.TAIJI_AGENT_DATA_DIR \?\? path\.join\(homedir\(\), '\.taiji-dev'\), 'electron'\)\)/,
    )
  })

  it('源码守护：TAIJI_AGENT_PORT_OFFSET 保持 ?? 兜底语义（无泄漏风险面，刻意不动）', () => {
    expect(mainSource).toMatch(
      /process\.env\.TAIJI_AGENT_PORT_OFFSET = process\.env\.TAIJI_AGENT_PORT_OFFSET \?\? String\(DEV_PORT_OFFSET\)/,
    )
  })

  it('源码守护：e2e 豁免双条件（flag === "1" 且外部值非空）住在纯函数内，防弱化为无条件采信', () => {
    expect(utilSource).toMatch(/env\.TAIJI_E2E === '1' && external/)
  })

  it('源码守护：树内包含判定用 sep 边界（非字符串前缀判，防 .taiji-devish 误放行）', () => {
    expect(utilSource).toMatch(/resolved === fallback \|\| resolved\.startsWith\(fallback \+ path\.sep\)/)
  })
})
