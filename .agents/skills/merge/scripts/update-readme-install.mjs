#!/usr/bin/env node
/**
 * 更新 README 安装段的版本号（merge skill 阶段 6.5 第 2 步调用）。
 *
 * 只替换 README.md / README_EN.md 中 `<!-- INSTALL:BEGIN -->` … `<!-- INSTALL:END -->`
 * 区块内的版本号 token（`v0.9.13` / `0.9.13` 两种形态），区块外内容零打扰——
 * README 正文是人工维护的 SSOT，本脚本只做机械的版本号推进。
 *
 * 用法：node .agents/skills/merge/scripts/update-readme-install.mjs <version>
 *   <version>  如 0.9.14 或 v0.9.14（v 前缀可选，内部归一）。
 *
 * 语义：仅用于正式发布后（merge skill）；prerelease（*-beta.*）不走本脚本——
 * README 安装段永远指向最新正式版，测试版通过 Release 页获取。
 * 幂等：版本已一致时报「已是该版本」exit 0。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
// scripts → merge → skills → .agents → repo root（4 级）
const repoRoot = resolve(scriptDir, '../../../..');
const README_FILES = ['README.md', 'README_EN.md'];

const BEGIN = '<!-- INSTALL:BEGIN -->';
const END = '<!-- INSTALL:END -->';

const arg = process.argv[2];
if (!arg) {
  console.error('用法：node .agents/skills/merge/scripts/update-readme-install.mjs <version>（如 0.9.14）');
  process.exit(1);
}
const version = String(arg).replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
  console.error(`[FAIL] 非法版本号 "${arg}"（期望 semver，如 0.9.14）`);
  process.exit(1);
}

/**
 * 区块内版本 token 替换。
 *
 * [HISTORICAL] 刻意不带 prerelease 后缀组（如 `-beta.1`）：`TaiJi-0.9.13-mac-arm64.dmg`
 * 这类产物文件名的平台后缀会被后缀组整段吞掉（实测事故：`-mac-arm64`/`-x86_64`/
 * `-setup-x64` 全部丢失）。区块只出现正式版，纯 `\d+\.\d+\.\d+` 三段替换即可；
 * `v0.9.13` 的 v 前缀不在匹配内、天然保留。
 */
function bumpVersions(block) {
  let total = 0;
  const out = block.replace(/\d+\.\d+\.\d+/g, () => {
    total += 1;
    return version;
  });
  return { out, total };
}

let failed = false;
for (const file of README_FILES) {
  const path = join(repoRoot, file);
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    console.log(`[skip] ${file} 不存在（英文页未创建？）`);
    continue;
  }
  const beginIdx = content.indexOf(BEGIN);
  const endIdx = content.indexOf(END);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    console.error(`[FAIL] ${file} 缺少 ${BEGIN}/${END} 标记（或顺序错误）——恢复：参照 README.md 的安装段结构补标记。`);
    failed = true;
    continue;
  }
  const before = content.slice(beginIdx + BEGIN.length, endIdx);
  const { out, total } = bumpVersions(before);
  if (total === 0) {
    console.log(`[warn] ${file} 区块内未找到任何版本号 token——检查区块内容是否被误改。`);
    continue;
  }
  if (before === out) {
    console.log(`[ok] ${file} 已是 v${version}（${total} 处版本号，无变化）`);
    continue;
  }
  writeFileSync(path, content.slice(0, beginIdx + BEGIN.length) + out + content.slice(endIdx));
  console.log(`[ok] ${file} 版本号已更新为 v${version}（${total} 处）`);
}

process.exit(failed ? 1 : 0);
