#!/usr/bin/env node
/**
 * network-proxy-drift-probe.mjs — LLM 网络分流失效漂移探针（llm-network-proxy 验收场景 7，pi 升级复用）
 *
 * 验证断言（设计 §2 证据 3 / 前提 P1+P2）：
 *   P2 外部 undici 包 setGlobalDispatcher 写入的全局分发器槽与 Node 内置 globalThis.fetch
 *      读取的槽一致（Symbol.for 注册表跨实例共享）；
 *   P1 上游默认 fetch 运行时读 globalThis.fetch（SDK 注入方式未变——本探针只覆盖 P2 槽共享，
 *      P1 的 SDK 行为在 pi 进程内由场景 1 全链路断言承载）。
 *
 * 形态：本脚本 spawn 空 Node 子进程（NODE_EXTRA_CA_CERTS 注入 mock 端点信任——该 env 仅
 * 进程启动时读取，父进程自身不能热注入），子进程内 require 实装版 undici →
 * setGlobalDispatcher(new ProxyAgent(mock 代理)) → 用 Node 内置 globalThis.fetch 请求
 * https://api.anthropic.com/v1/messages → mock 代理把 CONNECT 一律桥接本地 mock 端点。
 * PASS 判据 = 子进程拿到 mock 回复 且 mock 代理记录到 CONNECT（记录为空 = 请求绕过了代理，槽共享失效）。
 *
 * 用法：node scripts/network-proxy-drift-probe.mjs
 * 输出：PASS/FAIL 结论行（含 node / undici 版本）；exit 0 = PASS，exit 1 = FAIL。
 * pi 升级复跑口径见 docs/TROUBLESHOOTING.md「LLM 网络代理分流失效排查」。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { startMockProxy } from "./network-proxy-mocks/mock-proxy.mjs";

function fail(reason, action) {
  console.error(`[drift-probe] FAIL: ${reason}`);
  if (action) console.error(`[drift-probe] 恢复动作: ${action}`);
  process.exit(1);
}

// ---------- 环境版本（结论行取证字段） ----------

function nodeVersion() {
  return process.version;
}

function undiciInfo() {
  const require = createRequire(import.meta.url);
  let entry;
  try {
    entry = require.resolve("undici");
  } catch {
    return null;
  }
  let version = "unknown";
  let dir = path.dirname(entry);
  for (let i = 0; i < 4; i += 1) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        version = JSON.parse(fs.readFileSync(pkg, "utf8")).version ?? version;
      } catch {
        // 保持 unknown
      }
      break;
    }
    dir = path.dirname(dir);
  }
  return { entry, version };
}

// ---------- 子进程代码（空 Node 进程内完成「外部 undici 装槽 → 内置 fetch 出站」） ----------

const CHILD_CODE = `
(async () => {
  const { setGlobalDispatcher, ProxyAgent } = require(process.env.DRIFT_UNDICI_ENTRY);
  setGlobalDispatcher(new ProxyAgent(process.env.DRIFT_PROXY_URL));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: process.env.DRIFT_BODY,
  });
  if (!res.ok) throw new Error("HTTP " + res.status + "（" + res.headers.get("content-type") + "）");
  const json = await res.json();
  const text = json && json.content && json.content[0] && json.content[0].text;
  if (json.type !== "message" || typeof text !== "string" || !text.includes(process.env.DRIFT_ECHO)) {
    throw new Error("回复形态异常: " + JSON.stringify(json).slice(0, 200));
  }
  console.log("CHILD-OK " + text);
})().catch((err) => {
  console.error("CHILD-FAIL " + ((err && err.message) || String(err)));
  process.exit(1);
});
`;

// ---------- main ----------

async function main() {
  const undici = undiciInfo();
  if (!undici) {
    fail("实装 undici 不可解析（require.resolve('undici') 失败）", "在仓库根执行 pnpm install（undici 由 network-proxy extension bundle 依赖提供）后重跑本探针");
  }
  console.log(`[drift-probe] env: node ${nodeVersion()} / undici ${undici.version}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "network-proxy-drift-probe-"));
  let proxy = null;
  try {
    proxy = await startMockProxy({
      port: 0,
      withMockEndpoint: true,
      record: path.join(tmp, "connect-record.json"),
    });

    const echo = "drift-probe-echo";
    // 必须异步 spawn：mock 代理在本进程，spawnSync 会冻结事件循环、
    // 代理无法应答子进程的 CONNECT（互相死锁）
    const execFileP = promisify(execFile);
    let run;
    try {
      const { stdout } = await execFileP(process.execPath, ["-e", CHILD_CODE], {
        encoding: "utf8",
        timeout: 30_000,
        cwd: tmp,
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: proxy.caFile,
          DRIFT_UNDICI_ENTRY: undici.entry,
          DRIFT_PROXY_URL: `http://127.0.0.1:${proxy.port}`,
          DRIFT_BODY: JSON.stringify({ model: "claude-mock", max_tokens: 32, messages: [{ role: "user", content: echo }] }),
          DRIFT_ECHO: echo,
        },
      });
      run = stdout;
    } catch (err) {
      const childOut = [err?.stdout, err?.stderr].filter(Boolean).join(" ").trim();
      if (err?.killed) {
        fail("子进程 30s 未完成（超时被杀）——内置 fetch 可能绕过代理直连悬挂", "检查本机到 api.anthropic.com 的直连为何悬挂；探针语义见 docs/TROUBLESHOOTING.md");
      }
      fail(`子进程执行失败：${childOut.slice(0, 400) || (err?.message ?? String(err))}`, "核对 mock 端点/证书链（node scripts/network-proxy-mocks/mock-proxy.mjs --selftest）");
    }

    if (!run.includes("CHILD-OK")) {
      fail(`子进程未拿到 mock 回复：${run.trim().slice(0, 300) || "无输出"}`, "核对 mock 端点/证书链（node scripts/network-proxy-mocks/mock-proxy.mjs --selftest）");
    }

    const record = JSON.parse(fs.readFileSync(proxy.recordFile, "utf8"));
    const hit = Array.isArray(record.targets) && record.targets.some((t) => t.host === "api.anthropic.com" && t.port === 443);
    if (!hit) {
      fail(
        "fetch 成功但 mock 代理记录为空——请求绕过代理直连（全局分发器槽共享失效，前提 P2 被打破）",
        "按 pi 升级处置评估：bundle 内 undici 升至与 Node/pi 同代、或复用宿主 undici 实例；暂回退 = 关闭网络代理开关恢复直连",
      );
    }

    console.log(`[drift-probe] PASS: 外部 undici setGlobalDispatcher 槽共享有效——Node 内置 fetch 经 ProxyAgent 出站，mock 代理记录到 CONNECT api.anthropic.com:443（子进程回复: ${run.trim().replace("CHILD-OK ", "")}）`);
    process.exitCode = 0;
  } finally {
    if (proxy) await proxy.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
