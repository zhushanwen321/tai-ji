#!/usr/bin/env node
/**
 * 数据布局字面量守卫（check-layout-literals，设计 §10 U18 / 约束 C-pi-14）。
 *
 * [HISTORICAL] 起因 2026-09 方案 B 布局迁移：xyz-agent 数据布局与 pi 0.84.x 默认布局
 * 同构（agent/ 子树），唯一差异 = 根目录（~/.pi/ vs <dataDir>/）。旧布局 `<dataDir>/pi/agent`
 * + `<dataDir>/pi/sessions` 已由 scripts/migrate-pi-layout-v2.mjs 一次性迁移退役。
 * u15 一次性清扫无守卫 = 字面量必回流（SSOT 切换当轮即抓到 config-service-paths.test.ts
 * 断言旧布局的存量失真）。本守卫把「pi/ 兄弟布局引用回流」变成可机检的失败。
 *
 * 检查逻辑（行级正则，两个模式族）：
 *   P1 join 参数形态：`'pi', 'agent'` / `'pi', 'sessions'`（任意空白）
 *   P2 路径形态：`pi/agent` / `pi/sessions`——lookbehind 排除两类合法子串：
 *     - `.pi` 前缀（`~/.pi/agent` 系统 pi 家目录是固定合法路径，子串含 pi/agent，
 *       不排除则范围内 ≥6 处合法引用首跑即大面积误报；check_path_whitelist.py:88 同类先例）
 *     - 字母前缀（`api/agent-api` 含 `pi/agent` 子串，纯词法巧合）
 *
 * 文件范围（显式，非 rglob 全仓）：packages/ apps/ scripts/ 源码（.ts/.tsx/.mjs/.cjs/
 * .js/.jsx/.sh/.py）+ AGENTS.md + docs/TROUBLESHOOTING.md + docs/architecture/data-source-registry.md；
 * node_modules/dist/test-results 等生成物目录排除。.md 默认不在范围（三明列文件除外）
 * ——fixtures README / probe 历史报告属时点性历史记录，不属源码。registry 补录裁决
 * （2026-09 design-code-sync round1 F2）：U18 范围声明先于 data-source-registry.md 成为
 * 活跃维护面，属实现期盲区——registry §6 数据源主键是布局字面量回流的高危位，必须入域。
 *
 * 豁免：集中常量表 LAYOUT_LITERAL_EXEMPT（file 级 + 行内理由，对齐 R1 check_pi_direct_write.py
 * ALLOWLIST 的 file 级先例——行号键随编辑漂移永不生效，教训见 impl-plan D-10）。
 * 新增豁免必须附理由；理由消失（如对应插件/脚本改造完成）时同步移除条目。
 *
 * 用法：node scripts/check-layout-literals.mjs（每次全量扫描，毫秒级，无增量模式——
 * 触发面由 pre-commit 按路径控制）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))

/** 扫描范围：目录根（递归）+ 明列单文件。.md 仅两个明列文件入域。 */
const RANGE_DIRS = ['packages', 'apps', 'scripts']
const RANGE_FILES = ['AGENTS.md', 'docs/TROUBLESHOOTING.md', 'docs/architecture/data-source-registry.md']

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx', '.sh', '.py'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test-results', '.git', 'build', 'release', 'out'])

/**
 * 集中豁免常量表（file 级）。每项必须附理由；理由消失时同步移除条目。
 * 禁止为「新代码里的数据布局字面量」加豁免——那走改写或派生式（getPiAgentDir()/getSessionsDir()）。
 */
export const LAYOUT_LITERAL_EXEMPT = [
  {
    file: 'scripts/check-layout-literals.mjs',
    reason: '守卫本体——模式定义、文档注释与豁免理由表必然引用被检字面量（定义处即合法持有者）',
  },
  {
    file: 'scripts/__tests__/check-layout-literals.test.mjs',
    reason: '守卫单测——用例必须构造新旧字面量样本（报红/放行/排除断言的 fixture）',
  },
  {
    file: 'packages/runtime/src/infra/pi/pi-maintenance.ts',
    reason:
      'bundled 资源同步源 join(process.cwd(), pi, agent)（app 资源布局，打包 stage 产物）+ 启动 WARN 残留探测判据（<dataDir>/pi 存在且含 agent|sessions 子目录）+ 迁移史注释——文件职责即新旧布局兼容',
  },
  {
    file: 'packages/runtime/src/infra/pi/__tests__/pi-maintenance.test.ts',
    reason: 'WARN 残留探测 fixture 必须构造旧布局形态（pi/agent、pi/sessions 目录）——探测对象即旧布局残留，语义耦合',
  },
  {
    file: 'packages/runtime/src/services/session/workflow-extractor.ts',
    reason: ':236 历史证据标注行（B 布局迁移前旧布局时期的实测记录，历史证据不改写）',
  },
  {
    file: 'packages/runtime/test/recent-workspaces-real.test.ts',
    reason: '负向回归断言：字面量 pi/agent 即「getConfigDir() 返回值不得含旧布局子串」的断言本体（守卫同盟，非违规）',
  },
  {
    file: 'scripts/migrate-pi-layout-v2.mjs',
    reason: '迁移脚本本体——旧布局 pi/agent、pi/sessions 字面量的唯一合法持有者（impl-plan D-6/R1 file-level ALLOWLIST 先例）',
  },
  {
    file: 'scripts/__tests__/migrate-pi-layout-v2.test.mjs',
    reason: '迁移脚本测试 fixture 必须构造旧布局（<dataDir>/pi/agent|sessions）才能覆盖六步迁移逻辑',
  },
  {
    file: 'scripts/prepare-pi-resources.sh',
    reason: 'resources/pi 资源布局路径（bundled pi 二进制 stage 产物目录，app 资源树非数据布局）',
  },
  {
    file: 'docs/TROUBLESHOOTING.md',
    reason: '迁移节：pi.backup-v2-<ts> 备份名、回滚命令行、旧布局沿革描述——迁移语义承载文件',
  },
  {
    file: 'packages/runtime/src/infra/pi/find-pi-executable.ts',
    reason: 'bundled pi 二进制资源布局（resources/pi/pi-<plat>-<arch>）；当前无命中，登记防未来资源形态引用被误拦（find-pi-executable.ts:47 漏列教训）',
  },
  {
    file: 'apps/electron/resources/extensions/@zhushanwen/pi-session-reader/index.js',
    reason: 'bundled 产物内 2 处为 session-reader discovery/env.ts 布局探测的「B 前旧布局」诊断证据文案（evidence.push 描述检测到的旧布局形态，历史证据类非路径使用）；extensions/ 源码不在扫描域，产物经 bundle-extensions 与源码同步后入域',
  },
  {
    file: 'apps/electron/main/images/__tests__/image-cache.test.ts',
    reason:
      '负向诱饵 fixture（pi-maintenance.test.ts 同型先例）：缺省 sessionsDir 推导用例必须构造旧布局 pi/sessions 层级放孤儿同构文件——推导若错查旧层会误判活而不删；另 :43 实测锚点为旧布局时期取样记录（文件名形态两布局一致）',
  },
  {
    file: 'apps/electron/main/images/image-cache.ts',
    reason:
      ':176-178 session 文件名形态实测锚点（2026-09-02 旧布局时期本机取样记录，文件名形态跨布局不变，历史证据不改写——workflow-extractor.ts:236 先例）',
  },
  {
    file: 'apps/electron/main/test/global-setup.ts',
    reason:
      ':32 2026-09-02 会话丢失事故复盘的历史叙述（当时会话确在旧布局层，事实性历史证据不改写；现行 getSessionsDir 已是新布局派生式）',
  },
]

const EXEMPT_SET = new Set(LAYOUT_LITERAL_EXEMPT.map((e) => e.file))

/** P1：join 参数形态。`'pi'` 后随任意空白逗号再 `'agent'|'sessions'`。 */
export const JOIN_LITERAL_RE = /'pi'\s*,\s*'(?:agent|sessions)'/
/** P2：路径形态。lookbehind 排除 `.pi` 前缀（系统 pi 家目录）与字母前缀（api/agent 词法巧合）。 */
export const PATH_LITERAL_RE = /(?<![.\w])pi\/(?:agent|sessions)/

export function isLayoutLiteralLine(line) {
  return JOIN_LITERAL_RE.test(line) || PATH_LITERAL_RE.test(line)
}

/** 递归收集范围内的源码文件（跳过生成物目录）；.md 不入递归范围，仅明列文件由 collectFiles 直接收录。 */
export function collectFiles(rootDir = ROOT) {
  const out = []
  for (const dir of RANGE_DIRS) {
    walk(join(rootDir, dir), out)
  }
  for (const f of RANGE_FILES) {
    try {
      statSync(join(rootDir, f))
      out.push(join(rootDir, f))
    } catch {
      /* 明列文件不存在（如 worktree 裁剪）→ 跳过 */
    }
  }
  return out
}

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(full, out)
      continue
    }
    const dot = name.lastIndexOf('.')
    if (dot === -1) continue
    if (SOURCE_EXTS.has(name.slice(dot))) out.push(full)
  }
}

/**
 * 扫描单文件，返回违规行（相对路径:行号: 内容摘要）。
 * 豁免在文件级判定（EXEMPT_SET），扫描核心保持纯函数供单测直挂。
 */
export function scanFile(relPath, text) {
  if (EXEMPT_SET.has(relPath)) return []
  const hits = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (isLayoutLiteralLine(lines[i])) {
      hits.push({ file: relPath, line: i + 1, text: lines[i].trim().slice(0, 140) })
    }
  }
  return hits
}

function main() {
  const files = collectFiles(ROOT)
  const violations = []
  for (const abs of files) {
    const rel = relative(ROOT, abs)
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    violations.push(...scanFile(rel, text))
  }

  if (violations.length > 0) {
    console.error(`✗ check-layout-literals：${violations.length} 处旧布局字面量（C-pi-14：数据布局与 pi 默认布局同构，唯一差异 = 根目录）\n`)
    for (const v of violations) console.error(`  ✗ ${v.file}:${v.line}\n      ${v.text}`)
    console.error('')
    console.error('恢复动作（三选一）：')
    console.error('  1. 注释/文档失真 → 改写为新布局描述：<dataDir>/agent、<agentDir>/sessions/<encodeCwd>/')
    console.error('  2. 代码路径 → 改派生式：getPiAgentDir() / getSessionsDir()（packages/runtime/src/infra/pi/pi-paths.ts SSOT）')
    console.error('  3. 确属合法持有（bundled 资源布局 / 迁移语义 / 历史证据）→ scripts/check-layout-literals.mjs 的 LAYOUT_LITERAL_EXEMPT 登记 file + 理由')
    console.error('')
    console.error('禁止引入：pi/ 兄弟布局引用、新 --session-dir 覆盖、数据目录下新建 pi/ 子层。')
    process.exit(1)
  }

  console.log(`✓ check-layout-literals：${files.length} 个文件扫描通过（C-pi-14 布局对齐契约；豁免 ${LAYOUT_LITERAL_EXEMPT.length} 文件）`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(join(process.argv[1])).href
if (isMain) main()
