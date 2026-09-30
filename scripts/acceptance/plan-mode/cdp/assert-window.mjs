#!/usr/bin/env node
/**
 * CDP 等待断言——plan 模式抑制窗 / 稳定窗 / 兜底窗的「零渲染」与「最终出现」断言（U0 验收条款①）。
 *
 * 断言口径（设计 plan-mode-state-machine §3.3 D4 + §4 S2/S3）：
 *   suppress        抑制窗「3s 不闪」——respond 后 3s 内 degraded 分支零渲染（默认 selector =
 *                   [data-testid="plan-review-degraded"]，谓词 visible，窗 3000ms）
 *   zero-render     稳定窗「间隙内零渲染」——persist→pending 间隙（mock pi 1.5s 构造）内 degraded
 *                   零渲染（窗 = 间隙时长，默认 1500ms）
 *   fallback-not-lit 「10s 兜底不亮」——兜底窗内可点 degraded 零渲染（冷拉对账后才可渲染；谓词
 *                   clickable，窗 10000ms）
 *   eventually      正向等待——目标在窗内出现（如审批条回到 ready），谓词 exists
 *
 * 全部参数可覆盖（--selector / --predicate / --window-ms / --poll-ms / --label）——U4b 重设计
 * 后 testid 若更名（如「重新提交审批」按钮 [data-testid="plan-review-resubmit"]）直接传参，
 * 断言脚本无需改动。
 *
 * 用法：
 *   node scripts/acceptance/plan-mode/cdp/assert-window.mjs --kind suppress [--cdp-port 9320]
 *   node scripts/acceptance/plan-mode/cdp/assert-window.mjs --kind zero-render --window-ms 1500
 *   node scripts/acceptance/plan-mode/cdp/assert-window.mjs --kind fallback-not-lit
 *   node scripts/acceptance/plan-mode/cdp/assert-window.mjs --kind eventually --selector '[data-testid="plan-review-bar"]'
 *   node scripts/acceptance/plan-mode/cdp/assert-window.mjs --kind suppress --dry-run    # 对 dev 实例空跑
 *
 * 退出码：0 = 断言通过（或 dry-run）；1 = 断言失败；2 = 环境错误（连不上 CDP / 参数非法）。
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, listTargets, parseDevInstanceOutput, pickTarget } from './lib/cdp-client.mjs';
import { buildInstallScript, STOP_SCRIPT } from './lib/sampler-script.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..', '..');
const DEV_INSTANCE = resolve(REPO_ROOT, 'apps/electron/scripts/dev-instance.mjs');

export const KIND_DEFAULTS = {
  suppress: { predicate: 'visible', windowMs: 3000, selector: '[data-testid="plan-review-degraded"]', label: '抑制窗「3s 不闪」' },
  'zero-render': { predicate: 'visible', windowMs: 1500, selector: '[data-testid="plan-review-degraded"]', label: '稳定窗「间隙内零渲染」' },
  'fallback-not-lit': { predicate: 'clickable', windowMs: 10000, selector: '[data-testid="plan-review-degraded"]', label: '「10s 兜底不亮」' },
  eventually: { predicate: 'exists', windowMs: 30000, selector: '[data-testid="plan-review-bar"]', label: '正向等待' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 核心断言（可注入 evaluate/wait——自测通道用 fake DOM 沙箱，生产通道用 CDP）。
 * 零渲染族（suppress / zero-render / fallback-not-lit）：pass ⇔ total === 0；
 * eventually：pass ⇔ total > 0。
 */
export async function runWindowAssertion({ evaluate, kind, selector, predicate, windowMs, pollMs, label, wait = sleep }) {
  const d = KIND_DEFAULTS[kind] ?? {};
  const p = predicate ?? d.predicate ?? 'visible';
  const wMs = Number.isFinite(windowMs) ? windowMs : d.windowMs ?? 3000;
  const pMs = Number.isFinite(pollMs) ? pollMs : 100;
  const lbl = label ?? d.label ?? kind;
  const started = await evaluate(buildInstallScript({ selector, predicate: p, pollMs: pMs }));
  if (started !== true) throw new Error('assert-window: sampler install failed');
  await wait(wMs);
  const r = await evaluate(STOP_SCRIPT);
  if (!r) throw new Error('assert-window: sampler missing at stop');
  const zeroRenderKinds = new Set(['suppress', 'zero-render', 'fallback-not-lit']);
  const pass = zeroRenderKinds.has(kind) ? r.total === 0 : r.total > 0;
  const verdict = `${lbl}（kind=${kind}, selector=${selector}, predicate=${p}, window=${wMs}ms, poll=${pMs}ms）：` +
    `samples=${r.samples} hits=${r.total}${r.hits.length ? ` firstHit=+${r.hits[0]}ms` : ''} → ${pass ? 'PASS' : 'FAIL'}`;
  return { pass, verdict, result: r };
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--kind') out.kind = argv[++i];
    else if (a === '--selector') out.selector = argv[++i];
    else if (a === '--predicate') out.predicate = argv[++i];
    else if (a === '--window-ms') out.windowMs = Number(argv[++i]);
    else if (a === '--poll-ms') out.pollMs = Number(argv[++i]);
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--cdp-port') out.cdpPort = Number(argv[++i]);
    else if (a === '--cdp-url') out.cdpUrl = argv[++i];
    else if (a === '--page-pattern') out.pagePattern = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`assert-window: unknown arg: ${a}`);
  }
  return out;
}

/** 解析 dev 实例 CDP URL（--cdp-url > --cdp-port > dev-instance.mjs --print）。 */
export function resolveCdpUrl(args) {
  if (args.cdpUrl) return args.cdpUrl;
  if (args.cdpPort) return `http://localhost:${args.cdpPort}`;
  const r = spawnSync(process.execPath, [DEV_INSTANCE, '--print'], { cwd: REPO_ROOT, encoding: 'utf-8' });
  const url = parseDevInstanceOutput(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (!url) throw new Error('assert-window: 无法从 dev-instance.mjs --print 解析 CDP URL（用 --cdp-port 显式指定）');
  return url;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const kind = args.kind ?? 'suppress';
  const defaults = KIND_DEFAULTS[kind];
  if (!defaults) throw new Error(`assert-window: unknown kind: ${kind}（${Object.keys(KIND_DEFAULTS).join(' | ')}）`);
  const cfg = {
    kind,
    selector: args.selector ?? defaults.selector,
    predicate: args.predicate ?? defaults.predicate,
    windowMs: Number.isFinite(args.windowMs) ? args.windowMs : defaults.windowMs,
    pollMs: Number.isFinite(args.pollMs) ? args.pollMs : 100,
    label: args.label ?? defaults.label,
  };
  const cdpUrl = resolveCdpUrl(args);

  if (args.dryRun) {
    // 空跑：解析实例与参数并打印执行计划，不连接、不断言（U0 自测「对 dev 实例空跑」形态）
    console.log(`[dry-run] dev 实例 CDP: ${cdpUrl}`);
    console.log(`[dry-run] 断言计划: kind=${cfg.kind} label=${cfg.label}`);
    console.log(`[dry-run] selector=${cfg.selector} predicate=${cfg.predicate} window=${cfg.windowMs}ms poll=${cfg.pollMs}ms`);
    console.log(`[dry-run] 判定: ${['suppress', 'zero-render', 'fallback-not-lit'].includes(cfg.kind) ? '窗口内 total === 0' : '窗口内 total > 0'}`);
    console.log('[dry-run] 空跑完成（未连接、未断言）');
    return 0;
  }

  let conn;
  try {
    const targets = await listTargets(cdpUrl);
    const target = pickTarget(targets, args.pagePattern);
    console.log(`[assert-window] target: ${target.url}`);
    conn = connect(target.webSocketDebuggerUrl);
    await conn.ready();
  } catch (e) {
    console.error(`[assert-window] 环境错误: ${e.message}`);
    return 2;
  }
  try {
    const { pass, verdict } = await runWindowAssertion({ ...cfg, evaluate: (expr) => conn.evaluate(expr) });
    console.log(`[assert-window] ${verdict}`);
    return pass ? 0 : 1;
  } finally {
    conn.close();
  }
}

// 作为脚本直接执行时跑 main；被自测 import 时只导出纯函数
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(`[assert-window] ${e.message}`);
    process.exit(2);
  });
}
