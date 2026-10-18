#!/usr/bin/env node
/**
 * mock-proxy.mjs — 本地 HTTP CONNECT 代理（llm-network-proxy 验收工具，零 npm 依赖）
 *
 * 本机探针事实（设计 §2 证据 3）：undici ProxyAgent 对 http 目标也走 CONNECT 隧道——
 * mock 代理因此只监听 'connect' 事件即可承接全部代理流量。
 *
 * 用法：
 *   node scripts/network-proxy-mocks/mock-proxy.mjs [--port <n>] [--record <file>]
 *        [--with-mock-endpoint] [--block-upstream] [--san <host>]... [--cert-dir <dir>]
 *
 *   --port <n>            监听端口（默认 0 = 临时端口；只绑 127.0.0.1）
 *   --record <file>       CONNECT 记录落 JSON：{ targets: [{host, port, ts}] }（每次 CONNECT 原子重写；启动即重建为空）
 *   --with-mock-endpoint  同时启动 mock LLM HTTPS 端点；CONNECT 目标一律桥接该端点
 *                         （设计 §4 场景 1/9 口径——回复数据来源走 mock，无真实 key 依赖）
 *   --block-upstream      接受 CONNECT（回 200）但不桥接、随即断开——验收场景 3 第三形态
 *                         （代理可达但出口不通；与 --with-mock-endpoint 同给时本旗标优先）
 *   --san <host>          追加证书 SAN 条目（可重复；默认见 mock-endpoint.mjs DEFAULT_SANS）
 *   --cert-dir <dir>      证书输出目录（缺省 = os.tmpdir() 下临时目录，close 时自清）
 *                         caFile 供 NODE_EXTRA_CA_CERTS 注入客户端信任
 *   --selftest            自测子命令：单跑代理 + curl 经代理访问 mock 端点全链路（脚本内部断言，exit 0）
 *
 * 就绪信号：stdout 单行 JSON——[mock-proxy] {"ready":true,"proxyPort":N,"endpointPort":M,"caFile":"...","recordFile":"..."}
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_SANS,
  generateSelfSignedCert,
  makeTempCertDir,
  startMockLlmEndpoint,
  writeCertFiles,
} from "./mock-endpoint.mjs";

const SELFTEST_ECHO = "ping-selftest-42";
const SELFTEST_BODY = {
  model: "claude-mock",
  max_tokens: 64,
  messages: [{ role: "user", content: SELFTEST_ECHO }],
};

/** 解析 "host:port"（含 IPv6 [..] 形态）。 */
function parseHostPort(url) {
  const colon = url.lastIndexOf(":");
  if (colon < 0) return { host: url, port: 443 };
  return {
    host: url.slice(0, colon).replace(/^\[/, "").replace(/\]$/, ""),
    port: Number(url.slice(colon + 1)) || 443,
  };
}

/**
 * 启动 mock 代理。返回 { server, endpoint, port, endpointPort, caFile, recordFile, recordState, close() }。
 * opts: { port, record, withMockEndpoint, blockUpstream, sans, certDir }
 */
export async function startMockProxy(opts = {}) {
  const state = { targets: [] };
  const recordFile = opts.record ?? null;
  const appendRecord = (entry) => {
    state.targets.push(entry);
    if (!recordFile) return;
    const tmp = `${recordFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ targets: state.targets }, null, 2)}\n`);
    fs.renameSync(tmp, recordFile); // 原子重写，读侧不会看到半行 JSON
  };

  // 先起记录文件（启动即重建为空，防上一轮残留混入断言）
  if (recordFile) {
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    fs.writeFileSync(recordFile, `${JSON.stringify({ targets: [] }, null, 2)}\n`);
  }

  let endpoint = null;
  let certDirOwned = null;
  let caFile = null;
  if (opts.withMockEndpoint) {
    const sans = [...new Set([...DEFAULT_SANS, ...(opts.sans ?? [])])];
    const cert = generateSelfSignedCert({ sans });
    certDirOwned = opts.certDir ?? makeTempCertDir("taiji-mock-proxy-certs-");
    const files = writeCertFiles(cert, certDirOwned);
    caFile = files.caFile;
    endpoint = startMockLlmEndpoint({
      keyPem: fs.readFileSync(files.keyFile, "utf8"),
      certPem: fs.readFileSync(files.certFile, "utf8"),
    });
    await new Promise((resolve, reject) => {
      endpoint.server.once("listening", resolve);
      endpoint.server.once("error", reject);
    });
  }

  const sockets = new Set(); // 隧道两端 socket 跟踪（close 时统一断）
  // HTTP CONNECT 事件只由 http.Server 发出（net.Server 的 'connect' 是 TCP 连接建立，不是代理方法）
  const server = http.createServer((req, res) => {
    // 普通（非 CONNECT）HTTP 请求不是本代理的形态
    res.writeHead(405, { connection: "close" });
    res.end("mock proxy: CONNECT only\n");
  });

  server.on("connect", (req, clientSocket, head) => {
    sockets.add(clientSocket);
    clientSocket.on("close", () => sockets.delete(clientSocket));
    const { host, port } = parseHostPort(req.url);
    appendRecord({ host, port, ts: new Date().toISOString() });

    if (opts.blockUpstream) {
      // 接受 CONNECT 但不桥接：客户端 TLS 握手将失败（场景 3「代理可达但出口不通」形态）
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      setTimeout(() => clientSocket.destroy(), 50);
      return;
    }

    const target = opts.withMockEndpoint ? { host: "127.0.0.1", port: endpoint.port } : { host, port };
    const upstream = net.connect(target.port, target.host);
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => {
      try {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } catch {
        // 客户端已断开
      }
      clientSocket.destroy();
    });
    upstream.on("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    clientSocket.on("error", () => upstream.destroy());
    clientSocket.on("close", () => upstream.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1");
  });

  const close = async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
    if (endpoint) await endpoint.close();
    if (certDirOwned && !opts.certDir) fs.rmSync(certDirOwned, { recursive: true, force: true });
  };

  return {
    server,
    endpoint,
    get port() {
      return server.address().port;
    },
    get endpointPort() {
      return endpoint ? endpoint.port : null;
    },
    caFile,
    recordFile,
    recordState: state,
    close,
  };
}

// ---------- 自测子命令 ----------

// 必须异步执行：本代理与 curl 同进程，execFileSync 会冻结事件循环，
// 代理无法处理 CONNECT → curl 永等 200（互相死锁）。
const execFileP = promisify(execFile);

async function curlRun(args) {
  try {
    const { stdout } = await execFileP("curl", args, { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    return { ok: false, stdout: err?.stdout ?? Buffer.alloc(0), stderr: String(err?.stderr ?? err?.message ?? err) };
  }
}

async function selftest() {
  const failures = [];
  const check = (name, cond, detail = "") => {
    if (cond) {
      console.log(`  ok: ${name}`);
    } else {
      failures.push(name);
      console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    }
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mock-proxy-selftest-"));
  let a = null;
  let b = null;
  let c = null;
  try {
    // A) CONNECT 记录 + 一律桥接 mock 端点 + gzip/SSE 两形态全链路
    a = await startMockProxy({
      port: 0,
      withMockEndpoint: true,
      record: path.join(tmp, "a-record.json"),
      certDir: path.join(tmp, "certs-a"),
    });
    check("A: 端点与代理就绪（caFile 已产出）", typeof a.port === "number" && typeof a.caFile === "string");
    const base = ["--max-time", "10", "-sS", "--proxy", `http://127.0.0.1:${a.port}`, "--cacert", a.caFile];
    const url = "https://api.anthropic.com/v1/messages";

    // 非 stream：传输层显式 gzip（curl 未带 --compressed 时输出原始字节）
    const raw = await curlRun([...base, "-X", "POST", "-H", "content-type: application/json", "-d", JSON.stringify(SELFTEST_BODY), url]);
    check("A: CONNECT 隧道 + 自签信任链打通（curl exit 0）", raw.ok && raw.stdout.length > 0, raw.stderr.slice(-200));
    check("A: 响应体在传输层为 gzip（魔数 1f 8b）", raw.stdout[0] === 0x1f && raw.stdout[1] === 0x8b, `首字节 ${raw.stdout[0]} ${raw.stdout[1]}`);
    let parsed = null;
    try {
      parsed = JSON.parse(zlib.gunzipSync(raw.stdout).toString("utf8"));
    } catch {
      // 留给下一断言报失败
    }
    check(
      "A: anthropic /v1/messages 响应形态 + 回显（type=message，content[0].text 含请求文本）",
      parsed?.type === "message" && parsed?.content?.[0]?.text?.includes(SELFTEST_ECHO),
      parsed ? `text=${parsed?.content?.[0]?.text}` : "解包失败",
    );

    // stream=true：SSE 事件流（整流 gzip 包裹）
    const sseRaw = await curlRun([...base, "-N", "-X", "POST", "-H", "content-type: application/json", "-d", JSON.stringify({ ...SELFTEST_BODY, stream: true }), url]);
    let sse = "";
    try {
      sse = zlib.gunzipSync(sseRaw.stdout).toString("utf8");
    } catch {
      sse = "";
    }
    check(
      "A: SSE 流式形态（message_start…message_stop + text_delta 回显）",
      sse.includes("event: message_start") && sse.includes("event: content_block_delta") && sse.includes("event: message_stop") && sse.includes(SELFTEST_ECHO),
      sse ? sse.slice(0, 120) : "解包失败",
    );

    const recA = JSON.parse(fs.readFileSync(a.recordFile, "utf8"));
    check(
      "A: CONNECT 记录 {targets:[{host,port,ts}]} 含 api.anthropic.com:443",
      Array.isArray(recA.targets) && recA.targets.some((t) => t.host === "api.anthropic.com" && t.port === 443 && typeof t.ts === "string"),
      JSON.stringify(recA).slice(0, 200),
    );

    // B) 无 mock 端点的普通代理：默认分支 = 桥接 CONNECT 声明的真实目标
    //    （桥到 A 的 mock 端点 127.0.0.1:<endpointPort>，证书 SAN 含 127.0.0.1，全程不触外网）
    b = await startMockProxy({ port: 0 });
    const rawB = await curlRun([
      "--max-time", "10", "-sS",
      "--proxy", `http://127.0.0.1:${b.port}`,
      "--cacert", a.caFile,
      "-X", "POST", "-H", "content-type: application/json", "-d", JSON.stringify(SELFTEST_BODY),
      `https://127.0.0.1:${a.endpointPort}/v1/messages`,
    ]);
    let parsedB = null;
    try {
      parsedB = JSON.parse(zlib.gunzipSync(rawB.stdout).toString("utf8"));
    } catch {
      // 留给断言报失败
    }
    check(
      "B: 默认分支桥接真实目标（经两级隧道到 A 的端点，回显一致）",
      parsedB?.content?.[0]?.text?.includes(SELFTEST_ECHO),
      parsedB ? `text=${parsedB?.content?.[0]?.text}` : `raw ${rawB.stdout.length}B ${rawB.stderr.slice(-120)}`,
    );

    // C) block-upstream：接受 CONNECT（回 200）但不桥接 → 客户端出站失败
    c = await startMockProxy({ port: 0, blockUpstream: true, record: path.join(tmp, "c-record.json") });
    const cRun = await curlRun([
      "--max-time", "10", "-sS",
      "--proxy", `http://127.0.0.1:${c.port}`,
      "--cacert", a.caFile,
      "-X", "POST", "-H", "content-type: application/json", "-d", JSON.stringify(SELFTEST_BODY),
      url,
    ]);
    check("C: block-upstream 客户端出站失败（curl 非零退出）", !cRun.ok, cRun.stderr.slice(-200));
    const recC = JSON.parse(fs.readFileSync(c.recordFile, "utf8"));
    check("C: block-upstream 仍记录 CONNECT", Array.isArray(recC.targets) && recC.targets.length >= 1, JSON.stringify(recC).slice(0, 200));

    console.log(failures.length === 0 ? "[mock-proxy] SELFTEST PASS" : `[mock-proxy] SELFTEST FAIL（${failures.length} 项）`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    for (const p of [c, b, a]) await p?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- main ----------

function parseArgs(argv) {
  const opts = { port: 0, record: null, withMockEndpoint: false, blockUpstream: false, sans: [], certDir: null, selftest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--record") opts.record = argv[++i];
    else if (a === "--with-mock-endpoint") opts.withMockEndpoint = true;
    else if (a === "--block-upstream") opts.blockUpstream = true;
    else if (a === "--san") opts.sans.push(argv[++i]);
    else if (a === "--cert-dir") opts.certDir = argv[++i];
    else if (a === "--selftest") opts.selftest = true;
    else {
      console.error(`[mock-proxy] 未知参数: ${a}\n恢复动作：node scripts/network-proxy-mocks/mock-proxy.mjs --selftest 查看用法`);
      process.exit(2);
    }
  }
  return opts;
}

// 仅直接执行时跑 main；被 import（自测 / 漂移探针消费 factory）时不得拉起服务
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) {
    await selftest();
  } else {
    const proxy = await startMockProxy(opts);
    console.log(`[mock-proxy] ${JSON.stringify({ ready: true, proxyPort: proxy.port, endpointPort: proxy.endpointPort, caFile: proxy.caFile, recordFile: proxy.recordFile })}`);
    proxy.server.on("connect", (req) => console.log(`[mock-proxy] CONNECT ${req.url}`));
    process.on("SIGINT", () => proxy.close().then(() => process.exit(0)));
    process.on("SIGTERM", () => proxy.close().then(() => process.exit(0)));
  }
}
