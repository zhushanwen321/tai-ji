#!/usr/bin/env node
/**
 * Ensure the Electron binary is available for `npm run dev`.
 *
 * Layout:
 *
 *   workspace-root/                    ← <workspace>/（bare repo 模式，含 .bare/）
 *     .electron-dist/                  ← Electron.app 永久存放处（所有 worktree 共享）
 *     .bare/
 *     main/                            ← worktree
 *     feat-xxx/                        ← worktree
 *       apps/electron/node_modules/electron/
 *         dist  → ../../../../../.electron-dist   (symlink)
 *         path.txt                              (写死平台路径)
 *
 * 此脚本会在 `npm run dev` 之前运行：
 *   1. 检查 .electron-dist 是否存在且版本匹配
 *   2. 若不存在，调用 electron 自带 install.js 下载，然后搬到 .electron-dist
 *   3. 创建 symlink: node_modules/electron/dist → ../../../../.electron-dist
 *   4. 写入 path.txt
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname = <worktree>/apps/electron/scripts → 上三级到 worktree 根
const WORKTREE_ROOT = path.resolve(__dirname, '../../..');

// workspace root = worktree 的上一级（和 .bare 同级）
const WORKSPACE_ROOT = path.resolve(WORKTREE_ROOT, '..');

const SHARED_DIST = path.join(WORKSPACE_ROOT, '.electron-dist');
// [HISTORICAL] ada6c0466 把 .npmrc 从 hoisted 切到 isolated 后，electron 不再提升到
// worktree 根 node_modules，而是在 .pnpm/electron@x.y.z/node_modules/electron/。
// 旧实现写死 WORKTREE_ROOT/node_modules/electron，isolated 下 readVersion() 读 package.json
// 即 ENOENT，dev 启动崩在 electron-ensure（先于 process-control.ts 的 tsx 解析执行）。
// 正确做法：createRequire 从本脚本所在包（apps/electron，electron 的声明方）按 Node 解析算法
// 定位真实路径——与 supervisor 的 tsx 解析（process-control.ts 的 require.resolve）同思路，
// isolated → .pnpm/electron@x.y.z/...；hoisted → worktree 根。跨 linker 模式稳定。
const __require = createRequire(import.meta.url);
const ELECTRON_MODULE = path.dirname(__require.resolve('electron/package.json'));
const DIST_LINK = path.join(ELECTRON_MODULE, 'dist');
const PATH_TXT = path.join(ELECTRON_MODULE, 'path.txt');

// ─── Helpers ─────────────────────────────────────────────

/** Platform-specific binary path relative to dist root */
function getExePath() {
  switch (os.platform()) {
    case 'darwin': return 'Electron.app/Contents/MacOS/Electron';
    case 'win32':  return 'electron.exe';
    default:       return 'electron';
  }
}

/** Read electron version from node_modules package.json */
function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(ELECTRON_MODULE, 'package.json'), 'utf-8')).version;
}

/** Check if .electron-dist has the correct version */
function isSharedDistValid(version) {
  const vf = path.join(SHARED_DIST, 'version');
  if (!fs.existsSync(vf)) return false;
  return fs.readFileSync(vf, 'utf-8').trim().replace(/^v/, '') === version;
}

/** Check if symlink + path.txt are correct */
function isLinkValid(version) {
  if (!fs.existsSync(PATH_TXT)) return false;
  if (fs.readFileSync(PATH_TXT, 'utf-8').trim() !== getExePath()) return false;

  try {
    const real = fs.realpathSync(DIST_LINK);
    const vf = path.join(real, 'version');
    if (!fs.existsSync(vf)) return false;
    return fs.readFileSync(vf, 'utf-8').trim().replace(/^v/, '') === version;
  } catch {
    return false;
  }
}

/** Download via electron's own install.js, then move to .electron-dist */
function downloadAndMove(version) {
  console.log(`[electron-ensure] ⬇ Downloading Electron v${version}...`);
  execSync('node install.js', { cwd: ELECTRON_MODULE, stdio: 'inherit' });

  if (fs.existsSync(SHARED_DIST)) fs.rmSync(SHARED_DIST, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.renameSync(DIST_LINK, SHARED_DIST);
  console.log(`[electron-ensure] ✅ Saved to ${SHARED_DIST}`);
}

/** Steal existing node_modules dist and move to shared location */
function stealAndMove() {
  console.log(`[electron-ensure] 📦 Moving existing binary to ${SHARED_DIST}...`);
  if (fs.existsSync(SHARED_DIST)) fs.rmSync(SHARED_DIST, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.renameSync(DIST_LINK, SHARED_DIST);
}

/** Create symlink: node_modules/electron/dist → ../../../../.electron-dist */
function ensureLink() {
  try { fs.rmSync(DIST_LINK, { recursive: true, force: true }); } catch { /* nothing to remove */ }
  // Compute relative path from ELECTRON_MODULE to SHARED_DIST
  const rel = path.relative(ELECTRON_MODULE, SHARED_DIST);
  fs.symlinkSync(rel, DIST_LINK, 'junction');
}

// ─── Main ────────────────────────────────────────────────

const version = readVersion();

// Step 1: Ensure shared dist
if (!isSharedDistValid(version)) {
  // Check if node_modules already has a valid binary we can reuse
  const nmVerFile = path.join(DIST_LINK, 'version');
  let canSteal = false;
  try {
    if (fs.existsSync(nmVerFile)) {
      const v = fs.readFileSync(nmVerFile, 'utf-8').trim().replace(/^v/, '');
      canSteal = v === version && fs.existsSync(path.join(DIST_LINK, getExePath()));
    }
  } catch { /* empty */ }

  if (canSteal) {
    stealAndMove();
  } else {
    downloadAndMove(version);
  }
} else {
  console.log(`[electron-ensure] ✅ Electron v${version} binary: ${SHARED_DIST}`);
}

// Step 2: Ensure symlink + path.txt
if (!isLinkValid(version)) {
  ensureLink();
  fs.writeFileSync(PATH_TXT, getExePath(), 'utf-8');
  console.log(`[electron-ensure] ✅ Symlink: ${DIST_LINK} → ${SHARED_DIST}`);
} else {
  console.log(`[electron-ensure] ✅ Symlink valid`);
}

console.log(`[electron-ensure] 🚀 Ready (Electron v${version})`);
