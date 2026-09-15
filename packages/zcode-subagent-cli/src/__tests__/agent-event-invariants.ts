// agent-event-invariants.ts —— AgentEvent 产出不变量断言器（conformance C3 的实现体）。
//
// 设计权威源：docs/architecture/subagent-engine-abstraction.md §3.3.7「AgentEvent 产出
// 不变量」五条（全部引擎必须满足）。任何 adapter 的 conformance 套件（golden 回放层 /
// 合成样本）都经本断言器校验——负例守护（A12「套件有牙」）靠注入坏序列证明它转红。
//
// 为什么独立成模块（非内联在测试文件）：pi/zcode 两套 golden 回放 + 负例元测试共用
// 同一断言逻辑；断言规则漂移会同步影响所有引擎的 conformance，单点维护。

import type { AgentEvent, AgentUsage } from "@zhushanwen/subagent-engine-sdk";

/** 单条不变量违例。invariant 是规则编号（"1"/"2a"...），detail 是定位信息。 */
export interface InvariantFinding {
  invariant: string;
  detail: string;
}

/** 断言选项。granularity 决定不变量 3 走流式（byte 级拼接）还是 coarse 口径。 */
export interface InvariantOptions {
  granularity: "stream" | "coarse";
  /** 流式引擎的终态 content（不变量 3a：text_delta 拼接 === content，byte 级）。 */
  content?: string;
}

/** 五条不变量的纯校验（不 throw，返回违例清单——元测试要拿清单做反证）。 */
export function checkAgentEventInvariants(
  events: readonly AgentEvent[],
  opts: InvariantOptions,
): InvariantFinding[] {
  const findings: InvariantFinding[] = [];
  if (events.length === 0) {
    return [{ invariant: "0", detail: "事件序列为空——至少需要 turn_end 终态" }];
  }

  // 不变量 1：终态序唯一——最后一个非 error 事件必是 turn_end；message_end（若出现）
  // 必在其前（turn_end 之后不允许任何非 error 事件）
  const nonError = events.filter((e) => e.type !== "error");
  const last = nonError[nonError.length - 1];
  if (last === undefined || last.type !== "turn_end") {
    findings.push({
      invariant: "1",
      detail: `最后一个非 error 事件是 ${String(last?.type ?? "(none)")}，必须唯一且为 turn_end`,
    });
  }
  const lastTurnEndIdx = findLastIndex(events, (e) => e.type === "turn_end");
  if (lastTurnEndIdx >= 0) {
    for (let i = lastTurnEndIdx + 1; i < events.length; i++) {
      const ev = events[i];
      if (ev !== undefined && ev.type !== "error") {
        findings.push({ invariant: "1", detail: `turn_end 之后出现非 error 事件 ${ev.type}（idx ${i}）` });
      }
    }
  }
  const lastMessageEndIdx = findLastIndex(events, (e) => e.type === "message_end");
  if (lastMessageEndIdx >= 0 && lastTurnEndIdx >= 0 && lastMessageEndIdx > lastTurnEndIdx) {
    findings.push({ invariant: "1", detail: "message_end 出现在 turn_end 之后（必须在其前）" });
  }

  // 不变量 2：message_end.usage 出现时为完整 AgentUsage 形状——给不出完整 usage 时
  // 显式缺省整个字段，不给残缺对象（NaN/缺键 = 残缺）
  events.forEach((ev, idx) => {
    if (ev.type !== "message_end") return;
    if (ev.usage === undefined) return; // 显式缺省 = 合法
    if (!isCompleteUsage(ev.usage)) {
      findings.push({ invariant: "2", detail: `message_end(idx ${idx}).usage 残缺（四项 token 必须全为有限数）` });
    }
  });

  // 不变量 3a（流式）：全部 text_delta 拼接 === content（byte 级）
  if (opts.granularity === "stream") {
    if (opts.content === undefined) {
      findings.push({ invariant: "3a", detail: "流式口径必须提供 content 供拼接比对" });
    } else {
      const joined = events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta).join("");
      if (Buffer.from(joined, "utf8").toString("hex") !== Buffer.from(opts.content, "utf8").toString("hex")) {
        findings.push({ invariant: "3a", detail: "text_delta 拼接与 content 不一致（byte 级比对失败）" });
      }
    }
  } else {
    // 不变量 3b（coarse）：turn_end 前至少一个 message_end
    if (lastTurnEndIdx < 0 || !events.slice(0, lastTurnEndIdx).some((e) => e.type === "message_end")) {
      findings.push({ invariant: "3b", detail: "coarse 引擎 turn_end 前必须至少一个 message_end" });
    }
  }

  // 不变量 4：tool_start/tool_end 按名配对——终态前未配对的 tool_start 必须有配对
  // tool_end（isError 可）或后续 error 事件兜底
  const openTools: Array<{ toolName: string; idx: number }> = [];
  let errorSeen = false;
  events.forEach((ev, idx) => {
    if (ev.type === "error") {
      errorSeen = true;
      return;
    }
    if (ev.type === "tool_start") {
      openTools.push({ toolName: ev.toolName, idx });
      return;
    }
    if (ev.type === "tool_end") {
      const at = openTools.findIndex((t) => t.toolName === ev.toolName);
      if (at >= 0) openTools.splice(at, 1);
      return;
    }
  });
  for (const t of openTools) {
    if (!errorSeen) {
      findings.push({
        invariant: "4",
        detail: `tool_start(${t.toolName}, idx ${t.idx}) 终态前未配对（无 tool_end 也无 error 兜底）`,
      });
    }
  }

  return findings;
}

/** 断言形态（conformance 用例直接消费——违例 throw，测试转红）。 */
export function assertAgentEventInvariants(events: readonly AgentEvent[], opts: InvariantOptions): void {
  const findings = checkAgentEventInvariants(events, opts);
  if (findings.length > 0) {
    const lines = findings.map((f) => `  [不变量 ${f.invariant}] ${f.detail}`).join("\n");
    throw new Error(`AgentEvent 不变量违例（§3.3.7 五条）：\n${lines}`);
  }
}

/** AgentUsage 完整形状判定（四项 token 有限数；cost 可选）。 */
function isCompleteUsage(u: AgentUsage): boolean {
  return (
    Number.isFinite(u.input) && Number.isFinite(u.output) &&
    Number.isFinite(u.cacheRead) && Number.isFinite(u.cacheWrite)
  );
}

/** Array.prototype.findLastIndex 的 ES2022 前兼容（node 18+ 有原生，防御口径手写）。 */
function findLastIndex<T>(arr: readonly T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== undefined && pred(v)) return i;
  }
  return -1;
}
