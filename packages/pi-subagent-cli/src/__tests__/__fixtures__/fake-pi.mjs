#!/usr/bin/env node
// fake-pi.mjs — e2e 用的 fake pi rpc 子进程（PATH 注入名为 `pi` 的可执行 wrapper
// 调本文件）。行为契约（对齐真 pi --mode rpc 的本测试消费面）：
//   - `pi --version` 应答版本行（probe 语义）；
//   - stdin JSONL 驱动：get_state → 应答 sessionFile/sessionId；
//     prompt → 回放事件流（text_delta ×2 / tool_start / tool_end / turn_end /
//     message_end usage）→ extension_ui_request（select，ask_user channel marker）
//     → 等 extension_ui_response → 追加 message_end + 退出码 0。

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-pi 0.84.4\n");
  process.exit(0);
}

const sessionDir = (() => {
  const i = process.argv.indexOf("--session-dir");
  return i >= 0 ? process.argv[i + 1] : os.tmpdir();
})();
const sessionFile = path.join(sessionDir, "2026-09-09T00-00-00-000Z_fake-session-1.jsonl");

const SESSION_ID = "fake-session-1";

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let waitingUi = null;

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
    // cwd 探针（protocol-e2e 断言「wire ctx.cwd → 引擎 spawn cwd」传导链）：
    // 落盘本进程真实 cwd 到 session 目录，测试侧读文件比对。目录可能尚不存在
    //（pi session 延迟创建语义）——recursive mkdir 兜底。
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "cwd-probe.txt"), process.cwd());
    } catch { /* 探针失败不阻断协议应答 */ }
    write({ type: "response", id: cmd.id, command: "get_state", success: true, data: { sessionFile, sessionId: SESSION_ID } });
    return;
  }
  if (cmd.type === "prompt") {
    // 事件回放（SdkEvent 形态——spawn-event-adapter 的 event 分支）
    write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
    write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
    write({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { cmd: "echo hi" } });
    write({ type: "tool_execution_end", toolCallId: "tc-1", toolName: "bash", result: { content: [{ type: "text", text: "hi" }] } });
    write({ type: "turn_end" });
    write({ type: "message_end", message: { usage: { input: 100, output: 50 }, stopReason: "toolUse" } });
    // ask_user：经 select dialog 通道（TAIJI_ASK_USER marker 借道，title 带 NUL 前缀）
    write({
      type: "extension_ui_request",
      id: "ui-1",
      method: "select",
      title: "\0TAIJI_ASK_USER",
      options: [JSON.stringify({ questions: [{ question: "Pick", options: [{ label: "A" }] }], allowCancel: false })],
    });
    return;
  }
  if (cmd.type === "extension_ui_response") {
    // 用户答案到达 → 追加最终轮并收尾
    write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "final answer" } });
    write({ type: "turn_end" });
    write({ type: "message_end", message: { usage: { input: 10, output: 5 }, stopReason: "end" } });
    if (waitingUi) {
      const w = waitingUi;
      waitingUi = null;
      setTimeout(w, 20);
    }
    return;
  }
});

// exit 钩子：等收到 extension_ui_response 后由 waitingUi 触发退出
waitingUi = () => process.exit(0);
// 兜底：90s 无答案自杀（防 e2e 挂死）
setTimeout(() => process.exit(3), 90_000).unref();
