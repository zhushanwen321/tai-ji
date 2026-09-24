// src/notify-ledger.ts — notify-ledger（B-ledger）装配与 record 消费（notify-once D3 装配纪律①②④⑤）。
//
// canonical 消费面（D-10 领地补录后落地）：@zhushanwen/subagent-core 的
// getBoundNotifyLedger / bindNotifyLedgerHost——Symbol.for 进程级单例槽跨扩展 bundle
// 共享同一 ledger 实体（C-ext-06），本包不再持有任何槽镜像。
//
// 装配纪律（D3 五条）对照：
//   ① session_start 先查槽——有实例直接消费（避免无谓 dispose；与 subagent-workflow
//      并发双 bind 的收敛前提）；
//   ② 无实例 → bindNotifyLedgerHost(host).recoverFromSession() **成对**（bind 后必
//      recover，吸收 session 文件全部既有条目；G3 重启重放即 recoverFromSession 语义）；
//   ③ 双 bind 收敛：后 bind 者 dispose 前实例 + recover → 单实例全量态，前者的已落盘
//      条目无损（record 先 appendEntry 落盘后内存更新——notify-ledger-discipline 用例钉住）；
//      本包侧的对应义务 = 规则① 的「有实例不重 bind」（不制造无谓 dispose）；
//   ④ compactionCheck 同批接线（session_compact handler，P-B4 降级——
//      subagent-workflow 同款先例；两侧对同一槽实例重复调用为幂等 no-op）；
//   ⑤ 消费点恒经 getBoundNotifyLedger() 动态查槽，禁缓存实例引用——后 bind 方 dispose
//      旧实例后缓存引用的 record() 静默 return false 零日志，对半概率丢全部通知。
//
// 槽空降级（record 时点仍无实例：session_start 未跑 / bind 失败）：warn 留痕 + false
//（STANDARDS §11.1 通知类接入点降级，非静默吞）。

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  bindNotifyLedgerHost,
  getBoundNotifyLedger,
  type NotifyLedgerHost,
} from "@zhushanwen/subagent-core";
import { getLogger } from "@zhushanwen/pi-extension-logger";

import { MANAGED_SESSION_NOTIFY_CUSTOM_TYPE } from "./notify-content.ts";

const logger = getLogger("session-manager");

/**
 * 装配纪律 ①②（session_start 调用）：查槽 → 有实例直接消费；无实例 → bind + recover 成对。
 * host 形态与 subagent-workflow bindLedgerHostAndRecover 同构（同一槽的两处装配方，
 * host 接口一致才能互换消费）；装配失败不阻断 session_start（record 侧走槽空降级）。
 */
export function ensureLedgerBound(pi: ExtensionAPI, ctx: ExtensionContext): void {
  // ① 查槽：有实例直接消费（subagent-workflow 已绑的 fresh 实例不被无谓 dispose）
  if (getBoundNotifyLedger() !== undefined) return;
  try {
    const host: NotifyLedgerHost = {
      appendLedgerEntry: (customType, data) => {
        pi.appendEntry(customType, data);
      },
      readSessionEntries: () => ctx.sessionManager.getEntries(),
      isIdle: () => ctx.isIdle(),
      onAgentSettled: (handler) => {
        pi.on("agent_settled", handler);
      },
      sendDelivery: (message) => {
        // 单通道送达（D5）：courier 已在发送前二次复查 isIdle；非受理异常原样上抛，
        // 由 ledger attemptDeliver 既有 catch 走 settleRejected 留账重试语义
        pi.sendMessage(message, { triggerTurn: true });
      },
    };
    // ② bind + recover 成对（G3 重启重放 = recoverFromSession 既有语义）
    bindNotifyLedgerHost(host).recoverFromSession();
  } catch (err) {
    logger.warn("[session-manager] notify ledger bind failed (record degrades until next session_start)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 记账一条通知（B-ledger ① record，deliveryCustomType 走 managed-session-notify 外部通道，
 * 逐条投递不合批——合批已在 watch-coordinator 微窗内重建批身份，D3 裁决4）。
 * 装配纪律⑤：每次调用即到即读查槽，禁存实例引用；槽空 → warn 降级 + false。
 */
export function recordManagedNotify(
  notifyId: string,
  content: string,
  details: object,
): boolean {
  const ledger = getBoundNotifyLedger();
  if (!ledger) {
    logger.warn(
      "[session-manager] notify ledger not bound — notification dropped (ensureLedgerBound 未跑或 bind 失败；下次 session_start 重试装配)",
      { notifyId },
    );
    return false;
  }
  try {
    return ledger.record(notifyId, content, details, {
      deliveryCustomType: MANAGED_SESSION_NOTIFY_CUSTOM_TYPE,
    });
  } catch (err) {
    // 写入异常（stale ctx / appendEntry 失败）按接入点降级：不拖垮 watch 应答编排
    //（unregister 照常），warn 留痕可归因
    logger.warn("[session-manager] notify ledger record failed", {
      notifyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * compactionCheck 接线（装配纪律④，P-B4 降级——subagent-workflow session_compact 同款）：
 * 检测 ledger/ack entry 被 compaction 清除时按内存态补写（未清除即 0，幂等 no-op）。
 */
export function runLedgerCompactionCheck(): void {
  try {
    const rewritten = getBoundNotifyLedger()?.compactionCheck() ?? 0;
    if (rewritten > 0) {
      logger.warn(
        `[session-manager] notify ledger entries lost to compaction; rewrote ${rewritten} from memory`,
      );
    }
  } catch (err) {
    logger.warn("[session-manager] notify ledger compactionCheck failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
