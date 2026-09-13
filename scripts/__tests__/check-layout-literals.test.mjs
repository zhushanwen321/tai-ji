/**
 * check-layout-literals.mjs 检测核心单测（设计 §10 U18 / C-pi-14）。
 *
 * 误报会逼人加豁免瓦解护栏——四条行为必须机器锁定：
 *   R1 旧布局字面量报红（join 形态 + 路径形态）
 *   R2 豁免表放行（file 级）+ 豁免表结构完整性（file 真实存在 / 必附理由）
 *   R3 `.pi` 前缀不误报（系统 pi 家目录 ~/.pi/agent 等已知 ≥6 处合法引用形态）
 *   R4 文件范围边界（源码扩展集 / .md 仅明列 / 生成物目录跳过）
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  scanFile,
  collectFiles,
  isLayoutLiteralLine,
  LAYOUT_LITERAL_EXEMPT,
  PATH_LITERAL_RE,
} from '../check-layout-literals.mjs'

// 本测试位于 scripts/__tests__/，仓库根需上跳两级
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

// ---------- R1 旧布局字面量报红 ----------

describe('R1 join 参数形态（P1）', () => {
  it("'pi', 'agent' / 'pi','sessions' 各空白形态命中", () => {
    expect(isLayoutLiteralLine("join(dir, 'pi', 'agent')")).toBe(true)
    expect(isLayoutLiteralLine("join(dir, 'pi','agent')")).toBe(true)
    expect(isLayoutLiteralLine("join(dir, 'pi',  'agent', 'x')")).toBe(true)
    expect(isLayoutLiteralLine("join(dir, 'pi', 'sessions')")).toBe(true)
  })
  it('scanFile 返回行号与文件定位', () => {
    const hits = scanFile('a.test.ts', "const d = join(tmp, 'pi', 'agent')\nconst ok = 1\nconst s = join(tmp, 'pi', 'sessions')")
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ file: 'a.test.ts', line: 1 })
    expect(hits[1]).toMatchObject({ file: 'a.test.ts', line: 3 })
  })
})

describe('R1 路径形态（P2）', () => {
  it('数据目录上下文的 pi/agent、pi/sessions 命中', () => {
    expect(isLayoutLiteralLine('~/.xyz-agent/pi/agent/settings.json')).toBe(true)
    expect(isLayoutLiteralLine('<dataDir>/pi/agent 已由迁移脚本退役')).toBe(true)
    expect(isLayoutLiteralLine('`/Users/u/.xyz-agent/pi/sessions/x.jsonl`')).toBe(true)
    expect(isLayoutLiteralLine('getPiAgentDir = getConfigDir()/pi/agent')).toBe(true)
  })
  it('双引号与模板串同样命中（词法无关引号形态）', () => {
    expect(isLayoutLiteralLine('const p = "/data/pi/agent"')).toBe(true)
    expect(isLayoutLiteralLine('expect(x).toBe(`/h/.xyz-agent/pi/agent`)')).toBe(true)
  })
})

// ---------- R2 豁免表 ----------

describe('R2 豁免表放行', () => {
  it('豁免文件整文件跳过（file 级，对齐 R1 D-10 先例——行号键随编辑漂移永不生效）', () => {
    expect(scanFile('scripts/migrate-pi-layout-v2.mjs', "join(dd, 'pi', 'sessions')")).toEqual([])
    expect(scanFile('packages/runtime/src/infra/pi/pi-maintenance.ts', "join(process.cwd(), 'pi', 'agent')")).toEqual([])
    // u17 已清零并移除 reap-orphan-pi.test.ts 豁免（判据 v2 测试无旧布局字面量）；
    // 放行 fixture 换 migrate-pi-layout-v2.test.mjs——迁移测试 fixture 恒需构造旧布局，稳定长期持有者
    expect(scanFile('scripts/__tests__/migrate-pi-layout-v2.test.mjs', "const DIR = '/Users/x/.xyz-agent/pi/sessions'")).toEqual([])
  })
  it('非豁免文件同内容仍报红（豁免按登记生效，不是全局放行）', () => {
    expect(scanFile('some/other.ts', "join(dd, 'pi', 'sessions')")).toHaveLength(1)
  })
  it('豁免表结构完整性：每项 file 真实存在于仓内且必附理由', () => {
    expect(LAYOUT_LITERAL_EXEMPT.length).toBeGreaterThanOrEqual(10)
    for (const e of LAYOUT_LITERAL_EXEMPT) {
      expect(existsSync(join(ROOT, e.file)), `豁免文件不存在: ${e.file}`).toBe(true)
      expect(e.reason?.length ?? 0, `豁免缺理由: ${e.file}`).toBeGreaterThanOrEqual(10)
    }
  })
  it('豁免文件无重复登记', () => {
    const files = LAYOUT_LITERAL_EXEMPT.map((e) => e.file)
    expect(new Set(files).size).toBe(files.length)
  })
})

// ---------- R3 `.pi` 前缀不误报 ----------

describe('R3 .pi 前缀排除（已知合法引用形态，settings-data.ts:72,75 / resource-discovery.ts:13,568 / paths.ts:46 / pi-maintenance.ts:141 同族）', () => {
  it('~/.pi/agent 家目录引用不命中', () => {
    expect(isLayoutLiteralLine("sourcePath: '~/.pi/agent/skills/fallow/SKILL.md'")).toBe(false)
    expect(isLayoutLiteralLine('const PRESET_SKILL_DIRS_GLOBAL = [\'~/.pi/agent/skills\', \'~/.claude/skills\']')).toBe(false)
    expect(isLayoutLiteralLine('* 默认 ~/.pi/agent/sessions，D5 rootDir 可选语义')).toBe(false)
  })
  it('/.pi/ 与 <workspaceRoot>/.pi/ 前缀不命中', () => {
    expect(isLayoutLiteralLine('`<workspaceRoot>/.pi/agents`')).toBe(false)
    expect(isLayoutLiteralLine('homedir() + "/.pi/agent"')).toBe(false)
  })
  it("'.pi' 作为 join 段（引号内含点）不命中 P1", () => {
    expect(isLayoutLiteralLine("join(homedir(), '.pi', 'agent')")).toBe(false)
  })
  it('.pi/pi/ 纯 pi 宿主嵌套形态不命中（u14b WARN 探测防误报先例同源）', () => {
    expect(isLayoutLiteralLine('防纯 pi 宿主 ~/.pi/pi/ 目录误报')).toBe(false)
  })
  it('R3 防线整体：真实仓内已知合法引用文件逐行零命中（守护 settings-data/resource-discovery 同族形态）', () => {
    const samples = [
      "source: 'pi', triggers: ['fallow'], sourcePath: '~/.pi/agent/skills/fallow/SKILL.md', effective: true",
      '{ path: \'~/.pi/agent/skills\', enabled: true, scope: \'global\' },',
      '* 全局配置（~/.pi/agent/subagents/config.json）。',
      'subagents/…（~/.pi/agent/subagents/、~/.xyz-agent/agent/subagents/）',
    ]
    for (const s of samples) {
      expect(isLayoutLiteralLine(s), s).toBe(false)
    }
  })
})

describe('R3 词法巧合排除', () => {
  it('api/agent（字母前缀）不命中——agent-api 等模块路径含 pi/agent 子串', () => {
    expect(isLayoutLiteralLine("import { registerAgentRpcHandlers } from '../src/services/plugin-service/api/agent-api.js'")).toBe(false)
    expect(PATH_LITERAL_RE.test('xapi/agent')).toBe(false)
  })
  it('pi/logs、pi/npm、pi/extensions 等其他子目录不命中——模式只钉 agent|sessions 两个核心位', () => {
    expect(isLayoutLiteralLine('<dataDir>/pi/logs/runtime.log')).toBe(false)
    expect(isLayoutLiteralLine('pi/npm/node_modules/x')).toBe(false)
    expect(isLayoutLiteralLine('pi/extensions/@zhushanwen/')).toBe(false)
  })
})

// ---------- R4 文件范围边界 ----------

describe('R4 文件范围', () => {
  it('收集结果全部落在 packages/ apps/ scripts/ + 三明列 .md 内，且无 node_modules/dist/test-results', () => {
    const files = collectFiles()
    expect(files.length).toBeGreaterThan(1000)
    for (const abs of files) {
      const rel = relative(ROOT, abs)
      expect(
        /^(packages|apps|scripts)\//.test(rel) ||
          rel === 'AGENTS.md' ||
          rel === 'docs/TROUBLESHOOTING.md' ||
          rel === 'docs/architecture/data-source-registry.md',
        `越界文件: ${rel}`,
      ).toBe(true)
      expect(rel).not.toMatch(/node_modules|^packages\/[^/]+\/dist\//)
    }
  })
  it('明列 .md 入域（AGENTS.md / docs/TROUBLESHOOTING.md / docs/architecture/data-source-registry.md）', () => {
    const files = collectFiles()
    expect(files.some((f) => f === join(ROOT, 'AGENTS.md'))).toBe(true)
    expect(files.some((f) => f === join(ROOT, 'docs/TROUBLESHOOTING.md'))).toBe(true)
    expect(files.some((f) => f === join(ROOT, 'docs/architecture/data-source-registry.md'))).toBe(true)
  })
  it('普通 .md 不入域（fixtures README / probe 历史报告属时点性记录，出守卫域）', () => {
    const files = collectFiles()
    const mds = files.filter((f) => f.endsWith('.md'))
    expect(
      mds.every(
        (f) => f.endsWith('AGENTS.md') || f.endsWith('troubleshooting.md') || f.endsWith('data-source-registry.md'),
      ),
    ).toBe(true)
  })
})

// ---------- 真实仓抽查 ----------

describe('真实仓抽查（改写后基线）', () => {
  it('SSOT 文件 pi-paths.ts 零命中（头注释历史沿革已去 pi/agent 连写）', () => {
    const rel = 'packages/runtime/src/infra/pi/pi-paths.ts'
    const text = readFileSync(join(ROOT, rel), 'utf8')
    expect(scanFile(rel, text)).toEqual([])
  })
  it('data-source-registry.md 入域且当前零命中；§6 主键旧字面量回流必被拦（F2 补录裁决）', () => {
    const rel = 'docs/architecture/data-source-registry.md'
    // 入域证明：collectFiles 明列收录
    expect(collectFiles().some((f) => f === join(ROOT, rel))).toBe(true)
    // 当前实况基线：F1 已把 §6 两行主键改 <piAgentDir>/ 符号写法，零命中
    const text = readFileSync(join(ROOT, rel), 'utf8')
    expect(scanFile(rel, text)).toEqual([])
    // 回流拦截：曾实际发生的主键失真形态（§6 settings.json / auth.json 行）在域内必红
    expect(
      scanFile(rel, '| `~/.xyz-agent/pi/agent/settings.json` | pi 子进程 + xyz runtime | ... |'),
    ).toHaveLength(1)
    expect(scanFile(rel, '数据源主键 ~/.xyz-agent/pi/agent/auth.json 登记行')).toHaveLength(1)
  })
})
