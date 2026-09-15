// registry-fork-filter.test.ts —— [W6] 翻档 × fork 继承残留的读侧过滤契约 +
// bash 跨 session 可见性显式断言（R4 一刀语义钉住）+ 偏差 #4 探针（goal 守卫口径）。
//
// 设计权威源：chat-domain-v1x-liveness-governance.md §3.2 D4（翻档三连带——读侧
// 过滤三口；分档常量已随 ext-simplify-12 删除，三类型 process 档成为无条件代码
// 自然状态）+ 修订记录 v5-⑤（bash 跨 session 可见性一刀钉成显式选择）+ 验收 A9②
// + impl-plan §5 偏差 #4（W4 交接：goal 守卫消费点未传基准，W6 实测裁决是否需
// goal 侧两行传参）。
//
// 被测函数 = `extensions/universal/pending-notifications/src/state.ts` 的导出纯函数
// （零依赖、不触 Pi 运行时——文件头注自证；经相对路径源码消费，subagent-core 无该
// workspace 依赖声明，不加 phantom dep）。分工：
//   - 过滤函数本体 / pending_notifications 工具投影（entries 现算）的两口径行为：
//     本套件钉语义（conformance 视角）；
//   - 过滤①②③的**接线**（goal/subagent-workflow/pending-notifications 三消费点
//     透传 currentSessionId）：W4 包内测试已承载（pi-pending-notifications
//     __tests__、subagent-workflow pi-host.test）；
//   - 后代判定口（读侧过滤②）的差集口径与①共用同一函数——本套件①的断言即其
//     语义核心；接线透传由上述 W4 测试守护。
//
// 探针结论（偏差 #4，实测证据 = 「goal 守卫口径」describe）：**有虚增**——fork 后
// 父 session 仍活跃的后台任务残留使无基准口径幻 defer。该结论已由 d0b9a6faf
// （2026-09-09，fix(goal): pass currentSessionId）关闭——goal 两处守卫现传
// currentSessionId 基准，下方「无基准」形态仅作历史口径对照面保留。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 相对路径源码消费（7 层上溯到仓库根）：state.ts 是零依赖纯函数（不触 Pi 运行时），
// 无需为探针/契约测试给 subagent-core 添加 workspace 依赖声明。
// [ext-simplify-12] import 面收窄到 countActiveFromEntries——历史的 registry/
// session 档机器已整体删除，entries 是唯一状态源（跨包语义耦合面收敛到该函数）。
import { countActiveFromEntries } from "../../../../../../../extensions/universal/pending-notifications/src/state.ts";

import { runReconcileSweep } from "../../../round-supervisor/index.ts";

/** pending:register entry 的落盘形态（对齐 pending-notifications 写入侧契约）。 */
function registerEntry(
  id: string,
  type: "subagent" | "workflow" | "bash",
  sessionId: string,
  overrides: { expiresAt?: number } = {},
): { customType: string; data: Record<string, unknown> } {
  return {
    customType: "pending:register",
    data: {
      id,
      type,
      name: id,
      registeredAt: 1_000,
      sessionId,
      // 真实落盘无 expiresAt 键（写入侧无条件省略）；overrides.expiresAt 模拟历史
      // session 文件遗留的带 TTL 键 entry——差集读取侧刻意不读该键（对照面）。
      ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
    },
  };
}

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  tmpDirs = [];
});

describe("[W6/D4 翻档余义] 三类型跨时长无 TTL 清理（entries 差集现算）", () => {
  it("翻档后跨时长（远超旧 1h TTL）无 TTL 清理：三类型 register 均仍 active", () => {
    // NOW = 10 * 3_600_000 + 1：语义对照面基准时刻（旧 1h TTL = 3_600_000ms 的
    // 10 倍 + 1ms，远超旧 1h TTL）。entries 差集不接收时间参数——差集语义刻意
    // 不校验时间，NOW 仅标注对照语义：若旧 session 档 TTL 机器仍在，NOW 时刻
    // bg-1/wf-1 早已被过期清理。
    const NOW = 10 * 3_600_000 + 1;
    // 护栏：钉住对照面确实覆盖「超 TTL」域而非「窗口内未到期」假绿。
    expect(NOW - 1_000).toBeGreaterThan(3_600_000);
    const entries = [
      registerEntry("bg-1", "subagent", "sess-root", { expiresAt: 1_000 + 1 }), // 历史遗留 TTL 键（读取侧不读）
      registerEntry("wf-1", "workflow", "sess-root", { expiresAt: 1_000 + 1 }),
      registerEntry("bt-1", "bash", "sess-root"), // 真实落盘形态：无 expiresAt 键
    ];
    // 旧 session 档语义（1h TTL + 跨 session 补注销）曾把长任务/跨重启注册静默
    // 清除 → 守卫失明（事故环 4 放大器）；三类型全 process 档后差集一律续存。
    expect(countActiveFromEntries(entries).ids).toEqual(["bg-1", "wf-1", "bt-1"]);
  });
});

describe("[W6/D4 读侧过滤①] fork 继承残留 × countActiveFromEntries 基准", () => {
  it("带基准（currentSessionId）→ 父 session 残留不入差集、本 session 注册计入", () => {
    const entries = [
      registerEntry("parent-bg", "subagent", "sess-parent"),
      registerEntry("own-bg", "subagent", "sess-child"),
      registerEntry("own-bt", "bash", "sess-child"),
    ];
    const result = countActiveFromEntries(entries, { currentSessionId: "sess-child" });
    expect(result.ids).toEqual(["own-bg", "own-bt"]);
  });

  it("缺 sessionId 的旧形态条目视为本 session（宁放行不误杀——防误逐活跃计数）", () => {
    const entries = [{ customType: "pending:register", data: { id: "legacy-bg", type: "subagent" } }];
    expect(countActiveFromEntries(entries, { currentSessionId: "sess-child" }).ids).toEqual(["legacy-bg"]);
  });
});

describe("[W6/R4 一刀] bash 跨 session 可见性显式断言（钉成显式选择的语义变更）", () => {
  it("读侧过滤一刀后：子 session 的 goal 不再为父 session 的 bash 任务 defer（带基准口径）", () => {
    // fork 继承：子 session entries 复制父 session 的 bash 后台任务注册
    // （process 档跨 session 存活——U4 补注销对翻档类型不再中性化，残留永久留存）。
    const childEntries = [
      registerEntry("parent-bt", "bash", "sess-parent"),
      registerEntry("child-bt", "bash", "sess-child"),
    ];
    // 设计选择（R4）：按当前 session 过滤——父 session 的 bash 任务不再让子
    // session 的 goal 守卫 defer（子 session 有自己的等待域）。
    const scoped = countActiveFromEntries(childEntries, { currentSessionId: "sess-child" });
    expect(scoped.ids).toEqual(["child-bt"]);
    expect(scoped.count).toBe(1); // 只数本 session 的任务
  });

  it("旧行为显式登记：无基准对照面（历史形态）父 bash 残留仍入计数（= defer 驱动）", () => {
    const childEntries = [registerEntry("parent-bt", "bash", "sess-parent")];
    // 显式钉住「一刀的对照面」：不传基准 = 不过滤 = 子 session goal 仍为父 bash
    // 任务 defer。这是读侧过滤一刀**改变的旧行为**——保留此断言防止有人误以为
    // 过滤是缺省语义（偏差 #4：goal 消费点历史形态即此口径，已由 d0b9a6faf 修复
    // 传基准，见探针结论）。
    expect(countActiveFromEntries(childEntries).count).toBe(1);
  });
});

describe("[W6/D4 读侧过滤③] pending_notifications 工具投影（entries 现算）", () => {
  it("跨 session 残留不进差集、不产生任何写回（跳过不补注销——落盘收口归 core sweep / bte 对账通道）", () => {
    const entries = [
      registerEntry("parent-bg", "subagent", "sess-parent"),
      registerEntry("own-bg", "subagent", "sess-child"),
    ];
    // 工具投影面（count/list）不虚报继承残留（A9②：count/list 不含继承残留）——
    // 现算后与读侧过滤①共用同一 countActiveFromEntries 扫描，「落盘了什么」与
    // 「查询到什么」构造性一致。
    const result = countActiveFromEntries(entries, { currentSessionId: "sess-child" });
    expect(result.ids).toEqual(["own-bg"]);
    // 「跳过不补注销」：残留 entry 留在 session 文件（读侧①③口各自兜住差集消费
    // 方），countActiveFromEntries 只读不写——跨 session 写达域缺口由 core 对账
    // sweep 收口（bte 对账同理直接 appendEntry）。只读性实证：输入数组长度不变，
    // 无补发的 unregister entry。
    expect(entries).toHaveLength(2);
  });
});

describe("[W6/偏差 #4 探针] goal 守卫口径（无基准）× fork 残留——实测结论（历史口径）", () => {
  // 偏差 #4（impl-plan §5，W4 交接）：W4 读侧过滤①的 currentSessionId 为可选参数，
  // goal 守卫消费点未传基准。本探针在 fork 场景实测该口径是否被父 session 注册
  // 残留虚增，结论二选一回写报告：
  //   (a) 无影响（其他机制覆盖）→ 偏差 #4 关闭，goal 零改动；
  //   (b) 有虚增 → 列出确需的两行传参改动点（不改 goal——红线），留主会话裁决。
  //
  // **实测结论：(b) 有虚增。已由 d0b9a6faf（2026-09-09）关闭——goal 现传
  //   currentSessionId 基准，下方证据链与用例为无基准历史形态的对照面。**
  //   证据链（历史口径，d0b9a6faf 前的 goal 守卫两处消费点均无基准调用）：
  //     `extensions/universal/goal/src/adapters/event-handlers/agent-end.ts:198`
  //       `const pendingOps = countActiveFromEntries(entries);`（defer 分支判据
  //        = `pendingOps.count > 0`）
  //     `extensions/universal/goal/src/adapters/event-handlers/agent-end.ts:294`
  //       `if (countActiveFromEntries(ctx.sessionManager.getEntries()).count > 0) return;`
  //       （backoff 延迟发射前守卫）
  //   下方用例 1 证明该口径在 fork 残留下 count>0 → defer 命中（幻 defer）；
  //   用例 2 证明仅当父任务 record 已终态（core sweep 补注销落盘）才归零——
  //   「父任务仍活跃」窗口内无任何机制覆盖（W4 翻档后 U4 不再中性化）。
  //
  //   已执行的修复（d0b9a6faf，即当时登记的两行传参改动点）：
  //     agent-end.ts:198 → `countActiveFromEntries(entries, { currentSessionId: ctx.sessionManager.getSessionId() })`
  //     agent-end.ts:294 → `countActiveFromEntries(ctx.sessionManager.getEntries(), { currentSessionId: ctx.sessionManager.getSessionId() })`
  //   （getSessionId 是 extension 侧既有取 sessionId 形态——pending-notifications
  //   index.ts:216、subagent-workflow session-lifecycle.ts 同款先例；现行
  //   agent-end.ts 守卫注释反向引用本探针作为传基准依据。）

  it("用例 1：父 session 活跃 subagent 残留 → 无基准对照面（历史形态）count>0 → defer 分支命中（虚增）", () => {
    // fork 时刻快照：父 session 派了后台子代理（record 仍 running-resumable），
    // 子 session 继承其 register 残留；goal 守卫读到的 entries = 本 session 文件
    // 全量（含继承残留）。历史形态 = 无基准调用（d0b9a6faf 前 agent-end.ts:198
    // 逐字形态；现行已传基准，此对照面锁定「不传则虚增」的机制事实）。
    const childEntries = [
      registerEntry("parent-bg", "subagent", "sess-parent"),
      registerEntry("child-bg", "subagent", "sess-child"),
    ];
    const pendingOps = countActiveFromEntries(childEntries); // ← 无基准对照面（历史形态）
    // defer 分支判据（agent-end.ts:199 `if (pendingOps.count > 0)`）命中：
    // 父 session 的任务让子 session 的 goal 停发 continuation 并 notify
    // 「Goal waiting for 2 background task(s)」——计数含非本 session 任务 = 虚增。
    expect(pendingOps.count).toBe(2);
    expect(pendingOps.ids).toContain("parent-bg");
  });

  it("用例 2：父任务 record 终态后，core sweep 补注销落盘使现状口径归零（虚增仅限活跃窗口）", () => {
    const dir = mkdtempSync(join(tmpdir(), "w6-goal-probe-sweep-"));
    tmpDirs.push(dir);
    const sessionFile = join(dir, "session-child.jsonl");
    writeFileSync(
      sessionFile,
      `${JSON.stringify(registerEntry("parent-bg", "subagent", "sess-parent"))}\n`,
      "utf8",
    );
    // 父任务 record 已终态（closed）：core 对账 sweep 差集补发——appendEntry 权威
    // 落盘到子 session 文件（sweep 的注销对「无基准口径」也生效：差集读侧不过滤，
    // 补发的 unregister entry 抵消 register）。
    const result = runReconcileSweep({
      sessionFile,
      lookupRecordState: () => ({ terminal: true, closedReason: "completed" }),
      appendEntry: (customType, data) => {
        writeFileSync(sessionFile, `${JSON.stringify({ customType, data })}\n`, { flag: "a" });
      },
    });
    expect(result.reconciled).toEqual(["parent-bg"]);

    // 落盘后 goal 守卫（无基准口径，历史形态）重读 entries：计数归零——sweep 是
    // 无基准口径的唯一收敛通道，且只覆盖「record 可判定终态」的窗口；「父任务仍
    // 活跃」窗口（用例 1）无机制覆盖 → 虚增结论 (b) 成立。
    const entriesAfter = readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(countActiveFromEntries(entriesAfter).count).toBe(0);
  });
});
