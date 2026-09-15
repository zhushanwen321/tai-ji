// 一次性诊断：降级链路（SIGTERM dispose→重建→session_start 恢复钩子）实测补发形态。
import * as C from "./common.mjs";

async function waitDead(session, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const c = session.child;
    if (c.exitCode !== null || c.signalCode !== null) return true;
    if (Date.now() - start > timeoutMs) return false;
    await C.sleep(100);
  }
}

const ws = C.makeWorkspace("diag-degrade");
const s1 = C.spawnSession({
  piBin: C.resolvePiBin(), cwd: ws.cwd, sessionDir: ws.sessionDir,
  model: C.resolveModel(), label: "diag-degrade-main",
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
  const F = s1.sessionFile;
  await C.sleep(5000);
  console.log("graceful dispose (SIGTERM)…");
  s1.kill("SIGTERM");
  console.log("dispose dead:", await waitDead(s1, 15000));
  // 重建 → session_start 恢复钩子
  const s2 = C.spawnSession({
    piBin: C.resolvePiBin(), cwd: ws.cwd, sessionDir: ws.sessionDir, sessionFile: F,
    model: C.resolveModel(), label: "diag-degrade-restart",
  });
  console.log("restart ready:", !!(await s2.waitReady()));
  try {
    const entries = await C.waitForNotify(F, 120000, (ns) => ns.length > 0, "恢复补发 notify");
    const batches = C.syncBatchNotifyEntries(entries);
    console.log("notify 总数:", C.bgNotifyEntries(entries).length, "sync 批:", batches.length);
    if (batches[0]) {
      const segs = C.batchSegments(batches[0].content);
      console.log("批头:", batches[0].content.split("\n")[0]);
      console.log("条目首行:", segs.slice(1).map((s) => s.split("\n")[0]));
      console.log("details.items status/closedReason:", JSON.stringify((batches[0].details.items || []).map((m) => ({ status: m.status, closedReason: m.closedReason }))));
    }
    // 二次重启零重发
    await C.sleep(6000);
    const before = C.bgNotifyEntries(C.readJsonlEntries(F)).length;
    s2.kill("SIGKILL");
    await waitDead(s2, 8000);
    const s3 = C.spawnSession({
      piBin: C.resolvePiBin(), cwd: ws.cwd, sessionDir: ws.sessionDir, sessionFile: F,
      model: C.resolveModel(), label: "diag-degrade-restart2",
    });
    console.log("restart2 ready:", !!(await s3.waitReady()));
    await C.sleep(30000);
    const after = C.bgNotifyEntries(C.readJsonlEntries(F)).length;
    console.log(`二次重启零重发: before=${before} after=${after} → ${before === after ? "PASS" : "FAIL"}`);
  } catch (err) {
    console.log("degrade 观察:", err.message);
  }
} catch (err) {
  console.error("diag error:", err?.message ?? err);
  s1.kill();
  ws.cleanup();
  process.exit(1);
}
s1.kill();
ws.cleanup();
