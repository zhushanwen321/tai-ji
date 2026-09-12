// scripts/probes/subagent-sync-collect/common.mjs
//
// subagent-sync-collect 真实 CLI 探针共享骨架（U8；设计 §4 验收 A1-A8〔设计文档已删，git 可追溯〕/ AGENTS.md
// 「Pi Extension 开发」MANDATORY 通道）。
//
// 每个场景脚本 import 本模块，共享：
//   - pi RPC 子进程封装：spawn 真实 pi（`--mode rpc --session-dir <mkdtemp> --approve
//     --extension <subagent-workflow> --extension <session-reader>`），stdin JSONL 发
//     prompt、stdout JSONL 收 response/turn_end（协议对齐 scripts/verify-scheduler-e2e.cjs）
//   - session JSONL 断言原语：subagent-bg-notify custom_message entry 收集、批/单条
//     分类、assistant turn 计数、usage 汇总（A2）
//   - 磁盘观察原语：record manifest 反查、subagent session 最终 assistant 正文（A4
//     取回一致性）
//   - 手写轮询 pollUntil（禁 vi.waitFor 系——脚本是 node 直跑，vitest 无关）
//   - 结果收集 + PASS/FAIL 汇总退出码
//   - --dry-run 门：验证 pi 二进制 / extension 路径 / 模型解析后打印执行计划即退，
//     不 spawn 不落盘（U8 只负责脚本可执行性，长时场景由主 agent 统一跑）
//
// 模型：优先 `PI_PROBE_MODEL` env，缺省 xiaomi-token-plan-cn/mimo-v2.5-pro
//（AGENTS.md MANDATORY 通道示例模型）。
// pi 二进制：优先 `PI_PROBE_PI_BIN` env → 仓内 apps/electron/resources/pi/pi-<plat>-<arch>
// → PATH `pi`。
// 副作用隔离：每场景独立 mkdtemp cwd + sessionDir；cleanup 额外清
// <agentDir>/subagents/<enc(cwd)> 整段（subagent sessions/records 落 pi agent 数据目录，
// 与 --session-dir 无关——path-encoding.ts 布局）。

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROBE_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = resolve(PROBE_DIR, "..", "..", "..");
export const SW_EXTENSION = join(REPO_ROOT, "extensions", "universal", "subagent-workflow");
export const SR_EXTENSION = join(REPO_ROOT, "extensions", "universal", "session-reader");

/** MANDATORY 通道示例模型（AGENTS.md「pi Extension 开发」）。 */
export const DEFAULT_MODEL = "xiaomi-token-plan-cn/mimo-v2.5-pro";

/** 设计 §3.1.3 config 默认预算（A4 断言锚点）。 */
export const BUDGET = { perItemChars: 4000, totalChars: 24000 };
/** floor(24000 / 7) —— A4② 7 成员各 ~6K 的统一收紧预算（设计 §3.1.2 演算例）。 */
export const EFFECTIVE_PER_ITEM_7 = Math.floor(BUDGET.totalChars / 7); // 3428

export const NOTIFY_CUSTOM_TYPE = "subagent-bg-notify";
export const BATCH_HEADER_RE = /^Subagent batch completed: (\d+) finished, (\d+) failed, (\d+) cancelled\.$/;

// ── 解析：模型 / pi 二进制 / agentDir ─────────────────────

export function resolveModel() {
  return process.env.PI_PROBE_MODEL || DEFAULT_MODEL;
}

export function resolvePiBin() {
  const candidates = [
    process.env.PI_PROBE_PI_BIN || null,
    join(REPO_ROOT, "apps", "electron", "resources", "pi", `pi-${process.platform}-${process.arch}`),
    "pi", // PATH 兜底
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === "pi") return c; // 交由 spawn 解析 PATH；存在性由 --dry-run 的 `which` 提示
    if (existsSync(c)) return c;
  }
  return "pi";
}

export function piBinDescription(bin) {
  if (bin === "pi") return "PATH 上的 pi（--dry-run 不解析 PATH 存在性，实跑时由 spawn 报错兜底）";
  return bin;
}

/** pi agent 数据目录（subagent sessions/records 的物理落点）。 */
export function resolveAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** path-encoding.ts encodeCwd 的 JS 端口（cleanup 推导用）。 */
export function encodeCwd(cwd) {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

// ── 基础工具 ─────────────────────────────────────────────

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 手写轮询：cond() 真值返回；超时 throw（10ms 起、封顶 200ms 退避）。 */
export async function pollUntil(cond, timeoutMs, label = "condition") {
  const start = Date.now();
  let interval = 10;
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pollUntil timeout after ${timeoutMs}ms waiting for: ${label}`);
    }
    await sleep(interval);
    interval = Math.min(interval * 2, 200);
  }
}

export function isDryRun(argv) {
  return argv.includes("--dry-run") || argv.includes("--help") || argv.includes("-h");
}

// ── 工作区（mkdtemp + agentDir subagents 段清理）──────────

/** 隔离 agentDir 需要拷贝的最小文件集（模型鉴权/自定义 provider 配置；均 <几 KB）。
 *  pi 核心与扩展的其余状态（会话 db/日志/已装扩展等）探针用不上：--no-extensions +
 *  显式 --extension 本地源码 + 显式 --model，缺什么也不会坏启动。 */
const AGENT_DIR_BOOTSTRAP_FILES = ["auth.json", "models.json", "models-store.json", "settings.json"];

export function makeWorkspace(label, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), `pi-sync-collect-${label}-`));
  const rawCwd = join(root, "cwd");
  const sessionDir = join(root, "sessions");
  mkdirSync(rawCwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  // [A4/A6 扫描修复] spawn 后 pi 进程的 process.cwd() 会解析 macOS 符号链接
  // （/var/folders → /private/var/folders）；path-encoding 用的是进程内解析后的
  // cwd——工作区必须同步用 realpath 编码，否则 enc 段错位（真跑实证：磁盘目录名
  // 为 --private-var-…-，而旧移植按 /var/… 编码 → subagentSessionFiles/records 恒空）。
  const cwd = realpathSync(rawCwd);
  const enc = encodeCwd(cwd);
  // [A4 确定性触发] 隔离 agentDir：拷最小鉴权/模型配置集 + 写 subagents/config.json，
  // 经 PI_CODING_AGENT_DIR 注入（pi 核心 getAgentDir() 读该 env，扩展 config 发现
  // = <agentDir>/subagents/config.json）——预算覆盖可按 probe 定制，且子代理树
  // 全部落 tmp，零真实目录污染。env 注入同时对本进程生效（resolveAgentDir() 扫描对齐）。
  let agentDir = null;
  let savedAgentDirEnv;
  if (opts.isolatedAgentDir) {
    agentDir = mkdtempSync(join(tmpdir(), `pi-sync-collect-${label}-agent-`));
    for (const f of AGENT_DIR_BOOTSTRAP_FILES) {
      const src = join(resolveAgentDir(), f);
      if (existsSync(src)) copyFileSync(src, join(agentDir, f));
    }
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    if (typeof opts.writeConfig === "function") opts.writeConfig(agentDir);
  }
  return {
    root,
    cwd,
    sessionDir,
    enc,
    agentDir,
    subagentTree: join(agentDir ?? resolveAgentDir(), "subagents", enc),
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch { /* best-effort */ }
      try {
        rmSync(join(resolveAgentDir(), "subagents", enc), { recursive: true, force: true });
      } catch { /* best-effort */ }
      if (agentDir) {
        try {
          rmSync(agentDir, { recursive: true, force: true });
        } catch { /* best-effort */ }
        if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
      }
    },
  };
}

// ── pi RPC 子进程封装 ─────────────────────────────────────

/**
 * spawn 一个真实 pi RPC 进程（加载 subagent-workflow + session-reader 本地源码）。
 *
 * @param {{ piBin: string, cwd: string, sessionDir: string, sessionFile?: string,
 *           model: string, label: string, keepBuiltinTools?: boolean }} opts
 *   keepBuiltinTools: 主 agent 默认 --no-builtin-tools（只需 subagent/session_read 工具，
 *   防主 agent 自行跑命令产生噪声 turn；subagent 子进程自带全量 builtin 工具——
 *   argv-mirror 只镜像 --no-extensions/--approve/--no-context-files/--extension，
 *   不镜像 --no-builtin-tools，sleep 任务不受影响）。A2 需要主 agent 行为与真实
 *   使用一致时可传 true。
 */
export function spawnSession(opts) {
  const args = [
    "--no-extensions",
    "--extension", SW_EXTENSION,
    "--extension", SR_EXTENSION,
    ...(opts.keepBuiltinTools ? [] : ["--no-builtin-tools"]),
    "--no-context-files",
    "--mode", "rpc",
    "--session-dir", opts.sessionDir,
    "--model", opts.model,
    "--approve",
  ];
  if (opts.sessionFile) args.push("--session", opts.sessionFile);
  // [U8 同病同修·子 env 消毒] 宿主链可能注入 PI_SUBAGENT_*（身份/ROOT_CWD——后者会
  // 改写 subagent 树编码键：真跑实证 enc 段落到 enc(宿主 repo) 而非工作区）与
  // XYZ_SUBAGENT_RELAY_*（改道 getPiInvocation relay 分支）。探针 pi 必须以 root 层、
  // 自身 cwd 的干净身份运行，否则 A4 子 session 扫描/A6 records 扫描恒空。
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("PI_SUBAGENT_") || key.startsWith("XYZ_SUBAGENT_RELAY_")) delete childEnv[key];
  }
  const child = spawn(opts.piBin, args, { stdio: ["pipe", "pipe", "pipe"], cwd: opts.cwd, env: childEnv });

  let rpcId = 0;
  const pending = new Map();
  /** @type {unknown[]} */ const captured = [];
  let stdoutBuf = "";
  let stderrBuf = "";
  let turnEndResolver = null;
  let sessionFileCache = null;

  // 逐行分发原语（闭包内）：captured / pending / sessionFileCache / turnEndResolver
  // 是 spawnSession 的连接级状态，三个 settle_* 各管一类帧副作用。
  function handleRpcLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 非 JSON banner
    }
    captured.push(msg);
    captureSessionFile(msg);
    settlePendingRpc(msg);
    settleTurnEnd(msg);
  }

  function captureSessionFile(msg) {
    if (msg && msg.type === "response" && msg.data && typeof msg.data.sessionFile === "string") {
      sessionFileCache = msg.data.sessionFile;
    }
  }

  function settlePendingRpc(msg) {
    if (msg && msg.type === "response" && msg.id && pending.has(msg.id)) {
      pending.get(msg.id).resolve(msg);
      pending.delete(msg.id);
    }
  }

  /** turn_end 且 stopReason !== toolUse 才结算等待方（toolUse = 工具轮中间态）。 */
  function settleTurnEnd(msg) {
    if (!msg || msg.type !== "turn_end") return;
    const stopReason = (msg.message && msg.message.stopReason) || msg.stopReason || "";
    if (stopReason === "toolUse" || !turnEndResolver) return;
    const r = turnEndResolver;
    turnEndResolver = null;
    r.resolve({ ok: true, stopReason });
  }

  child.stdout.on("data", (d) => {
    stdoutBuf += d.toString("utf-8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      handleRpcLine(line);
    }
  });
  child.stderr.on("data", (d) => {
    stderrBuf += d.toString("utf-8");
  });

  function sendRpc(command) {
    const id = "r" + ++rpcId;
    return new Promise((resolvePromise) => {
      pending.set(id, { resolve: resolvePromise });
      child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }

  function waitForTurnEnd(timeoutMs) {
    return new Promise((resolvePromise) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          turnEndResolver = null;
          resolvePromise({ ok: false });
        }
      }, timeoutMs);
      turnEndResolver = {
        resolve: (v) => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolvePromise(v);
          }
        },
      };
    });
  }

  return {
    child,
    label: opts.label,
    /** RPC 通道就绪（get_state 成功 = extensions 加载成功）。失败返回 null。 */
    async waitReady(timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const r = await Promise.race([sendRpc({ type: "get_state" }), sleep(5000).then(() => null)]);
        if (r && r.success) return r;
        await sleep(500);
      }
      return null;
    },
    /** 发 prompt 并等真回合结束（stopReason !== toolUse）。
     *  rpcExtras：透传额外 RPC 字段（如 streamingBehavior:"followUp"——批唤醒 turn
     *  可能仍在跑，带此字段排队而非被拒，A4 取回轮确定性写入）。 */
    async prompt(message, turnTimeoutMs = 180000, rpcExtras = {}) {
      const ack = await Promise.race([
        sendRpc({ type: "prompt", message, ...rpcExtras }),
        sleep(30000).then(() => null),
      ]);
      if (!ack) throw new Error(`[${opts.label}] prompt ack timeout (30s)`);
      if (!ack.success) throw new Error(`[${opts.label}] prompt rejected: ${JSON.stringify(ack.error || ack.data)}`);
      return waitForTurnEnd(turnTimeoutMs);
    },
    getState() {
      return sendRpc({ type: "get_state" });
    },
    getEntries() {
      return sendRpc({ type: "get_entries" });
    },
    get sessionFile() {
      return sessionFileCache;
    },
    get capturedMessages() {
      return captured;
    },
    kill(sig = "SIGTERM") {
      try {
        child.kill(sig);
      } catch { /* noop */ }
    },
    async waitExit(timeoutMs = 5000) {
      const start = Date.now();
      while (child.exitCode === null && Date.now() - start < timeoutMs) await sleep(50);
      return child.exitCode;
    },
    stderrTail(len = 600) {
      return stderrBuf.slice(-len);
    },
  };
}

// ── session JSONL 断言原语 ───────────────────────────────

export function readJsonlEntries(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** 全部 subagent-bg-notify 送达 entry（type=custom_message）。批/单条由 details.batch 区分。 */
export function bgNotifyEntries(entries) {
  return entries
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e && e.type === "custom_message" && e.customType === NOTIFY_CUSTOM_TYPE)
    .map(({ e, index }) => ({
      index,
      content: typeof e.content === "string" ? e.content : "",
      details: e.details && typeof e.details === "object" ? e.details : {},
    }));
}

export function batchNotifyEntries(entries) {
  return bgNotifyEntries(entries).filter((n) => n.details.batch === true);
}

export function singleNotifyEntries(entries) {
  return bgNotifyEntries(entries).filter((n) => n.details.batch !== true);
}

/** assistant message entry（A1「闭合前无新 turn」计数 / A2 usage 汇总）。 */
export function assistantMessages(entries) {
  return entries.filter((e) => e && e.type === "message" && e.message && e.message.role === "assistant");
}

/** Σ usage（A2）：input / cacheRead 分开记（cacheRead 也是实付 input 上下文）。 */
export function sumUsage(entries) {
  let input = 0;
  let cacheRead = 0;
  let output = 0;
  let assistantCount = 0;
  for (const m of assistantMessages(entries)) {
    const u = m.message && m.message.usage;
    if (u) {
      input += u.input || 0;
      cacheRead += u.cacheRead || 0;
      output += u.output || 0;
    }
    assistantCount += 1;
  }
  return { input, cacheRead, output, assistantCount };
}

// ── 磁盘观察原语（record manifest / 子 session 最终正文）────

/** <agentDir>/subagents/<enc>/records/*.json manifest 反查。 */
export function readRecordManifests(ws) {
  const dir = join(resolveAgentDir(), "subagents", ws.enc, "records");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf-8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** subagent session 文件最终结果正文（与 record.result / session_read action:result 同源）。
 *
 * 同源语义（session-reader result-action.ts extractFinalAssistantText 同构）：取
 * 「最后一条 user message 之后」的 assistant 文本块，message 内无分隔拼接、跨
 * message join("\n\n")，thinking/toolCall 块排除。one-shot（单 user prompt）与
 * record.getFullText 逐字节一致。 */
/** message entry 且 role 匹配（user / assistant / toolResult 判定共用原语）。 */
function isMessageOfRole(e, role) {
  return e && e.type === "message" && e.message && e.message.role === role;
}

/** 最后一个匹配 role 的 message entry 下标（无则 -1）。 */
function lastIndexOfRole(entries, role) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isMessageOfRole(entries[i], role)) return i;
  }
  return -1;
}

/** 单条 assistant message 的文本块拼接（string 直取；数组只拼 type:"text" 块）。 */
function assistantTextOf(e) {
  const content = e.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const c of content) {
    if (c && c.type === "text" && typeof c.text === "string") text += c.text;
  }
  return text;
}

export function finalAssistantText(sessionFile) {
  const entries = readJsonlEntries(sessionFile);
  const start = lastIndexOfRole(entries, "user") + 1;
  const texts = [];
  for (let i = start; i < entries.length; i += 1) {
    const e = entries[i];
    if (!isMessageOfRole(e, "assistant")) continue;
    const text = assistantTextOf(e);
    if (text.length > 0) texts.push(text);
  }
  return texts.join("\n\n");
}

/** 按 sa- id 反查 manifest（批量 id 逗号串也逐个查）。 */
export function manifestById(ws) {
  const map = new Map();
  for (const m of readRecordManifests(ws)) {
    if (m && typeof m.id === "string") map.set(m.id, m);
  }
  return map;
}

// ── 结果收集 + 汇总 ───────────────────────────────────────

export function makeChecks() {
  const results = [];
  return {
    check(name, pass, detail = "") {
      results.push({ name, pass: !!pass, detail });
      console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
      return !!pass;
    },
    /** 参考型记录（设计明示非门，如 A2 token 数字）：打印 NOTE 不计入 fail。 */
    note(name, detail) {
      console.log(`  NOTE  ${name}${detail ? ` — ${detail}` : ""}`);
    },
    async guard(name, fn) {
      try {
        return await fn();
      } catch (err) {
        this.check(name, false, `异常: ${err && err.message ? err.message : String(err)}`);
        return null;
      }
    },
    /** PASS/FAIL 计数快照（记录行插值用——check 数随分支增减，禁硬编码经验值）。 */
    summary() {
      const failed = results.filter((r) => !r.pass).length;
      return { total: results.length, passed: results.length - failed, failed };
    },
    finish(scenarioId) {
      const failed = results.filter((r) => !r.pass);
      console.log(`\n[${scenarioId}] ${failed.length === 0 ? "ALL PASS" : `FAILED (${failed.length}/${results.length})`}`);
      process.exitCode = failed.length === 0 ? 0 : 1;
    },
  };
}

/** dry-run 通用输出：解析结果 + 前置存在性 + 提示。返回 exitCode。
 * scriptFile：场景脚本自身路径（import.meta.url，用于「实跑」提示）。 */
export function dryRunReport({ scenarioId, design, expect, plan, scriptFile }) {
  const model = resolveModel();
  const piBin = resolvePiBin();
  console.log(`[${scenarioId}] dry-run（不 spawn pi / 不执行长时场景）`);
  console.log(`  设计验收行: ${design}`);
  console.log(`  预期输出: ${expect}`);
  console.log(`  模型: ${model}${process.env.PI_PROBE_MODEL ? " (PI_PROBE_MODEL)" : " (默认)"}`);
  console.log(`  pi 二进制: ${piBinDescription(piBin)}`);
  const extOk = [SW_EXTENSION, SR_EXTENSION].map((p) => {
    const ok = existsSync(join(p, "package.json"));
    console.log(`  extension ${p}: ${ok ? "OK" : "缺失"}`);
    return ok;
  });
  const binOk = piBin !== "pi" ? existsSync(piBin) : true;
  if (piBin === "pi") console.log("  （PATH pi：实跑时若不可解析将报错）");
  console.log("  执行计划:");
  for (const step of plan) console.log(`    - ${step}`);
  const scriptName = scriptFile ? basename(fileURLToPath(scriptFile)) : "<脚本>.mjs";
  console.log(`  实跑: node ${scriptName}   （移除 --dry-run）`);
  const ok = extOk.every(Boolean) && binOk;
  console.log(`[${scenarioId}] dry-run ${ok ? "OK" : "FAILED"}`);
  return ok ? 0 : 1;
}

/** 手写 prompt 构造：同轮 N 连 start 的标准指令（防模型自由发挥的强约束模板）。 */
export function dispatchPrompt({ starts, tail }) {
  const lines = [
    "Dispatch background subagents using the `subagent` tool. In THIS SINGLE reply, make exactly " +
      `${starts.length} \`subagent\` tool calls (action:"start") with these exact arguments, nothing else:`,
  ];
  starts.forEach((s, i) => {
    lines.push(`${i + 1}. task: ${JSON.stringify(s.task)}  slug: ${JSON.stringify(s.slug)}${s.collect ? `  collect: ${JSON.stringify(s.collect)}` : ""}${s.engine ? `  engine: ${JSON.stringify(s.engine)}` : ""}`);
  });
  lines.push(
    "After all tool calls return, reply with a one-line confirmation and STOP. Do not run any other tool.",
    "Do not poll or check on them — completions will be delivered to you automatically.",
  );
  if (tail) lines.push(tail);
  return lines.join("\n");
}

// ══ U8 扩展原语（接替执行者补齐）════════════════════

/** sync 批通知：content 首行匹配批头（`Subagent batch completed: ...`）。
 * 不用 details.batch —— async 多条经 courier 合并投递时 details.batch 也是 true
 * （notify-ledger.ts 合批形态），批头行才是 sync 批的稳定识别键。 */
export function syncBatchNotifyEntries(entries) {
  return bgNotifyEntries(entries).filter((n) => BATCH_HEADER_RE.test(n.content.split("\n")[0] || ""));
}

/** async 通知（单条 + courier 合并）：非 sync 批头形态的全部送达 entry。 */
export function asyncNotifyEntries(entries) {
  return bgNotifyEntries(entries).filter((n) => !BATCH_HEADER_RE.test(n.content.split("\n")[0] || ""));
}

/** 批 content 分段：[批头, 条目1, 条目2, ...]（与 buildBatchLlmContent join 同构）。 */
export function batchSegments(content) {
  return content.split("\n\n---\n\n");
}

/** 条目正文（`Subagent "x" (sa-y) completed. Result:
<正文>`）——截断长度口径
 * 只计正文，头行/指针行不入预算（对齐 U4 totalChars 口径）。 */
export function itemResultBody(item) {
  const idx = item.indexOf("Result:\n");
  if (idx < 0) return "";
  let body = item.slice(idx + "Result:\n".length);
  // 去掉截断指针尾行（指针不入正文预算口径）
  const m = body.match(/\n\[truncated [^\n]*\]$/);
  if (m) body = body.slice(0, m.index);
  // U4 截断会在正文尾附省略号「…」，同样属于截断包装而非原文，但计入保留长度
 //（kept = slice(0, limit) 本身含在内），此处保守保留。
  return body;
}

/** sa- 全形 id 提取：真实形态 = sa-<uuid>（如 sa-9407516a-a053-45a4-9d12-69a93b6d7c8c，
 *  A1 真跑 dump 实证），短式 sa-<hex> 兜底。返回首个命中或 undefined。
 *  各场景 item 侧/start 侧必须同用本函数，避免截断不一致导致集合比对假阴性。 */
export function saIdOf(text) {
  if (typeof text !== "string") return undefined;
  return text.match(/sa-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]
    ?? text.match(/sa-[0-9a-f]{6,}/i)?.[0];
}

/** message content 的正文文本（string 直取；数组拼 type:"text" 块；其他形态空串）。 */
function messageContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && c.type === "text").map((c) => c.text || "").join("\n");
}

/** 单个 toolCall 块的 start 调用配对 [callId, args]；非 subagent start 调用返回 null。
 *  arguments 为对象（兼容字符串形态 JSON.parse）。 */
function startCallPairOf(c) {
  if (!c || c.type !== "toolCall") return null;
  if ((c.name ?? c.toolName) !== "subagent") return null;
  const callId = typeof c?.id === "string" ? c.id : c?.toolCallId;
  if (typeof callId !== "string") return null;
  let args = c.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  if (!args || args.action !== "start") return null;
  return [callId, args];
}

/** 阶段一：扫描 assistant toolCall 块，收集 action:"start" 调用（toolCallId -> args）。 */
function collectStartToolCalls(entries) {
  const calls = new Map(); // toolCallId -> args
  for (const e of entries) {
    if (!isMessageOfRole(e, "assistant") || !Array.isArray(e.message.content)) continue;
    for (const c of e.message.content) {
      const pair = startCallPairOf(c);
      if (pair) calls.set(pair[0], pair[1]);
    }
  }
  return calls;
}

/** 阶段二：toolResult 正文按 toolCallId 配回 start 调用，产出 { saId, collect, engine, task }。 */
function matchStartToolResults(entries, calls) {
  const out = [];
  for (const e of entries) {
    if (!isMessageOfRole(e, "toolResult")) continue;
    const tcid = typeof e.message.toolCallId === "string" ? e.message.toolCallId : null;
    if (!tcid || !calls.has(tcid)) continue;
    const saId = saIdOf(messageContentText(e.message.content));
    if (!saId) continue;
    const args = calls.get(tcid);
    out.push({ saId, collect: args.collect || "async", engine: args.engine || null, task: args.task || "" });
  }
  return out;
}

/** 扫描主 session entries，提取派发轮 subagent start 调用映射。
 *
 * 真实形态（A1 真跑 dump 实证，2026-09）：assistant content 的 toolCall 块字段为
 * {type:"toolCall", id, name, arguments}——工具名字段是 name（非 toolName），调用 id
 * 字段是 id（非 toolCallId）；toolResult message 侧才是 toolCallId/toolName。
 * arguments 为对象（兼容字符串形态 JSON.parse）× toolResult 正文首块
 * {"action":"start","subagentId":"sa-…"} 配对 → { saId, collect, engine, task } 列表。 */
export function dispatchedStarts(entries) {
  return matchStartToolResults(entries, collectStartToolCalls(entries));
}

/** 轮询主 session 文件直到出现满足 pred 的 subagent-bg-notify entry。
 * pred 收「当前全部 notify entries」，真值时返回全部 entries（调用方自行重读断言）。 */
export async function waitForNotify(sessionFile, timeoutMs, pred = (ns) => ns.length > 0, label = "bg-notify entry") {
  const start = Date.now();
  let interval = 200;
  for (;;) {
    const entries = readJsonlEntries(sessionFile);
    const ns = bgNotifyEntries(entries);
    if (pred(ns)) return entries;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForNotify timeout after ${timeoutMs}ms waiting for: ${label} (seen ${ns.length} notify entries)`,
      );
    }
    await sleep(interval);
    interval = Math.min(interval * 2, 2000);
  }
}

/** 子 session 文件列表（<agentDir>/subagents/<enc>/sessions/*.jsonl）。 */
export function subagentSessionFiles(ws) {
  const dir = join(resolveAgentDir(), "subagents", ws.enc, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
}

/** 已完成的子 session 数（.finalized sidecar，finalized-marker.ts 机制）。 */
export function countFinalized(ws) {
  const dir = join(resolveAgentDir(), "subagents", ws.enc, "sessions");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl.finalized")).length;
}

/** 轮询直到 ≥n 个子 session finalized（崩溃恢复场景：孤儿进程自行跑完的观察点）。 */
export async function waitForFinalized(ws, n, timeoutMs) {
  const start = Date.now();
  let interval = 500;
  for (;;) {
    if (countFinalized(ws) >= n) return countFinalized(ws);
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForFinalized timeout after ${timeoutMs}ms (want ${n}, got ${countFinalized(ws)})`);
    }
    await sleep(interval);
    interval = Math.min(interval * 2, 3000);
  }
}

/** 主 session JSONL 中「notify entry 之前」的 assistant message 数（A1 闭合前零新 turn）。 */
export function assistantCountBefore(entries, entryIndex) {
  return entries.slice(0, entryIndex).filter((e) => e && e.type === "message" && e.message && e.message.role === "assistant").length;
}

/** toolResult 正文提取（指定 toolName；含 A4③ session_read 取回断言用）。 */
export function toolResultTexts(entries, toolName) {
  const out = [];
  for (const e of entries) {
    if (!isMessageOfRole(e, "toolResult")) continue;
    if (toolName && e.message.toolName !== toolName) continue;
    out.push(messageContentText(e.message.content));
  }
  return out;
}

// ── 结果记录（A2/A7 手动执行模板 + 各场景执行留痕）──────

// [commit 前修复·R1 误报拆分] RESULTS.md 追加写入已抽至 results-log.mjs
//（纯结果日志模块，不含任何 pi 数据目录路径推导——R1 文件级启发式不再命中）；
// 此处 re-export，场景脚本 C.appendResultRecord / C.RESULTS_FILE 调用面不变。
export { RESULTS_FILE, appendResultRecord } from "./results-log.mjs";

// ── 场景包装：统一 try/catch + cleanup + 退出码 ─────────

export async function runScenario(scenarioId, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`\n[${scenarioId}] 执行异常: ${err && err.stack ? err.stack : String(err)}`);
    process.exitCode = 1;
  }
}
