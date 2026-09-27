#!/usr/bin/env bash
# apply-version.sh — 按人工 type 批量 bump + 自动 patch DEPENDENTS + 生成 CHANGELOG + 消费 .changeset + fixed 校验
#
# 设计依据：/tmp/versioning-longterm-design.md §4.2 / §4.5 / §4.3 规则一
#
# 输入：
#   --changed <pkg=type>          可重复，人工定的 CHANGED_PACKAGES type（minor/major/patch）
#   --dependents-from <file>      check 脚本输出（文件路径或 - 表 stdin），解析 DEPENDENTS_OF_CHANGED 段
#                                 每个包强制 patch bump（规则一确定性，刷新 workspace:* 解析后的 tarball 范围）
#   --dry-run                     只打印将做的改动，不写文件、不删文件
#
# 规则一（机械，§4.3）：DEPENDENTS 包无人工判断空间，一律 patch。脚本自动执行避免传递闭包下漏传。
# 规则二（语义）：CHANGED 包 type 由人工 --changed 传入。
#
# CHANGELOG（§4.5）：
#   - 有 .changeset body 的包（CHANGED）：body 第一行作条目，按人工 type 归入 Major/Minor/Patch Changes
#   - DEPENDENTS 包（无 changeset）：自动条目 chore: refresh dependency range (triggered by dep@old → dep@new)
#
# Usage:
#   bash scripts/apply-version.sh \
#     --changed @scope/pkg-a=minor @scope/pkg-b=patch \
#     --dependents-from <(bash scripts/check-version-changes.sh main..HEAD) \
#     [--dry-run]
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/apply-version.sh --changed <pkg=type>... --dependents-from <file> [--dry-run]

按人工 type 批量 bump package.json version + 自动 patch DEPENDENTS + 生成 CHANGELOG + 消费 .changeset。

参数：
  --changed <pkg=type>          可重复。人工定的 CHANGED_PACKAGES type（minor/major/patch）。
                                pkg 必须与 package.json 的 name 字段精确匹配（带 @scope/）。
  --dependents-from <file>      check-version-changes.sh 的输出文件（或 - 表 stdin）。
                                解析 DEPENDENTS_OF_CHANGED 段，每个包强制 patch bump。
  --dry-run                     打印将做的改动，不写/不删任何文件。

示例：
  bash scripts/apply-version.sh \
    --changed @zhushanwen/pi-foo=minor \
    --dependents-from <(bash scripts/check-version-changes.sh main..HEAD) \
    --dry-run
EOF
}

CHANGED_ARGS=()
DEPENDENTS_FILE=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --changed)
      shift
      while [[ $# -gt 0 && "$1" != --* ]]; do CHANGED_ARGS+=("$1"); shift; done
      ;;
    --dependents-from)
      DEPENDENTS_FILE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage; exit 0
      ;;
    *)
      echo "错误：未知参数 '$1'" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ${#CHANGED_ARGS[@]} -eq 0 && -z "$DEPENDENTS_FILE" ]]; then
  usage
  exit 0
fi

ROOT="$(pwd)"
TMPDIR_WORK="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_WORK"' EXIT

# 把解析后的 DEPENDENTS 包名列表写入临时文件，供 node 读取（避免 argv 过长 + 隔离解析）
DEPS_LIST_FILE="$TMPDIR_WORK/dependents.txt"
: > "$DEPS_LIST_FILE"
if [[ -n "$DEPENDENTS_FILE" ]]; then
  if [[ "$DEPENDENTS_FILE" == "-" ]]; then cat > "$TMPDIR_WORK/dep-input.txt"; DEPENDENTS_FILE="$TMPDIR_WORK/dep-input.txt"; fi
  if [[ ! -r "$DEPENDENTS_FILE" ]]; then echo "错误：无法读取 --dependents-from 文件：$DEPENDENTS_FILE" >&2; exit 1; fi
  # 提取 DEPENDENTS_OF_CHANGED: 段下的行，取行首 token（第一个空白前）作 pkg-name
  awk '
    /^DEPENDENTS_OF_CHANGED:/ { in_sec=1; next }
    /^[A-Z_]+:/ && in_sec { in_sec=0 }
    in_sec {
      line=$0
      # 去前导空白
      sub(/^[ \t]+/, "", line)
      if (line == "" || line == "(none)") next
      # pkg-name = 行首到第一个空白或左圆括号前的 token
      if (match(line, /[^ \t(]+/)) print substr(line, RSTART, RLENGTH)
    }
  ' "$DEPENDENTS_FILE" > "$DEPS_LIST_FILE"
fi

# CHANGED pkg=type 列表写入临时文件（argv 传递亦可，文件更稳）
CHANGED_LIST_FILE="$TMPDIR_WORK/changed.txt"
: > "$CHANGED_LIST_FILE"
for arg in "${CHANGED_ARGS[@]}"; do printf '%s\n' "$arg" >> "$CHANGED_LIST_FILE"; done

cat > "$TMPDIR_WORK/apply.cjs" <<'NODE_SCRIPT'
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2];
const CHANGED_LIST_FILE = process.argv[3];
const DEPS_LIST_FILE = process.argv[4];
const DRY_RUN = process.argv[5] === '1';

// 优先用 workspace 顶层 semver（temp .cjs 在 /tmp，默认 require 解析不到 ROOT/node_modules）
let semver;
try { semver = require(path.join(ROOT, 'node_modules', 'semver')); }
catch { semver = require('semver'); }

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function shortSha() { try { return git(['rev-parse', '--short', 'HEAD']); } catch { return 'HEAD'; } }

// --- 包发现（与 check 脚本同构）---
function listDirs(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return [];
  return fs.readdirSync(p, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== 'node_modules').map(e => e.name);
}
function readPkg(rel) {
  const p = path.join(ROOT, rel);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const pkgJsons = [];
// extensions 分组布局（taiji/universal）：分组目录 + 顶层兜底（与 check-version-changes.sh 同修）
for (const base of ['extensions/taiji', 'extensions/universal', 'extensions', 'packages', 'apps']) {
  for (const name of listDirs(base)) {
    if (base === 'extensions' && ['shared', 'taiji', 'universal'].includes(name)) continue;
    if (fs.existsSync(path.join(ROOT, base, name, 'package.json'))) pkgJsons.push(`${base}/${name}/package.json`);
  }
}
for (const name of listDirs('extensions/shared')) {
  if (fs.existsSync(path.join(ROOT, 'extensions/shared', name, 'package.json'))) pkgJsons.push(`extensions/shared/${name}/package.json`);
}
const configPath = path.join(ROOT, '.changeset/config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
const ignoreSet = new Set(config.ignore || []);
const packages = {}; // name -> { dir, version, private, wsDeps:[{dep,range,depType}], pkgPath }
for (const rel of pkgJsons) {
  const raw = readPkg(rel);
  if (!raw.name) continue;
  const dir = path.dirname(rel);
  const wsDeps = [];
  for (const depType of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, range] of Object.entries(raw[depType] || {})) {
      if (typeof range === 'string' && range.startsWith('workspace')) wsDeps.push({ dep, range, depType });
    }
  }
  packages[raw.name] = { name: raw.name, dir, version: raw.version, private: !!raw.private, wsDeps, pkgPath: rel };
}
const isVersionable = (name) => packages[name] && !packages[name].private && !ignoreSet.has(name);

// --- 解析 .changeset/*.md（body 供 CHANGED 包 CHANGELOG 条目）---
const changesetDir = path.join(ROOT, '.changeset');
const changesets = []; // [{ file, decls: [{name,type}], body }]
if (fs.existsSync(changesetDir)) {
  for (const f of fs.readdirSync(changesetDir)) {
    if (!f.endsWith('.md') || f === 'README.md') continue;
    const content = fs.readFileSync(path.join(changesetDir, f), 'utf8');
    const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) continue;
    const decls = [];
    for (const line of m[1].split(/\r?\n/)) {
      const mm = line.match(/^['"]?([^:'"\s]+?)['"]?\s*:\s*(major|minor|patch)\s*$/);
      if (mm) decls.push({ name: mm[1].trim(), type: mm[2] });
    }
    changesets.push({ file: f, decls, body: m[2].trim() });
  }
}

// --- 读 CHANGED pkg=type ---
const changedMap = {}; // name -> type（人工）
for (const line of fs.readFileSync(CHANGED_LIST_FILE, 'utf8').split('\n').filter(Boolean)) {
  const idx = line.lastIndexOf('=');
  if (idx < 0) { console.error(`错误：--changed 格式应为 pkg=type，收到 '${line}'`); process.exit(1); }
  const name = line.slice(0, idx).trim();
  const type = line.slice(idx + 1).trim();
  if (!['major', 'minor', 'patch'].includes(type)) { console.error(`错误：type 必须是 major/minor/patch，收到 '${type}'`); process.exit(1); }
  if (!packages[name]) { console.error(`错误：--changed 的包不存在：${name}（须与 package.json name 精确匹配）`); process.exit(1); }
  if (!isVersionable(name)) { console.error(`错误：--changed 的包不可版本化（private 或在 ignore 名单）：${name}`); process.exit(1); }
  changedMap[name] = type;
}

// --- 读 DEPENDENTS pkg-name 列表 ---
const dependentNames = [];
for (const name of fs.readFileSync(DEPS_LIST_FILE, 'utf8').split('\n').filter(Boolean)) {
  const n = name.trim();
  if (!n) continue;
  if (!packages[n]) { console.error(`错误：--dependents-from 含未知包名 '${n}'（须与 package.json name 精确匹配）`); process.exit(1); }
  if (!isVersionable(n)) { console.error(`错误：dependent 包不可版本化：${n}`); process.exit(1); }
  if (changedMap[n]) continue; // 已在 --changed（人工 type）中处理，不重复 patch
  dependentNames.push(n);
}

// --- 计算 bump 计划 ---
// plan: name -> { oldVer, newVer, kind: 'changed'|'dependent', type, triggers?:[{name,old,new}] }
const plan = {};
const allBumped = new Set();
for (const name of Object.keys(changedMap)) {
  const p = packages[name];
  const newVer = semver.inc(p.version, changedMap[name]);
  if (!newVer) { console.error(`错误：semver.inc('${p.version}','${changedMap[name]}') 失败（包 ${name}）`); process.exit(1); }
  plan[name] = { oldVer: p.version, newVer, kind: 'changed', type: changedMap[name] };
  allBumped.add(name);
}
// 先记录每个被 bump 包的 old→new，DEPENDENTS 条目用
const verMap = {};
for (const name of allBumped) verMap[name] = { old: packages[name].version, new: plan[name].newVer };

for (const name of dependentNames) {
  const p = packages[name];
  const newVer = semver.inc(p.version, 'patch');
  if (!newVer) { console.error(`错误：semver.inc('${p.version}','patch') 失败（包 ${name}）`); process.exit(1); }
  // 找出该 dependent 的哪些 workspace dep 被本次 bump（作 triggers）
  const triggers = p.wsDeps
    .filter(d => allBumped.has(d.dep) || plan[d.dep])
    .filter(d => packages[d.dep] && (plan[d.dep] || verMap[d.dep]))
    .map(d => {
      const bm = plan[d.dep] || verMap[d.dep];
      return { name: d.dep, old: packages[d.dep].version, new: bm.newVer };
    });
  // 去重 + 仅保留真正被 bump 的（new != old）
  const seen = new Set();
  const realTriggers = [];
  for (const t of triggers) {
    if (t.new === t.old) continue;
    if (seen.has(t.name)) continue;
    seen.add(t.name); realTriggers.push(t);
  }
  plan[name] = { oldVer: p.version, newVer, kind: 'dependent', type: 'patch', triggers: realTriggers };
  allBumped.add(name);
  verMap[name] = { old: p.version, new: newVer };
}

// --- fixed 组一致性校验（§4.2 step 6；当前 config.fixed 为空，逻辑写但不触发）---
for (const group of (config.fixed || [])) {
  const bumpedInGroup = group.filter(m => allBumped.has(m));
  if (bumpedInGroup.length === 0) continue;
  // bumped 成员新版本若分歧（人工给同组不同 type）→ fixed 契约无法满足，报错
  const bumpedVersions = new Set(bumpedInGroup.map(m => plan[m].newVer));
  if (bumpedVersions.size > 1) {
    console.error(`错误：fixed 组 [${group.join(', ')}] 内被 bump 的包版本不一致：${[...bumpedVersions].join(', ')}。fixed 契约要求整组同版本，请给同组包一致的 type。`);
    process.exit(1);
  }
  // 目标 = max(bumped 成员新版本, 全组成员当前版本)。绝不降级（fixed 版本单调非降，设计 §4.2 step 6「最高版本」）
  const allCandidates = [];
  for (const m of group) {
    if (!packages[m]) continue;
    allCandidates.push(allBumped.has(m) ? plan[m].newVer : packages[m].version);
  }
  const target = allCandidates.reduce((a, b) => (semver.gt(b, a) ? b : a));
  // 全组对齐到 target：任何成员最终版本 < target 都升上去（保留 bumped 成员的 kind/type 语义）
  for (const m of group) {
    if (!packages[m]) continue;
    const finalVer = allBumped.has(m) ? plan[m].newVer : packages[m].version;
    if (semver.lt(finalVer, target)) {
      if (!allBumped.has(m)) {
        // 未 bump 成员 → fixed-align（patch，仅对齐+刷范围）
        plan[m] = { oldVer: packages[m].version, newVer: target, kind: 'fixed-align', type: 'patch' };
        allBumped.add(m);
      } else {
        // 已 bump 成员因组内 drift 被拉高 → 保留其 kind/type，只升版本（CHANGELOG 语义不变）
        plan[m].newVer = target;
      }
      verMap[m] = { old: packages[m].version, new: target };
    }
  }
}

if (Object.keys(plan).length === 0) {
  console.log('无可处理的版本改动（未传 --changed，且 DEPENDENTS_OF_CHANGED 为空）。');
  process.exit(0);
}

// --- 生成 CHANGELOG 段 ---
const SHA = shortSha();
function changelogForChanged(name) {
  // 取声明该包的 changeset body（可能多个 → 多条目）
  const entries = changesets.filter(cs => cs.decls.some(d => d.name === name));
  const items = [];
  if (entries.length === 0) {
    items.push(`- ${SHA}: (no changeset body; ${plan[name].type} version bump)`);
  } else {
    for (const cs of entries) {
      // body 逐行 trim 后统一缩进 2 空格；空行保持真空（避免尾随空白）
      const bodyLines = cs.body.replace(/\r\n/g, '\n').split('\n');
      const firstLine = bodyLines[0].trim();
      const restLines = bodyLines.slice(1).map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      let item = `- ${SHA}: ${firstLine}`;
      if (restLines) {
        const indented = restLines.split('\n').map(l => l === '' ? '' : '  ' + l).join('\n');
        item += `\n\n${indented}`;
      }
      items.push(item);
    }
  }
  return items;
}
function changelogForDependent(name) {
  const triggers = plan[name].triggers || [];
  const trigStr = triggers.length > 0
    ? triggers.map(t => `${t.name}@${t.old} → ${t.name}@${t.new}`).join(', ')
    : '(no triggering dep detected)';
  return [`- ${SHA}: chore: refresh dependency range (triggered by ${trigStr})`];
}

// 组装每个包的 CHANGELOG 块
function buildSection(name) {
  const pl = plan[name];
  const typeHeading = pl.kind === 'dependent' || pl.kind === 'fixed-align'
    ? 'Patch Changes'
    : ({ major: 'Major Changes', minor: 'Minor Changes', patch: 'Patch Changes' }[pl.type]);
  const items = pl.kind === 'changed' ? changelogForChanged(name) : changelogForDependent(name);
  return `## ${pl.newVer}\n\n### ${typeHeading}\n\n${items.join('\n\n')}\n`;
}

// 把新 section 插入 CHANGELOG.md（标题之后）
function prependChangelog(pkgPath, pkgName, section) {
  const filePath = path.join(ROOT, pkgPath.replace(/package\.json$/, 'CHANGELOG.md'));
  let existing = '';
  if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, 'utf8');
  const header = `# ${pkgName}\n\n`;
  let out;
  if (existing.startsWith(`# ${pkgName}`)) {
    const lines = existing.split('\n');
    lines.shift(); // 去标题行
    while (lines.length && lines[0] === '') lines.shift();
    const rest = lines.join('\n');
    out = header + section + (rest ? '\n' + rest : '');
  } else {
    out = header + section + (existing ? '\n' + existing : '');
  }
  return { filePath, out };
}

// --- 写 package.json（保留格式：探测 indent + 保留尾换行）---
function writeJsonPreserve(file, mutator) {
  const raw = fs.readFileSync(file, 'utf8');
  const obj = JSON.parse(raw);
  mutator(obj);
  const indentMatch = raw.match(/\n( +|"\t")"/);
  const indent = indentMatch ? indentMatch[1] : '  ';
  const trailingNl = raw.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, JSON.stringify(obj, null, indent) + trailingNl);
}

// --- 判定可消费的 .changeset/*.md：其声明的包全部在本次 bump 集合内 ---
function consumableChangesets() {
  return changesets.filter(cs => cs.decls.length > 0 && cs.decls.every(d => allBumped.has(d.name)));
}

// ===================== 执行 / dry-run =====================
const out = [];
out.push(DRY_RUN ? '=== DRY RUN（不写文件） ===' : '=== 执行版本 bump ===');
out.push('');
out.push('版本变更：');
for (const name of Object.keys(plan).sort()) {
  const pl = plan[name];
  const tag = pl.kind === 'changed' ? `[changed/${pl.type}]` : (pl.kind === 'fixed-align' ? '[fixed-align]' : '[dependent/patch]');
  out.push(`  ${name}: ${pl.oldVer} → ${pl.newVer}  ${tag}`);
}
out.push('');
out.push('CHANGELOG 预览：');
for (const name of Object.keys(plan).sort()) {
  out.push(`--- ${name} (${packages[name].dir.replace(/\/$/, '')}/CHANGELOG.md) ---`);
  out.push(buildSection(name).trimEnd());
  out.push('');
}
const consumable = consumableChangesets();
out.push('将消费的 .changeset/*.md：');
if (consumable.length === 0) out.push('  (none)');
for (const cs of consumable) out.push(`  .changeset/${cs.file}`);
out.push('');

if (DRY_RUN) {
  out.push('（dry-run：未写任何 package.json，未改任何 CHANGELOG.md，未删任何 .changeset）');
  console.log(out.join('\n'));
  process.exit(0);
}

// 实际写
const touchedFiles = [];
for (const name of Object.keys(plan)) {
  const p = packages[name];
  // package.json
  const pjAbs = path.join(ROOT, p.pkgPath);
  writeJsonPreserve(pjAbs, (obj) => { obj.version = plan[name].newVer; });
  touchedFiles.push(p.pkgPath);
  // CHANGELOG
  const { filePath: clAbs, out: clOut } = prependChangelog(p.pkgPath, name, buildSection(name));
  fs.writeFileSync(clAbs, clOut);
  touchedFiles.push(path.relative(ROOT, clAbs));
}
// 删除已消费 changeset
for (const cs of consumable) {
  fs.unlinkSync(path.join(changesetDir, cs.file));
}

out.push('已修改文件：');
for (const f of touchedFiles.sort()) out.push(`  ${f}`);
console.log(out.join('\n'));
NODE_SCRIPT

node "$TMPDIR_WORK/apply.cjs" "$ROOT" "$CHANGED_LIST_FILE" "$DEPS_LIST_FILE" "$DRY_RUN"
