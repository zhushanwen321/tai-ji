// static-spawn-guard.test.ts —— W10 静态断言「任务子进程 spawn 必经 SDK
// spawnEngineChild」的 CI 挂载点（vitest 内执行 scripts/check-engine-spawn-guard.mjs，
// 不依赖 W9 的 workflows 领地；进 CI invariants job 的落点与 W9 协调——本地经本
// 测试即恒绿门）。
//
// 正例：两引擎包 src 干净 + 存在 spawnEngineChild 消费点（防空转）。
// 负例：临时 root 内放置直接 spawn 的源文件 → 脚本必须红（守卫有牙，A12 同款
// 负例自证）。
//
// 与 C-proc-09（check_spawn_env_boundary.py）分工互不代偿：C-proc-09 盖 spawn 点
// env 出站卫生（全仓），本守卫盖引擎包 spawn 单一入口（形态 + stdin fd 不外泄）。

import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const GUARD = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../scripts/check-engine-spawn-guard.mjs",
);

let tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  tmpRoots = [];
});

describe("静态断言：引擎包任务子进程必经 spawnEngineChild", () => {
  it("正例：两引擎包 src 干净且存在 spawnEngineChild 消费点", async () => {
    const { stdout } = await execFileAsync("node", [GUARD]);
    expect(stdout).toContain("[engine-spawn-guard] PASS");
    expect(stdout).toMatch(/spawnEngineChild/);
  });

  it("负例：直接 spawn 的源文件必须被检出（守卫有牙）", async () => {
    const root = mkdtempSync(join(tmpdir(), "spawn-guard-neg-"));
    tmpRoots.push(root);
    mkdirSync(join(root, "__tests__"), { recursive: true });
    // __tests__ 排除面（测试文件可用 child_process mock）——放一个不触发的样本
    writeFileSync(join(root, "__tests__", "mock.test.ts"), 'import { spawn } from "node:child_process";\n');
    // src 直陈违规：直接 spawn（未走 SDK spawnEngineChild）
    mkdirSync(join(root, "engine"), { recursive: true });
    writeFileSync(
      join(root, "engine", "bypass.ts"),
      'import { spawn } from "node:child_process";\nexport const p = spawn("ls");\n',
    );
    await expect(execFileAsync("node", [GUARD, "--roots", root])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("spawn"),
    });
  });
});
