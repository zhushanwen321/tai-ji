#!/usr/bin/env node
/**
 * release.mjs — merge 流程阶段 5：Release Notes + 创建/更新 GitHub Release
 * （.agents/skills/merge/scripts/release.sh 的 Node 移植，notes 模板逐字节保真、
 * 每道防线与失败语义逐条保留）
 *
 * 做什么：
 *   1. 从 conventional commits 自动生成 release notes 草稿（双语三节结构，对齐
 *      docs/release-notes.md；条目为 commit 原文直出，须按该规范人工定稿）
 *   2. 创建或更新 GitHub Release（优先更新 CI 创建的 Draft Release）
 *   3. 仅在创建 / Draft 态重写 notes：release 已发布（非 draft）且现有 notes 已含
 *      <!-- LANG: 语言标记（已定稿双语）时不覆盖重写，改用手动 gh release edit
 *
 * 前置：阶段 4 已完成（version bump + tag push + CI 构建产物）
 * 用法: node scripts/merge/release.mjs [tag] [--notes <file>]
 *   tag:       如 v0.6.5（不提供则从 main worktree 的 package.json 读取）
 *   --notes:   指定 release notes 文件（不提供则从 commit 自动生成）
 * 退出码：0 = 成功，1 = 失败
 *
 * 依赖说明（相对原 bash 版）：JSON 解析改用 Node 内建 JSON.parse，jq 依赖移除；
 * 子命令一律参数数组形态（lib/exec.mjs，不经 shell），从结构上消灭 bash 引号/
 * 变量界定整类缺陷（5b 的 [HISTORICAL] 注释记原事故）。
 */
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './lib/exec.mjs'
import { RED, GREEN, YELLOW, BOLD, NC } from './lib/output.mjs'
import { DEFAULT_REPO } from './lib/repo.mjs'
import { findWorkspaceRoot, mainWorktreePath } from './lib/workspace.mjs'
import { writeMergeState } from './lib/state.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fail(message) {
  console.error(`${RED}${message}${NC}`)
}

/**
 * argv 解析（纯函数，供测试导入）。
 *
 * 返回 { ok: true, tag, notesFile } 或 { ok: false, error }。
 * 与原 bash 的差异（按移植规格收紧）：原 bash 对多余位置参数静默忽略，Node 版
 * 一律 Unknown option 拒绝——发布脚本误传参时宁可早退，不带错参数碰真实 Release。
 */
export function parseArgs(argv) {
  const out = { tag: '', notesFile: '' }
  const rest = [...argv]
  while (rest.length > 0) {
    const a = rest.shift()
    if (a === '--notes') {
      const v = rest.shift()
      if (v === undefined) return { ok: false, error: 'Missing value for option: --notes' }
      out.notesFile = v
    } else if (a.startsWith('--') || out.tag !== '') {
      return { ok: false, error: `Unknown option: ${a}` }
    } else {
      out.tag = a
    }
  }
  return { ok: true, ...out }
}

const COMMIT_KINDS = [
  ['feat', 'features'],
  ['fix', 'fixes'],
  ['perf', 'perfs'],
  ['breaking', 'breaking'],
]

/** 原 bash case 的两条模式：`<kind>:*` 与 `<kind\(*:*)`（前缀 + 任意 + 冒号 + 任意）。 */
const matchesKind = (line, kind) =>
  line.startsWith(`${kind}:`) || (line.startsWith(`${kind}(`) && line.includes(':'))

/**
 * conventional commit 分组（纯函数，供测试导入）。
 *
 * 分组判定与原 bash case 完全一致：feat:/feat(...): → features，fix / perf /
 * breaking 同理；其余前缀（chore/docs/refactor/test/Merge…）忽略。
 * 条目文本 = 第一个 ": " 之后的剩余部分（对应 bash ${line#*: } 最短前缀剥除；
 * 无 ": " 时 bash 剥除无匹配回退整行，此处保持同一行为）。
 */
export function parseCommitGroups(lines) {
  const groups = { features: [], fixes: [], perfs: [], breaking: [] }
  for (const line of lines) {
    const hit = COMMIT_KINDS.find(([kind]) => matchesKind(line, kind))
    if (hit === undefined) continue
    const sep = line.indexOf(': ')
    groups[hit[1]].push(sep === -1 ? line : line.slice(sep + 2))
  }
  return groups
}

/**
 * 双语 release notes 模板（纯函数，供测试导入）——与原 bash 109-160 行的 echo
 * 序列逐字节一致：en 段（breaking/features/perfs/fixes/Changelog）→ zh 段同序；
 * 空组整段跳过；每节后空一行；串尾恒以换行结束（末节后的 echo ""）。
 */
export function buildBilingualNotes({ groups, lastTag, tag, repoUrl }) {
  const lines = ['<!-- LANG:en -->']
  const section = (heading, entries) => {
    lines.push(heading, ...entries.map((e) => `  - ${e}`), '')
  }
  const changelog = (label) => {
    lines.push(`**${label}**: ${repoUrl}/compare/${lastTag}...${tag}`, '')
  }
  if (groups.breaking.length > 0) section('## Breaking Changes', groups.breaking)
  if (groups.features.length > 0) section('## New Features', groups.features)
  if (groups.perfs.length > 0) section('## Improvements', groups.perfs)
  if (groups.fixes.length > 0) section('## Bug Fixes', groups.fixes)
  if (lastTag !== '') changelog('Full Changelog')
  lines.push('<!-- LANG:zh -->')
  if (groups.breaking.length > 0) section('## 重大变更', groups.breaking)
  if (groups.features.length > 0) section('## 新增功能', groups.features)
  if (groups.perfs.length > 0) section('## 功能优化', groups.perfs)
  if (groups.fixes.length > 0) section('## 修复缺陷', groups.fixes)
  if (lastTag !== '') changelog('完整变更')
  return `${lines.join('\n')}\n`
}

/**
 * PR 标题兜底模板（纯函数，供测试导入）——与原 bash 167-185 行的 echo 序列
 * 逐字节一致：双语各一节 New Features，条目为 "- <PR 标题>"（无组内缩进）。
 */
export function buildPrTitleFallbackNotes({ prTitle, lastTag, tag, repoUrl }) {
  const lines = ['<!-- LANG:en -->', '## New Features', '', `- ${prTitle}`]
  if (lastTag !== '') lines.push('', `**Full Changelog**: ${repoUrl}/compare/${lastTag}...${tag}`)
  lines.push('', '<!-- LANG:zh -->', '## 新增功能', '', `- ${prTitle}`)
  if (lastTag !== '') lines.push('', `**完整变更**: ${repoUrl}/compare/${lastTag}...${tag}`)
  return `${lines.join('\n')}\n`
}

/**
 * notes 覆盖保护判定（纯函数，供测试导入）：release 已发布（非 draft）且现有
 * notes 已含 <!-- LANG: 语言标记（视为已定稿双语 notes）→ true，不覆盖重写，
 * 避免阶段 5 重跑/重复执行时把定稿内容冲掉。
 */
export function notesFinalized(body, isDraft) {
  if (isDraft === true) return false
  return String(body ?? '').includes('<!-- LANG:')
}

/** gh release --json 的 assets 数量；字段缺失/非数组按 0（对应 jq `length // 0`）。 */
function releaseAssetCount(rel) {
  return Array.isArray(rel?.assets) ? rel.assets.length : 0
}

/** 读 main worktree package.json 的 version；读不到/为空返回 null（调用方报错退出）。 */
function readMainVersion(mainWt) {
  try {
    const pkg = JSON.parse(readFileSync(join(mainWt, 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' && pkg.version !== '' ? pkg.version : null
  } catch {
    return null
  }
}

/** ── tag 解析：显式传参优先；缺省读 main worktree 版本号拼 v 前缀 ── */
function resolveTagOrFail(parsed, MAIN_WT) {
  if (parsed.tag !== '') return parsed.tag
  const version = readMainVersion(MAIN_WT)
  if (version === null) {
    fail('Error: 无法读取版本号，请显式传入 tag')
    process.exit(1)
  }
  return `v${version}`
}

/** ── 5a. 自动生成 release notes（--notes-file 未指定时）；返回 notes 文件路径 ── */
function buildAutoNotes({ WS_ROOT, MAIN_WT, TAG, GH_REPO, REPO_URL }) {
  const describeRes = run('git', ['-C', MAIN_WT, 'describe', '--tags', '--abbrev=0', 'HEAD^'], { stdio: 'capture' })
  const LAST_TAG = describeRes.ok ? describeRes.stdout.trim() : ''
  let LOG_RANGE
  if (LAST_TAG !== '') {
    LOG_RANGE = `${LAST_TAG}..HEAD`
    console.log(`  上一个 tag: ${LAST_TAG}`)
    console.log(`  commit 范围: ${LOG_RANGE}`)
  } else {
    LOG_RANGE = 'HEAD~30..HEAD'
    console.log('  无上一个 tag，取最近 30 条 commit')
  }

  const FINAL_NOTES_FILE = join(WS_ROOT, '.release-notes-auto.md')
  const COMMIT_FILE = join(WS_ROOT, '.release-commits.txt')
  const logRes = run('git', ['-C', MAIN_WT, 'log', LOG_RANGE, '--pretty=format:%s', '--no-merges'], { stdio: 'capture' })
  // 对应原 bash `> file ... || echo "(无 commit)" > file`：git 失败按空清单继续
  writeFileSync(COMMIT_FILE, logRes.ok ? logRes.stdout : '(无 commit)\n')

  console.log('  从 conventional commits 自动生成 release notes...')
  const groups = parseCommitGroups(logRes.ok ? logRes.stdout.split('\n') : [])
  const notes = buildBilingualNotes({ groups, lastTag: LAST_TAG, tag: TAG, repoUrl: REPO_URL })
  writeFileSync(FINAL_NOTES_FILE, notes)

  // 对应原 wc -l ≤ 2 判定（notes 恒以换行结尾，换行数 = 行数）
  if (notes.split('\n').length - 1 <= 2) {
    console.log(`  ${YELLOW}⚠️  自动生成的 release notes 为空（无 feat/fix/perf/breaking commit）${NC}`)
    console.log('  使用 PR 标题作为默认内容')
    const prRes = run(
      'gh',
      ['pr', 'list', '--repo', GH_REPO, '--state', 'merged', '--limit', '1', '--json', 'title', '--jq', '.[0].title'],
      { stdio: 'capture' },
    )
    const prTitle = prRes.ok && prRes.stdout.trim() !== '' ? prRes.stdout.trim() : `Release ${TAG}`
    writeFileSync(FINAL_NOTES_FILE, buildPrTitleFallbackNotes({ prTitle, lastTag: LAST_TAG, tag: TAG, repoUrl: REPO_URL }))
  }

  console.log(`  ${YELLOW}⚠️  以上为自动草稿：条目是 commit 原文直出，未按规范模糊化 / 排序 / 合并${NC}`)
  console.log(`  ${YELLOW}     定稿要求见 docs/release-notes.md，手写后覆盖：gh release edit ${TAG} --repo ${GH_REPO} --notes-file <双语文件>${NC}`)
  return FINAL_NOTES_FILE
}

/** Release notes emoji 门禁：写入 GitHub Release 前校验 notes 不含装饰 emoji。
 * 检测逻辑单一实现 = .githooks/check_doc_emoji.py（与 pre-commit 文档 emoji 检查同一脚本），
 * 禁止复制第二份正则。fail-closed：脚本缺失按门禁失败处理，不静默放行。 */
function ensureNotesNoEmoji(MAIN_WT, notesFile) {
  const checker = join(MAIN_WT, '.githooks', 'check_doc_emoji.py')
  if (!existsSync(checker)) {
    fail(`Error: emoji 检测脚本缺失: ${checker}（门禁 fail-closed，禁止放行）`)
    process.exit(1)
  }
  const res = run('python3', [checker, notesFile])
  if (!res.ok) {
    fail('Error: Release notes 含 emoji（禁止）。删除 emoji 或改为文字表述后重跑')
    process.exit(1)
  }
}

/** 查现有 release；gh 失败/输出非 JSON（未创建）→ null。 */
function fetchExistingRelease(TAG, GH_REPO) {
  const res = run('gh', ['release', 'view', TAG, '--repo', GH_REPO, '--json', 'isDraft,id,body,assets'], { stdio: 'capture' })
  if (!res.ok) return null
  try {
    return JSON.parse(res.stdout)
  } catch {
    return null
  }
}

/**
 * 已有 Release 的 notes 回填 / 草稿发布（首查与等待后再查两分支共用骨架）。
 * announceAssets=false 对应等待循环后的再查分支——原 bash 该分支不打印
 * assets/draft 状态行，且回填提示语固定为「Release 已存在，更新 notes」。
 */
function updateExistingRelease(rel, { TAG, GH_REPO, MAIN_WT, FINAL_NOTES_FILE, announceAssets, updateMessage }) {
  const isDraft = rel?.isDraft === true
  const body = typeof rel?.body === 'string' ? rel.body : ''
  if (announceAssets) {
    // [HISTORICAL] 原 bash 此处必须写 ${IS_DRAFT} 显式界定变量名边界：其后紧跟
    // UTF-8 全角括号（U+FF09），裸 $IS_DRAFT 会被 bash 变量名扫描器吞入首字节
    // 0xEF，set -u 下触发 `IS_DRAFT$'\357': unbound variable` 退出。Node 模板
    // 字符串 + 参数数组形态（不经 shell）从结构上消灭该类缺陷，全角括号直接书写。
    console.log(`  发现已有 Release（assets=${releaseAssetCount(rel)}, draft=${isDraft}）`)
  }
  if (notesFinalized(body, isDraft)) {
    console.log('  ⏭️  Release 已发布且 notes 已定稿（含 <!-- LANG: 标记），跳过覆盖')
    console.log(`  如需修改: gh release edit ${TAG} --repo ${GH_REPO} --notes-file <双语文件>`)
  } else {
    console.log(updateMessage)
    ensureNotesNoEmoji(MAIN_WT, FINAL_NOTES_FILE)
    // 对应原 bash `|| true`：edit 失败容忍继续（终局产物验证仍反映真实状态）
    run('gh', ['release', 'edit', TAG, '--repo', GH_REPO, '--notes-file', FINAL_NOTES_FILE])
  }
  if (isDraft) {
    console.log('  发布 Draft Release...')
    run('gh', ['release', 'edit', TAG, '--repo', GH_REPO, '--draft=false'])
  }
  return `https://github.com/${GH_REPO}/releases/tag/${TAG}`
}

/** 等 CI 创建 Draft Release（最多 120s，5s × 24 轮）；轮询耗尽由调用方再查兜底。 */
async function waitForCiDraft(TAG, GH_REPO) {
  let waitElapsed = 0
  while (waitElapsed < 120) {
    await sleep(5000)
    waitElapsed += 5
    const found = fetchExistingRelease(TAG, GH_REPO)
    if (found !== null && releaseAssetCount(found) > 0) {
      console.log(`  ${GREEN}✅ CI 已创建 Draft Release（${releaseAssetCount(found)} 个产物，${waitElapsed}s）${NC}`)
      break
    }
    console.log(`  ⏳ 等待中... (${waitElapsed}s/120s)`)
  }
}

/** CI 未建 Release 时手动创建（将无构建产物）；返回 release URL。 */
function createReleaseManually(TAG, GH_REPO, MAIN_WT, FINAL_NOTES_FILE) {
  console.log(`  ${YELLOW}⚠️  CI 未创建 Release，手动创建（将无构建产物）${NC}`)
  console.log(`  ${YELLOW}如需构建产物: gh workflow run release.yml --repo ${GH_REPO}${NC}`)
  ensureNotesNoEmoji(MAIN_WT, FINAL_NOTES_FILE)
  const createRes = run(
    'gh',
    ['release', 'create', TAG, '--repo', GH_REPO, '--title', TAG, '--notes-file', FINAL_NOTES_FILE, '--target', 'main'],
    { stdio: 'capture' },
  )
  if (!createRes.ok) {
    fail('❌ Release 创建失败')
    process.exit(1)
  }
  const urlLines = createRes.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  console.log(`  ${GREEN}✅ Release 已创建${NC}`)
  return urlLines[urlLines.length - 1] ?? ''
}

/** 最终产物数量核验（0 = 打警告不失败，产物真实状态由终局验证反映）。 */
function verifyFinalAssets(TAG, GH_REPO) {
  const finalRes = run('gh', ['release', 'view', TAG, '--repo', GH_REPO, '--json', 'assets'], { stdio: 'capture' })
  let finalAssets = 0
  if (finalRes.ok) {
    try {
      finalAssets = releaseAssetCount(JSON.parse(finalRes.stdout))
    } catch {
      finalAssets = 0
    }
  }
  if (finalAssets === 0) {
    console.log(`  ${YELLOW}⚠️  Release 无构建产物（dmg/exe/AppImage）${NC}`)
    console.log(`  ${YELLOW}手动触发: gh workflow run release.yml --repo ${GH_REPO}${NC}`)
  } else {
    console.log(`  ${GREEN}✅ Release 含 ${finalAssets} 个产物${NC}`)
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(parsed.error)
    process.exit(1)
  }

  // ── 定位 workspace（原 bash 以脚本自身路径向上找 .bare，Node 同锚点，不依赖 cwd）──
  const WS_ROOT = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)))
  if (WS_ROOT === null) {
    fail('Error: 未找到 workspace 根（向上查找含 .bare/ 的目录失败）')
    process.exit(1)
  }
  const MAIN_WT = mainWorktreePath(WS_ROOT)

  const TAG = resolveTagOrFail(parsed, MAIN_WT)

  // ── --notes 前置校验 ──
  if (parsed.notesFile !== '' && !existsSync(parsed.notesFile)) {
    fail(`Error: Release notes 文件不存在: ${parsed.notesFile}`)
    process.exit(1)
  }

  console.log(`${BOLD}═══ 阶段 5: Release (${TAG}) ═══${NC}`)

  const GH_REPO = DEFAULT_REPO
  const REPO_URL = `https://github.com/${GH_REPO}`

  // ── 5a. 确定 release notes ──
  let FINAL_NOTES_FILE
  if (parsed.notesFile !== '') {
    console.log(`  使用指定的 release notes: ${parsed.notesFile}`)
    FINAL_NOTES_FILE = parsed.notesFile
  } else {
    FINAL_NOTES_FILE = buildAutoNotes({ WS_ROOT, MAIN_WT, TAG, GH_REPO, REPO_URL })
  }

  // ── 5b. 创建或更新 Release ──
  // 优先等 CI 创建 Draft Release（含构建产物），fallback 手动创建
  // notes 覆盖保护判定本体 = 顶部导出的纯函数 notesFinalized
  let RELEASE_URL = ''
  const existing = fetchExistingRelease(TAG, GH_REPO)
  if (existing !== null) {
    const body = typeof existing.body === 'string' ? existing.body : ''
    RELEASE_URL = updateExistingRelease(existing, {
      TAG,
      GH_REPO,
      MAIN_WT,
      FINAL_NOTES_FILE,
      announceAssets: true,
      updateMessage: body.length < 20 ? '  Release notes 为空，回填中...' : '  更新已有 Release notes',
    })
  } else {
    // CI 可能还没创建，等待最多 120 秒（5s × 24 轮）
    console.log('  未找到 Release，等待 CI 创建 Draft Release（最多 120s）...')
    await waitForCiDraft(TAG, GH_REPO)

    // 再次检查（等待循环中可能已创建；原 bash break 后同样无条件重查一次）
    const after = fetchExistingRelease(TAG, GH_REPO)
    if (after !== null) {
      RELEASE_URL = updateExistingRelease(after, {
        TAG,
        GH_REPO,
        MAIN_WT,
        FINAL_NOTES_FILE,
        announceAssets: false,
        updateMessage: '  Release 已存在，更新 notes',
      })
    } else {
      RELEASE_URL = createReleaseManually(TAG, GH_REPO, MAIN_WT, FINAL_NOTES_FILE)
    }
  }

  verifyFinalAssets(TAG, GH_REPO)

  // 清理临时文件（对应原 rm -f；force = 不存在时静默）
  rmSync(join(WS_ROOT, '.release-notes-auto.md'), { force: true })
  rmSync(join(WS_ROOT, '.release-commits.txt'), { force: true })

  // 状态落盘（管线状态机 release 阶段终点；状态是辅助通道，写失败不阻塞）
  const written = writeMergeState(WS_ROOT, {
    tag: TAG,
    stage: 'released',
    releaseUrl: RELEASE_URL,
    releasedAt: new Date().toISOString(),
  })
  if (written === null) {
    console.log(`  ${YELLOW}Warning: merge 状态写入失败（不影响本阶段结果）${NC}`)
  }

  console.log('')
  console.log(`  URL: ${RELEASE_URL}`)
  console.log(`  ${GREEN}✅ 阶段 5 完成${NC}`)
  process.exit(0)
}

// 直接执行（node scripts/merge/release.mjs ...）时进入主流程；被测试 import 纯函数时不触发
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
