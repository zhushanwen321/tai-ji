#!/usr/bin/env bash
# check-version-changes.sh — 扫描本次改动，输出需要版本处理的包列表（人工定 type 的决策面）
#
# 设计依据：/tmp/versioning-longterm-design.md §4.1
#
# 职责（只列清单，不给 type 倾向）：
#   1. git diff 找改动文件，按「是否影响运行时行为/消费者可见契约」判定触发
#   2. 对照 .changeset/*.md frontmatter，标记每个包有无声明 + 声明的 type（只显示不采纳）
#   3. 在反向依赖图上对「已声明 bump 的包」做传递闭包 → DEPENDENTS_OF_CHANGED
#      （自己没改 src，但通过 workspace: 直接/间接引用了已 bump 包，须 patch 重发刷新 tarball 范围）
#   4. 读 .changeset/config.json 的 linked 组，输出受影响组（参考用，不驱动）
#   5. 残留 changeset 检测（警告级，纯信息增量）：对每个 .changeset/*.md 做双信号判定
#      （git 删除历史内容一致 / body 首行已在 CHANGELOG），命中只警告不排除，
#      防已发布消费过的 changeset 被旧分支 merge 复活后被重复消费（误发新版 + CHANGELOG 重复）
#
# 触发判定准则（§4.1 step 3）：
#   - *.md 文档 → 仅当位于包 npm files 白名单内（SKILL.md / agent.md / README 等
#     消费者安装可见内容）才触发；包外 md（docs/、根目录、.agents/）不触发
#   - __tests__/ / fixture / .test. / .spec. → 不触发
#   - package.json 的 dependencies/peerDependencies/optionalDependencies range 改动 → 强制纳入
#   - 其他源码改动 → 触发
#
# Usage:
#   bash scripts/check-version-changes.sh [git-diff-range]
#   默认 range = main..HEAD
#
# 退出码：0 = 正常（有输出即可，UNDECLARED 非空不当失败）；非 0 = 脚本本身出错
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/check-version-changes.sh [git-diff-range]

扫描本次改动，输出需要版本处理的包列表（人工定 type 的决策面）。

参数：
  git-diff-range   git diff range，默认 main..HEAD（merge 时传 merge commit range）

输出段（机器可读，apply-version.sh 解析 DEPENDENTS_OF_CHANGED 段）：
  NEEDS_VERSION=true|false
  CHANGED_PACKAGES        已在 .changeset 声明的包（将 bump）+ 声明的 type
  UNDECLARED_PACKAGES     src 实质改动但无 changeset 声明（PR 漏声明警告）
  ANCHOR_ONLY_PACKAGES    仅 dep 范围/锚点跟随、无 src 改动（对齐 patch 先例，非警告）
  DEPENDENTS_OF_CHANGED   传递闭包：引用了已 bump 包、须 patch 重发刷新范围的包
  LINKED_GROUPS_AFFECTED  linked 组受影响参考（不强制对齐）
  WARN_DECLARED_PACKAGE_NOT_FOUND          声明了但包不存在（typo/已删）
  WARN_CHANGESET_PREVIOUSLY_CONSUMED       疑似已发布消费过的残留 changeset
                                           （git 删除历史 / CHANGELOG 首行双信号，只警告不排除）

退出码：0 = 正常；非 0 = 脚本本身出错
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

RANGE="${1:-main..HEAD}"

ROOT="$(pwd)"
TMPDIR_WORK="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_WORK"' EXIT

# 节点逻辑用临时 .cjs 承载（graph/JSON/yaml 解析不适合 node -e 单行）。
# 用引号 heredoc 防止 bash 对 $/反引号 展开，数据通过 argv 传入。
cat > "$TMPDIR_WORK/check.cjs" <<'NODE_SCRIPT'
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RANGE = process.argv[2] || 'main..HEAD';
const ROOT = process.argv[3] || process.cwd();

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// --- 包发现：精确扫 4 类根（extensions/*、extensions/shared/*、packages/*、apps/*）---
function listDirs(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'node_modules')
    .map(e => e.name);
}
function readPkgIfExists(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
const pkgJsons = [];
// extensions 分组布局（taiji/universal，2026-08-22 目录重组）：分组目录 + shared 库 + 顶层
// 兜底（未来新增分组单点追加）。旧一层扫描在重组后漏掉全部分组包（cw-tool 死警告根因）。
for (const base of ['extensions/taiji', 'extensions/universal', 'extensions', 'packages', 'apps']) {
  for (const name of listDirs(base)) {
    if (base === 'extensions' && ['shared', 'taiji', 'universal'].includes(name)) continue; // 分组目录/shared 单独扫
    if (fs.existsSync(path.join(ROOT, base, name, 'package.json'))) {
      pkgJsons.push(`${base}/${name}/package.json`);
    }
  }
}
for (const name of listDirs('extensions/shared')) {
  if (fs.existsSync(path.join(ROOT, 'extensions/shared', name, 'package.json'))) {
    pkgJsons.push(`extensions/shared/${name}/package.json`);
  }
}

// config.ignore 是 changeset 自己的「不版本化」名单，沿用同一语义
const configPath = path.join(ROOT, '.changeset/config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const ignoreSet = new Set(config.ignore || []);

// packages: name -> { dir, version, private, wsDeps:[{dep,range,depType}] }
const packages = {};
for (const rel of pkgJsons) {
  const raw = readPkgIfExists(rel);
  if (!raw || !raw.name) continue;
  const dir = path.dirname(rel).replace(/\/package\.json$/, '');
  const wsDeps = [];
  for (const depType of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const sec = raw[depType] || {};
    for (const [dep, range] of Object.entries(sec)) {
      if (typeof range === 'string' && range.startsWith('workspace')) {
        wsDeps.push({ dep, range, depType });
      }
    }
  }
  packages[raw.name] = { name: raw.name, dir, version: raw.version, private: !!raw.private, wsDeps };
}
const exists = (name) => Object.prototype.hasOwnProperty.call(packages, name);
const isVersionable = (name) => exists(name) && !packages[name].private && !ignoreSet.has(name);

// --- 解析 range 成 base/head ref（git show <ref>:<path> 取基线版本）---
let baseRef, headRef;
const triple = RANGE.split('...');
const double = RANGE.split('..');
if (RANGE.includes('...') && triple.length === 2) {
  baseRef = triple[0]; headRef = triple[1] || 'HEAD';
} else if (double.length === 2) {
  baseRef = double[0]; headRef = double[1] || 'HEAD';
} else {
  baseRef = `${RANGE}^`; headRef = RANGE; // 单 commit → 与其父比较
}

// --- 读取某 ref 下某 package.json 的依赖 range 集合（合并三类 dep）---
function depRangesAt(ref, relPath) {
  let out;
  try {
    out = execFileSync('git', ['show', `${ref}:${relPath}`], { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return null; // 文件在该 ref 不存在
  }
  try {
    const raw = JSON.parse(out);
    const r = {};
    for (const dt of ['dependencies', 'peerDependencies', 'optionalDependencies']) Object.assign(r, raw[dt] || {});
    return r;
  } catch { return null; }
}

// --- 找文件所属的可版本化包（最长前缀匹配，仅限可版本化包）---
function pkgOf(file) {
  let best = null;
  for (const name in packages) {
    if (!isVersionable(name)) continue;
    const d = packages[name].dir;
    if (file === `${d}/package.json` || file.startsWith(`${d}/`)) {
      if (!best || d.length > best.dir.length) best = packages[name];
    }
  }
  return best;
}

// --- 测试/fixture 文件判定（不触发 version）---
function isTestOrFixture(file) {
  return /(^|\/)__tests__\//.test(file)
    || /(^|\/)(fixtures?|__fixtures__)\//.test(file)
    || /[\/.](test|spec)\./.test(file)
    || /\.test\.[a-z]+$/.test(file);
}

// --- npm files 白名单匹配（判断 md 是否随包发布、消费者可见）---
// 支持 npm files 字段三类条目：精确文件（README.md）、目录（skills/）、glob（src/**/*.ts）
function globToRegex(pattern) {
  // ** 匹配零或多层目录（含 /），* 匹配单层非 / 字符，? 匹配单个非 / 字符
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      // ** 后跟 / → 匹配零或多层目录前缀；裸 ** → 匹配任意（含 /）
      if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
      re += '.*'; i += 2; continue;
    }
    if (c === '*') { re += '[^/]*'; i++; continue; }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if ('\\^$.|+()[]{}'.includes(c)) { re += '\\' + c; i++; continue; }
    re += c; i++;
  }
  return new RegExp('^' + re + '$');
}
function inFilesWhitelist(relFileInPkg, files) {
  if (!Array.isArray(files)) return false;
  for (const entry of files) {
    if (entry.endsWith('/')) {
      // 目录条目 foo/ → foo/**
      const dir = entry.slice(0, -1);
      if (relFileInPkg === dir || relFileInPkg.startsWith(dir + '/')) return true;
      continue;
    }
    if (entry.includes('*')) {
      if (globToRegex(entry).test(relFileInPkg)) return true;
      continue;
    }
    if (relFileInPkg === entry) return true; // 精确文件
  }
  return false;
}

// --- git diff 改动文件分类 ---
let changedFiles = [];
try {
  changedFiles = git(['diff', '--name-only', RANGE]).split('\n').filter(Boolean);
} catch {
  changedFiles = []; // range 无效或无差异不算致命
}
const triggeringPackages = new Set(); // 因 src/dep 改动而触发的包
// src 触发（非 package.json 的实质文件改动）：区分「PR 漏声明」（UNDECLARED，需要补
// changeset）与「纯锚点/依赖范围跟随」（ANCHOR_ONLY，按 79e16b5b0 先例发对齐 patch，
// 不是漏声明警告）——2026-08-30 修正：此前两者混入同一 UNDECLARED，pi 升级时每次
// 误报一批「漏声明」
const srcTouchedPackages = new Set();
for (const f of changedFiles) {
  const pkg = pkgOf(f);
  if (!pkg) continue; // 不在任何可版本化包内（根文件/私有包改动）→ 不影响 npm 版本
  if (f === `${pkg.dir}/package.json`) {
    // package.json 改动：仅当 dep range 变化才触发（§4.1 step 3c）
    const baseDeps = depRangesAt(baseRef, `${pkg.dir}/package.json`);
    const headRaw = readPkgIfExists(`${pkg.dir}/package.json`);
    const headDeps = {};
    if (headRaw) {
      for (const dt of ['dependencies', 'peerDependencies', 'optionalDependencies']) Object.assign(headDeps, headRaw[dt] || {});
    }
    const allKeys = new Set([...Object.keys(baseDeps || {}), ...Object.keys(headDeps || {})]);
    let depChanged = false;
    for (const k of allKeys) {
      if ((baseDeps && baseDeps[k]) !== (headDeps[k] || undefined)) { depChanged = true; break; }
    }
    if (depChanged) triggeringPackages.add(pkg.name);
    // package.json 非 dep 改动（version/description 等）不触发运行时行为
  } else if (f.endsWith('.md')) {
    // md：仅当位于包 npm files 白名单内（消费者安装可见，如 SKILL.md/agent.md/README）才触发
    // 包外 md（docs/、根目录、.agents/）不触发
    const pkgFiles = readPkgIfExists(`${pkg.dir}/package.json`);
    if (pkgFiles && inFilesWhitelist(f.slice(pkg.dir.length + 1), pkgFiles.files)) {
      triggeringPackages.add(pkg.name);
      srcTouchedPackages.add(pkg.name);
    }
  } else if (isTestOrFixture(f)) {
    // 测试/fixture 不触发
  } else {
    triggeringPackages.add(pkg.name);
    srcTouchedPackages.add(pkg.name);
  }
}

// --- 解析 .changeset/*.md frontmatter ---
const changesetDir = path.join(ROOT, '.changeset');
const declared = {};          // name -> type（declared type，只显示不采纳）
const changesetFilesForPkg = {}; // name -> [filename,...]（供 apply 消费时关联）
const changesetMeta = {};      // file -> { pkgs, firstLine, content }（供残留检测）
if (fs.existsSync(changesetDir)) {
  for (const f of fs.readdirSync(changesetDir)) {
    if (!f.endsWith('.md') || f === 'README.md') continue;
    const content = fs.readFileSync(path.join(changesetDir, f), 'utf8');
    const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) continue;
    const fm = m[1];
    const pkgs = [];
    for (const line of fm.split(/\r?\n/)) {
      // 支持 '@scope/pkg': minor / "@scope/pkg": minor / unquoted: minor
      const mm = line.match(/^['"]?([^:'"\s]+?)['"]?\s*:\s*(major|minor|patch)\s*$/);
      if (mm) {
        const pkgName = mm[1].trim();
        declared[pkgName] = mm[2];
        (changesetFilesForPkg[pkgName] ||= []).push(f);
        pkgs.push(pkgName);
      }
    }
    // body 首个非空行 = apply-version.sh 生成的 CHANGELOG 条目文本（检测需用同一文本）
    const firstLine = (m[2].split(/\r?\n/).find(l => l.trim().length > 0) || '').trim();
    changesetMeta[f] = { pkgs, firstLine, content };
  }
}

// CHANGED_PACKAGES = 可版本化且已声明的包（= 闭包种子 = 将被 bump 的包）
// UNDECLARED = src 实质改动但未声明（PR 漏声明警告）
// ANCHOR_ONLY = 仅 package.json dep 范围/锚点跟随、无 src 改动（对齐 patch 先例，非警告）
const changedList = Object.keys(declared).filter(n => isVersionable(n) && exists(n)).sort();
const undeclaredList = [...triggeringPackages].filter(n => !declared[n] && srcTouchedPackages.has(n)).sort();
const anchorOnlyList = [...triggeringPackages].filter(n => !declared[n] && !srcTouchedPackages.has(n)).sort();

// --- 反向依赖图（仅可版本化包之间）---
const reverseDeps = {}; // A -> [{ from, depType }]
for (const name in packages) {
  if (!isVersionable(name)) continue;
  for (const { dep, depType } of packages[name].wsDeps) {
    if (!isVersionable(dep)) continue; // 跨进私有/忽略包的边不参与 npm 重发
    (reverseDeps[dep] ||= []).push({ from: name, depType });
  }
}

// --- BFS 传递闭包（从 declared 种子向外扩散，种子自身不算 dependent）---
const seeds = new Set(changedList);
const layer = {};     // name -> 最小层数
const via = {};       // name -> { trigger, depType }
for (const s of seeds) layer[s] = 0;
let frontier = [...seeds];
let cur = 0;
while (frontier.length) {
  cur++;
  const next = [];
  for (const node of frontier) {
    for (const { from, depType } of (reverseDeps[node] || [])) {
      if (seeds.has(from)) continue;            // 种子不算 dependent（避免与 CHANGED 重复）
      if (layer[from] === undefined) {           // BFS 首次到达 = 最小层
        layer[from] = cur;
        via[from] = { trigger: node, depType };
        next.push(from);
      }
    }
  }
  frontier = next;
}
// 依据 §4.3 规则二：自己 src 也改了的包属于 CHANGED/UNDECLARED 决策面，不列入 DEPENDENTS。
// 闭包遍历仍经过它们（以触达更深层的纯 dependent），只是不在 DEPENDENTS 输出中列出。
const dependents = Object.keys(layer)
  .filter(n => layer[n] > 0 && !triggeringPackages.has(n))
  .sort((a, b) => layer[a] - layer[b] || a.localeCompare(b));

// --- linked 组受影响（参考用）---
const affectedSet = new Set([...changedList, ...undeclaredList, ...anchorOnlyList, ...dependents]);
const linkedAffected = [];
for (const group of (config.linked || [])) {
  if (group.some(m => affectedSet.has(m))) linkedAffected.push(group);
}

// --- 声明了但不存在的包（typo/已删）警告 ---
const declaredMissing = Object.keys(declared).filter(n => !exists(n));

// --- 已发布 changeset 残留检测（警告级，纯信息增量，不改变任何段/退出码/下游行为）---
// 背景：已消费的 changeset（apply-version.sh 消费即删除）可能被旧分支 merge 复活，重新进入
// CHANGED_PACKAGES 被人工误当新声明 → 重复 bump + CHANGELOG 重复条目。此处只把警告投放到
// 人工定 type 的决策面，不擅自排除（排除会破坏「人工决策、脚本机械执行」的语义边界）。
// 双信号（任一命中即警告）：
//   git       文件曾在历史中被删除，且删除前内容与当前一致（内容比对防止开发分支上同名不同内容的正常重建误报）
//   changelog body 首个非空行（= apply-version.sh 生成的 CHANGELOG 条目文本）已出现在声明包的 CHANGELOG.md
// 降级原则：所有 git/文件操作失败一律静默降级为不报警（shallow clone、无历史、文件缺失），
// 绝不允许检测本身影响脚本退出码——防御机制的故障不能比被防的事故更糟。
const consumedWarnings = []; // [{ file, evidence: [string] }]
for (const [f, meta] of Object.entries(changesetMeta)) {
  const evidence = [];
  const relPath = `.changeset/${f}`;
  // 信号 1：git 删除历史 + 内容一致性比对
  let deletedIn = null;
  try {
    deletedIn = execFileSync('git', ['log', '--all', '--diff-filter=D', '--format=%H', '-1', '--', relPath],
      { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || null;
  } catch { deletedIn = null; }
  if (deletedIn) {
    let prevContent = null;
    try {
      prevContent = execFileSync('git', ['show', `${deletedIn}^:${relPath}`],
        { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { prevContent = null; }
    // \r\n 归一 + 去首尾空白：从 git 历史恢复的文件与当前文件在换行符/尾换行上的差异不构成新内容
    const norm = (s) => s.replace(/\r\n/g, '\n').trim();
    if (prevContent !== null && norm(prevContent) === norm(meta.content)) {
      evidence.push(`git: file was deleted by ${deletedIn.slice(0, 9)} and current content is identical`);
    }
  }
  // 信号 2：body 首行已出现在声明包的 CHANGELOG.md（首行 <10 字符不检测，泛文本撞车无告警价值）
  if (meta.firstLine.length >= 10) {
    for (const name of meta.pkgs) {
      const p = packages[name];
      if (!p) continue;
      const clPath = path.join(ROOT, p.dir, 'CHANGELOG.md');
      let hit = false;
      try {
        if (fs.existsSync(clPath)) {
          hit = fs.readFileSync(clPath, 'utf8').split('\n')
            // 条目行格式固定为 "- <sha>: <首行>"（或历史 official-changeset 的 "- <首行>"）；
            // endsWith 要求行尾完整等于首行，排除 "fix bug" 命中 "fix bug in xxx" 类子串误报
            .some(line => { const t = line.trimEnd(); return t.startsWith('- ') && t.endsWith(meta.firstLine); });
        }
      } catch { hit = false; }
      if (hit) {
        evidence.push(`changelog: body first line already present in ${name} CHANGELOG.md`);
        break; // 一个包命中即可，多包声明的 changeset 不重复刷屏
      }
    }
  }
  if (evidence.length > 0) consumedWarnings.push({ file: f, evidence });
}

// --- 输出 ---
const lines = [];
const needs = changedList.length > 0 || undeclaredList.length > 0 || anchorOnlyList.length > 0 || dependents.length > 0;
lines.push(`NEEDS_VERSION=${needs ? 'true' : 'false'}`);
lines.push('');
lines.push('CHANGED_PACKAGES:');
if (changedList.length === 0) lines.push('  (none)');
for (const name of changedList) {
  const p = packages[name];
  lines.push(`  ${name} (${p.dir}, current: ${p.version}, declared: ${declared[name]})`);
}
lines.push('');
lines.push('UNDECLARED_PACKAGES:');
if (undeclaredList.length === 0) lines.push('  (none)');
for (const name of undeclaredList) {
  const p = packages[name];
  lines.push(`  ${name} (${p.dir}, current: ${p.version})`);
}
lines.push('');
lines.push('ANCHOR_ONLY_PACKAGES:');
if (anchorOnlyList.length === 0) {
  lines.push('  (none)');
} else {
  lines.push('  # 仅 dep 范围/锚点跟随、无 src 改动——非漏声明；按对齐 patch 先例（79e16b5b0）发 patch 保持 npm 元数据与仓内一致');
}
for (const name of anchorOnlyList) {
  const p = packages[name];
  lines.push(`  ${name} (${p.dir}, current: ${p.version})`);
}
lines.push('');
lines.push('DEPENDENTS_OF_CHANGED:');
if (dependents.length === 0) lines.push('  (none)');
for (const name of dependents) {
  const p = packages[name];
  const v = via[name];
  lines.push(`  ${name} (${p.dir}, current: ${p.version}) [层${layer[name]}] via ${v.trigger} (${v.depType})`);
}
lines.push('');
lines.push('LINKED_GROUPS_AFFECTED:');
if (linkedAffected.length === 0) lines.push('  (none)');
for (const group of linkedAffected) {
  lines.push(`  [${group.join(', ')}]`);
}
if (declaredMissing.length > 0) {
  lines.push('');
  lines.push('WARN_DECLARED_PACKAGE_NOT_FOUND:');
  for (const name of declaredMissing) lines.push(`  ${name} (declared in changeset but no such package)`);
}
if (consumedWarnings.length > 0) {
  lines.push('');
  lines.push('WARN_CHANGESET_PREVIOUSLY_CONSUMED: (likely leftover from an already-released changeset; do not bump unless the change is genuinely new)');
  for (const w of consumedWarnings) {
    lines.push(`  .changeset/${w.file}`);
    for (const e of w.evidence) lines.push(`    - ${e}`);
  }
}
console.log(lines.join('\n'));
NODE_SCRIPT

node "$TMPDIR_WORK/check.cjs" "$RANGE" "$ROOT"
