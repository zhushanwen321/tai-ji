// src/__tests__/e2e-harness.ts
// E2E test harness for ask_user. Drives tool.execute() end-to-end with a
// REAL AskUserComponent and simulated key sequences — no mocking of internal
// state. Mocks only the Pi surface (registerTool, getAllTools, setActiveTools,
// ctx.ui.custom) since those are the only host-API touch points.

import { AskUserComponent } from "../component";
import factory from "../index";
import type { AskUserDetails, Question, Result } from "../types";
import { mockTui, stubTheme } from "./fixtures";

/** Subset of Pi that ask_user's factory touches. */
interface PiShape {
	activeTools: string[] | null;
	tool: unknown;
	registerTool(t: unknown): void;
	getAllTools(): { name: string }[];
	setActiveTools(names: string[]): void;
	// session_start handler（factory 注册透传 channel 用）；测试不覆盖透传，空实现。
	on(event: string, handler: (...args: unknown[]) => unknown): void;
}

export interface E2EApi {
	/** Most recent execute() result. Populated after getExecuted() resolves. */
	keys(seq: string[]): void;
	abort(): void;
	getExecuted(): Promise<AskUserDetails>;
	pi: { activeTools: string[] | null };
}

export interface E2EOptions {
	hasUI?: boolean;
	preAborted?: boolean;
}

export function makeE2E(questions: Question[], opts: E2EOptions = {}): E2EApi {
	const { hasUI = true, preAborted = false } = opts;
	const controller = new AbortController();
	if (preAborted) controller.abort();

	const pi: PiShape = {
		activeTools: null,
		tool: undefined,
		registerTool(t) {
			this.tool = t;
		},
		getAllTools() {
			return [{ name: "ask_user" }, { name: "read" }, { name: "bash" }];
		},
		setActiveTools(names) {
			this.activeTools = names;
		},
		on() {
			// no-op：session_start handler（透传 channel 注册），测试不覆盖
		},
	};

	factory(pi as never);

	type Tool = {
		execute(
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		): Promise<AskUserDetails>;
	};
	const tool = pi.tool as Tool;
	if (!tool) throw new Error("factory did not register a tool");

	let compRef: AskUserComponent | null = null;

	const execPromise = tool.execute(
		"id",
		{ questions },
		controller.signal,
		undefined,
		{
			mode: hasUI ? "tui" : "print",
			hasUI,
			signal: controller.signal,
			ui: {
				custom: <T = Result | null>(factoryFn: (...args: unknown[]) => unknown): Promise<T> =>
					new Promise<T>((resolve) => {
						const done = (r: T): void => resolve(r);
						compRef = factoryFn(mockTui, stubTheme, {}, done) as AskUserComponent;
					}),
			},
		},
	);

	return {
		keys: (seq) => {
			for (const k of seq) compRef?.handleInput(k);
		},
		abort: () => controller.abort(),
		getExecuted: () => execPromise,
		pi: { get activeTools() { return pi.activeTools; } },
	};
}
