/**
 * dev 数据目录钉死回归守护（2026-09-08 Gate B 泄漏事故修复）。
 *
 * [HISTORICAL] 事故：宿主 shell 的 TAIJI_AGENT_DATA_DIR=/Users/<user>/.taiji
 * 泄漏进 dev Electron，main.ts isDev 块旧实现（`env ?? ~/.taiji-dev`）只在
 * undefined 兜底、泄漏值被采信 → dev app 整个跑在用户 prod 数据目录上。
 * 修复语义：isDev 下外部 TAIJI_AGENT_DATA_DIR 被无条件覆盖为 ~/.taiji-dev。
 *
 * 测试策略（沿用 main-launch-result.test.ts 降级方案——main.ts 顶层副作用极重，
 * 直接 import 的 mock 面过宽且脆弱）：
 *   ① 源码守护：main.ts 含钉死兜底分支，且两类受控豁免（TAIJI_E2E / TAIJI_DEV_ASSEMBLED）
 *      均保持「标记 === '1' 且外部值有效」双条件，防豁免被弱化为无条件采信；
 *      TAIJI_AGENT_PORT_OFFSET 刻意保持 ?? 语义（无泄漏风险面，不随本次修复改动）
 *   ② 行为守护：从 main.ts 源码提取 dev 数据目录豁免段的真实语句并执行
 *      （new Function 注入 process/path/homedir 绑定），预置污染 env（含事故形态
 *      ~/.taiji 与任意目录）→ 断言无标记时一律落在 ~/.taiji-dev；
 *      装配标记 + 树内值 → 采信；装配标记 + 树外值/无标记 → 仍钉死。
 *      旧代码（?? 兜底）下提取语句为自赋值 no-op，污染值不被覆盖 → 本组转红，
 *      即红/绿判别力来自真实源码而非测试内复制品。
 *
 * 运行：cd apps/electron/main && npx vitest run test/main-dev-datadir-pin.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mainSource = readFileSync(path.resolve(__dirname, '../main.ts'), 'utf-8')

const DEV_DATA_DIR = path.join(homedir(), '.taiji-dev')

/** 提取 main.ts 中 dev 数据目录豁免段的真实语句（externalDataDir const 起、
 * 钉死三目赋值终，跨多行；含值域谓词与 assembledOverride 判定——整段自洽可独立执行）。
 * 段内 TS 类型注解经 stripTsAnnotations 清洗为 JS（new Function 不吃 TS；
 * main.ts 该段改注解形态时须同步此清洗规则，注解残留会以 SyntaxError 响亮失败）。 */
function extractDataDirAssignment(): string {
  const m = mainSource.match(/const externalDataDir[\s\S]*?:\s*devDataParent\b/)
  if (!m) throw new Error('main.ts 中未找到 dev 数据目录豁免赋值段')
  return m[0].replace(/\(\s*p\s*:\s*string\s*\)\s*:\s*boolean\s*=>/, '(p) =>')
}

/** 用注入的 process/path/homedir 绑定执行提取到的真实语句，返回执行后的 env 值 */
function executeAssignments(
  initial: string | undefined,
  e2eFlag?: string,
  assembledFlag?: string,
): string | undefined {
  const env: Record<string, string | undefined> = {
    TAIJI_AGENT_DATA_DIR: initial,
    TAIJI_E2E: e2eFlag,
    TAIJI_DEV_ASSEMBLED: assembledFlag,
  }
  const run = new Function(
    'process',
    'path',
    'homedir',
    `${extractDataDirAssignment()}`,
  )
  run({ env }, path, homedir)
  return env.TAIJI_AGENT_DATA_DIR
}

describe('main.ts dev 数据目录钉死（2026-09-08 泄漏事故回归守护）', () => {
  it('源码守护：无豁免命中时钉死 ~/.taiji-dev（兜底分支存在）', () => {
    expect(mainSource).toMatch(
      /\?\s*externalDataDir\s*\n\s*:\s*devDataParent\b/,
    )
  })

  it('源码守护：TAIJI_E2E 豁免必须双条件（flag === "1" 且外部值非空），防豁免被弱化为无条件采信', () => {
    expect(mainSource).toMatch(
      /process\.env\.TAIJI_E2E === '1' && externalDataDir/,
    )
  })

  it('源码守护：装配器豁免必须三条件（TAIJI_DEV_ASSEMBLED=1 且外部值非空且落在 ~/.taiji-dev 树内）', () => {
    expect(mainSource).toMatch(
      /process\.env\.TAIJI_DEV_ASSEMBLED === '1' &&\s*\n?\s*!!externalDataDir &&\s*\n?\s*isWithinDevDataParent\(externalDataDir\)/,
    )
  })

  it('源码守护：不得回归「自赋值 ?? 采信外部值」事故形态', () => {
    expect(mainSource).not.toMatch(
      /process\.env\.TAIJI_AGENT_DATA_DIR = process\.env\.TAIJI_AGENT_DATA_DIR/,
    )
  })

  it('源码守护：TAIJI_AGENT_PORT_OFFSET 保持 ?? 兜底语义（无泄漏风险面，刻意不动）', () => {
    expect(mainSource).toMatch(
      /process\.env\.TAIJI_AGENT_PORT_OFFSET = process\.env\.TAIJI_AGENT_PORT_OFFSET \?\? String\(DEV_PORT_OFFSET\)/,
    )
  })

  it('行为守护：事故形态（宿主泄漏 ~/.taiji）+ isDev → 被覆盖为 ~/.taiji-dev', () => {
    // 2026-09-08 事故原形态：宿主 shell 泄漏的 prod 数据目录
    expect(executeAssignments(path.join(homedir(), '.taiji'))).toBe(DEV_DATA_DIR)
  })

  it('行为守护：任意外部污染目录 + isDev → 一律落到 ~/.taiji-dev', () => {
    expect(executeAssignments('/tmp/leaked-custom-dir')).toBe(DEV_DATA_DIR)
  })

  it('行为守护：env 缺省（undefined）时同样钉到 ~/.taiji-dev', () => {
    expect(executeAssignments(undefined)).toBe(DEV_DATA_DIR)
  })

  it('行为守护：树内泄漏值（宿主恰有 ~/.taiji-dev/xxx）但无装配标记 → 仍钉死（裸泄漏不含标记不采信）', () => {
    expect(executeAssignments(path.join(DEV_DATA_DIR, 'host-leak'))).toBe(DEV_DATA_DIR)
  })

  it('行为守护：TAIJI_E2E=1 + 显式注入值（e2e 受控装配）→ 豁免生效、值被保留', () => {
    expect(executeAssignments('/tmp/e2e-mkdtemp-dir', '1')).toBe('/tmp/e2e-mkdtemp-dir')
  })

  it('行为守护：TAIJI_E2E=1 但外部值非空才豁免——与无 flag 同样钉死', () => {
    expect(executeAssignments(undefined, '1')).toBe(DEV_DATA_DIR)
  })

  it('行为守护：装配标记 + 树内值（--data-dir 通道）→ 采信', () => {
    expect(executeAssignments(path.join(DEV_DATA_DIR, 'renderopt'), undefined, '1')).toBe(
      path.join(DEV_DATA_DIR, 'renderopt'),
    )
  })

  it('行为守护：装配标记 + 树外值（越界/事故形态）→ 仍钉死（值域白名单拒绝）', () => {
    expect(executeAssignments('/tmp/leaked-custom-dir', undefined, '1')).toBe(DEV_DATA_DIR)
    expect(executeAssignments(path.join(homedir(), '.taiji'), undefined, '1')).toBe(DEV_DATA_DIR)
  })

  it('行为守护：装配标记 + 外部值缺失 → 钉死（!!externalDataDir 守住 undefined）', () => {
    expect(executeAssignments(undefined, undefined, '1')).toBe(DEV_DATA_DIR)
  })
})
