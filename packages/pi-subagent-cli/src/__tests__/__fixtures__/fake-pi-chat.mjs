#!/usr/bin/env node
// fake-pi-chat.mjs — [H1 U3] chat 轮 run 派发形态 e2e 用的 fake pi rpc 子进程（PATH
// 注入名为 `pi` 的 wrapper 调本文件）。每轮一进程（引擎 agent_settled resolve 后
// 杀链收割，续聊 = 新 run + --session 续写）：
//   - `pi --version` 应答版本行；
//   - get_state → 应答 sessionFile/sessionId（resume 形态 = --session 指向的原文件）；
//   - prompt → 先读 session 文件历史（append 前），把 prompt 追写进 session 文件
//     （模拟 pi 的 session 持久化：首轮新建 / resume 续写同文件），回复携带
//     「读到的历史行数」（resume 形态）——同文件续写 + 历史召回的构造性断言面：
//     第二个进程能看到第一个进程写入的内容，当且仅当 --session 穿透正确；
//   - agent_end + agent_settled（引擎 resolve + 收割边界）；
//   - SIGTERM → exit 0（pi trap 语义：先 flush 后退出）。

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-pi-chat 0.84.4\n");
  process.exit(0);
}

const sessionDir = (() => {
  const i = process.argv.indexOf("--session-dir");
  return i >= 0 ? process.argv[i + 1] : os.tmpdir();
})();
const resumeFile = (() => {
  const i = process.argv.indexOf("--session");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
// 冷续形态沿用 resume 目标文件（断言面：--session 透传后定位不变）
const sessionFile = resumeFile ?? path.join(sessionDir, "2026-09-09T00-00-00-000Z_fake-chat-1.jsonl");

const SESSION_ID = "fake-chat-1";

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function countHistoryLines() {
  try {
    return fs.readFileSync(sessionFile, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let cmd;
  try {
    cmd = JSON.parse(text);
  } catch {
    return;
  }
  if (cmd.type === "get_state") {
    write({ type: "response", id: cmd.id, command: "get_state", success: true, data: { sessionFile, sessionId: SESSION_ID } });
    return;
  }
  if (cmd.type === "prompt") {
    // 历史召回面：append 前读——读到的只能是先前进程写入的内容
    const historyLines = countHistoryLines();
    // 模拟 pi session 持久化：prompt 追加进 session 文件（首轮新建 / resume 续写同文件）
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "user", text: cmd.message })}\n`);
    const reply = resumeFile !== undefined ? `resumed-history:${historyLines}` : "chat-first-answer";
    write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } });
    write({ type: "message_end", message: { usage: { input: 42, output: 21 }, stopReason: "end" } });
    write({ type: "agent_end" });
    write({ type: "agent_settled" });
    return;
  }
});

// pi trap 语义：SIGTERM → 优雅退出（exit 0 口径）
process.on("SIGTERM", () => {
  process.exit(0);
});
// 兜底：120s 无事件自杀（防 e2e 挂死）
setTimeout(() => process.exit(3), 120_000).unref();
