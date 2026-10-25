// record-restart-sweep 失联清点 manifest 写点纪律测试（§3.3.4 + 原子写/水位统一原语锚）：
//   ① 清点写出的 manifest 帧事件水位在场（withEventsWatermark——写点戳 = 收条追加前
//      的事件文件 stat；收条落盘后水位过期由读侧按设计回落事件流重建）；
//   ② 写点走统一原子写原语（writeAtomicFileSync）——成功路径零约定 tmp 残留、旧自滚
//      `.swept-tmp` 形态不出现；崩溃残留（约定形态）可被 listStaleTmpFiles 反查。
// mkdtemp 假树直调（startup-sweep.test.ts 同形态），零真实数据目录触碰。
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listStaleTmpFiles } from "../../shared/atomic-write.ts";
import { sweepInterruptedRecords } from "../record-restart-sweep.ts";

/** 本文件共享 sid fixture（树内一级目录名，须过 shared isPiSessionId）。 */
const SWEEP_SID = "sid-sweep-fixture";

type SweepLog = { info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void };

/** 落「在途失联」假树：running manifest 快照 + 事件流停在轮始前族（created——无收条）。 */
function seedInFlightRecord(recordsDir: string, id: string): Stats {
  writeFileSync(
    join(recordsDir, `${id}.json`),
    JSON.stringify({ id, status: "running", createdAt: 1000 }),
  );
  const eventsPath = join(recordsDir, `${id}.events`);
  const header = { type: "record-events", id };
  const created = {
    type: "record-created",
    seq: 1,
    ts: 1000,
    id,
    agent: "worker",
    task: "t",
    slug: "s",
    origin: "tool",
    rootSessionId: SWEEP_SID,
    depth: 0,
    mode: "background",
    startedAt: 1000,
  };
  writeFileSync(eventsPath, [header, created].map((l) => JSON.stringify(l)).join("\n") + "\n");
  // 写点时点的事件文件 stat（收条 append 在 manifest 刷新之后——写点戳 = 本值）。
  return statSync(eventsPath);
}

describe("record-restart-sweep manifest 写点纪律（水位 + 统一原子原语）", () => {
  let agentRoot: string;
  let recordsDir: string;
  let log: SweepLog;

  beforeEach(() => {
    agentRoot = mkdtempSync(join(tmpdir(), "record-restart-sweep-"));
    recordsDir = join(agentRoot, "ext-sessions", SWEEP_SID, "subagents", "records");
    mkdirSync(recordsDir, { recursive: true });
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  afterEach(() => {
    rmSync(agentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("清点写出的 manifest 嵌事件文件水位（写点时戳 = 收条追加前 stat）且成功路径零 tmp 残留", async () => {
    const id = "sa-swept-1";
    const preStamp = seedInFlightRecord(recordsDir, id);

    const result = await sweepInterruptedRecords(() => agentRoot, log);
    expect(result.swept).toBe(1);

    const swept: unknown = JSON.parse(readFileSync(join(recordsDir, `${id}.json`), "utf-8"));
    expect(swept).toMatchObject({ executionStatus: "idle", stopReason: "interrupted-by-restart" });
    // 水位锚：在场且精确等于写点时点的事件文件 stat（修复前 = 无水位或沿用磁盘旧戳，
    // 读侧 mergeManifestRecords 校验恒失败——派生视图永回落重建）。
    expect(swept).toHaveProperty("eventsStamp", { mtimeMs: preStamp.mtimeMs, size: preStamp.size });
    // 统一原语锚：成功写无约定 tmp 残留；旧自滚 `.swept-tmp` 形态不再出现。
    expect(readdirSync(recordsDir).some((n) => n.includes(".swept-tmp"))).toBe(false);
    expect(listStaleTmpFiles(recordsDir)).toEqual([]);
  });

  it("写点 tmp 走统一约定：崩溃残留（约定形态）可被 listStaleTmpFiles 反查到 manifest 目标", () => {
    // 反事实锚：若写点回退自滚 tmp（旧 `.swept-tmp` 形态），残留不命中约定 pattern
    //（`.tmp.<pid>.<uniq>`），本反查通道即失效——写点命名约定由本断言与原语测试
    //（atomic-write.test.ts 扫描段）共同钉住。
    writeFileSync(join(recordsDir, "sa-swept-2.json.tmp.424242.7-abc123"), "{}");
    const refs = listStaleTmpFiles(recordsDir);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.targetPath).toBe(join(recordsDir, "sa-swept-2.json"));
    expect(refs[0]!.pid).toBe(424242);
  });
});
