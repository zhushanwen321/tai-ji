// child-env.test.ts —— pi-subagent-cli C05 簇合并产物（round5-G）。
// 共同被测业务模块：`src/child-env.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/__tests__/identity-env.test.ts（7 用例，skip 0）
//   - src/__tests__/task-pi-env-shape.test.ts（4 用例，skip 0）

import { describe, expect, it } from 'vitest'
import { SUBAGENT_IDENTITY_ENV, buildEngineChildEnv, buildOutboundChildEnv, CONTROL_ENV_ROOT_SESSION_ID, CONTROL_ENV_SOCKET } from '@zhushanwen/subagent-engine-sdk'
import { applyIdentityEnvToChildEnv, buildChildEnv, type SpawnRunParams } from '../child-env.ts'
import { isRawMirrorActive, RAW_MIRROR_ENV_VAR } from '../raw-mirror.ts'

// ======== 来源：identity-env.test.ts ========
describe("identity-env", () => {
  const KEY = SUBAGENT_IDENTITY_ENV;

  const BASE_PARAMS = {
    recordId: "sa-child",
    agentName: "reviewer",
    task: "review this",
    cwd: "/repo/worktree",
  };

  describe("applyIdentityEnvToChildEnv（§2.7 身份 env 写回）", () => {
    it("run 参数侧：selfRecordId / agent / task / rootCwd 回落 spawn cwd", () => {
      const env: Record<string, string> = {};
      applyIdentityEnvToChildEnv(env, BASE_PARAMS, {});
      expect(env[KEY.selfRecordId]).toBe("sa-child");
      expect(env[KEY.agent]).toBe("reviewer");
      expect(env[KEY.task]).toBe("review this");
      // 引擎自身没有真 ROOT cwd → 回落本次 spawn cwd
      expect(env[KEY.rootCwd]).toBe("/repo/worktree");
      // 顶层（父进程无 DEPTH）→ 子进程深度 1
      expect(env[KEY.depth]).toBe("1");
      // 缺省 mode = background；无 fork 链、无 worktree、无父 record → 不写
      expect(env[KEY.mode]).toBe("background");
      expect(env[KEY.forkDepth]).toBeUndefined();
      expect(env[KEY.worktree]).toBeUndefined();
      expect(env[KEY.parentRecordId]).toBeUndefined();
      // startedAt / slug 引擎无从得知 → 不写（壳读者各自回落）
      expect(env[KEY.startedAt]).toBeUndefined();
      expect(env[KEY.slug]).toBeUndefined();
    });

    it("嵌套链贯穿：rootSessionId 参数优先、rootCwd 继承、depth+1、父 record 入位", () => {
      const env: Record<string, string> = {};
      applyIdentityEnvToChildEnv(
        env,
        { ...BASE_PARAMS, sessionRootId: "sess-run" },
        {
          [KEY.rootSessionId]: "sess-env",
          [KEY.rootCwd]: "/repo/root",
          [KEY.depth]: "2",
          [KEY.forkDepth]: "1",
          [KEY.selfRecordId]: "sa-parent",
          [KEY.mode]: "chat",
          [KEY.worktree]: "true",
        },
      );
      expect(env[KEY.rootSessionId]).toBe("sess-run");
      expect(env[KEY.rootCwd]).toBe("/repo/root");
      expect(env[KEY.depth]).toBe("3");
      expect(env[KEY.forkDepth]).toBe("1");
      expect(env[KEY.parentRecordId]).toBe("sa-parent");
      expect(env[KEY.mode]).toBe("chat");
      expect(env[KEY.worktree]).toBe("true");
    });

    it("rootSessionId 回落引擎 env；worktree 由 run 声明置位", () => {
      const env: Record<string, string> = {};
      applyIdentityEnvToChildEnv(env, { ...BASE_PARAMS, worktree: true }, { [KEY.rootSessionId]: "sess-env" });
      expect(env[KEY.rootSessionId]).toBe("sess-env");
      expect(env[KEY.worktree]).toBe("true");
    });

    it("[D4] record 身份信封在场：slug / startedAt / mode 三键由信封权威写入", () => {
      const env: Record<string, string> = {};
      applyIdentityEnvToChildEnv(
        env,
        { ...BASE_PARAMS, identity: { slug: "fix-bug-42", startedAt: 1_700_000_000_000, mode: "chat" } },
        // 父 env 的旧值不得覆盖信封（宿主派发值是权威）
        { [KEY.slug]: "stale-slug", [KEY.startedAt]: "1", [KEY.mode]: "background" },
      );
      expect(env[KEY.slug]).toBe("fix-bug-42");
      expect(env[KEY.startedAt]).toBe("1700000000000");
      expect(env[KEY.mode]).toBe("chat");
    });

    it("[D4] 信封部分在场：缺席键按既有继承/缺省语义回落（不写空串、不写 NaN）", () => {
      const env: Record<string, string> = {};
      applyIdentityEnvToChildEnv(
        env,
        { ...BASE_PARAMS, identity: { slug: "only-slug" } },
        { [KEY.startedAt]: "1700000000000" },
      );
      expect(env[KEY.slug]).toBe("only-slug");
      // startedAt 回落父 env；mode 无父值 → 缺省 background
      expect(env[KEY.startedAt]).toBe("1700000000000");
      expect(env[KEY.mode]).toBe("background");
      // 信封与父 env 都没有 → 不写该键（读者按可选回落）
      expect(env[KEY.slug]).toBe("only-slug");
    });

    it("[D4] 信封缺省：三键均不写（除非父 env 携带）——保持既有回落面", () => {
      const env: Record<string, string> = {};
      applyIdentityEnvToChildEnv(env, BASE_PARAMS, {});
      expect(env[KEY.slug]).toBeUndefined();
      expect(env[KEY.startedAt]).toBeUndefined();
      expect(env[KEY.mode]).toBe("background");
    });

    it("覆盖既有 env 值（deny 终态写回的语义：以本次 run 的事实为准）", () => {
      const env: Record<string, string> = { [KEY.selfRecordId]: "stale", [KEY.depth]: "9" };
      applyIdentityEnvToChildEnv(env, BASE_PARAMS, {});
      expect(env[KEY.selfRecordId]).toBe("sa-child");
      expect(env[KEY.depth]).toBe("1");
    });
  });
});

// ======== 来源：task-pi-env-shape.test.ts ========
describe("task-pi-env-shape", () => {
  const CONTROL_SOCKET = "/tmp/taiji-control.sock";

  const ROOT_SESSION_ID = "sess-root-1";

  /** 引擎进程 launch env 的形状（runtime buildEngineLaunchEnv 的等价两步：SDK 三层 +
 * 显式 L0 注入；raw mirror 在 buildEngineChildEnv 之后注入是设计 D6 的规定）。 */
  function engineLaunchEnvShape(): Record<string, string> {
    const env = buildEngineChildEnv(
      {
        PATH: "/usr/bin",
        [CONTROL_ENV_SOCKET]: CONTROL_SOCKET,
        [CONTROL_ENV_ROOT_SESSION_ID]: ROOT_SESSION_ID,
      },
      { dataDir: "/tmp/engine-data" },
    );
    env[RAW_MIRROR_ENV_VAR] = "1";
    return env;
  }

  function baseParams(overrides: Partial<SpawnRunParams> = {}): SpawnRunParams {
    return {
      recordId: "sa-task-pi",
      task: "do the thing",
      agentName: "impl-worker",
      model: "prov/model-1",
      sessionDir: "/tmp/sessions",
      cwd: "/repo/worktree",
      ...overrides,
    };
  }

  describe("[P-15] task pi env 形状（raw mirror 只给引擎）", () => {
    it("引擎 env 有 raw mirror 宣告（引擎是唯一合法读取方）", () => {
      const engineEnv = engineLaunchEnvShape();
      expect(engineEnv[RAW_MIRROR_ENV_VAR]).toBe("1");
      expect(isRawMirrorActive(engineEnv)).toBe(true);
    });

    it("task pi（顶层）从引擎 env 出站：无 raw mirror、有 control 两键", () => {
      const engineEnv = engineLaunchEnvShape();
      const taskEnv = buildChildEnv(baseParams(), engineEnv);

      expect(taskEnv[RAW_MIRROR_ENV_VAR]).toBeUndefined();
      expect(isRawMirrorActive(taskEnv)).toBe(false);
      // 设计 D4：control 两键供 task pi 内的嵌套 extension 读取（不剥）
      expect(taskEnv[CONTROL_ENV_SOCKET]).toBe(CONTROL_SOCKET);
      expect(taskEnv[CONTROL_ENV_ROOT_SESSION_ID]).toBe(ROOT_SESSION_ID);
    });

    it("嵌套 task pi（父为引擎 spawn 的 task pi）：同样剥除，身份链继续贯穿", () => {
      const engineEnv = engineLaunchEnvShape();
      const parentTaskEnv = buildChildEnv(baseParams(), engineEnv);
      // 模拟嵌套：父 task pi 作为下一跳的 parentEnv（深度已由身份写回置 1）
      const nestedEnv = buildChildEnv(baseParams({ recordId: "sa-nested" }), parentTaskEnv);

      expect(nestedEnv[RAW_MIRROR_ENV_VAR]).toBeUndefined();
      expect(nestedEnv[CONTROL_ENV_SOCKET]).toBe(CONTROL_SOCKET);
      expect(nestedEnv[SUBAGENT_IDENTITY_ENV.selfRecordId]).toBe("sa-nested");
      expect(nestedEnv[SUBAGENT_IDENTITY_ENV.depth]).toBe("2");
    });

    it("承重性：SDK buildOutboundChildEnv 单独调用会保留 raw mirror（deny 清单不含该键）", () => {
      // 这条断言锁定「显式 delete 不可删」的事实前提：若未来 SDK deny 加键或 runtime
      // 改写注入方式，本用例翻转会提示同批核对设计 D4/D6 与这里的三方契约。
      const inherited = buildOutboundChildEnv({ parentEnv: engineLaunchEnvShape() });
      expect(inherited[RAW_MIRROR_ENV_VAR]).toBe("1");
    });
  });
});
