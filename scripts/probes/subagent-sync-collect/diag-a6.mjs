// 一次性诊断：kill -9 主 pi 后 worker 存活性 + 重启恢复链路。跑完保留现场并转储证据。
import * as C from "./common.mjs";

const ws = C.makeWorkspace("diag-a6");
const s1 = C.spawnSession({
  piBin: C.resolvePiBin(), cwd: ws.cwd, sessionDir: ws.sessionDir,
  model: C.resolveModel(), label: "diag-a6-main",
});
try {
  const ready = await s1.waitReady();
  console.log("ready:", !!ready);
  const prompt = C.dispatchPrompt({
    starts: [1, 2].map((n) => ({
      task: `You MUST actually run this exact bash command first: sleep 60 && echo marker-${n}. After it finishes, reply with exactly: a6-${n}-done`,
      slug: `diag-slow-${n}`, collect: "sync",
    })),
  });
  const turn = await s1.prompt(prompt, 120000);
  console.log("dispatch turn:", JSON.stringify(turn));
  const F = s1.sessionFile;
  console.log("F:", F);
  await C.sleep(8000);
  console.log("pre-kill sessions:", C.subagentSessionFiles(ws).length, "finalized:", C.countFinalized(ws));
  s1.kill("SIGKILL");
  console.log("killed main pi (SIGKILL)");
  // 观察 worker 存活：finalized sidecar / session 文件增长，每 10s 采样，共 100s
  for (let t = 10; t <= 100; t += 10) {
    await C.sleep(10000);
    console.log(`t+${t}s sessions=${C.subagentSessionFiles(ws).length} finalized=${C.countFinalized(ws)}`);
  }
  // 重启 → 观察恢复补发
  const s2 = C.spawnSession({
    piBin: C.resolvePiBin(), cwd: ws.cwd, sessionDir: ws.sessionDir, sessionFile: F,
    model: C.resolveModel(), label: "diag-a6-restart",
  });
  const ready2 = await s2.waitReady();
  console.log("restart ready:", !!ready2);
  try {
    const entries = await C.waitForNotify(F, 150000, (ns) => ns.length > 0, "重启后任意 notify");
    console.log("NOTIFY ARRIVED:", C.bgNotifyEntries(entries).map((n) => n.content.split("\n")[0]));
  } catch (err) {
    console.log("NO NOTIFY:", err.message);
  }
  console.log("final sessions:", C.subagentSessionFiles(ws).length, "finalized:", C.countFinalized(ws));
  // 转储主 session 全文 + worker session 名单供离线分析
  const { writeFileSync, readFileSync } = await import("node:fs");
  writeFileSync("/tmp/diag-a6-main.jsonl", readFileSync(F, "utf-8"));
  console.log("dumped /tmp/diag-a6-main.jsonl");
} catch (err) {
  console.error("diag error:", err?.message ?? err);
  s1.kill();
  process.exit(1);
}
s1.kill();
ws.cleanup();
