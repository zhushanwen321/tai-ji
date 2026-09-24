/**
 * 最小 CDP 客户端（taiji plan 模式验收 CDP 断言脚本族）。
 *
 * 依赖 = Node 24 内建 fetch + WebSocket（零第三方依赖，不引 playwright——本族只做
 * Runtime.evaluate 轮询断言，browser-automation skill 的完整 CDP 工具链是另一形态）。
 *
 * 目标发现 = dev 实例 CDP 端口（`node apps/electron/scripts/dev-instance.mjs --print`），
 * `GET <cdp>/json/list` 枚举 targets，按 URL pattern 挑 renderer 页面。
 */

/** 枚举 CDP targets（/json/list）。 */
export async function listTargets(cdpUrl) {
  const res = await fetch(`${cdpUrl}/json/list`);
  if (!res.ok) throw new Error(`cdp-client: ${cdpUrl}/json/list -> HTTP ${res.status}`);
  return res.json();
}

/** 按 URL pattern 挑页面 target（缺省取首个 page 类型且非 devtools 的 target）。 */
export function pickTarget(targets, urlPattern) {
  const pages = targets.filter((t) => t.type === 'page' || t.type === 'webview');
  const pat = urlPattern ? new RegExp(urlPattern) : null;
  const hit = pat ? pages.find((t) => pat.test(t.url ?? '')) : pages[0];
  if (!hit?.webSocketDebuggerUrl) {
    throw new Error(`cdp-client: no matching page target (pattern=${urlPattern ?? '<first>'}, candidates=${pages.map((t) => t.url).join(' | ')})`);
  }
  return hit;
}

/** 连接 target 的 WebSocket debugger 通道，返回 { evaluate, close }。 */
export function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`cdp-client: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    }
  });

  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error(`cdp-client: WS connect failed: ${wsUrl}`)), { once: true });
  });

  function send(method, params) {
    seq += 1;
    const id = seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  return {
    async ready() {
      await opened;
    },
    /** Runtime.evaluate（returnByValue），返回 JS 值。 */
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(`cdp-client: evaluate exception: ${r.exceptionDetails.text ?? ''} ${r.exceptionDetails.exception?.description ?? ''}`);
      }
      return r.result?.value;
    },
    close() {
      try { ws.close(); } catch { /* already closed */ }
    },
  };
}

/** 从 dev-instance 装配器输出解析 CDP URL（`│ CDP:  http://localhost:9320`）。 */
export function parseDevInstanceOutput(text) {
  const m = text.match(/CDP:\s+(http:\/\/localhost:\d+)/);
  return m ? m[1] : null;
}
