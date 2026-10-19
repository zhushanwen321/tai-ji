// src/execution/__tests__/notifier.test.ts
//
// BgNotifier 投递路径契约（unified-delivery 波 2：port.deliver 主投 + 缺席直发兜底）。
//
// u-5c 迁自壳套件 src/__tests__/notifier-flush.test.ts（被测 module 是 core 件，
// 唯一测试覆盖原落壳）。
//
// 波 2 改写对位（账本 + 内核路径退役，场景逐条对位不删——对位表见
// .tmp/dev-flow/unified-delivery.runlog/u3-ledger-absorb.md）：
//   - dedup 按轮次 / epoch 键形态 → 幂等键语义由 port 承载（notifier 构造 notifyId
//     作 port.deliver 的 id，同 id 重提 = 端口 swallowed——判重锚定投递日志）；
//   - isIdle gate 退避 / 退避上限强发 / subscribeSettled 边沿驱动 → 机制随内核队列
//     持有退役（port 受理即入 pi 原生唯一队列，忙时不拒；retain 重投由端口内
//     settled/compaction 边沿驱动——pi-delivery-port 套件「注入 throw → retain 留账；
//     恢复后 settled 边沿重投」已对位）；
//   - ledger 未 bind 降级留痕 → port 缺席直发降级留痕（warn 文案 + 量级限流）；
//   - mergeHold 合批 join → merge 选项透传端口（合批合成在内核出站点，形态由
//     pi-delivery-port 套件「60s 到期合成一条批消息」锁定）。
//
// 测试方法：主路径注入 fake port（getDeliveryPort 槽访问器），缺席路径观察 mock
// host 的 sendMessage（直发兜底唯一形态 = { triggerTurn: true }，G4 字节锁定）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// port 缺席降级留痕 warn——mock 掉防刷屏，同时供「降级 warn 限流」用例断言调用次数。
vi.mock("../../core/logger.ts", () => ({ getLogger: () => loggerMock }));

import {
  configureNotifyDomain,
  resetNotifyDomainForTests,
  type DeliveryPortHandle,
} from "../../core/notify-ports.ts";
import {
  createNotifier,
  FAILURE_RECOVERY_TAIL,
  type BgNotifier,
  type NotifierHost,
} from "../notify/notifier.ts";

// ─── fake 投递端口（deliver/flush 消费方 + 同 id 幂等吞） ─────────────────────

type RecordedEnvelope = {
  id: string | undefined;
  payload: { kind: string; customType: string; content: string; display: boolean; details?: unknown };
  opts: { merge?: boolean } | undefined;
};

function makeFakePort() {
  const seen = new Set<string>();
  const envelopes: RecordedEnvelope[] = [];
  let rejectedIds = new Set<string>();
  let nextAcceptReject: "accept" | "reject" = "accept";
  const flush = vi.fn();
  const handle: DeliveryPortHandle = {
    deliver(envelope, opts) {
      const id = envelope.id ?? "gen-id";
      if (rejectedIds.has(id)) rejectedIds.delete(id);
      if (nextAcceptReject === "reject") {
        nextAcceptReject = "accept";
        return { kind: "rejected", reason: "persist-failed (fake)" };
      }
      if (seen.has(id)) {
        return { kind: "swallowed", reason: "already-seen" };
      }
      seen.add(id);
      envelopes.push({
        id: envelope.id,
        payload: envelope.payload,
        opts,
      });
      return { kind: "accepted", id };
    },
    flush,
  };
  return {
    handle,
    envelopes,
    flush,
    /** 下一次 deliver 返回 rejected（persist-failed 形态）。 */
    rejectNext: () => {
      nextAcceptReject = "reject";
    },
  };
}

/** mock host：捕获所有 sendMessage（直发兜底观察侧）+ 控制 hasRunningBackground。 */
function makeMockHost(): NotifierHost & {
	sendMessageCalls: { message: unknown; options: unknown }[];
	hasRunningBackground: ReturnType<typeof vi.fn>;
	isIdle: ReturnType<typeof vi.fn>;
} {
	const sendMessageCalls: { message: unknown; options: unknown }[] = [];
	const hasRunningBackground = vi.fn(() => false);
	const isIdle = vi.fn(() => true);
	return {
		sendMessageCalls,
		hasRunningBackground,
		isIdle,
		sendMessage(message, options) {
			sendMessageCalls.push({ message, options });
		},
	};
}

beforeEach(() => {
  resetNotifyDomainForTests();
});

afterEach(() => {
  resetNotifyDomainForTests();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
});

/** 构造最小 closed 通知（G4 文案断言范围在 buildLlmContent 段）。 */
const notifyRecord = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "closed" as const,
  agent: "explorer",
  result: "done",
  startedAt: 1,
  endedAt: 2,
  ...extra,
});

// ─── 主路径：port.deliver（unified-delivery 波 2） ────────────────────────────

describe("BgNotifier 主路径 — port.deliver（envelope 构造 + flush 转发）", () => {
  let fake: ReturnType<typeof makeFakePort>;
  let host: ReturnType<typeof makeMockHost>;
  let notifier: BgNotifier;

  beforeEach(() => {
    fake = makeFakePort();
    host = makeMockHost();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    notifier = createNotifier(host);
  });

  afterEach(() => {
    notifier.dispose();
  });

  it("notify → port.deliver：id = notifyId（裸 id 形态），payload 走默认通道 + details 携带 record；host.sendMessage 零调用", () => {
    notifier.notify(notifyRecord("bg-test-1"));

    expect(fake.envelopes).toHaveLength(1);
    expect(fake.envelopes[0]!.id).toBe("bg-test-1");
    expect(fake.envelopes[0]!.payload.customType).toBe("subagent-bg-notify");
    expect(fake.envelopes[0]!.payload.display).toBe(true);
    expect(fake.envelopes[0]!.payload.details).toMatchObject({ id: "bg-test-1", notifyId: "bg-test-1" });
    // 主投不经直发（port 是唯一注入出口）
    expect(host.sendMessageCalls).toHaveLength(0);
  });

  it("hasRunningBackground=false → merge 缺省直通；=true → merge:true 进端口 60s 窗口", () => {
    host.hasRunningBackground.mockReturnValue(false);
    notifier.notify(notifyRecord("bg-merge-false"));
    // collectKey：无 round = 完成通知，世代首个申报判据命中（result-collect 设计 §3.3）
    expect(fake.envelopes[0]!.opts).toEqual({ merge: false, collectKey: ["bg-merge-false"] });

    host.hasRunningBackground.mockReturnValue(true);
    notifier.notify(notifyRecord("bg-merge-true"));
    expect(fake.envelopes[1]!.opts).toEqual({ merge: true, collectKey: ["bg-merge-true"] });
  });

  it("flushPendingNotifications → port.flush 转发（窗口缓冲提前出站的强制投递口）", () => {
    notifier.flushPendingNotifications();
    expect(fake.flush).toHaveBeenCalledTimes(1);
  });

  it("port rejected（persist-failed）→ 不降级直发 + warn 显式上报（首败即停，ADR-0122 ⑧）", () => {
    fake.rejectNext();
    notifier.notify(notifyRecord("bg-reject-1"));

    expect(host.sendMessageCalls).toHaveLength(0); // 不绕过耐久承诺直发
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("delivery port rejected notification"),
      expect.objectContaining({ detail: expect.objectContaining({ notifyId: "bg-reject-1" }) }),
    );
  });

  it("port swallowed（同 notifyId 已判重）→ 静默（已投递终局，fire-and-forget）", () => {
    notifier.notify(notifyRecord("bg-dup-port"));
    notifier.notify(notifyRecord("bg-dup-port"));

    // 第二次被端口判重吞（fake seen 集合），envelopes 只录首条；无降级 warn
    expect(fake.envelopes).toHaveLength(1);
    expect(host.sendMessageCalls).toHaveLength(0);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});

// ─── collectKey 债权申报（result-collect 设计 §3.3 多轮通知条目） ─────────────

describe("BgNotifier collectKey 申报 — 该操作世代的第一个通知", () => {
  let fake: ReturnType<typeof makeFakePort>;
  let host: ReturnType<typeof makeMockHost>;
  let notifier: BgNotifier;

  beforeEach(() => {
    fake = makeFakePort();
    host = makeMockHost();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    notifier = createNotifier(host);
  });

  afterEach(() => {
    notifier.dispose();
  });

  it("首轮通知（round 推进后 =1）申报 collectKey: [id]；后续轮次（round≥2）不申报", () => {
    // 首个轮终通知：markRoundIdle 轮终簿记先于通知发出（finalizeRoundOutcome 内
    // round 0/undefined → 1），notifier 收到的 record.round = 1。
    notifier.notify(notifyRecord("bg-collect-1", { round: 1 }));
    notifier.notify(notifyRecord("bg-collect-1", { round: 2 }));

    expect(fake.envelopes).toHaveLength(2);
    expect(fake.envelopes[0]!.opts).toMatchObject({ collectKey: ["bg-collect-1"] });
    expect(fake.envelopes[1]!.opts).not.toHaveProperty("collectKey");
  });

  it("one-shot / close 收尾等完成通知（round=undefined）同样申报", () => {
    notifier.notify(notifyRecord("bg-collect-oneshot"));

    expect(fake.envelopes[0]!.opts).toMatchObject({ collectKey: ["bg-collect-oneshot"] });
  });

  it("reopen 新世代（epoch+1、round 归零后首轮 round=1）重新申报", () => {
    notifier.notify(notifyRecord("bg-collect-re", { epoch: 0, round: 1 }));
    notifier.notify(notifyRecord("bg-collect-re", { epoch: 1, round: 1 }));

    expect(fake.envelopes).toHaveLength(2);
    expect(fake.envelopes[0]!.opts).toMatchObject({ collectKey: ["bg-collect-re"] });
    expect(fake.envelopes[1]!.opts).toMatchObject({ collectKey: ["bg-collect-re"] });
  });

  it("dedupKey 派生通知（drain 丢弃等）不申报——非世代主身份、非终态信号", () => {
    notifier.notify(notifyRecord("bg-collect-drain", { round: 1, dedupKey: "bg-collect-drain:1:drain-drop" }));

    expect(fake.envelopes[0]!.opts).not.toHaveProperty("collectKey");
  });
});

// ─── 直发兜底路径（port 缺席：装配异常窗口的安全侧退化） ──────────────────────

describe("BgNotifier.flushPendingNotifications — 直发兜底单通道 triggerTurn 契约（port 缺席）", () => {
  let host: ReturnType<typeof makeMockHost>;
  let notifier: BgNotifier;

  beforeEach(() => {
    host = makeMockHost();
    notifier = createNotifier(host);
  });

  afterEach(() => {
    notifier.dispose();
  });

  it("缺席直发时 sendMessage 的 options 恰为 { triggerTurn: true }（无 deliverAs，单通道）", () => {
    notifier.notify(notifyRecord("bg-test-1"));

    expect(host.sendMessageCalls).toHaveLength(1);
    const call = host.sendMessageCalls[0];
    expect(call.options).toEqual({ triggerTurn: true });
  });

  it("缺席直发 triggerTurn 必须为 true（让父 agent 立即唤醒）", () => {
    notifier.notify(notifyRecord("bg-test-2"));

    expect(host.sendMessageCalls).toHaveLength(1);
    expect(host.sendMessageCalls[0].options).toEqual({ triggerTurn: true });
  });

  it("缺席直发在 dispose 后 notify 静默丢弃（disposed 短路，零 timer 依赖）", () => {
    vi.useFakeTimers();
    try {
      notifier.notify(notifyRecord("bg-dispose-1"));
      expect(host.sendMessageCalls).toHaveLength(1);

      notifier.dispose();
      notifier.notify(notifyRecord("bg-dispose-2"));
      vi.advanceTimersByTime(60_000);
      expect(host.sendMessageCalls).toHaveLength(1); // disposed 短路：无timer可触发、不再发送
    } finally {
      vi.useRealTimers();
    }
  });

  it("未注入 isIdle 时不 gate，缺席直发保持立即发送行为（向后兼容旧 host）", () => {
    const legacyHost: NotifierHost = {
      sendMessage: (message, options) => host.sendMessage(message, options),
      hasRunningBackground: () => false,
    };
    const legacyNotifier = createNotifier(legacyHost);
    legacyNotifier.notify(notifyRecord("bg-legacy-1"));

    expect(host.sendMessageCalls).toHaveLength(1);
    legacyNotifier.dispose();
  });
});

// ─── dedup 按轮次 / epoch 键形态（幂等键由 port 承载） ────────────────────────

describe("BgNotifier dedup 按轮次（G1 决策 9：对话模式豁免——key=id:round 参与 port 幂等键）", () => {
  let fake: ReturnType<typeof makeFakePort>;
  let notifier: BgNotifier;

  beforeEach(() => {
    fake = makeFakePort();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    notifier = createNotifier(makeMockHost());
  });

  afterEach(() => {
    notifier.dispose();
  });

  it("对话模式：同 id 不同 round 的两次 notify 不互相吞（round 参与幂等键）", () => {
    notifier.notify({
      id: "sa-chat", status: "running", agent: "w", round: 1, result: "round1",
      startedAt: 1, endedAt: 2,
    });
    notifier.notify({
      id: "sa-chat", status: "running", agent: "w", round: 2, result: "round2",
      startedAt: 3, endedAt: 4,
    });

    // MF-1 修复语义：幂等键 id:round，不同 round 不互相吞
    expect(fake.envelopes.map((e) => e.id)).toEqual(["sa-chat:1", "sa-chat:2"]);
  });

  it("同 id 同 round 第二次被 port 幂等判重吞（防重复通知）", () => {
    notifier.notify({
      id: "sa-dup", status: "running", agent: "w", round: 1, result: "r",
      startedAt: 1, endedAt: 2,
    });
    notifier.notify({
      id: "sa-dup", status: "running", agent: "w", round: 1, result: "r",
      startedAt: 3, endedAt: 4,
    });

    // 第二条同键（sa-dup:1）被端口 swallowed
    expect(fake.envelopes).toHaveLength(1);
    expect(fake.envelopes[0]!.id).toBe("sa-dup:1");
  });

  it("非 chatMode（round undefined → key=id）行为同旧（向后兼容，同 id 吞）", () => {
    notifier.notify(notifyRecord("sa-once"));
    notifier.notify(notifyRecord("sa-once"));

    expect(fake.envelopes).toHaveLength(1);
    expect(fake.envelopes[0]!.id).toBe("sa-once");
  });

  it("[U5] 无轮形态（close 收尾提示清 round）epoch>0 → key=`id:epoch`：不同 epoch 不互吞，同 key 仍吞", () => {
    notifier.notify(notifyRecord("sa-epoch", { result: "close@0" }));
    notifier.notify(notifyRecord("sa-epoch", { result: "close@1", epoch: 1 }));

    // 两条不同 key（裸 id vs id:1）都受理，details 携带各自 notifyId
    expect(fake.envelopes).toHaveLength(2);
    expect(fake.envelopes[0]!.payload.details).toMatchObject({ notifyId: "sa-epoch" });
    expect(fake.envelopes[1]!.payload.details).toMatchObject({ notifyId: "sa-epoch:1" });

    // 同 key（同 epoch）重复仍被端口判重吞——幂等去重语义不因 epoch 段放宽
    notifier.notify(notifyRecord("sa-epoch", { result: "again@1", epoch: 1 }));
    expect(fake.envelopes).toHaveLength(2);
  });
});

// ─── port 缺席降级留痕（诊断计数 + 量级限流） ────────────────────────────────

describe("BgNotifier — port 缺席直发降级留痕（warn 限流：首次 + 量级跨越）", () => {
  it("降级 warn 首条触发；后续 notify / revive 在同量级内不刷（降级代价：无判重无耐久）", () => {
    const host = makeMockHost();
    const notifier = createNotifier(host);
    notifier.notify(notifyRecord("sa-lw-1"));
    notifier.notify(notifyRecord("sa-lw-2"));
    notifier.notify(notifyRecord("sa-lw-3"));

    // 三条都送达（降级只损失判重与耐久，不丢消息），warn 只在首条刷
    expect(host.sendMessageCalls).toHaveLength(3);
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(String(loggerMock.warn.mock.calls[0]?.[0])).toContain("delivery port not bound");

    // revive 不复位计数：装配级降级事实一次留痕即可定位，新生命周期不重复刷
    notifier.dispose();
    notifier.revive();
    notifier.notify(notifyRecord("sa-lw-4"));
    expect(host.sendMessageCalls).toHaveLength(4);
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);

    notifier.dispose();
  });
});

// ─── buildLlmContent 文案侧（与投递路径解耦的纯函数部分——经直发兜底观察） ─────

describe("BgNotifier buildLlmContent 指针行（wave2：chatMode sessionFile 透传）", () => {
  let host: ReturnType<typeof makeMockHost>;
  let notifier: BgNotifier;

  beforeEach(() => {
    host = makeMockHost();
    // 无 port 注入 → 缺席直发兜底，sendMessageCalls 恰 1 条
    notifier = createNotifier(host);
  });

  afterEach(() => {
    notifier.dispose();
  });

  /** 取唯一一条已发消息的 content（前置断言恰 1 条）。 */
  function sentContent(): string {
    expect(host.sendMessageCalls).toHaveLength(1);
    return (host.sendMessageCalls[0]!.message as { content: string }).content;
  }

  it("running（轮次通知）+ sessionFile → 末尾追加 \\n\\n 空行分隔的指针行", () => {
    notifier.notify({
      id: "sa-ptr-1", status: "running", agent: "w", round: 1, result: "round1 text",
      sessionFile: "/tmp/sessions/child-1.jsonl",
      startedAt: 1, endedAt: 2,
    });

    expect(sentContent()).toBe(
      'Subagent "w" (sa-ptr-1) finished a round. Reply:\nround1 text' +
      "\n\nFull transcript: /tmp/sessions/child-1.jsonl",
    );
  });

  it("closed 成功文案 + sessionFile → 指针行追加在最终串末尾", () => {
    notifier.notify({
      id: "sa-ptr-2", status: "closed", agent: "w", result: "final result",
      sessionFile: "/tmp/sessions/child-2.jsonl",
      startedAt: 1, endedAt: 2,
    });

    expect(sentContent()).toBe(
      'Subagent "w" (sa-ptr-2) completed. Result:\nfinal result' +
      "\n\nFull transcript: /tmp/sessions/child-2.jsonl",
    );
  });

  it("closed + patchFile + sessionFile → 指针行追加在 patch 提示串末尾（最终串）", () => {
    notifier.notify({
      id: "sa-ptr-3", status: "closed", agent: "w", result: "did work",
      patchFile: "/tmp/patches/sa-ptr-3.patch",
      sessionFile: "/tmp/sessions/child-3.jsonl",
      startedAt: 1, endedAt: 2,
    });

    const content = sentContent();
    expect(content).toContain("git apply /tmp/patches/sa-ptr-3.patch");
    expect(content.endsWith("\n\nFull transcript: /tmp/sessions/child-3.jsonl")).toBe(true);
  });

  it("sessionFile 缺失 → 省略整行（running 通知正文与无指针形态逐字节一致）", () => {
    notifier.notify({
      id: "sa-ptr-4", status: "running", agent: "w", round: 2, result: "round2 text",
      startedAt: 1, endedAt: 2,
    });

    expect(sentContent()).toBe('Subagent "w" (sa-ptr-4) finished a round. Reply:\nround2 text');
  });

  it("cancelled → 不追加指针行（即使 sessionFile 有值）", () => {
    notifier.notify({
      id: "sa-ptr-5", status: "closed", closedReason: "cancelled", agent: "w",
      sessionFile: "/tmp/sessions/child-5.jsonl",
      startedAt: 1, endedAt: 2,
    });

    expect(sentContent()).toBe('Subagent "w" (sa-ptr-5) cancelled.');
  });

  it("gc-failed（closed + closedReason=gc + error 有值）→ failed 文案 + 恢复指引尾段 + 指针行", () => {
    notifier.notify({
      id: "sa-ptr-6", status: "closed", closedReason: "gc", agent: "w",
      error: "spawn EPIPE",
      sessionFile: "/tmp/sessions/child-6.jsonl",
      startedAt: 1, endedAt: 2,
    });

    // 新契约（batch C+D）：failed 通知附恢复指引尾段——期望引用权威常量构造，防文案再漂移
    expect(sentContent()).toBe(
      `Subagent "w" (sa-ptr-6) failed: spawn EPIPE\n\n${FAILURE_RECOVERY_TAIL}` +
      "\n\nFull transcript: /tmp/sessions/child-6.jsonl",
    );
  });

  it("[review 修复] gc-failed + patchFile 并存 → failed 文案优先（失败轮也会写 patchFile，patch 提示不可达）", () => {
    // 回归锚定：doFinalizeRecord Step 0 对 worktreeHandle 无条件 collectPatch，gc 失败 +
    // worktree 并存时 patchFile 有值。[U3] 判定收尾到单一 deriveOutcome（cancelled →
    // failed → patch/result），否则 LLM 被告知 completed 掩盖失败。
    notifier.notify({
      id: "sa-ptr-8", status: "closed", closedReason: "gc", agent: "w",
      error: "spawn EPIPE",
      patchFile: "/tmp/patches/sa-ptr-8.patch",
      sessionFile: "/tmp/sessions/child-8.jsonl",
      startedAt: 1, endedAt: 2,
    });

    expect(sentContent()).toBe(
      `Subagent "w" (sa-ptr-8) failed: spawn EPIPE\n\n${FAILURE_RECOVERY_TAIL}` +
      "\n\nFull transcript: /tmp/sessions/child-8.jsonl",
    );
  });

  it("[U3][D6 显式取舍] parent-shutdown 合成关闭 + patchFile 并存 → failed 文案优先（patch 提示不可达）", () => {
    // disposeAllRecords 合成 result 恒写 error:"closed due to ..." → outcome='failed'；
    // worktree 失败并存时仍不得展示 patch 提示（「failed 优先于 patchFile 提示」保真）。
    notifier.notify({
      id: "sa-u3-ps", status: "closed", closedReason: "parent-shutdown", agent: "w",
      error: "closed due to parent-shutdown",
      patchFile: "/tmp/patches/sa-u3-ps.patch",
      startedAt: 1, endedAt: 2,
    });

    expect(sentContent()).toBe(
      `Subagent "w" (sa-u3-ps) failed: closed due to parent-shutdown\n\n${FAILURE_RECOVERY_TAIL}`,
    );
  });

  it("[U3] details payload 物化 outcome：closed 入参缺省时按 deriveOutcome 兜底填充", () => {
    notifier.notify({
      id: "sa-u3-mat", status: "closed", closedReason: "gc", agent: "w",
      error: "boom",
      startedAt: 1, endedAt: 2,
    });

    expect(host.sendMessageCalls).toHaveLength(1);
    const msg = host.sendMessageCalls[0]!.message as { details?: { outcome?: string } };
    expect(msg.details?.outcome).toBe("failed");
  });

  it("[U3] 显式 outcome 优先于 closedReason 兜底（一等字段直读）", () => {
    notifier.notify({
      id: "sa-u3-explicit", status: "closed", closedReason: "gc", agent: "w",
      outcome: "cancelled",
      startedAt: 1, endedAt: 2,
    });

    expect(sentContent()).toBe('Subagent "w" (sa-u3-explicit) cancelled.');
  });

  it("[U3] running（轮次通知）不物化 outcome（终态语义不适用活跃态）", () => {
    notifier.notify({
      id: "sa-u3-round", status: "running", agent: "w", round: 1, result: "r1",
      startedAt: 1, endedAt: 2,
    });

    expect(host.sendMessageCalls).toHaveLength(1);
    const msg = host.sendMessageCalls[0]!.message as { details?: { outcome?: string } };
    expect(msg.details?.outcome).toBeUndefined();
  });

  it("one-shot（sessionFile 未透传 → undefined）→ closed 通知与改造前逐字节一致（基线常量锚定）", () => {
    notifier.notify({
      id: "sa-ptr-7", status: "closed", agent: "worker", result: "done",
      startedAt: 1, endedAt: 2,
    });

    // 改造前形态：sessionFile undefined 时指针为空串，追加不改变输出——逐字节锁定
    expect(sentContent()).toBe('Subagent "worker" (sa-ptr-7) completed. Result:\ndone');
  });

  it("[C-2] closed + totalRounds（chatMode close 终态通知）→ 文案附轮次统计 after N rounds", () => {
    notifier.notify({
      id: "sa-rounds-1", status: "closed", agent: "w", totalRounds: 3, result: "",
      sessionFile: "/tmp/sessions/child-rounds.jsonl",
      startedAt: 1, endedAt: 2,
    });

    // 设计 D2 路径①：closed 分支文案附轮次统计 + sessionFile 提示；
    // 路径②正文空串（idle close）形态也走本分支（result 空串非 nullish，不触发 (empty)）
    expect(sentContent()).toBe(
      'Subagent "w" (sa-rounds-1) completed after 3 rounds. Result:\n' +
      "\n\nFull transcript: /tmp/sessions/child-rounds.jsonl",
    );
  });

  it("[C-2] 对照：totalRounds 缺失（one-shot 完成通知）→ 无轮次统计，文案逐字节保持 completed. Result:", () => {
    notifier.notify({
      id: "sa-rounds-2", status: "closed", agent: "w", result: "done",
      sessionFile: "/tmp/sessions/child-oneshot.jsonl",
      startedAt: 1, endedAt: 2,
    });

    // one-shot record 无轮次语义（totalRounds 不设置）——G4：文案不含统计
    expect(sentContent()).toBe(
      'Subagent "w" (sa-rounds-2) completed. Result:\ndone' +
      "\n\nFull transcript: /tmp/sessions/child-oneshot.jsonl",
    );
  });
});

// ─── dispose / revive 生命周期 ────────────────────────────────────────────────

describe("BgNotifier — dispose / revive 生命周期（port 形态：无内核 handle 重建义务）", () => {
  let fake: ReturnType<typeof makeFakePort>;
  let host: ReturnType<typeof makeMockHost>;
  let notifier: BgNotifier;

  beforeEach(() => {
    fake = makeFakePort();
    host = makeMockHost();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    notifier = createNotifier(host);
  });

  afterEach(() => {
    notifier.dispose();
  });

  it("dispose → notify 静默丢弃 → revive → notify 恢复受理", () => {
    notifier.notify(notifyRecord("bg-revive-1"));
    expect(fake.envelopes).toHaveLength(1);

    // session_shutdown：dispose（外层 disposed 短路）
    notifier.dispose();

    // dispose 窗口内的 notify：外层 disposed 短路，静默丢弃（旧有语义）
    notifier.notify(notifyRecord("bg-revive-2"));
    expect(fake.envelopes).toHaveLength(1);

    // /resume /fork /new 后的 revive：直发 handle 无状态、port 单例与 notifier
    // 生命周期解耦——复位外层标志即恢复受理
    notifier.revive();
    notifier.notify(notifyRecord("bg-revive-3"));

    expect(fake.envelopes).toHaveLength(2);
    expect(fake.envelopes[1]!.payload.content).toContain("bg-revive-3");
  });

  it("revive 后同 id 重复通知被 port 幂等判重吞（投递日志判重不随 notifier 生命周期重置——幂等语义增强）", () => {
    notifier.notify(notifyRecord("bg-revive-dup", { result: "r1" }));
    notifier.dispose();
    notifier.revive();
    // 同 id 第二次：port seenIds 与 notifier 生命周期解耦，恒被吞（幂等正确性
    // 优于旧内核 LRU 逐出后的可再入形态）
    notifier.notify(notifyRecord("bg-revive-dup", { result: "r2" }));
    expect(fake.envelopes).toHaveLength(1);
  });
});

// ─── U3_UNIT：合批窗口判定透传（合批合成在内核出站点，形态由 port 套件锁定） ──

describe("U3_UNIT: createNotifier unit verification", () => {
  it("hasRunningBackground=true → merge:true 透传端口（60s 窗口攒批判定跟随提交方语义）；flush 转发端口", () => {
    const fake = makeFakePort();
    configureNotifyDomain({ getDeliveryPort: () => fake.handle });
    const host: NotifierHost = {
      sendMessage: () => {},
      hasRunningBackground: () => true,
      isIdle: () => true,
    };
    const notifier = createNotifier(host);
    notifier.notify(notifyRecord("u3-merge-1", { result: "r1" }));
    notifier.notify(notifyRecord("u3-merge-2", { result: "r2" }));

    // 两条都带 merge:true 进端口（攒批成员——窗口内不注入的合成时机由端口承载）
    expect(fake.envelopes).toHaveLength(2);
    expect(fake.envelopes[0]!.opts).toEqual({ merge: true, collectKey: ["u3-merge-1"] });
    expect(fake.envelopes[1]!.opts).toEqual({ merge: true, collectKey: ["u3-merge-2"] });

    // flushPendingNotifications → 端口 flush（窗口缓冲提前出站）
    notifier.flushPendingNotifications();
    expect(fake.flush).toHaveBeenCalledTimes(1);
    notifier.dispose();
  });
});
