#!/usr/bin/env node
/**
 * socks5-server.mjs — 最小 SOCKS5 服务（llm-network-proxy 验收工具，零 npm 依赖）
 *
 * 覆盖设计 §4 场景 9（SOCKS5 主链）：RFC 1928 握手 + RFC 1929 用户名密码认证 +
 * CONNECT 命令桥接。构造属测试工具实现，非待验证机制。
 *
 * 用法：
 *   node scripts/network-proxy-mocks/socks5-server.mjs [--port <n>] [--record <file>]
 *        [--auth <user:pass>] [--with-mock-endpoint] [--san <host>]... [--cert-dir <dir>]
 *
 *   --port <n>            监听端口（默认 0 = 临时端口；只绑 127.0.0.1）
 *   --auth <user:pass>    开启 RFC 1929 用户名密码认证（缺省 = 无需认证方法 0x00 形态）
 *   --record <file>       连接记录落 JSON：{ targets: [{host, port, ts}] }（每次 CONNECT 原子重写；启动即重建为空）
 *   --with-mock-endpoint  同时启动 mock LLM HTTPS 端点（mock-proxy.mjs 同款）；CONNECT 目标一律桥接该端点
 *                         （场景 9 口径：CONNECT 目标一律桥接场景 1 同款本地 mock LLM 端点）
 *   --san <host>          追加证书 SAN 条目（可重复）
 *   --cert-dir <dir>      证书输出目录（缺省 = os.tmpdir() 下临时目录，close 时自清）
 *   --selftest            自测子命令：curl 经 SOCKS5 访问 mock 端点全链路（认证正/负两形态 + IP 目标桥接，脚本内部断言，exit 0）
 *
 * 就绪信号：stdout 单行 JSON——[socks5-server] {"ready":true,"port":N,"endpointPort":M,"caFile":"...","recordFile":"..."}
 *
 * 协议范围：仅 CONNECT（其余命令回 REP=7 command not supported）；
 * ATYP 支持 IPv4 / 域名 / IPv6；握手段 10s 无进展即断开（防垃圾连接悬挂）。
 */

import fs from "node:fs";
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

/** 握手读取器：按需读取 n 字节；10s 无进展 / 连接断开即抛错。 */
function makeHandshakeReader(socket) {
  const queue = [];
  let queued = 0;
  let waiter = null;
  let failure = null;
  const fail = (err) => {
    failure = err;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };
  socket.on("data", (chunk) => {
    queue.push(chunk);
    queued += chunk.length;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  });
  socket.on("close", () => fail(new Error("客户端在握手段断开")));
  socket.on("error", fail);
  const timeout = setTimeout(() => fail(new Error("SOCKS5 握手 10s 无进展")), 10_000);
  timeout.unref?.();
  const read = async (n) => {
    while (queued < n) {
      if (failure) throw failure;
      await new Promise((resolve) => {
        waiter = resolve;
      });
      if (failure) throw failure;
    }
    const out = Buffer.alloc(n);
    let filled = 0;
    while (filled < n) {
      const chunk = queue[0];
      const take = Math.min(chunk.length, n - filled);
      chunk.copy(out, filled, 0, take);
      if (take === chunk.length) {
        queue.shift();
      } else {
        queue[0] = chunk.subarray(take);
      }
      filled += take;
      queued -= take;
    }
    return out;
  };
  return { read, done: () => clearTimeout(timeout) };
}

function socksReply(rep, atyp) {
  // VER REP RSV ATYP BND.ADDR(4B 0.0.0.0) BND.PORT(2B 0)
  return Buffer.from([0x05, rep, 0x00, atyp, 0, 0, 0, 0, 0, 0]);
}

function bytesToIpv6(buf) {
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(buf.readUInt16BE(i).toString(16));
  return groups.join(":");
}

/**
 * 启动 SOCKS5 服务。返回 { server, endpoint, port, endpointPort, caFile, recordFile, recordState, close() }。
 * opts: { port, auth: {username,password}|null, record, withMockEndpoint, sans, certDir }
 */
export function startSocks5Server(opts = {}) {
  const state = { targets: [] };
  let endpoint = null; // withMockEndpoint 时先起端点再起 SOCKS（连接处理闭包读 endpoint.port）
  let certDirOwned = null;
  const recordFile = opts.record ?? null;
  const appendRecord = (entry) => {
    state.targets.push(entry);
    if (!recordFile) return;
    const tmp = `${recordFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ targets: state.targets }, null, 2)}\n`);
    fs.renameSync(tmp, recordFile);
  };
  if (recordFile) {
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    fs.writeFileSync(recordFile, `${JSON.stringify({ targets: [] }, null, 2)}\n`);
  }

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handleConnection(socket).catch(() => socket.destroy());
  });

  async function handleConnection(socket) {
    const reader = makeHandshakeReader(socket);
    try {
      // RFC 1928 greeting
      const greeting = await reader.read(2);
      if (greeting[0] !== 0x05) return socket.destroy();
      const methodCount = greeting[1];
      const methods = await reader.read(methodCount);
      let chosen = 0xff;
      if (opts.auth) {
        if (methods.includes(0x02)) chosen = 0x02;
      } else if (methods.includes(0x00)) {
        chosen = 0x00;
      }
      socket.write(Buffer.from([0x05, chosen]));
      if (chosen === 0xff) return socket.destroy();

      // RFC 1929 子协商
      if (chosen === 0x02) {
        const head = await reader.read(2); // VER ULEN
        if (head[0] !== 0x01) return socket.destroy();
        const uname = (await reader.read(head[1])).toString("utf8");
        const plen = (await reader.read(1))[0];
        const passwd = (await reader.read(plen)).toString("utf8");
        const ok = uname === opts.auth.username && passwd === opts.auth.password;
        socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) return socket.destroy();
      }

      // RFC 1928 request
      const req = await reader.read(4); // VER CMD RSV ATYP
      if (req[0] !== 0x05) return socket.destroy();
      const cmd = req[1];
      const atyp = req[3];
      let host;
      if (atyp === 0x01) {
        host = [...(await reader.read(4))].join(".");
      } else if (atyp === 0x03) {
        const len = (await reader.read(1))[0];
        host = (await reader.read(len)).toString("ascii");
      } else if (atyp === 0x04) {
        host = bytesToIpv6(await reader.read(16));
      } else {
        socket.write(socksReply(0x08, atyp)); // address type not supported
        return socket.destroy();
      }
      const portBuf = await reader.read(2);
      const port = portBuf.readUInt16BE(0);
      reader.done();
      appendRecord({ host, port, ts: new Date().toISOString() });

      if (cmd !== 0x01) {
        socket.write(socksReply(0x07, atyp)); // command not supported
        return socket.destroy();
      }

      const target = endpoint ? { host: "127.0.0.1", port: endpoint.port } : { host, port };
      const upstream = net.connect(target.port, target.host);
      upstream.on("error", () => {
        try {
          socket.write(socksReply(0x01, atyp)); // general SOCKS server failure
        } catch {
          // 客户端已断开
        }
        socket.destroy();
      });
      upstream.on("connect", () => {
        socket.write(socksReply(0x00, atyp));
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    } catch (err) {
      reader.done();
      throw err;
    }
  }

  const listen = () =>
    new Promise((resolve, reject) => {
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

  const api = {
    server,
    endpoint: null,
    get port() {
      return server.address().port;
    },
    get endpointPort() {
      return endpoint ? endpoint.port : null;
    },
    caFile: null,
    recordFile,
    recordState: state,
    close,
    // withMockEndpoint 需要先起端点再起 SOCKS（连接处理闭包读 endpoint.port）
    start: async () => {
      if (opts.withMockEndpoint) {
        const sans = [...new Set([...DEFAULT_SANS, ...(opts.sans ?? [])])];
        const cert = generateSelfSignedCert({ sans });
        certDirOwned = opts.certDir ?? makeTempCertDir("taiji-socks5-certs-");
        const files = writeCertFiles(cert, certDirOwned);
        api.caFile = files.caFile;
        endpoint = startMockLlmEndpoint({
          keyPem: fs.readFileSync(files.keyFile, "utf8"),
          certPem: fs.readFileSync(files.certFile, "utf8"),
        });
        api.endpoint = endpoint;
        await new Promise((resolve, reject) => {
          endpoint.server.once("listening", resolve);
          endpoint.server.once("error", reject);
        });
      }
      await listen();
      return api;
    },
  };
  return api;
}

// ---------- 自测子命令 ----------

// 必须异步执行：本服务与 curl 同进程，execFileSync 会冻结事件循环，
// 握手无法推进 → curl 永等（互相死锁）。
const execFileP = promisify(execFile);

async function curlRun(args) {
  try {
    const { stdout } = await execFileP("curl", args, { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    return { ok: false, stdout: err?.stdout ?? Buffer.alloc(0), stderr: String(err?.stderr ?? err?.message ?? err) };
  }
}

function decodeGzipJson(raw) {
  return JSON.parse(zlib.gunzipSync(raw).toString("utf8"));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "socks5-selftest-"));
  let a = null;
  let b = null;
  let c = null;
  try {
    const url = "https://api.anthropic.com/v1/messages";
    const body = JSON.stringify(SELFTEST_BODY);

    // A) 无需认证形态 + mock 端点桥接（socks5h：curl 发域名 ATYP）
    a = await startSocks5Server({
      withMockEndpoint: true,
      record: path.join(tmp, "a-record.json"),
      certDir: path.join(tmp, "certs-a"),
    });
    await a.start();
    check("A: SOCKS5 + 端点就绪（caFile 已产出）", typeof a.port === "number" && typeof a.caFile === "string");
    const rawA = await curlRun([
      "--max-time", "10", "-sS",
      "--proxy", `socks5h://127.0.0.1:${a.port}`,
      "--cacert", a.caFile,
      "-X", "POST", "-H", "content-type: application/json", "-d", body,
      url,
    ]);
    let parsedA = null;
    try {
      parsedA = decodeGzipJson(rawA.stdout);
    } catch {
      // 留给断言报失败
    }
    check(
      "A: 无需认证握手 + CONNECT 桥接 mock 端点（回显一致）",
      parsedA?.type === "message" && parsedA?.content?.[0]?.text?.includes(SELFTEST_ECHO),
      parsedA ? `text=${parsedA?.content?.[0]?.text}` : `raw ${rawA.stdout.length}B ${rawA.stderr.slice(-120)}`,
    );
    const recA = JSON.parse(fs.readFileSync(a.recordFile, "utf8"));
    check(
      "A: 连接记录含域名目标 api.anthropic.com:443（ATYP=domain）",
      Array.isArray(recA.targets) && recA.targets.some((t) => t.host === "api.anthropic.com" && t.port === 443),
      JSON.stringify(recA).slice(0, 200),
    );

    // B) RFC 1929 认证形态：正确凭据通、错误凭据拒
    b = await startSocks5Server({
      auth: { username: "mockuser", password: "mockpass" },
      withMockEndpoint: true,
      record: path.join(tmp, "b-record.json"),
      certDir: path.join(tmp, "certs-b"),
    });
    await b.start();
    const rawB = await curlRun([
      "--max-time", "10", "-sS",
      "--proxy", `socks5h://mockuser:mockpass@127.0.0.1:${b.port}`,
      "--cacert", b.caFile,
      "-X", "POST", "-H", "content-type: application/json", "-d", body,
      url,
    ]);
    let parsedB = null;
    try {
      parsedB = decodeGzipJson(rawB.stdout);
    } catch {
      // 留给断言报失败
    }
    check("B: RFC 1929 正确凭据认证通过 + 全链路回显", parsedB?.content?.[0]?.text?.includes(SELFTEST_ECHO), parsedB ? `text=${parsedB?.content?.[0]?.text}` : `raw ${rawB.stdout.length}B ${rawB.stderr.slice(-120)}`);
    const bAuthRun = await curlRun([
      "--max-time", "10", "-sS",
      "--proxy", `socks5h://mockuser:WRONGPASS@127.0.0.1:${b.port}`,
      "--cacert", b.caFile,
      "-X", "POST", "-H", "content-type: application/json", "-d", body,
      url,
    ]);
    check("B: RFC 1929 错误凭据被拒（curl 非零退出，CONNECT 未记录）", !bAuthRun.ok, bAuthRun.stderr.slice(-120));
    const recB = JSON.parse(fs.readFileSync(b.recordFile, "utf8"));
    check(
      "B: 认证失败的连接不进连接记录（记录仅含认证通过那 1 条）",
      Array.isArray(recB.targets) && recB.targets.length === 1,
      JSON.stringify(recB).slice(0, 200),
    );

    // C) IP 目标（ATYP=IPv4）+ 默认分支桥接真实目标（桥到 A 的端点，全程不触外网）
    c = await startSocks5Server({ record: path.join(tmp, "c-record.json") });
    await c.start();
    const rawC = await curlRun([
      "--max-time", "10", "-sS",
      "--proxy", `socks5h://127.0.0.1:${c.port}`,
      "--cacert", a.caFile,
      "-X", "POST", "-H", "content-type: application/json", "-d", body,
      `https://127.0.0.1:${a.endpointPort}/v1/messages`,
    ]);
    let parsedC = null;
    try {
      parsedC = decodeGzipJson(rawC.stdout);
    } catch {
      // 留给断言报失败
    }
    check("C: ATYP=IPv4 目标桥接（回显一致）", parsedC?.content?.[0]?.text?.includes(SELFTEST_ECHO), parsedC ? `text=${parsedC?.content?.[0]?.text}` : `raw ${rawC.stdout.length}B ${rawC.stderr.slice(-120)}`);
    const recC = JSON.parse(fs.readFileSync(c.recordFile, "utf8"));
    check(
      "C: 连接记录含 IP 目标 127.0.0.1（ATYP=IPv4）",
      Array.isArray(recC.targets) && recC.targets.some((t) => t.host === "127.0.0.1" && typeof t.ts === "string"),
      JSON.stringify(recC).slice(0, 200),
    );

    console.log(failures.length === 0 ? "[socks5-server] SELFTEST PASS" : `[socks5-server] SELFTEST FAIL（${failures.length} 项）`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    for (const s of [c, b, a]) await s?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- main ----------

function parseArgs(argv) {
  const opts = { port: 0, auth: null, record: null, withMockEndpoint: false, sans: [], certDir: null, selftest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--auth") {
      const raw = argv[++i];
      const colon = raw.indexOf(":");
      if (colon < 0) {
        console.error("[socks5-server] --auth 需要 user:pass 形态\n恢复动作：--auth mockuser:mockpass");
        process.exit(2);
      }
      opts.auth = { username: raw.slice(0, colon), password: raw.slice(colon + 1) };
    } else if (a === "--record") opts.record = argv[++i];
    else if (a === "--with-mock-endpoint") opts.withMockEndpoint = true;
    else if (a === "--san") opts.sans.push(argv[++i]);
    else if (a === "--cert-dir") opts.certDir = argv[++i];
    else if (a === "--selftest") opts.selftest = true;
    else {
      console.error(`[socks5-server] 未知参数: ${a}\n恢复动作：node scripts/network-proxy-mocks/socks5-server.mjs --selftest 查看用法`);
      process.exit(2);
    }
  }
  return opts;
}

// 仅直接执行时跑 main；被 import（自测 / 验收编排消费 factory）时不得拉起服务
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) {
    await selftest();
  } else {
    const server = startSocks5Server(opts);
    await server.start();
    console.log(`[socks5-server] ${JSON.stringify({ ready: true, port: server.port, endpointPort: server.endpointPort, caFile: server.caFile, recordFile: server.recordFile })}`);
    process.on("SIGINT", () => server.close().then(() => process.exit(0)));
    process.on("SIGTERM", () => server.close().then(() => process.exit(0)));
  }
}
