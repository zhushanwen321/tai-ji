/**
 * cw 子进程执行抽象。
 *
 * 设计为可注入（CwSpawner），使核心逻辑（cw-runner.ts）可在测试中用 fake
 * spawner 替换，避免真调 cw。默认实现 {@link defaultCwSpawner} 走 child_process。
 *
 * cw 路径解析：spawn 裸命令名 `cw`，由 OS execvp 语义在 `process.env.PATH` 中
 * 查找（架构约定 #16：禁止写死绝对路径）。env 继承自 process.env，确保 PATH 可用。
 *
 * [worktree-reaper-fix] cwd 可能已被 orphan reaper 清理（pi-subagent-workflow 误删活
 * worktree 后子进程 cwd 指向虚空）。Node spawn 对不存在的 cwd 报 ENOENT，错误消息只含
 * command 名（"cw"）不含 cwd——2026-08-11 事故中导致 AI 误诊"node 被卸载"。故 spawn 前
 * 检查 cwd 存在性，失败时返回可操作错误（含完整 cwd + 恢复指引）。
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import { isEnoentError } from "@zhushanwen/pi-ext-guards";

/**
 * cwd 不存在时的可操作错误文案（错误 → 权威源 worktrees.json → 重试闭环）。
 * @param cwd 不存在的路径
 */
function cwdMissingError(cwd: string): string {
	return [
		`cwd 不存在：${cwd}`,
		"该 worktree 可能已被 orphan reaper 清理，或子 agent 已结束。",
		"恢复：1) 检查 pi agent 目录下 subagents/worktrees.json 中该 branch 的 pid 是否已补全；",
		"      2) 若子 agent 仍在运行，重新派发（worktree 重建）；3) 若已结束，忽略此错误。",
	].join("\n");
}

/** cw 子进程执行结果。 */
export interface CwSpawnResult {
	/** stdout 内容（cw action 通常把结果 JSON 输出到 stdout）。 */
	stdout: string;
	/** stderr 内容（cw 的错误/诊断信息）。 */
	stderr: string;
	/** 进程退出码；null 表示被信号终止未产出退出码（视为异常）。 */
	exitCode: number | null;
}

/**
 * spawn cw 的可注入抽象。
 *
 * @param args   传给 cw 的参数（不含 `cw` 本身，由实现补上）。
 * @param input  要写入子进程 stdin 的内容；undefined 表示不写（cw 不读 stdin）。
 * @param cwd    子进程工作目录。
 * @param signal 可选 abort signal；实现应在 abort 时 kill 子进程（见 defaultCwSpawner），
 *               避免 abort 后僵尸 cw 子进程继续运行（executeCwAction 把 SDK signal +
 *               超时合并为此 signal 传入）。
 */
export type CwSpawner = (
	args: string[],
	input: string | undefined,
	cwd: string,
	signal?: AbortSignal,
) => Promise<CwSpawnResult>;

/**
 * 默认 cw spawner：用 child_process.spawn 执行 PATH 中的 `cw`。
 *
 * - stdout/stderr 设 utf8 编码后全量捕获（data 回调收 string，无需 Buffer 处理）。
 * - input（若提供）写入 stdin 后关闭；未提供则直接 end（cw 不阻塞等待 stdin）。
 * - spawn 自身失败（如 cw 不在 PATH）走 'error' 事件，拼进 stderr、exitCode=-1 标记异常。
 * - signal abort 时 kill 子进程（SIGTERM），避免 abort 后僵尸 cw 继续运行；
 *   signal 进入时已 aborted 则立即 kill。listener 在 settle 时移除防泄漏。
 */
export const defaultCwSpawner: CwSpawner = (args, input, cwd, signal) =>
	new Promise<CwSpawnResult>((resolve) => {
		// [worktree-reaper-fix] spawn 前检查 cwd 存在性（TOCTOU 兜底见下方 error handler）。
		// 与现有 error 路径返回形态一致：resolve + exitCode=-1 + stderr，不 reject。
		if (!existsSync(cwd)) {
			resolve({ stdout: "", stderr: cwdMissingError(cwd), exitCode: -1 });
			return;
		}

		const child = spawn("cw", args, {
			cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		// abort → kill 子进程，防止已 abort 的调用仍留下运行中的 cw 子进程。
		const onAbort = (): void => {
			child.kill("SIGTERM");
		};
		if (signal) {
			if (signal.aborted) {
				child.kill("SIGTERM");
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		if (input !== undefined) {
			child.stdin.write(input, "utf8");
		}
		child.stdin.end();

		// error 与 close 可能先后触发；用 settled 守卫保证只 resolve 一次并清理 listener。
		let settled = false;
		const finish = (result: CwSpawnResult): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};

		child.on("error", (err: NodeJS.ErrnoException) => {
			// spawn 失败（cw 不在 PATH / 无执行权限 / TOCTOU：检查后 cwd 被删等）。
			// [worktree-reaper-fix] 拼 cwd 进错误消息：ENOENT 的 err.message 只有 command 名，
			// 无 cwd 线索会导致误诊（2026-08-11 事故 AI 误判"node 被卸载"）。
			// exitCode=-1 区分于正常退出码。
			const errCwd = isEnoentError(err) ? `\ncwd: ${cwd}` : "";
			const hint = isEnoentError(err) && !existsSync(cwd) ? `\n${cwdMissingError(cwd)}` : "";
			finish({ stdout, stderr: `${stderr}\n[spawn error] ${err.message}${errCwd}${hint}`, exitCode: -1 });
		});
		child.on("close", (code: number | null) => {
			finish({ stdout, stderr, exitCode: code });
		});
	});
