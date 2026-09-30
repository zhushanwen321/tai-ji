/**
 * 页内采样器脚本构造（CDP 断言脚本族的「零渲染」观测核心）。
 *
 * 形态 = 可注入任意 JS 沙箱的表达式字符串（真实通道：CDP Runtime.evaluate；
 * 自测通道：node vm + fake DOM——**同一份采样代码**，语义无分叉）。
 *
 * 采样语义：每 pollMs 查询 selector 并按谓词判定命中；命中即累计（带时间戳，
 * 上限 recordLimit 条防记录爆炸，total 仍全量计数）。断言判定基于 stop() 返回的
 * { total, hits, samples, elapsedMs }——「窗口内零渲染」= total === 0。
 *
 * 谓词：
 * - exists    命中 DOM 即真
 * - visible   命中且 getClientRects().length > 0（隐藏/未布局 = 不渲染）
 * - clickable visible 且非 disabled / aria-disabled（「可点 degraded 不亮」口径）
 */

export function buildInstallScript({ selector, predicate = 'visible', pollMs = 100, recordLimit = 20 }) {
  const opts = JSON.stringify({ selector, predicate, pollMs, recordLimit });
  return `(() => {
  const opts = ${opts};
  if (window.__taijiAssertSampler) { try { window.__taijiAssertSampler.stop(); } catch (e) { /* replace */ } }
  const state = { hits: [], total: 0, samples: 0, startedAt: Date.now() };
  const check = () => {
    state.samples += 1;
    let hit = false;
    const el = document.querySelector(opts.selector);
    if (el) {
      if (opts.predicate === 'exists') {
        hit = true;
      } else if (opts.predicate === 'visible') {
        hit = el.getClientRects().length > 0;
      } else if (opts.predicate === 'clickable') {
        hit = el.getClientRects().length > 0 && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      }
    }
    if (hit) {
      state.total += 1;
      if (state.hits.length < opts.recordLimit) state.hits.push(Date.now() - state.startedAt);
    }
  };
  const timer = setInterval(check, opts.pollMs);
  window.__taijiAssertSampler = {
    stop() {
      clearInterval(timer);
      return {
        selector: opts.selector,
        predicate: opts.predicate,
        hits: state.hits.slice(),
        total: state.total,
        samples: state.samples,
        elapsedMs: Date.now() - state.startedAt,
      };
    },
  };
  return true;
})()`;
}

export const STOP_SCRIPT = 'window.__taijiAssertSampler ? window.__taijiAssertSampler.stop() : null';
