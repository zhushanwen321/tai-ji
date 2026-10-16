// src/notify-delivery.ts — managed session 死亡通知的投递接入（unified-delivery 波 2：
// 投递路径切 pi 半区投递端口，getDeliveryPort 进程级槽消费，C-ext-06）。
//
// 投递形态（老能力映射 #6）：watch 上游不变，recordManagedNotify 投递路径切
// port.deliver（managed-session-notify 外部通道逐条不合批——port 批组隔离原生
// 承载，合批已在 watch-coordinator 微窗内重建批身份，D3 裁决4）。port 恒装配于
// base-tool-enhance session_start（P6 infrastructure 档必载），本域零装配义务
//（通知账本装配随波 2 账本退役删除——两套装配并存违背装配单一归属，§3.7）。
//
// 槽空降级（port 缺席：base-tool-enhance session_start 未跑 / bind 失败——装配异常
// 窗口，生产不可达常态）：warn 留痕 + false（STANDARDS §11.1 通知类接入点降级，
// 非静默吞）。缺席回退不建第二投递路径（unified-delivery §3.7：两套装配并存违背
// 装配单一归属——notifier 直发兜底属 notifier 自身形态，本域降级 = 放弃该条 +
// warn 修复信号）。

import { getDeliveryPort } from "@zhushanwen/pi-delivery-port";
import { getLogger } from "@zhushanwen/pi-extension-logger";
import { toErrorMessage } from "@zhushanwen/pi-ext-guards";

import {
	MANAGED_SESSION_NOTIFY_CUSTOM_TYPE,
	type ManagedNotifyDetails,
} from "./notify-content.ts";

const logger = getLogger("session-manager");

/**
 * 投递一条死亡通知（unified-delivery 波 2：port.deliver 主投——managed-session-notify
 * 外部通道逐条不合批）。
 *
 * port 缺席 → warn + false（降级登记，见文件头）。deliver swallowed = 幂等命中
 * （同 notifyId 已受理或已终局——重放/重复应答的重复提交），按已投递返回 true；
 * deliver rejected（persist-failed 等）→ warn + false（幂等键未登记，watch 重试
 * 合法）。
 */
export function recordManagedNotify(
	notifyId: string,
	content: string,
	details: ManagedNotifyDetails,
): boolean {
	const port = getDeliveryPort();
	if (!port) {
		logger.warn(
			"[session-manager] delivery port not bound — notification dropped (base-tool-enhance session_start 装配缺失；下次 session_start 重试装配)",
			{ notifyId },
		);
		return false;
	}
	try {
		const result = port.deliver({
			payload: {
				kind: "custom",
				customType: MANAGED_SESSION_NOTIFY_CUSTOM_TYPE,
				content,
				display: true,
				details,
			},
			id: notifyId,
		});
		if (result.kind === "rejected") {
			logger.warn("[session-manager] delivery port rejected notification (idempotency key not registered)", {
				notifyId,
				reason: result.reason,
			});
			return false;
		}
		return true;
	} catch (err) {
		// 写入异常（stale ctx / appendEntry 失败）按接入点降级：不拖垮 watch 应答编排
		//（unregister 照常），warn 留痕可归因
		logger.warn("[session-manager] notify delivery failed", {
			notifyId,
			error: toErrorMessage(err),
		});
		return false;
	}
}
