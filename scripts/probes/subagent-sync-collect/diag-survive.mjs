// 一次性诊断：主 pi SIGKILL 后 worker 子进程存活性与最终化。跑完自清理。
import { execSync } from "node:child_process";
import * as C from "./common.mjs";

function workerProcs(marker) {
  try {
    const out = execSync(`ps -eo pid,ppid,command | grep "${marker}" | grep -v grep`, { encoding: "utf-8" });
    return out.trim().split("\n").filter(Boolean);
  } catch { return []; }
}

const ws = C.makeWorkspace("diag-survive");
const marker = `pi-sync-collect-diag-survive`;
const s1 = C.spawnSession({
  piBin: C.resolvePiBin(), cwd: ws.cwd, sessionDir: ws.sessionDir,
  model: C.resolveModel(), label: "diag-survive-main",
});
try {
  const ready = await s1.waitReady();
  console.log("ready:", !!ready);
  const prompt = C.dispatchPrompt({
    starts: [1, 2].map((n) => ({
      task: `You MUST actually run this exact bash command first: sleep 60 && echo marker-${n}. After it finishes, reply with exactly: a6-${n}-done`,
      slug: `slow-${n}`, collect: "sync",
    })),
  });
  await s1.prompt(prompt, 120000);
  await C.sleep(8000);
  console.log("主 pi 存活期 worker 进程：");
  workerProcs(marker).forEach((l) => console.log("  ", l.slice(0, 150)));
  s1.kill("SIGKILL");
  console.log("main SIGKILLed");
  for (const t of [5, 30, 70]) {
    await C.sleep((t === 5 ? 5 : t === 30 ? 25 : 40) * 1000);
    const procs = workerProcs(marker);
    console.log(`t+${t}s: worker 进程=${procs.length} finalized=${C.countFinalized(ws)} sessions=${C.subagentSessionFiles(ws).length}`);
  }
  console.log("结论采样完成");
} catch (err) {
  console.error("diag error:", err?.message ?? err);
  s1.kill();
  ws.cleanup();
  process.exit(1);
}
s1.kill();
ws.cleanup();
