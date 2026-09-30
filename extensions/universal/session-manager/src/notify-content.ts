// src/notify-content.ts — managed session 完成/死亡通知文案与 details 构造（notify-once D9/U4）。
//
// buildBackflowContent 迁入（U3 裁决：completion-backflow 废弃后 extension 是唯一消费方，
// extension 不能反向 import runtime 包）。形状保持现 backflow 文案：
//   Managed session "<label>" (<sid>) finished with status "<status>"[ (exit code: N)].[ (fulfills N request(s))]
//   Stderr: <tail 400 字截尾>        （stderr 非空时）
//   Full transcript: <sessionFilePath>（watch respond payload 已携该字段——u-protocol
//     d69583684；runtime 查得到即携、查不到不携，不携时整行省略语义不变）。
//
// label 两路径（U4）：正常路径 = 工具入参 label（create 入参 / send 经 labelCache 回填）；
// 重启收口腿 = pending:register 三键的 name。两条路径都汇入本函数的 params.label，
// deathSeq 后 kind 不再决定文案（D3 例外2 内容确定性）。

/** managed session 完成通知的送达 customType（D9）。与 packages/shared
 *  COMPLETE_NOTIFY_CUSTOM_TYPES 追加值、core extractNotifyRecords 分支字面量三处同值，
 *  改名需三处同步（shared 为渲染侧 SSOT，本包不能 import @taiji/shared——非依赖）。 */
export const MANAGED_SESSION_NOTIFY_CUSTOM_TYPE = "managed-session-notify";

/** stderr 摘要上限（截尾，迁移自 completion-backflow——诊断价值 > 完整性，防爆量撑爆文案） */
const STDERR_TAIL_LIMIT = 400;

export interface ManagedNotifyContentParams {
	/** 会话标签（两路径汇入点，见文件头） */
	label: string;
	/** 子会话 id（watch respond payload 回带） */
	sessionId: string;
	/** 通知状态（settle: completed/failed/stopped；death: exited/deleted） */
	status: string;
	/** 本批销账的债权笔数（D3 合批 fulfills N；0/undefined → 不出行；纯死亡通知无债权） */
	fulfills?: number;
	/** transcript 指针行数据源（watch respond payload.sessionFilePath——u-protocol d69583684；
	 *  runtime 查不到不携 → 缺席时整行省略） */
	sessionFilePath?: string;
	/** death 应答携带（D6 meta，exit 腿诊断通路复刻） */
	exitCode?: number | null;
	stderrTail?: string;
}

/**
 * 构造通知正文（对齐 notifier buildLlmContent 模式：label/status + 指针行）。
 * 纯函数，零 I/O——U6_UNIT 同族测试随迁（原 completion-backflow.test.ts 的纯函数组）。
 */
export function buildManagedNotifyContent(params: ManagedNotifyContentParams): string {
	const exitNote =
		params.exitCode !== undefined ? ` (exit code: ${params.exitCode ?? "null"})` : "";
	const fulfillsNote =
		params.fulfills !== undefined && params.fulfills > 0
			? ` (fulfills ${params.fulfills} request${params.fulfills === 1 ? "" : "s"})`
			: "";
	let content = `Managed session "${params.label}" (${params.sessionId}) finished with status "${params.status}"${exitNote}.${fulfillsNote}`;
	if (params.stderrTail && params.stderrTail.trim() !== "") {
		const tail =
			params.stderrTail.length > STDERR_TAIL_LIMIT
				? params.stderrTail.slice(-STDERR_TAIL_LIMIT)
				: params.stderrTail;
		content += `\nStderr: ${tail.trim()}`;
	}
	if (params.sessionFilePath) {
		content += `\nFull transcript: ${params.sessionFilePath}`;
	}
	return content;
}

/**
 * record 的投递 details（ledger record 第三参）——core `extractNotifyRecords`
 * 的 `managed-session-notify` 分支读 `notifyId`（去重键）与 `reason`（outcome 映射
 * completed→success / failed→failed / 其余 neutral，D9）。其余字段为诊断冗余。
 */
export interface ManagedNotifyDetails {
	/** 本批 record 的幂等键 = 批内首个响应的 notifyId（≤1 record/批由合批边界保证） */
	notifyId: string;
	sessionId: string;
	reason: string;
	/** 批内销账笔数（runtime fulfillsN 直供，缺省回退批长——见 watch-coordinator） */
	fulfills: number;
	label: string;
}
