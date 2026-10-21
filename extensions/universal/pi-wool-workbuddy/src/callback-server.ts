// callback-server.ts — WorkBuddy OAuth 本机回调监听（授权期临时通道）。
//
// 桥接裁决（设计 D3 形态 × 上游 state 轮询协议）：上游 OAuth 无 redirect_uri，
// 「回调送达」= taiji 浮层 → 扩展的本机信号通道：
//   GET http://127.0.0.1:<port>/wool-auth/callback?state=<state>&status=done|cancel
// - done → 扩展执行一次令牌交换；成功即完成登录；未完成（上游 code 11217 pending）
//   → 回 202 等待页，浮层可再次发 done 重试（事件驱动，无轮询、无定时兜底）
// - cancel → 完成取消终态
// 生命周期纪律（时间平抑红线）：仅授权期存活，完成/取消/失败/abort 即回收监听——
// 全事件驱动，零定时器。形态参照 pi-ai dist/auth/oauth/callback-server.js 实装
// （pi-ai exports 不含 ./auth/*，扩展不可直接 import，等价实装）。

import { createServer, type Server } from "node:http";

import {
	CALLBACK_HOST,
	CALLBACK_PATH,
	HTTP_ACCEPTED,
	HTTP_BAD_GATEWAY,
	HTTP_BAD_REQUEST,
	HTTP_CONFLICT,
	HTTP_NOT_FOUND,
	HTTP_OK,
} from "./constants.ts";

/** 回调信号处理结果：completed=true 流程完成（监听回收）；false 等待下一次 done。 */
export type CallbackDoneResult = {
	completed: boolean;
	/** 浮层页面文案（成功/等待提示）。 */
	pageMessage: string;
};

/** wait() 的终态：浮层/外部取消，或经 done 信号完成。 */
export type WoolCallbackOutcome = { type: "cancelled"; reason: string } | { type: "done" };

export type WoolAuthCallbackServer = {
	/** 浮层可达的回调端点（含实际绑定端口）。 */
	callbackUrl: string;
	/** 授权窗口终态（cancelled / done）。 */
	wait(): Promise<WoolCallbackOutcome>;
	/** 外部主动取消（未完成时以 cancelled 终态回收）。 */
	cancel(reason?: string): void;
	/** 强制回收（登录流程异常退出时；wait 以 cancelled reject 语义 settle）。 */
	close(): void;
};

export type WoolAuthCallbackOptions = {
	state: string;
	/** done 信号处理（令牌交换尝试）；可多次调用直到 completed。 */
	onDone: () => Promise<CallbackDoneResult>;
	signal?: AbortSignal;
};

function htmlPage(title: string, detail: string): string {
	const escape = (text: string): string =>
		text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return [
		"<!doctype html><html><head><meta charset=\"utf-8\">",
		`<title>${escape(title)}</title>`,
		"<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6}</style>",
		"</head><body>",
		`<h1>${escape(title)}</h1><p>${escape(detail)}</p>`,
		"</body></html>",
	].join("");
}

function sendPage(response: {
	writeHead(status: number, headers: Record<string, string>): void;
	end(body: string): void;
}, status: number, title: string, detail: string): void {
	response.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(htmlPage(title, detail));
}

/**
 * 起回调监听（127.0.0.1 + 系统分配端口）。resolve 时监听已建立；
 * 完成终态后监听自动回收（server.close），无需调用方再关。
 */
export function startWoolAuthCallbackServer(options: WoolAuthCallbackOptions): Promise<WoolAuthCallbackServer> {
	const { state, onDone, signal } = options;
	if (signal?.aborted) {
		return Promise.reject(new DOMException("Login cancelled", "AbortError"));
	}

	let settled = false;
	let resolveWait: (outcome: WoolCallbackOutcome) => void = () => undefined;
	const waitPromise = new Promise<WoolCallbackOutcome>((resolve) => {
		resolveWait = resolve;
	});
	// 无人消费的 reject 不发生（本实现 wait 只 resolve）；防 unhandled rejection 惯例挂底。
	waitPromise.catch(() => undefined);

	const server: Server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", `http://${CALLBACK_HOST}`);
			if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
				sendPage(response, HTTP_NOT_FOUND, "Not found", "Unknown callback route.");
				return;
			}
			if (url.searchParams.get("state") !== state) {
				sendPage(response, HTTP_BAD_REQUEST, "State mismatch", "This callback does not match the active authorization.");
				return;
			}
			const status = url.searchParams.get("status");
			if (settled) {
				sendPage(response, HTTP_CONFLICT, "Already handled", "This authorization window has finished.");
				return;
			}
			if (status === "cancel") {
				sendPage(response, HTTP_OK, "Authorization cancelled", "The WorkBuddy authorization was cancelled. You may close this page.");
				finish({ type: "cancelled", reason: "overlay cancel signal" });
				return;
			}
			if (status !== "done") {
				sendPage(response, HTTP_BAD_REQUEST, "Bad callback", `Unsupported status "${status ?? ""}"; expected done or cancel.`);
				return;
			}
			try {
				const result = await onDone();
				if (settled) {
					return; // 等待交换期间已被并发终态（abort/取消）——丢弃本次结果
				}
				if (result.completed) {
					sendPage(response, HTTP_OK, "Signed in to WorkBuddy", result.pageMessage);
					finish({ type: "done" });
				} else {
					sendPage(response, HTTP_ACCEPTED, "Authorization not finished yet", result.pageMessage);
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				sendPage(response, HTTP_BAD_GATEWAY, "Sign-in failed", `${detail} Start the authorization again from taiji.`);
				finish({ type: "cancelled", reason: `token exchange failed: ${detail}` });
			}
		})();
	});

	// 终态唯一入口（幂等）：settled 置位 + 摘除 abort 监听 + 回收监听 + settle wait。
	const finish = (outcome: WoolCallbackOutcome): void => {
		if (settled) {
			return;
		}
		settled = true;
		signal?.removeEventListener("abort", onAbort);
		server.close();
		resolveWait(outcome);
	};

	const onAbort = (): void => {
		finish({ type: "cancelled", reason: "aborted" });
	};

	return new Promise<WoolAuthCallbackServer>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, CALLBACK_HOST, () => {
			server.off("error", reject);
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("WorkBuddy OAuth callback server did not bind to TCP"));
				return;
			}
			server.on("error", () => {
				// 绑定后期的 socket 错误（端口失守等）按取消终态回收，不悬挂授权窗口。
				finish({ type: "cancelled", reason: "callback server error" });
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			resolve({
				callbackUrl: `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`,
				wait: () => waitPromise,
				cancel(reason = "cancelled by caller") {
					if (!settled) {
						finish({ type: "cancelled", reason });
					}
				},
				close() {
					finish({ type: "cancelled", reason: "callback server closed" });
				},
			});
		});
	});
}
