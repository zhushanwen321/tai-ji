#!/usr/bin/env node
/**
 * CDP 断言脚本自测入口（U0 验收条款①）——零 token、不依赖 dev 实例必跑绿、约 3s。
 *
 * 覆盖：
 *   sampler-zero-hit        窗口内零命中 → 零渲染族 PASS（「3s 不闪」语义）
 *   sampler-mid-hit         窗口中段命中 → FAIL 且命中时间戳可定位
 *   sampler-after-window    窗口结束后才出现 → PASS（窗口有界语义）
 *   sampler-clickable-hidden  在场但不可见 → fallback-not-lit PASS（谓词分层）
 *   sampler-clickable-disabled 在场可见但 disabled → fallback-not-lit PASS（「可点不亮」口径）
 *   sampler-clickable-live  在场可见可点 → fallback-not-lit FAIL
 *   sampler-eventually      窗口内出现 → eventually PASS；不出现 → FAIL
 *   predicate-param         --predicate 可参数化（exists 与 visible 判定分叉可观测）
 *   dry-run-auto-port       --dry-run 对 dev 实例空跑（自动解析 dev-instance --print CDP 端口）
 *   dry-run-params          --window-ms 等参数透传进执行计划
 *   dry-run-bad-kind        非法 kind → exit 2
 *   dev-instance-reachable  CDP 探活（实例未运行 = SKIP 不计红，空跑已覆盖验收口径）
 *
 * 采样语义用**同一份** sampler 脚本字符串在 node vm + fake DOM 沙箱执行（与 CDP
 * Runtime.evaluate 通道零分叉）；真实 DOM 轨归 U6 验收窗口。
 *
 * 运行：node scripts/acceptance/plan-mode/cdp/selftest.mjs
 * 退出码：0 = 全绿；1 = 任一用例红。
 */
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWindowAssertion, KIND_DEFAULTS, parseArgs, resolveCdpUrl } from './assert-window.mjs';
import { listTargets, parseDevInstanceOutput, pickTarget } from './lib/cdp-client.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = resolve(SCRIPT_DIR, 'assert-window.mjs');

let failed = 0;
const results = [];
function check(name, ok, evidence) {
  results.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${evidence}`);
  if (!ok) failed += 1;
}
const assert$ = (name, cond, evidence) => check(name, Boolean(cond), evidence);

/** fake DOM 沙箱（时间线由 state 控制；vm 执行的是 sampler 真脚本字符串）。 */
function makeSandbox(state) {
  const el = {
    getClientRects: () => (state.visible ? [{}] : []),
    disabled: state.disabled,
    getAttribute: (k) => (k === 'aria-disabled' ? (state.ariaDisabled ? 'true' : null) : null),
  };
  const sandbox = {
    document: { querySelector: () => (state.present ? el : null) },
    window: {},
    setInterval,
    clearInterval,
    Date,
    JSON,
  };
  return vm.createContext(sandbox);
}

function evalIn(ctx, expr) {
  return vm.runInContext(expr, ctx);
}

/** 单断言单沙箱（install 与 stop 必须共享同一 window.__taijiAssertSampler）。 */
function makeEvaluator(state) {
  const ctx = makeSandbox(state);
  return (e) => evalIn(ctx, e);
}

const short = { windowMs: 150, pollMs: 10 };

async function main() {
  // ── 采样语义 ──────────────────────────────────────────────────────
  {
    const state = { present: false, visible: false, disabled: false, ariaDisabled: false };
    const r = await runWindowAssertion({ evaluate: makeEvaluator(state), kind: 'suppress', selector: '[data-testid="plan-review-degraded"]', label: KIND_DEFAULTS.suppress.label, ...short });
    assert$('sampler-zero-hit', r.pass && r.result.total === 0, r.verdict);
  }
  {
    const state = { present: true, visible: true, disabled: false, ariaDisabled: false };
    const r = await runWindowAssertion({ evaluate: makeEvaluator(state), kind: 'suppress', selector: 'x', label: 't', ...short });
    assert$('sampler-mid-hit', !r.pass && r.result.total > 0 && typeof r.result.hits[0] === 'number', `${r.verdict}（命中时间戳可定位）`);
  }
  {
    const state = { present: false, visible: true, disabled: false, ariaDisabled: false };
    setTimeout(() => { state.present = true; }, 400); // 窗口（150ms）结束后才出现
    const r = await runWindowAssertion({ evaluate: makeEvaluator(state), kind: 'suppress', selector: 'x', label: 't', ...short });
    assert$('sampler-after-window', r.pass && r.result.total === 0, r.verdict);
  }
  {
    const state = { present: true, visible: false, disabled: false, ariaDisabled: false };
    const r = await runWindowAssertion({ evaluate: makeEvaluator(state), kind: 'fallback-not-lit', selector: 'x', label: 't', ...short });
    assert$('sampler-clickable-hidden', r.pass, `${r.verdict}（在场不可见 ≠ 可点亮）`);
  }
  {
    const state = { present: true, visible: true, disabled: true, ariaDisabled: false };
    const r = await runWindowAssertion({ evaluate: makeEvaluator(state), kind: 'fallback-not-lit', selector: 'x', label: 't', ...short });
    assert$('sampler-clickable-disabled', r.pass, `${r.verdict}（disabled ≠ 可点亮）`);
  }
  {
    const state = { present: true, visible: true, disabled: false, ariaDisabled: false };
    const r = await runWindowAssertion({ evaluate: makeEvaluator(state), kind: 'fallback-not-lit', selector: 'x', label: 't', ...short });
    assert$('sampler-clickable-live', !r.pass, r.verdict);
  }
  {
    const state = { present: true, visible: true, disabled: false, ariaDisabled: false };
    const r1 = await runWindowAssertion({ evaluate: makeEvaluator(state), kind: 'eventually', selector: 'x', label: 't', ...short });
    const state2 = { present: false, visible: true, disabled: false, ariaDisabled: false };
    const r2 = await runWindowAssertion({ evaluate: makeEvaluator(state2), kind: 'eventually', selector: 'x', label: 't', ...short });
    assert$('sampler-eventually', r1.pass && !r2.pass, `出现→${r1.pass ? 'PASS' : 'FAIL'}，不出现→${r2.pass ? 'PASS' : 'FAIL'}`);
  }
  {
    // 同一 DOM（在场但不可见）：exists 命中、visible 不命中——谓词参数化分叉
    const state = { present: true, visible: false, disabled: false, ariaDisabled: false };
    const rExists = await runWindowAssertion({ evaluate: makeEvaluator(state), kind: 'eventually', selector: 'x', predicate: 'exists', label: 't', ...short });
    const rVisible = await runWindowAssertion({ evaluate: makeEvaluator(state), kind: 'eventually', selector: 'x', predicate: 'visible', label: 't', ...short });
    assert$('predicate-param', rExists.pass && !rVisible.pass, `exists=${rExists.pass ? 'PASS' : 'FAIL'} vs visible=${rVisible.pass ? 'PASS' : 'FAIL'}`);
  }

  // ── CLI 空跑（对 dev 实例）────────────────────────────────────────
  const dry = spawnSync(process.execPath, [SELF, '--kind', 'suppress', '--dry-run'], { encoding: 'utf-8' });
  assert$('dry-run-auto-port', dry.status === 0 && /dev 实例 CDP: http:\/\/localhost:\d+/.test(dry.stdout) && /空跑完成/.test(dry.stdout),
    `exit=${dry.status}，${(dry.stdout.match(/dev 实例 CDP: \S+/) ?? [''])[0]}`);
  assert$('dry-run-params', /\[dry-run\] 断言计划: kind=suppress label=抑制窗/.test(dry.stdout) && /window=3000ms/.test(dry.stdout),
    '执行计划含 kind/label/window 参数');
  const dryFallback = spawnSync(process.execPath, [SELF, '--kind', 'fallback-not-lit', '--window-ms', '10000', '--poll-ms', '200', '--dry-run'], { encoding: 'utf-8' });
  assert$('dry-run-params-override', dryFallback.status === 0 && /window=10000ms poll=200ms/.test(dryFallback.stdout) && /predicate=clickable/.test(dryFallback.stdout),
    '参数覆盖透传（10s 兜底窗 + clickable 谓词）');
  const dryZero = spawnSync(process.execPath, [SELF, '--kind', 'zero-render', '--window-ms', '1500', '--dry-run'], { encoding: 'utf-8' });
  assert$('dry-run-zero-render', dryZero.status === 0 && /kind=zero-render label=稳定窗/.test(dryZero.stdout) && /窗口内 total === 0/.test(dryZero.stdout),
    '稳定窗「间隙内零渲染」执行计划就绪');
  const bad = spawnSync(process.execPath, [SELF, '--kind', 'nope', '--dry-run'], { encoding: 'utf-8' });
  assert$('dry-run-bad-kind', bad.status === 2 && /unknown kind/.test(bad.stderr), `exit=${bad.status}（非法 kind 拒绝）`);

  // ── CDP 探活（实例未运行 = SKIP 不计红）────────────────────────────
  {
    const parsed = parseDevInstanceOutput('│  CDP:            http://localhost:9320\n');
    assert$('parse-dev-instance-output', parsed === 'http://localhost:9320', `解析 dev-instance --print: ${parsed}`);
    try {
      const cdpUrl = resolveCdpUrl(parseArgs([]));
      const targets = await listTargets(cdpUrl);
      const t = pickTarget(targets);
      check('dev-instance-reachable', true, `dev 实例可达: ${t.url}`);
    } catch (e) {
      check('dev-instance-reachable', true, `SKIP（dev 实例未运行/无页面，真机连跑归 U6）: ${e.message}`);
    }
  }

  console.log(`\ncdp assert selftest: ${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('selftest runner error:', e);
  process.exit(1);
});
