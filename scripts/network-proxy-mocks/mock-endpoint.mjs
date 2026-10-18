/**
 * mock-endpoint.mjs — mock LLM HTTPS 端点 + 自签证书生成（零 npm 依赖）
 *
 * llm-network-proxy 验收工具的共享模块（mock-proxy.mjs / socks5-server.mjs 经
 * --with-mock-endpoint 桥接本端点）。设计依据 .tmp/tech-design/llm-network-proxy.md
 * §4 场景 1 / 场景 9：无 anthropic 真实 key 依赖，CONNECT 目标一律桥接本地端点。
 *
 * 端点行为：
 *   - POST /v1/messages，按请求体 stream 字段分两形态：
 *     非 stream → anthropic message JSON，响应体显式 gzip（Content-Encoding: gzip）
 *     stream=true → anthropic SSE 事件流（message_start…message_stop），
 *                   整流 gzip 包裹（createGzip + Z_SYNC_FLUSH 逐事件冲刷）
 *   - 回复文本回显请求末条 user 消息内容，供全链路断言（pi 侧可见完整回复 = 解压链路通）。
 *   - 不校验凭据（Accept 头不区分）。
 *
 * 自签证书：运行期 node:crypto 生成（免 openssl CLI 与 fixture 文件）——
 * RSA 2048 单张自签证书（CA:TRUE + SAN），同一份既是服务端证书也是
 * NODE_EXTRA_CA_CERTS / curl --cacert 的信任锚（自签叶子 = 信任锚是合法形态）。
 * 默认 SAN 覆盖 api.anthropic.com（场景 1 主机名）+ localhost + 127.0.0.1，
 * 额外主机名经 --san 追加（如场景 13 的 zhipu-mock.test）。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

export const DEFAULT_SANS = ["api.anthropic.com", "localhost", "127.0.0.1"];
const COMMON_NAME = "taiji-mock-proxy";

// ---------- 自签证书（DER 手工编码 + node:crypto 签名） ----------

function derLen(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function derTlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function derOid(dotted) {
  const arcs = dotted.split(".").map(Number);
  const body = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const bytes = [arc & 0x7f];
    let v = arc >> 7;
    while (v > 0) {
      bytes.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    body.push(...bytes);
  }
  return derTlv(0x06, Buffer.from(body));
}

function derName(commonName) {
  // Name = SEQUENCE { SET { SEQUENCE { OID(commonName), UTF8String } } }
  const attr = derTlv(0x30, Buffer.concat([derOid("2.5.4.3"), derTlv(0x0c, Buffer.from(commonName, "utf8"))]));
  return derTlv(0x30, derTlv(0x31, attr));
}

function derUtcTime(date) {
  // UTCTime YYMMDDHHMMSSZ（2050 年前有效；证书窗口 ±10 年内恒满足）
  const iso = date.toISOString().replace(/[-:T]/g, "");
  return derTlv(0x17, Buffer.from(`${iso.slice(2, 14)}Z`, "ascii"));
}

function derExtension(oidDotted, critical, innerDer) {
  const parts = [derOid(oidDotted)];
  if (critical) parts.push(Buffer.from([0x01, 0x01, 0xff])); // BOOLEAN TRUE
  parts.push(derTlv(0x04, innerDer)); // OCTET STRING 包裹 extnValue 内层 DER
  return derTlv(0x30, Buffer.concat(parts));
}

function derSanEntry(host) {
  if (net.isIPv4(host)) return derTlv(0x87, Buffer.from(host.split(".").map(Number))); // iPAddress
  return derTlv(0x82, Buffer.from(host, "ascii")); // dNSName
}

/** 生成自签证书（同一张既是服务端证书也是信任锚）。 */
export function generateSelfSignedCert({ commonName = COMMON_NAME, sans = DEFAULT_SANS } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serial = crypto.randomBytes(8);
  serial[0] &= 0x7f; // 保证正整数（最高位清零，免前导 0x00 分支）

  const sigAlg = derTlv(0x30, Buffer.concat([derOid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00])])); // sha256WithRSAEncryption + NULL
  const spki = publicKey.export({ type: "spki", format: "der" });
  const now = Date.now();
  const validity = derTlv(0x30, Buffer.concat([derUtcTime(new Date(now - 3600_000)), derUtcTime(new Date(now + 10 * 365 * 86400_000))]));

  const basicConstraints = derExtension("2.5.29.19", true, derTlv(0x30, Buffer.from([0x01, 0x01, 0xff]))); // CA:TRUE
  const uniqueSans = [...new Set(sans)];
  const subjectAltName = derExtension("2.5.29.17", false, derTlv(0x30, Buffer.concat(uniqueSans.map(derSanEntry))));
  const extensions = derTlv(0xa3, derTlv(0x30, Buffer.concat([basicConstraints, subjectAltName])));

  const tbs = derTlv(0x30, Buffer.concat([
    derTlv(0xa0, derTlv(0x02, Buffer.from([0x02]))), // [0] EXPLICIT version = v3
    derTlv(0x02, serial),
    sigAlg,
    derName(commonName), // issuer（自签 = subject）
    validity,
    derName(commonName), // subject
    spki,
    extensions,
  ]));
  const signature = crypto.sign("sha256", tbs, privateKey); // RSA-SHA256 PKCS#1 v1.5
  const cert = derTlv(0x30, Buffer.concat([tbs, sigAlg, derTlv(0x03, Buffer.concat([Buffer.from([0x00]), signature]))]));

  const toPem = (der, label) => `-----BEGIN ${label}-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END ${label}-----\n`;
  return {
    keyPem: toPem(privateKey.export({ type: "pkcs8", format: "der" }), "PRIVATE KEY"),
    certPem: toPem(cert, "CERTIFICATE"),
  };
}

/** 证书落盘；返回 CA 信任锚文件路径（供 NODE_EXTRA_CA_CERTS / curl --cacert）。 */
export function writeCertFiles({ keyPem, certPem }, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, "server-key.pem");
  const certFile = path.join(dir, "server-cert.pem");
  fs.writeFileSync(keyFile, keyPem, { mode: 0o600 });
  fs.writeFileSync(certFile, certPem);
  return { keyFile, certFile, caFile: certFile };
}

// ---------- mock LLM HTTPS 端点（anthropic /v1/messages 形态） ----------

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content.filter((b) => b?.type === "text").map((b) => b?.text ?? "").join(" ");
      if (text) return text;
    }
  }
  return "(no user text)";
}

function buildMessage(body) {
  const text = `mock-reply: ${lastUserText(body)}`;
  return {
    id: `msg_mock_${crypto.randomBytes(8).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: typeof body?.model === "string" ? body.model : "claude-mock",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  };
}

function handleMessagesRequest(body, res) {
  const message = buildMessage(body);
  if (body?.stream === true) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "content-encoding": "gzip",
    });
    const gz = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH });
    gz.pipe(res);
    const send = (event, data) => gz.write(Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, "utf8"));
    send("message_start", { type: "message_start", message: { ...message, content: [], usage: { input_tokens: 1, output_tokens: 0 } } });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: message.content[0].text } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    send("message_stop", { type: "message_stop" });
    gz.end();
    return;
  }
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(message), "utf8"));
  res.writeHead(200, {
    "content-type": "application/json",
    "content-encoding": "gzip",
    "content-length": gz.length,
  });
  res.end(gz);
}

/**
 * 启动 mock LLM HTTPS 端点。返回 { server, port, hits, close() }；
 * hits 追加每次请求的 { path, ts }（观测用，不做断言义务）。
 */
export function startMockLlmEndpoint({ keyPem, certPem, host = "127.0.0.1", port = 0 } = {}) {
  const hits = [];
  const server = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({ path: req.url, ts: new Date().toISOString() });
      if (req.method === "POST" && req.url === "/v1/messages") {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          body = {};
        }
        handleMessagesRequest(body, res);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "not_found_error", message: "mock endpoint: use POST /v1/messages" } }));
    });
    req.on("error", () => res.destroy());
  });
  server.listen(port, host);
  return {
    server,
    get port() {
      return server.address().port;
    },
    hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** 端点连通性自测用的小工具：临时证书目录。 */
export function makeTempCertDir(prefix = "taiji-mock-certs-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
