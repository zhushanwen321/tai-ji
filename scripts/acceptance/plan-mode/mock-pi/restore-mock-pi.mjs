#!/usr/bin/env node
/**
 * mock pi 卸载器——**三证恢复**（S12 验收纪律：symlink 还原 + `--version` 真实输出 + `ls -l` 形态）。
 *
 * 三证（缺一不算恢复，全部 PASS 才 exit 0）：
 * 证① symlink 还原：`pi.bak` 移回 `pi`，且 lstat 形态/链接目标与安装回执一致；
 * 证② `--version` 真实输出：`<bin>/pi --version` 输出非空且不含 mock 标记；
 * 证③ `ls -l` 形态核对：捕获 `ls -l <bin>/pi` 原样输出（symlink `->` 目标形态）留证。
 *
 * 用法：
 *   node scripts/acceptance/plan-mode/mock-pi/restore-mock-pi.mjs [--bin-dir <dir>] [--config <path>]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WRAPPER_MARKER = 'taiji acceptance mock-pi wrapper';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--bin-dir') out.binDir = resolve(argv[++i]);
    else if (a === '--config') out.configPath = resolve(argv[++i]);
    else throw new Error(`restore-mock-pi: unknown arg: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const binDir = args.binDir ?? resolve(SCRIPT_DIR, '..', '..', '..', '..', 'node_modules', '.bin');
const configPath = args.configPath ?? join(os.homedir(), '.taiji-dev', 'mock-pi', 'active-config.json');
const receiptPath = join(dirname(configPath), 'install-receipt.json');
const piPath = join(binDir, 'pi');
const bakPath = join(binDir, 'pi.bak');

let receipt = null;
if (existsSync(receiptPath)) {
  receipt = JSON.parse(readFileSync(receiptPath, 'utf-8'));
}

const proofs = [];
function proof(n, pass, evidence) {
  proofs.push({ n, pass, evidence });
  console.log(`[restore-mock-pi] 证${n} ${pass ? 'PASS' : 'FAIL'}: ${evidence}`);
}

// ── 还原 ───────────────────────────────────────────────────────────
const piStat = lstatSync(piPath, { throwIfNoEntry: false });
if (piStat) {
  const isWrapper = !piStat.isSymbolicLink() && safeRead(piPath).includes(WRAPPER_MARKER);
  if (!isWrapper) {
    console.log('[restore-mock-pi] pi 不是 mock wrapper（可能已恢复），继续三证核对');
  } else {
    rmSync(piPath);
    if (existsSync(bakPath)) {
      renameSync(bakPath, piPath);
    } else if (receipt?.originalTarget) {
      // .bak 丢失：按回执重建 symlink（软恢复，形态仍需过三证）
      mkdirSync(binDir, { recursive: true });
      execFileSync('ln', ['-s', receipt.originalTarget, piPath]);
    } else {
      proof(1, false, `无法还原：${bakPath} 缺失且无安装回执`);
      finish();
    }
  }
}

// ── 三证 ───────────────────────────────────────────────────────────
const afterStat = lstatSync(piPath, { throwIfNoEntry: false });
const restoredSymlink = afterStat?.isSymbolicLink() ? readlinkSync(piPath) : null;
const expectTarget = receipt?.originalTarget ?? null;
const formMatches = receipt ? (Boolean(restoredSymlink) === Boolean(receipt.originalWasSymlink)) && (restoredSymlink === expectTarget || expectTarget === null) : Boolean(restoredSymlink);
proof(1, Boolean(afterStat) && formMatches, `symlink 还原: restored=${JSON.stringify(restoredSymlink)} expected=${JSON.stringify(expectTarget)}`);

const ver = spawnSync(piPath, ['--version'], { encoding: 'utf-8' });
const verOut = `${ver.stdout ?? ''}${ver.stderr ?? ''}`.trim();
proof(2, ver.status === 0 && verOut.length > 0 && !verOut.includes('mock-pi'), `\`--version\` 真实输出: ${JSON.stringify(verOut)} (exit=${ver.status})`);

let lsOut = '';
try {
  lsOut = execFileSync('ls', ['-l', piPath], { encoding: 'utf-8' }).trim();
} catch (e) {
  lsOut = `ls failed: ${e.message}`;
}
proof(3, lsOut.includes('->') || (afterStat && !afterStat.isSymbolicLink() && formMatches), `ls -l 形态: ${lsOut}`);

finish();

function finish() {
  // 留证落盘（S12「验收结束恢复三证」举证材料）
  const evidencePath = join(dirname(configPath), 'restore-evidence.json');
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify({ finishedAt: new Date().toISOString(), proofs }, null, 2)}\n`);
  console.log(`[restore-mock-pi] 证据落盘: ${evidencePath}`);
  const allPass = proofs.length === 3 && proofs.every((p) => p.pass);
  console.log(allPass ? '[restore-mock-pi] 三证齐 —— 恢复完成' : '[restore-mock-pi] 三证不齐 —— 未恢复，请人工核对');
  process.exit(allPass ? 0 : 1);
}

function safeRead(p) {
  try {
    return readFileSync(p, 'utf-8').slice(0, 4096);
  } catch {
    return '';
  }
}
