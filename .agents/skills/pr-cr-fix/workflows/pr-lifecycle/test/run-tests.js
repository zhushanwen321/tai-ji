'use strict';
/*
 * pr-lifecycle lib.cjs 单测 runner（自写断言，非 node:test 框架）。
 *
 * 运行：node .agents/skills/pr-cr-fix/workflows/pr-lifecycle/test/run-tests.js（exit 非 0 = 失败）。
 * 依据 impl-plan 偏差 3：测试对象是 .agents/workflows/ 下独立 .cjs，不在任何
 * pnpm 子包内、无 vitest 配置可挂载，故用 mock io 依赖注入直跑。
 * 全部读写只发生在 os.tmpdir() 下 mkdtemp 自建目录，测试结束删除，不触真实数据目录。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require(path.join(__dirname, '..', 'lib.cjs'));

// 统一清理登记：所有 mkdtemp root 在 main 末尾 rmSync（对齐头注释「测试结束删除」）
const tempRoots = [];

/* ── runner 骨架 ─────────────────────────────────────────────────────── */

let passed = 0;
const failed = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed.push({ name, e });
    console.error(`FAIL  ${name}`);
    console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`);
    if (e && e.actual !== undefined) {
      console.error(`      actual:   ${JSON.stringify(e.actual)}`);
      console.error(`      expected: ${JSON.stringify(e.expected)}`);
    }
  }
}

function assertIncludes(hay, needle, msg) {
  assert.ok(
    String(hay).includes(needle),
    msg || `期望包含「${needle}」，实际：「${String(hay).slice(0, 400)}」`,
  );
}

/* ── mock io 工厂 ────────────────────────────────────────────────────── */

function stateDirOf(root) {
  return path.join(root, '.review', 'pr-workflow');
}

const RUN_ID_A = 'prw-20260901-090000-aaaa';

/**
 * 构造 mock io：temp repoRoot + 可编程 git 快照 + 引擎 state 映射 + pid 映射。
 * opts: { args, steps, head, branch, base, baseHash, porcelain, engineMap, pidMap,
 *         failBase, commits, stat, names, scriptMocks: { <脚本路径>: 响应|fn(args) },
 *         agent: async (params) => ({ value, error }) }
 */
function makeIo(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prl-u1-'));
  tempRoots.push(root);
  const base = opts.base || 'main';
  const git = {
    head: opts.head || 'H1',
    branch: opts.branch || 'feat-x',
    baseHash: opts.baseHash || 'B1',
    porcelain: opts.porcelain || '',
    commits: opts.commits !== undefined ? opts.commits : 'feat: a commit\n\nbody line\n---\n',
    stat: opts.stat !== undefined ? opts.stat : ' a.js | 2 +-\n',
    names: opts.names !== undefined ? opts.names : 'src/a.js\n',
  };
  const engineMap = Object.assign({ 'wf-old': 'done' }, opts.engineMap);
  const pidMap = Object.assign({}, opts.pidMap);
  const scriptMocks = opts.scriptMocks || {};
  const agentCalls = [];
  const workflowCalls = [];
  const recorded = { sh: [], logs: [], renames: [], renameContents: [] };

  const sh = (cmd, args) => {
    recorded.sh.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === 'rev-parse') {
      if (args[1] === '--show-toplevel') {
        if (opts.failToplevel) return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
        return { code: 0, stdout: `${opts.toplevelOverride || root}\n` };
      }
      if (args[1] === '--abbrev-ref' && args[2] === 'HEAD') return { code: 0, stdout: `${git.branch}\n` };
      if (args[1] === 'HEAD') return { code: 0, stdout: `${git.head}\n` };
      if (args[1] === `${base}^{commit}`) {
        if (opts.failBase) return { code: 128, stdout: '', stderr: `fatal: ambiguous argument '${base}^{commit}'` };
        return { code: 0, stdout: `${git.baseHash}\n` };
      }
    }
    if (cmd === 'git' && args[0] === 'status' && args[1] === '--porcelain') {
      return { code: 0, stdout: git.porcelain };
    }
    if (cmd === 'git' && args[0] === 'log' && args[1] === `${git.baseHash}..HEAD`) {
      return { code: 0, stdout: git.commits };
    }
    if (cmd === 'git' && args[0] === 'diff' && args[1] === `${git.baseHash}..HEAD`) {
      if (args[2] === '--stat') return { code: 0, stdout: git.stat };
      if (args[2] === '--name-only') return { code: 0, stdout: git.names };
      return { code: 0, stdout: git.stat };
    }
    // gh / fallow 等外部命令按名 mock（preflight 用）
    if (opts.cmdResults && Object.prototype.hasOwnProperty.call(opts.cmdResults, cmd)) {
      const m = opts.cmdResults[cmd];
      return typeof m === 'function' ? m(args) : m;
    }
    // u2/u3 脚本 mock 分发（按 argv[0] = 脚本路径；假脚本经此注入，不需要真实文件）
    if ((cmd === 'bash' || cmd === 'python3' || cmd === 'node')
      && Object.prototype.hasOwnProperty.call(scriptMocks, args[0])) {
      const m = scriptMocks[args[0]];
      return typeof m === 'function' ? m(args) : m;
    }
    // which pi 默认命中（pi-fixture 预检的 binary 探测；cmdResults.which 可覆盖）
    if (cmd === 'which') return { code: 0, stdout: '/usr/local/bin/pi\n' };
    return { code: 0, stdout: '' };
  };

  // 包装真实 fs：写序列可观测（原子写断言），读写只落 temp root
  const fsWrap = {
    existsSync: fs.existsSync.bind(fs),
    mkdirSync: fs.mkdirSync.bind(fs),
    readFileSync: fs.readFileSync.bind(fs),
    writeFileSync: fs.writeFileSync.bind(fs),
    unlinkSync: fs.unlinkSync.bind(fs),
    openSync: fs.openSync.bind(fs),
    writeSync: fs.writeSync.bind(fs),
    closeSync: fs.closeSync.bind(fs),
    readdirSync: fs.readdirSync.bind(fs),
    realpathSync: fs.realpathSync.bind(fs),
    renameSync: (a, b) => {
      recorded.renames.push([String(a), String(b)]);
      try {
        recorded.renameContents.push(fs.readFileSync(a, 'utf8'));
      } catch {
        recorded.renameContents.push(null);
      }
      fs.renameSync(a, b);
    },
  };

  const io = {
    args: opts.args !== undefined ? opts.args : {},
    repoRoot: root,
    pid: 4242,
    fs: fsWrap,
    sh,
    env: opts.env || {},
    homedir: opts.homedir || (() => '/home/fake-home'),
    // agent mock：记录调用并按 opts.agent 编程；默认成功——simplify 调用会写报告文件并返回计数
    agent: async (params) => {
      agentCalls.push(params);
      const impl = opts.agent || (async (p2) => {
        const m = String(p2 && p2.prompt).match(/报告输出路径 = (\S+)/);
        if (m) {
          fs.mkdirSync(path.dirname(m[1]), { recursive: true });
          fs.writeFileSync(m[1], '# simplify report\n');
          return { value: { applied: 0, proposals: 1 }, error: null };
        }
        return { value: {}, error: null };
      });
      return impl(params);
    },
    // nested workflow mock（u4 cr-fix 经此注入点；默认返回 clean 终态，runDir 为不存在路径）
    workflow: async (name, params) => {
      workflowCalls.push({ name, params });
      const impl = opts.workflow || (async () => ({
        content: '',
        parsedOutput: { terminated: 'clean', runDir: path.join(root, '.review-fix-loop', 'wf-mock'), batches: 1, totalFixed: 2, message: 'ok' },
      }));
      return impl(name, params);
    },
    readEngineState: (er) => (er && Object.prototype.hasOwnProperty.call(engineMap, er)
      ? { ok: true, status: engineMap[er] }
      : { ok: false, reason: `engine state file not found: ${er}` }),
    probePid: (pid) => (Object.prototype.hasOwnProperty.call(pidMap, pid) ? pidMap[pid] : 'dead'),
    log: (...m) => recorded.logs.push(m.join(' ')),
    now: () => new Date('2026-09-03T10:00:00'),
    randomToken: () => 'ab12',
    steps: opts.steps || [],
  };
  // 预置产物文件（coverage.json / metrics.json / constraints.md 等 step 读取的落盘产物）
  for (const [rel, content] of Object.entries(opts.presetFiles || {})) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return { io, root, recorded, git, engineMap, pidMap, agentCalls, workflowCalls };
}

// u2/u3：steps 注册表（脚本路径全部注入假路径，脚本行为经 scriptMocks 编程）
const FAKE_PATHS = {
  preMerge: '/fake/pr-pre-merge.sh',
  prSubmit: '/fake/pr-submit.sh',
  validateSkillYaml: '/fake/validate-skill-yaml.py',
  selectConstraints: '/fake/select-constraints.mjs',
  coverageGate: '/fake/coverage-gate.py',
  metricsGate: '/fake/metrics-gate.py',
};

function makeSteps(opts = {}) {
  const steps = lib.createPrSteps({ repoRoot: opts.root, scriptPaths: FAKE_PATHS });
  return opts.range ? steps.slice(opts.range[0], opts.range[1]) : steps;
}

// 注册表下标（§3.3 顺序）：0 preflight … 5 pr-submit | 6 constraints 7 coverage-1
// 8 metrics-1 9 cr-fix(u4) 10 simplify(u5) 11 final-gates
const STEP_RANGE = { prOnly: [0, 6], gates: [6] };

/** 手工构造一个 resume 前置 state（绕过 fresh 链路，独立驱动守卫分支） */
function seedState(root, overrides = {}) {
  const state = Object.assign({
    stateVersion: 1,
    runId: RUN_ID_A,
    repo: root,
    branch: 'feat-x',
    base: 'main',
    baseHash: 'B1',
    pid: 111,
    engineRunId: 'wf-old',
    params: {
      runId: RUN_ID_A,
      base: 'main',
      reviewers: null,
      maxRounds: 10,
      simplifyMode: 'apply',
      skipSteps: [],
      allowExternalChanges: false,
    },
    status: 'running',
    failedStep: null,
    error: null,
    lastHead: 'H1',
    result: null,
    steps: {},
  }, overrides);
  const dir = path.join(stateDirOf(root), state.runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  return state;
}

function readStateFile(root, runId) {
  return JSON.parse(fs.readFileSync(path.join(stateDirOf(root), runId, 'state.json'), 'utf8'));
}

const mkStep = (id, runs) => ({
  id,
  run: async () => {
    runs.push(id);
    return { v: id };
  },
});

/* ── 单元级：schema / runId / 参数归一 / sh 工厂 / 文案 ───────────────── */

async function main() {
  await test('state schema：createState 顶层字段与 §3.4-(2) 逐字段一致（不多不少）', () => {
    const state = lib.createState({
      runId: 'r', repo: '/r', branch: 'b', base: 'main', baseHash: 'h',
      pid: 1, engineRunId: 'wf-1', params: {}, head: 'H',
    });
    assert.deepStrictEqual(Object.keys(state), lib.STATE_FIELDS);
    assert.deepStrictEqual(lib.STATE_FIELDS, [
      'stateVersion', 'runId', 'repo', 'branch', 'base', 'baseHash', 'pid',
      'engineRunId', 'params', 'status', 'failedStep', 'error', 'lastHead',
      'result', 'steps',
    ]);
    assert.strictEqual(state.stateVersion, 1);
    assert.strictEqual(state.status, 'running');
    assert.strictEqual(state.failedStep, null);
    assert.strictEqual(state.error, null);
    assert.strictEqual(state.result, null);
    assert.deepStrictEqual(state.steps, {});
  });

  await test('runId 格式：prw-<yyyymmdd>-<HHMMSS>-<rand4>', () => {
    const id = lib.makeRunId(() => new Date('2026-09-03T10:00:00'), () => 'ab12');
    assert.strictEqual(id, 'prw-20260903-100000-ab12');
    assert.ok(lib.isValidRunId(id));
    assert.ok(!lib.isValidRunId('prw-20260903-100000-AB12')); // rand4 仅小写字母数字
    assert.ok(!lib.isValidRunId('wf-20260903-100000-ab12'));
  });

  await test('参数归一：CLI 字符串形态解析 + 默认值填充 + 非法值 fail-fast', () => {
    const p = lib.normalizeParams({
      base: 'dev', maxRounds: '5', skipSteps: 'a, b',
      allowExternalChanges: 'true', simplifyMode: 'report', reviewers: 'x.md,y.md',
    });
    assert.deepStrictEqual(p, {
      runId: null, repo: null, aggregatorModel: null, base: 'dev', reviewers: ['x.md', 'y.md'], maxRounds: 5,
      simplifyMode: 'report', skipSteps: ['a', 'b'], allowExternalChanges: true,
    });
    assert.strictEqual(lib.normalizeParams({ repo: '/abs/repo' }).repo, '/abs/repo');
    const dflt = lib.normalizeParams({});
    assert.strictEqual(dflt.base, 'main');
    assert.strictEqual(dflt.maxRounds, 10);
    assert.strictEqual(dflt.simplifyMode, 'apply');
    assert.deepStrictEqual(dflt.skipSteps, []);
    assert.strictEqual(dflt.allowExternalChanges, false);
    assert.throws(() => lib.normalizeParams({ maxRounds: 'abc' }), /参数 maxRounds 非法/);
    assert.throws(() => lib.normalizeParams({ simplifyMode: 'nope' }), /参数 simplifyMode 非法/);
    // JSON 数组字符串形态
    assert.deepStrictEqual(lib.normalizeParams({ skipSteps: '["cr-fix","simplify"]' }).skipSteps, ['cr-fix', 'simplify']);
  });

  await test('sh 工厂：maxBuffer=64MB + 显式 cwd + 参数数组透传 + 失败归一不 throw（P4）', () => {
    const captured = [];
    const spyExec = (cmd, args, opts) => {
      captured.push({ cmd, args, opts });
      if (args[0] === 'fail') {
        const e = new Error('spawn fail');
        e.status = 42;
        e.stdout = 'partial-out';
        e.stderr = 'boom-err';
        throw e;
      }
      if (args[0] === 'enoent-marker') {
        const e = new Error('spawn git ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return 'out\n';
    };
    const sh = lib.createSh({ execFileSync: spyExec, defaultCwd: '/repo/root' });
    assert.deepStrictEqual(sh('git', ['status', '--porcelain']), { code: 0, stdout: 'out\n', stderr: '' });
    assert.strictEqual(captured[0].cmd, 'git');                       // 命令名独立（不经 shell 字符串）
    assert.deepStrictEqual(captured[0].args, ['status', '--porcelain']); // 参数数组
    assert.strictEqual(captured[0].opts.cwd, '/repo/root');           // 显式 cwd
    assert.strictEqual(captured[0].opts.maxBuffer, 64 * 1024 * 1024); // P4：≥64MB
    assert.strictEqual(captured[0].opts.encoding, 'utf8');
    const failRes = sh('git', ['fail']);
    assert.deepStrictEqual(failRes, { code: 42, stdout: 'partial-out', stderr: 'boom-err' });
    assert.strictEqual(sh('git', ['enoent-marker']).code, 127);
    // cwd 覆盖
    sh('git', ['x'], { cwd: '/other' });
    assert.strictEqual(captured[3].opts.cwd, '/other');
  });

  await test('resumeCommand 生成：zsw CLI 真形态（--workflow 绝对路径 / --runId），cli 解析失败降级占位', () => {
    const t = makeIo({}); // homedir 指向无 zsw 的 fake-home → 占位降级
    const withRun = lib.resumeCommand(t.io, '/abs/repo', 'prw-20260903-100000-ab12');
    assert.ok(withRun.includes(`--workflow /abs/repo/.agents/skills/pr-cr-fix/workflows/pr-lifecycle.js`), withRun);
    assert.ok(withRun.includes('--workdir /abs/repo'), withRun);
    assert.ok(withRun.includes('--repo /abs/repo'), `workdir 是保留键，恢复命令必须带 --repo：${withRun}`);
    assert.ok(withRun.includes('--runId prw-20260903-100000-ab12'), withRun);
    assert.ok(withRun.startsWith('node '), withRun);
    assert.ok(withRun.includes('<zsw-cli>（占位'), `cli 缺失应降级占位：${withRun}`);
    const fresh = lib.resumeCommand(t.io, '/abs/repo', null);
    assert.ok(fresh.includes('--workflow /abs/repo/.agents/skills/pr-cr-fix/workflows/pr-lifecycle.js') && !fresh.includes('--runId'), fresh);
    assert.ok(fresh.includes('--repo /abs/repo'), fresh);
  });

  await test('resolveZswCli：main worktree 候选优先；cache 多版本取数值最高且过滤 <1.2.0（1.0.0 旧契约跑不了 core 脚本）', () => {
    const t = makeIo({
      presetFiles: {
        'Code/zcode-plugin-workspace/main/z-subagent-workflow/bin/zsw.js': '// main\n',
        '.zcode/cli/plugins/cache/zcode-plugin-workspace/z-subagent-workflow/1.2.0/bin/zsw.js': '// old\n',
        '.zcode/cli/plugins/cache/zcode-plugin-workspace/z-subagent-workflow/1.10.0/bin/zsw.js': '// new\n',
        '.zcode/cli/plugins/cache/zcode-plugin-workspace/z-subagent-workflow/2.0.0-no-bin/placeholder': 'x',
      },
    });
    Object.defineProperty(t.io, 'homedir', { value: () => t.root });
    const resolved = lib.resolveZswCli(t.io);
    assert.strictEqual(resolved, path.join(t.root, 'Code', 'zcode-plugin-workspace', 'main', 'z-subagent-workflow', 'bin', 'zsw.js'));
    // 无 main 候选 → cache 数值最高且 ≥1.2.0
    const t1 = makeIo({
      presetFiles: {
        '.zcode/cli/plugins/cache/zcode-plugin-workspace/z-subagent-workflow/1.2.0/bin/zsw.js': '// old\n',
        '.zcode/cli/plugins/cache/zcode-plugin-workspace/z-subagent-workflow/1.10.0/bin/zsw.js': '// new\n',
        '.zcode/cli/plugins/cache/zcode-plugin-workspace/z-subagent-workflow/2.0.0-no-bin/placeholder': 'x',
      },
    });
    Object.defineProperty(t1.io, 'homedir', { value: () => t1.root });
    assert.strictEqual(
      lib.resolveZswCli(t1.io),
      path.join(t1.root, '.zcode', 'cli', 'plugins', 'cache', 'zcode-plugin-workspace', 'z-subagent-workflow', '1.10.0', 'bin', 'zsw.js'),
    );
    // cache 只有 1.0.0（旧契约，跑 core 脚本必失败）→ 过滤 → null（降级占位）
    const t2 = makeIo({
      presetFiles: { '.zcode/cli/plugins/cache/zcode-plugin-workspace/z-subagent-workflow/1.0.0/bin/zsw.js': '// legacy\n' },
    });
    Object.defineProperty(t2.io, 'homedir', { value: () => t2.root });
    assert.strictEqual(lib.resolveZswCli(t2.io), null);
    // 全空 → null
    const t3 = makeIo({});
    Object.defineProperty(t3.io, 'homedir', { value: () => path.join(t3.root, 'empty-home') });
    assert.strictEqual(lib.resolveZswCli(t3.io), null);
  });

  /* ── fresh 流程 ── */

  await test('fresh（空注册表）：直接到 awaiting-push 终态，latest/state/锁/engineRunId 全部落盘', async () => {
    const { io, root, recorded } = makeIo({ args: { _runId: 'wf-engine-1' } });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.ok(lib.isValidRunId(result.runId), `runId 格式：${result.runId}`);
    assert.strictEqual(result.runId, 'prw-20260903-100000-ab12');
    assert.strictEqual(result.prUrl, null);
    assert.strictEqual(result.terminated, null);
    assert.strictEqual(result.simplify, null);
    assert.deepStrictEqual(result.gates, { coverage: null, metrics: null, premerge: null });
    assert.deepStrictEqual(result.skippedSteps, []);
    // latest 指针 = runId 单行（暴毙兜底通道）
    assert.strictEqual(fs.readFileSync(path.join(stateDirOf(root), 'latest'), 'utf8'), `${result.runId}\n`);
    // state 落盘：status/engineRunId/params
    const state = readStateFile(root, result.runId);
    assert.strictEqual(state.status, 'awaiting-push');
    assert.strictEqual(state.engineRunId, 'wf-engine-1'); // fresh：engineRunId = 本次 $ARGS._runId
    assert.strictEqual(state.pid, 4242);
    assert.strictEqual(state.baseHash, 'B1');
    assert.strictEqual(state.branch, 'feat-x');
    assert.deepStrictEqual(state.result, result); // result 快照 = 返回值
    // 终态后锁删除
    assert.strictEqual(fs.existsSync(path.join(stateDirOf(root), 'lock')), false);
    // log 首行含 runId 与 resumeCommand（获取通道 3）
    assertIncludes(recorded.logs[0], `runId=${result.runId}`);
    assertIncludes(recorded.logs[0], `--workflow ${root}/.agents/skills/pr-cr-fix/workflows/pr-lifecycle.js`);
    assertIncludes(recorded.logs[0], `--runId ${result.runId}`);
  });

  await test('fresh 并发防护：latest 指向进行中 run 且记录 pid 存活 → fail-fast「已有进行中的 run」', async () => {
    const { io, root } = makeIo({ args: {}, engineMap: { 'wf-live': 'running' }, pidMap: { 999: 'alive' } });
    seedState(root, { runId: RUN_ID_A, engineRunId: 'wf-live', pid: 999, status: 'running' });
    fs.writeFileSync(path.join(stateDirOf(root), 'latest'), `${RUN_ID_A}\n`);
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.runId, RUN_ID_A); // result 指向在跑的 run（供主 agent abort/resume）
    assertIncludes(result.error, `已有进行中的 run ${RUN_ID_A}`);
    assertIncludes(result.error, 'abort');
    // 未新建任何 run 目录
    const entries = fs.readdirSync(stateDirOf(root)).filter((n) => n.startsWith('prw-'));
    assert.deepStrictEqual(entries, [RUN_ID_A]);
  });

  await test('fresh 并发防护：latest 指向已终态 run → 放行新建', async () => {
    const { io, root } = makeIo({ args: {} });
    seedState(root, { runId: RUN_ID_A, engineRunId: 'wf-old', status: 'awaiting-push' }); // wf-old = done
    fs.writeFileSync(path.join(stateDirOf(root), 'latest'), `${RUN_ID_A}\n`);
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.notStrictEqual(result.runId, RUN_ID_A);
  });

  await test('fresh：base 无法解析 → fail-fast 带 base 修复指引', async () => {
    const { io } = makeIo({ args: { base: 'nonexist' }, base: 'nonexist', failBase: true });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, 'base "nonexist" 无法解析');
  });

  /* ── 互斥锁 ── */

  await test('lockfile：EEXIST 且持锁 run 进行中 → fail-fast（活性复查拦截）', async () => {
    const { io, root } = makeIo({ args: {}, engineMap: { 'wf-live': 'running' }, pidMap: { 999: 'alive' } });
    fs.mkdirSync(stateDirOf(root), { recursive: true });
    fs.writeFileSync(path.join(stateDirOf(root), 'lock'), JSON.stringify({ runId: RUN_ID_A, pid: 999, engineRunId: 'wf-live' }));
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '仍在进行');
    assertIncludes(result.error, 'abort');
    // 锁未被误删（持锁者还活着）
    assert.strictEqual(fs.existsSync(path.join(stateDirOf(root), 'lock')), true);
  });

  await test('lockfile：EEXIST 且持锁 run 已终态 → 接管（删旧锁重建，流程完成）', async () => {
    const { io, root, recorded } = makeIo({ args: {} }); // wf-old = done
    fs.mkdirSync(stateDirOf(root), { recursive: true });
    fs.writeFileSync(path.join(stateDirOf(root), 'lock'), JSON.stringify({ runId: 'prw-20260901-080000-zzzz', pid: 111, engineRunId: 'wf-old' }));
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assertIncludes(recorded.logs.join('\n'), '接管重建');
    assert.strictEqual(fs.existsSync(path.join(stateDirOf(root), 'lock')), false); // 终态删锁
  });

  await test('lockfile：EEXIST 且锁内容不可读 → fail-closed 交人工（锁保留）', async () => {
    const { io, root } = makeIo({ args: {} });
    fs.mkdirSync(stateDirOf(root), { recursive: true });
    fs.writeFileSync(path.join(stateDirOf(root), 'lock'), 'garbage{not-json');
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '互斥锁存在但内容不可读');
    assertIncludes(result.error, '手工删除');
    assert.strictEqual(fs.existsSync(path.join(stateDirOf(root), 'lock')), true);
  });

  await test('lockfile：锁写入内容经捕获断言（初写 runId=null + updateLockContent 回填 runId/pid/engineRunId）', async () => {
    const { io, root } = makeIo({ args: { _runId: 'wf-lock-check' } });
    const lockPath = path.join(stateDirOf(root), 'lock');
    // 经注入 fs 捕获 openSync/writeSync（acquireLock 用 'wx' 创建 + writeSync(fd) 写内容）
    const fdToPath = new Map();
    const lockWrites = [];
    const origOpen = io.fs.openSync;
    const origWrite = io.fs.writeSync;
    const origWriteFile = io.fs.writeFileSync;
    io.fs.openSync = (p, flags) => {
      const fd = origOpen(p, flags);
      fdToPath.set(fd, String(p));
      return fd;
    };
    io.fs.writeSync = (fd, content) => {
      if (fdToPath.get(fd) === lockPath) lockWrites.push(String(content));
      return origWrite(fd, content);
    };
    io.fs.writeFileSync = (p, content, ...rest) => {
      if (String(p) === lockPath) lockWrites.push(String(content)); // updateLockContent 回填走 writeFileSync
      return origWriteFile(p, content, ...rest);
    };
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.strictEqual(lockWrites.length, 2, `初写 + 回填共两次：${JSON.stringify(lockWrites)}`);
    const first = JSON.parse(lockWrites[0]);
    assert.strictEqual(first.runId, null); // acquireLock 时 fresh runId 未生成
    assert.strictEqual(first.pid, 4242);
    assert.strictEqual(first.engineRunId, 'wf-lock-check');
    const second = JSON.parse(lockWrites[1]);
    assert.strictEqual(second.runId, result.runId); // updateLockContent 回填真 runId
    assert.strictEqual(second.pid, 4242);
    assert.strictEqual(second.engineRunId, 'wf-lock-check');
  });

  /* ── resume 守卫（§3.4-(4) 顺序） ── */

  const resumeArgs = () => ({ runId: RUN_ID_A, _runId: 'wf-new' });

  await test('守卫 1 反：runId 对应 state 不存在 → 文案含「去掉 runId」，resumeCommand 为 fresh 形态', async () => {
    const { io, root } = makeIo({ args: { runId: 'prw-20260901-000000-zzzz' } });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.runId, 'prw-20260901-000000-zzzz');
    assertIncludes(result.error, '无效');
    assertIncludes(result.error, '去掉 runId');
    assert.ok(result.resumeCommand.includes(`--workflow ${root}/.agents/skills/pr-cr-fix/workflows/pr-lifecycle.js`), result.resumeCommand);
    assert.ok(!result.resumeCommand.includes(`--runId`), 'fresh 形态不带 runId');
  });

  await test('守卫 1 反：stateVersion 非 1（版本不兼容）→ 同文案 fail-fast', async () => {
    const { io, root } = makeIo({ args: resumeArgs() });
    seedState(root, { stateVersion: 2 });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '版本不兼容');
  });

  await test('守卫 2 反：repo 不一致 → fail-fast「另一仓库/worktree」，且不再继续后续 git 调用', async () => {
    const { io, root, recorded } = makeIo({ args: resumeArgs() });
    seedState(root, { repo: '/some/other/worktree' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '另一仓库/worktree');
    assertIncludes(result.error, '/some/other/worktree');
    // 守卫顺序：分支/活性/工作区检查不应发生
    assert.ok(!recorded.sh.some((c) => c[0] === 'git' && c[1] === 'status'), 'repo 守卫失败后不应执行工作区检查');
  });

  await test('守卫 3 反：分支不一致 → fail-fast 文案含「属于分支 X」与正确做法', async () => {
    const { io, root } = makeIo({ args: resumeArgs(), branch: 'other-branch' });
    seedState(root, { branch: 'feat-x' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '属于分支 feat-x');
    assertIncludes(result.error, '不传 runId 起新 run');
  });

  await test('守卫 4 主通道：引擎 status=running 且记录 pid 存活 → fail-fast「仍在进行」+ abort 指引', async () => {
    const { io, root } = makeIo({ args: resumeArgs(), engineMap: { 'wf-live': 'running' }, pidMap: { 111: 'alive' } });
    seedState(root, { engineRunId: 'wf-live' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '仍在进行');
    assertIncludes(result.error, 'engineRunId=wf-live');
    assertIncludes(result.error, 'abort');
  });

  await test('守卫 4 fail-closed：引擎 status 为未知值且记录 pid 存活 → 一律视为进行中拦截', async () => {
    const { io, root } = makeIo({ args: resumeArgs(), engineMap: { 'wf-weird': 'frobnicated' }, pidMap: { 111: 'alive' } });
    seedState(root, { engineRunId: 'wf-weird' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '仍在进行');
    assertIncludes(result.error, 'frobnicated');
  });

  await test('守卫 4 主通道终态放行：status=done → 进入后续流程（walker 执行未完成 step）', async () => {
    const runs = [];
    const { io, root } = makeIo({ args: resumeArgs(), steps: [mkStep('s1', runs)] }); // wf-old = done
    seedState(root, { engineRunId: 'wf-old' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['s1']); // 守卫放行后 walker 正常执行
  });

  await test('守卫 4 降级通道：引擎文件不可读 + pid 已死 → 放行并 log 标注降级', async () => {
    const runs = [];
    const { io, root, recorded } = makeIo({ args: resumeArgs(), engineMap: {}, steps: [mkStep('s1', runs)] }); // wf-gone 不在 map → ok:false
    seedState(root, { engineRunId: 'wf-gone', pid: 222 }); // pidMap 无 222 → dead
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['s1']);
    assertIncludes(recorded.logs.join('\n'), '降级 pid 探测');
    assertIncludes(recorded.logs.join('\n'), 'pid=222 已退出，放行');
  });

  await test('守卫 4 降级通道：pid 存活 → fail-fast，文案含 pid 复用人工出口', async () => {
    const { io, root } = makeIo({ args: resumeArgs(), engineMap: {}, pidMap: { 222: 'alive' } });
    seedState(root, { engineRunId: 'wf-gone', pid: 222 });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '仍在进行');
    assertIncludes(result.error, 'pid=222');
    assertIncludes(result.error, 'ps -p 222 -o command='); // pid 复用核实出口
    assertIncludes(result.error, '清除 pid 字段'); // 人工出口
  });

  await test('守卫 5 反：工作区脏 → fail-fast，error 含改动清单与 commit/checkout 指引', async () => {
    const runs = [];
    const { io, root } = makeIo({ args: resumeArgs(), porcelain: ' M src/a.js\n?? src/b.js', steps: [mkStep('s1', runs)] });
    seedState(root, { engineRunId: 'wf-old' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '存在未提交改动');
    assertIncludes(result.error, 'M src/a.js');
    assertIncludes(result.error, '?? src/b.js');
    assertIncludes(result.error, 'git add <显式路径> && git commit');
    assertIncludes(result.error, 'git checkout --');
  });

  await test('守卫 6 反：HEAD 外部变更（running）无参数 → fail-fast 带 allowExternalChanges 指引', async () => {
    const runs = [];
    const { io, root } = makeIo({ args: resumeArgs(), head: 'H2', steps: [mkStep('s1', runs)] });
    seedState(root, { lastHead: 'H1', status: 'running' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '外部变更');
    assertIncludes(result.error, 'H1 → H2');
    assertIncludes(result.error, 'allowExternalChanges=true');
  });

  await test('守卫 6 正：带 allowExternalChanges=true → 放行，walker 从断点重跑', async () => {
    const runs = [];
    const { io, root, recorded } = makeIo({
      args: Object.assign(resumeArgs(), { allowExternalChanges: true }),
      head: 'H2',
      steps: [mkStep('s1', runs)],
    });
    seedState(root, { lastHead: 'H1', status: 'running' });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['s1']);
    assertIncludes(recorded.logs.join('\n'), 'allowExternalChanges=true 显式放行');
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.lastHead, 'H2');
  });

  await test('守卫 6：status=failed 时外部 commit 属预期恢复动作 → 无参数直接放行', async () => {
    const runs = [];
    const { io, root } = makeIo({ args: resumeArgs(), head: 'H2', steps: [mkStep('s1', runs)] });
    seedState(root, { lastHead: 'H1', status: 'failed', failedStep: 's1', steps: { s1: { status: 'failed', attempts: 1 } } });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['s1']); // 从断点 step 重跑
  });

  /* ── resume walker（§3.4-(3) 六条语义） ── */

  await test('walker：done 跳过 / failed 整体重跑 / pending 执行，执行顺序按注册表', async () => {
    const runs = [];
    const { io, root } = makeIo({
      args: resumeArgs(),
      steps: [mkStep('a', runs), mkStep('b', runs), mkStep('c', runs)],
    });
    seedState(root, {
      steps: { a: { status: 'done', attempts: 1, outputs: { v: 'a' } }, b: { status: 'failed', attempts: 1 } },
    });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['b', 'c']); // a done 不重跑
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.steps.a.status, 'done');
    assert.strictEqual(state.steps.b.status, 'done');
    assert.strictEqual(state.steps.b.attempts, 2); // 重跑计数递增
    assert.strictEqual(state.steps.c.attempts, 1);
  });

  await test('walker：in_progress（上次死在中途）整体重跑', async () => {
    const runs = [];
    const { io, root } = makeIo({
      args: resumeArgs(),
      steps: [mkStep('a', runs), mkStep('b', runs)],
    });
    seedState(root, { steps: { a: { status: 'done', attempts: 1 }, b: { status: 'in_progress', attempts: 1 } } });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['b']);
    assert.strictEqual(readStateFile(root, RUN_ID_A).steps.b.status, 'done');
  });

  await test('walker：skipped 跳过不重跑', async () => {
    const runs = [];
    const { io, root } = makeIo({
      args: resumeArgs(),
      steps: [mkStep('a', runs), mkStep('b', runs), mkStep('c', runs)],
    });
    seedState(root, {
      steps: {
        a: { status: 'done', attempts: 1 },
        b: { status: 'skipped', reason: 'user-ack' },
      },
    });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['c']);
    assert.deepStrictEqual(result.skippedSteps, [{ step: 'b', reason: 'user-ack' }]); // skipped 透传终态
  });

  await test('walker：skipSteps 逃生舱消费本次发起参数，skipped 落盘必带 reason=user-ack', async () => {
    const runs = [];
    const { io, root } = makeIo({
      args: { runId: RUN_ID_A, skipSteps: 'b' }, // CLI 字符串形态
      steps: [mkStep('a', runs), mkStep('b', runs), mkStep('c', runs)],
    });
    // state.params.skipSteps 为空（上次未传）——逃生舱仍应按本次发起参数生效
    seedState(root, {});
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, ['a', 'c']); // b 被跳过
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.steps.b.status, 'skipped');
    assert.strictEqual(state.steps.b.reason, 'user-ack');
    assert.deepStrictEqual(result.skippedSteps, [{ step: 'b', reason: 'user-ack' }]);
  });

  await test('walker：skipSteps 对 done/skipped step 无效果', async () => {
    const runs = [];
    const { io, root } = makeIo({
      args: { runId: RUN_ID_A, skipSteps: 'a' },
      steps: [mkStep('a', runs)],
    });
    seedState(root, { steps: { a: { status: 'done', attempts: 1 } }, lastHead: 'H1' });
    const result = await lib.runPipeline(io);
    // a 已 done → 全 finished → 空转防护路径，skipSteps 不产生 skipped 条目
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(runs, []);
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.steps.a.status, 'done');
  });

  await test('walker：step 失败 → state 落盘 failed + failedStep + error + resumeCommand，后续 step 不执行', async () => {
    const runs = [];
    const boom = {
      id: 'b',
      run: async () => {
        runs.push('b');
        throw new Error('boom-b');
      },
    };
    const { io, root } = makeIo({
      args: resumeArgs(),
      steps: [mkStep('a', runs), boom, mkStep('c', runs)],
    });
    seedState(root, { steps: { a: { status: 'done', attempts: 1 } } });
    const result = await lib.runPipeline(io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'b');
    assert.strictEqual(result.error, 'boom-b');
    assert.ok(result.resumeCommand.includes(`--workflow ${root}/.agents/skills/pr-cr-fix/workflows/pr-lifecycle.js`), result.resumeCommand);
    assert.ok(result.resumeCommand.includes(`--runId ${RUN_ID_A}`), result.resumeCommand);
    assert.deepStrictEqual(runs, ['b']); // c 未执行
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.status, 'failed');
    assert.strictEqual(state.failedStep, 'b');
    assert.strictEqual(state.error, 'boom-b');
    assert.strictEqual(state.steps.b.status, 'failed');
    assert.deepStrictEqual(state.result, result); // result 快照落盘
  });

  await test('落盘时序：step 开始（in_progress）与结束（done）各一次原子写，终态再次落盘', async () => {
    const runs = [];
    const { io, root, recorded } = makeIo({ args: { _runId: 'wf-1' }, steps: [mkStep('a', runs)] });
    const stateJsonPath = path.join(stateDirOf(root), 'prw-20260903-100000-ab12', 'state.json');
    await lib.runPipeline(io);
    // 原子写序列：tmp 写 → rename 替换 state.json；无 tmp 残留
    assert.ok(recorded.renames.length >= 3, `至少 in_progress/done/终态三次落盘，实际 ${recorded.renames.length}`);
    for (const [src, dst] of recorded.renames) {
      assert.ok(src.includes('.tmp-4242-'), `tmp 文件名含 pid：${src}`);
      assert.strictEqual(dst, stateJsonPath);
      assert.strictEqual(fs.existsSync(src), false); // rename 后 tmp 不存在
    }
    const snapshots = recorded.renameContents.map((c) => JSON.parse(c));
    const aSnapshots = [];
    for (const snap of snapshots) {
      if (snap.steps && snap.steps.a) aSnapshots.push(snap.steps.a.status);
    }
    assert.deepStrictEqual(aSnapshots, ['in_progress', 'done', 'done']); // 开始/结束/终态各一次
  });

  await test('lastHead 语义：每次 checkpoint 刷新为当时 HEAD', async () => {
    const runs = [];
    const { io, root, git } = makeIo({ args: resumeArgs(), head: 'H1', steps: [mkStep('s1', runs)] });
    seedState(root, { lastHead: 'H0', status: 'failed', failedStep: 's1', steps: { s1: { status: 'failed', attempts: 1 } } });
    git.head = 'H9'; // resume 期间 HEAD 前移（模拟人工修复 commit，failed 状态被守卫 6 放行）
    await lib.runPipeline(io);
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.lastHead, 'H9'); // 最后一次 checkpoint 时 HEAD
  });

  /* ── 空转防护（walker 语义 6） ── */

  await test('空转防护：全 done 且 HEAD 不变 → 幂等回放 result 快照，零 step 执行', async () => {
    const runs = [];
    const snapshot = { status: 'awaiting-push', runId: RUN_ID_A, prUrl: 'https://github.com/x/pull/1', terminated: 'clean', simplify: null, gates: { coverage: 'pass', metrics: 'pass', premerge: 'PASS' }, skippedSteps: [] };
    const { io, root } = makeIo({
      args: resumeArgs(),
      steps: [mkStep('a', runs), mkStep('b', runs)],
    });
    seedState(root, {
      status: 'awaiting-push',
      lastHead: 'H1',
      result: snapshot,
      steps: { a: { status: 'done', attempts: 1 }, b: { status: 'skipped', reason: 'cond' } },
    });
    const result = await lib.runPipeline(io);
    assert.deepStrictEqual(result, snapshot); // 同一结果（快照回放）
    assert.deepStrictEqual(runs, []); // 不重跑任何步骤
  });

  await test('空转防护：全 done 且 HEAD 已变 → fail-fast 指引起新 run；allowExternalChanges 也拦', async () => {
    for (const allow of [false, true]) {
      const runs = [];
      const args = resumeArgs();
      if (allow) args.allowExternalChanges = true;
      const { io, root } = makeIo({ args, head: 'H2', steps: [mkStep('a', runs)] });
      seedState(root, { status: 'awaiting-push', lastHead: 'H1', steps: { a: { status: 'done', attempts: 1 } } });
      const result = await lib.runPipeline(io);
      assert.strictEqual(result.status, 'failed', `allowExternalChanges=${allow}`);
      assertIncludes(result.error, `本 run ${RUN_ID_A} 已完成`);
      assertIncludes(result.error, '请不传 runId 起新 run');
      assertIncludes(result.error, 'allowExternalChanges 在此场景无效');
      assertIncludes(result.error, `新 run 命令：node `);
      assertIncludes(result.error, `--workflow ${root}/.agents/skills/pr-cr-fix/workflows/pr-lifecycle.js`);
      assert.strictEqual(result.resumeCommand, null); // 防指引链兜圈
      assert.deepStrictEqual(runs, []);
    }
  });

  /* ── result 快照回放一致性 + engineRunId 刷新 ── */

  await test('快照回放一致性：fresh 终态 → resume 回放同一 result，engineRunId 刷新落盘', async () => {
    const first = makeIo({ args: { _runId: 'wf-run-1' } });
    const resultA = await lib.runPipeline(first.io);
    assert.strictEqual(resultA.status, 'awaiting-push');
    // 第二次发起：带 runId resume（空 registry = 全 done，HEAD 不变）
    const secondIo = first.io;
    secondIo.args = { runId: resultA.runId, _runId: 'wf-run-2' };
    const resultB = await lib.runPipeline(secondIo);
    assert.deepStrictEqual(resultB, resultA); // 同一结果
    const state = readStateFile(first.root, resultA.runId);
    assert.strictEqual(state.engineRunId, 'wf-run-2'); // 每次发起刷新（活性主通道读最近一次）
    assert.strictEqual(state.pid, 4242);
    assert.deepStrictEqual(state.result, resultA); // 快照原样保留
  });

  await test('resume 后 state 引擎上下文刷新：守卫过 → engineRunId/pid 为本次值', async () => {
    const { io, root } = makeIo({ args: resumeArgs(), head: 'H2' });
    seedState(root, { lastHead: 'H1', status: 'failed', failedStep: 's1', steps: { s1: { status: 'failed', attempts: 1 } } });
    const runs = [];
    io.steps = [mkStep('s1', runs)];
    await lib.runPipeline(io);
    const state = readStateFile(root, RUN_ID_A);
    assert.strictEqual(state.engineRunId, 'wf-new');
    assert.strictEqual(state.pid, 4242);
  });

  /* ── u2：PR 阶段 steps（preflight / static-gate / changeset / pr-meta / skill-yaml / pr-submit） ── */

  // 全链成功 mocks：gate 过（带 WARN 触发 changeset）、两 agent 成功、submit 返回合法 pr_url
  function allPassMocks() {
    return {
      scriptMocks: {
        [FAKE_PATHS.preMerge]: { code: 0, stdout: '  PASS typecheck:extensions\n  PASS lint\n  WARN changeset-check 0s (2 missing)\n' },
        [FAKE_PATHS.prSubmit]: { code: 0, stdout: 'branch pushed\nhttps://github.com/acme/widget/pull/42\n' },
        [FAKE_PATHS.validateSkillYaml]: { code: 0, stdout: 'OK' },
      },
      agent: async (params) => {
        if (params.description === 'pr-meta') return { value: { title: 'feat(core): add x', body: '## Summary\nadd x\n## Test plan\ntypecheck+lint pass\n' }, error: null };
        if (params.description === 'changeset-draft') return { value: { action: 'draft', files: ['.changeset/widget.md'] }, error: null };
        return { value: {}, error: null }; // gate fix agent
      },
    };
  }

  const findStep = (steps, id) => {
    const s = steps.find((x) => x.id === id);
    assert.ok(s, `注册表中存在 step ${id}`);
    return s;
  };

  function mkCtx(t, state, runIdDir) {
    return {
      state,
      params: state.params,
      runIdDir: runIdDir || path.join(t.root, '.review', 'pr-workflow', state.runId),
      io: t.io,
      saveCheckpoint() {},
    };
  }

  await test('u2 全链 fresh：六 steps 串行到 awaiting-push，prUrl/skippedSteps/outputs 契约正确', async () => {
    const m = allPassMocks();
    const t = makeIo(Object.assign({ args: { _runId: 'wf-u2-full' }, names: 'src/a.js\n' }, m));
    t.io.steps = makeSteps({ root: t.root, range: STEP_RANGE.prOnly });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.strictEqual(result.prUrl, 'https://github.com/acme/widget/pull/42');
    assert.deepStrictEqual(result.skippedSteps, [{ step: 'skill-yaml', reason: 'diff 未触及 .agents/skills/，条件不满足' }]);
    const state = readStateFile(t.root, result.runId);
    assert.deepStrictEqual(state.steps['static-gate'].outputs, { result: 'PASS', changesetWarn: true });
    assert.strictEqual(state.steps.changeset.status, 'done');
    assert.strictEqual(state.steps['pr-submit'].status, 'done');
    assert.strictEqual(state.steps['skill-yaml'].status, 'skipped');
    assert.ok(state.steps['pr-submit'].outputs.prUrl.startsWith('https://github.com/acme/widget/pull/'));
  });

  await test('preflight：state.baseHash 已锁定时不重算 rev-parse base（全程恰 1 次 = fresh 创建时）', async () => {
    const m = allPassMocks();
    const t = makeIo(Object.assign({ args: { _runId: 'wf-u2-pf' } }, m));
    t.io.steps = makeSteps({ root: t.root, range: STEP_RANGE.prOnly });
    await lib.runPipeline(t.io);
    const baseResolves = t.recorded.sh.filter(
      (c) => c[0] === 'git' && c[1] === 'rev-parse' && c[2] === 'main^{commit}',
    );
    assert.strictEqual(baseResolves.length, 1,
      'rev-parse base 只应发生在 fresh 创建 state 时；preflight 复用 state.baseHash 不重算');
  });

  await test('preflight：无 commits + gh 未认证 + fallow 缺失 → 聚合失败文案逐条给修复命令', async () => {
    const m = allPassMocks();
    const t = makeIo(Object.assign({
      args: { _runId: 'wf-u2-pf2' },
      commits: '',
      cmdResults: {
        gh: { code: 1, stderr: 'not logged in' },
        fallow: { code: 127, stderr: 'command not found' },
      },
    }, m));
    t.io.steps = makeSteps({ root: t.root, range: STEP_RANGE.prOnly });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'preflight');
    assertIncludes(result.error, 'preflight 前置条件未过');
    assertIncludes(result.error, `分支相对 base main 无 commits`);
    assertIncludes(result.error, 'gh auth login');
    assertIncludes(result.error, 'npm i -g fallow');
  });

  await test('preflight：baseHash 缺失（旧 state）时补锁并落盘', async () => {
    const m = allPassMocks();
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u2-pf3' } }, m));
    seedState(t.root, { baseHash: null });
    t.io.steps = makeSteps({ root: t.root, range: STEP_RANGE.prOnly });
    await lib.runPipeline(t.io);
    assert.ok(t.recorded.sh.some((c) => c[0] === 'git' && c[1] === 'rev-parse' && c[2] === 'main^{commit}'));
    assert.strictEqual(readStateFile(t.root, RUN_ID_A).baseHash, 'B1');
  });

  await test('static-gate：过且无 WARN → outputs 契约 + changeset 预写 skipped（条件随前置 done checkpoint 落盘）', async () => {
    const m = allPassMocks();
    m.scriptMocks[FAKE_PATHS.preMerge] = { code: 0, stdout: '  PASS typecheck:extensions\n  PASS lint\n' }; // 无 WARN
    const t = makeIo(Object.assign({ args: { _runId: 'wf-u2-sg1' } }, m));
    t.io.steps = makeSteps({ root: t.root, range: STEP_RANGE.prOnly });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push');
    const state = readStateFile(t.root, result.runId);
    assert.deepStrictEqual(state.steps['static-gate'].outputs, { result: 'PASS', changesetWarn: false });
    assert.strictEqual(state.steps.changeset.status, 'skipped');
    assertIncludes(state.steps.changeset.reason, '条件不满足');
    assert.strictEqual(t.agentCalls.filter((c) => c.description === 'changeset-draft').length, 0);
  });

  await test('static-gate：fail → fix agent 修 → 第 2 轮过（gate 调 2 次、agent 1 次、prompt 含 commit message 约定）', async () => {
    let gateRuns = 0;
    const m = allPassMocks();
    m.scriptMocks[FAKE_PATHS.preMerge] = () => {
      gateRuns += 1;
      return gateRuns === 1 ? { code: 1, stderr: 'lint failed hard' } : { code: 0, stdout: '  PASS lint\n' };
    };
    const t = makeIo(Object.assign({ args: { _runId: 'wf-u2-sg2' } }, m));
    t.io.steps = makeSteps({ root: t.root, range: STEP_RANGE.prOnly });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.strictEqual(gateRuns, 2);
    const fixCalls = t.agentCalls.filter((c) => c.description === 'fix-static-gate');
    assert.strictEqual(fixCalls.length, 1);
    assertIncludes(fixCalls[0].prompt, 'fix: gate static-gate round 1');
    assertIncludes(fixCalls[0].prompt, 'lint failed hard');
    assertIncludes(fixCalls[0].prompt, 'git add <显式路径>'); // 禁 add -A 语义
    const state = readStateFile(t.root, result.runId);
    assert.strictEqual(state.steps['static-gate'].attempts, 1);
  });

  await test('static-gate：3 轮子循环上限 → failed（gate 3 次、agent 2 次、文案含人工修复 + resumeCommand 指引）', async () => {
    let gateRuns = 0;
    const t = makeIo({
      args: { _runId: 'wf-u2-sg3' },
      scriptMocks: {
        [FAKE_PATHS.preMerge]: () => {
          gateRuns += 1;
          return { code: 1, stderr: `still failing round ${gateRuns}` };
        },
      },
    });
    t.io.steps = makeSteps({ root: t.root, range: STEP_RANGE.prOnly });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'static-gate');
    assert.strictEqual(gateRuns, lib.MAX_GATE_ROUNDS);
    assert.strictEqual(t.agentCalls.filter((c) => c.description === 'fix-static-gate').length, lib.MAX_GATE_ROUNDS - 1);
    assertIncludes(result.error, '3 轮修复子循环仍未通过');
    assertIncludes(result.error, 'git add <显式路径> && git commit');
    assertIncludes(result.error, 'resumeCommand 续跑');
  });

  await test('static-gate：fix agent 留脏工作区 → 立即 failed（第 1 次止损，gate 只跑 1 次）', async () => {
    let gateRuns = 0;
    const t = makeIo({
      args: { _runId: 'wf-u2-sg4' },
      scriptMocks: {
        [FAKE_PATHS.preMerge]: () => {
          gateRuns += 1;
          return { code: 1, stderr: 'lint failed' };
        },
      },
      agent: async () => ({ value: {}, error: null }),
    });
    // agent 返回后置脏：借 agent mock 副作用改 git.porcelain（模拟 agent 修完未 commit）
    const origAgent = t.io.agent;
    t.io.agent = async (params) => {
      const res = await origAgent(params);
      t.git.porcelain = ' M dirty.js\n';
      return res;
    };
    t.io.steps = makeSteps({ root: t.root, range: STEP_RANGE.prOnly });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'static-gate');
    assert.strictEqual(gateRuns, 1); // 第 1 次止损：不烧后续轮次
    assertIncludes(result.error, '存在未提交改动');
    assertIncludes(result.error, 'dirty.js');
    assertIncludes(result.error, '止损');
  });

  await test('static-gate：exit 2（工具错误）→ failed 不自动重试（gate 1 次、agent 0 次）', async () => {
    let gateRuns = 0;
    const t = makeIo({
      args: { _runId: 'wf-u2-sg5' },
      scriptMocks: {
        [FAKE_PATHS.preMerge]: () => {
          gateRuns += 1;
          return { code: 2, stderr: 'ERROR: 用法错误' };
        },
      },
    });
    t.io.steps = makeSteps({ root: t.root, range: STEP_RANGE.prOnly });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(gateRuns, 1);
    assert.strictEqual(t.agentCalls.length, 0);
    assertIncludes(result.error, '工具错误，不自动重试');
    assertIncludes(result.error, '需人看');
  });

  await test('changeset：changesetWarn=false 且条目被篡改删除 → 防御重放落盘条件（不真跑 agent）', async () => {
    const t = makeIo({ agent: async () => { throw new Error('agent 不应被调用'); } });
    const steps = makeSteps({ root: t.root });
    const changesetStep = findStep(steps, 'changeset');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: { 'static-gate': { status: 'done', outputs: { result: 'PASS', changesetWarn: false } } } };
    const res = await changesetStep.run(mkCtx(t, state));
    assert.strictEqual(res.skipped, true);
    assertIncludes(res.reason, 'changesetWarn=false');
  });

  await test('changeset：WARN=true → agent 按 diff 起草（prompt 含 stat/commits，outputs 契约）', async () => {
    const t = makeIo({
      agent: async () => ({ value: { action: 'draft', files: ['.changeset/widget.md'] }, error: null }),
    });
    const steps = makeSteps({ root: t.root });
    const changesetStep = findStep(steps, 'changeset');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: { 'static-gate': { status: 'done', outputs: { result: 'PASS', changesetWarn: true } } } };
    const res = await changesetStep.run(mkCtx(t, state));
    assert.deepStrictEqual(res.drafted, ['.changeset/widget.md']);
    assertIncludes(res.note, '已起草 1 个 changeset 文件');
    const prompt = t.agentCalls[0].prompt;
    assertIncludes(prompt, 'minor'); // 分类规则内嵌
    assertIncludes(prompt, 'feat: a commit'); // commits 全文作输入
  });

  await test('changeset：agent 判非发布改动 → note 汇总跳过原因', async () => {
    const t = makeIo({
      agent: async () => ({ value: { action: 'no-release', skipReasons: ['pi-goal: 纯注释改动，diff 证据为注释行'] }, error: null }),
    });
    const steps = makeSteps({ root: t.root });
    const changesetStep = findStep(steps, 'changeset');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: { 'static-gate': { status: 'done', outputs: { changesetWarn: true } } } };
    const res = await changesetStep.run(mkCtx(t, state));
    assert.deepStrictEqual(res.drafted, []);
    assertIncludes(res.note, '纯注释改动');
  });

  await test('changeset：agent 调用失败 → failed 文案可操作', async () => {
    const t = makeIo({ agent: async () => ({ value: null, error: 'model timeout' }) });
    const steps = makeSteps({ root: t.root });
    const changesetStep = findStep(steps, 'changeset');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: { 'static-gate': { status: 'done', outputs: { changesetWarn: true } } } };
    await assert.rejects(changesetStep.run(mkCtx(t, state)), /changeset agent 调用失败：model timeout/);
  });

  await test('changeset：outputs 缺 changesetWarn（旧版本 state）→ fail-fast 不猜条件', async () => {
    const t = makeIo({});
    const steps = makeSteps({ root: t.root });
    const changesetStep = findStep(steps, 'changeset');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: { 'static-gate': { status: 'done', outputs: {} } } };
    await assert.rejects(changesetStep.run(mkCtx(t, state)), /changesetWarn/);
  });

  await test('pr-meta：schema agent 产物落盘 pr-title.txt / pr-body.md，outputs {title, bodyFile}', async () => {
    const t = makeIo({
      agent: async () => ({ value: { title: 'feat(core): add x', body: '## Summary\nadd x\n' }, error: null }),
    });
    const steps = makeSteps({ root: t.root });
    const prMetaStep = findStep(steps, 'pr-meta');
    const runIdDir = path.join(t.root, 'run-dir');
    fs.mkdirSync(runIdDir, { recursive: true });
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: {} };
    const res = await prMetaStep.run(mkCtx(t, state, runIdDir));
    assert.strictEqual(res.title, 'feat(core): add x');
    assert.strictEqual(res.bodyFile, path.join(runIdDir, 'pr-body.md'));
    assert.strictEqual(fs.readFileSync(path.join(runIdDir, 'pr-title.txt'), 'utf8'), 'feat(core): add x');
    assertIncludes(fs.readFileSync(path.join(runIdDir, 'pr-body.md'), 'utf8'), '## Summary');
    const prompt = t.agentCalls[0].prompt;
    assertIncludes(prompt, 'conventional commit');
    assertIncludes(prompt, 'feat: a commit');
    assertIncludes(prompt, 'a.js | 2');
  });

  await test('pr-meta：agent 返回缺 body → failed 文案（schema 回退 content 兜底）', async () => {
    const t = makeIo({
      agent: async () => ({ value: 'raw text fallback（无 schema 输出）', error: null }),
    });
    const steps = makeSteps({ root: t.root });
    const prMetaStep = findStep(steps, 'pr-meta');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: {} };
    await assert.rejects(prMetaStep.run(mkCtx(t, state)), /pr-meta agent 返回不符合契约/);
  });

  await test('pr-meta：agent 调用失败 → failed 文案', async () => {
    const t = makeIo({ agent: async () => ({ value: null, error: 'rate limited' }) });
    const steps = makeSteps({ root: t.root });
    const prMetaStep = findStep(steps, 'pr-meta');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: {} };
    await assert.rejects(prMetaStep.run(mkCtx(t, state)), /pr-meta agent 调用失败：rate limited/);
  });

  await test('skill-yaml：diff 未触及 .agents/skills/ → skipped 落盘 reason', async () => {
    const t = makeIo({ names: 'src/a.js\npackages/runtime/src/x.ts\n' });
    const steps = makeSteps({ root: t.root });
    const skillStep = findStep(steps, 'skill-yaml');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: {} };
    const res = await skillStep.run(mkCtx(t, state));
    assert.strictEqual(res.skipped, true);
    assertIncludes(res.reason, '.agents/skills/');
  });

  await test('skill-yaml：改动 skill 目录映射到各自 SKILL.md 传参（去重），成功 outputs', async () => {
    const t = makeIo({
      names: '.agents/skills/foo/scripts/x.py\n.agents/skills/bar/SKILL.md\n.agents/skills/foo/SKILL.md\n',
      scriptMocks: {
        [FAKE_PATHS.validateSkillYaml]: (args) => {
          t.validateArgs = args;
          return { code: 0, stdout: 'OK' };
        },
      },
    });
    const steps = makeSteps({ root: t.root });
    const skillStep = findStep(steps, 'skill-yaml');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: {} };
    const res = await skillStep.run(mkCtx(t, state));
    assert.deepStrictEqual(res.validated, ['.agents/skills/foo/SKILL.md', '.agents/skills/bar/SKILL.md']);
    assert.deepStrictEqual(t.validateArgs, [FAKE_PATHS.validateSkillYaml, '.agents/skills/foo/SKILL.md', '.agents/skills/bar/SKILL.md']);
  });

  await test('skill-yaml：校验 fail → failed（硬校验不修，文案带输出）', async () => {
    const t = makeIo({
      names: '.agents/skills/foo/SKILL.md\n',
      scriptMocks: { [FAKE_PATHS.validateSkillYaml]: { code: 1, stdout: 'ERROR: missing field name' } },
    });
    const steps = makeSteps({ root: t.root });
    const skillStep = findStep(steps, 'skill-yaml');
    const state = { runId: RUN_ID_A, baseHash: 'B1', params: {}, steps: {} };
    await assert.rejects(skillStep.run(mkCtx(t, state)), (e) => {
      assertIncludes(e.message, '硬校验不修');
      assertIncludes(e.message, 'missing field name');
      return true;
    });
  });

  await test('pr-submit：pr-meta 产物缺失 → failed 前置文案', async () => {
    const t = makeIo({});
    const steps = makeSteps({ root: t.root });
    const submitStep = findStep(steps, 'pr-submit');
    const state = { runId: RUN_ID_A, baseHash: 'B1', base: 'main', params: {}, steps: {} };
    await assert.rejects(submitStep.run(mkCtx(t, state)), /pr-submit 前置产物缺失/);
  });

  await test('pr-submit：成功 → 从 stdout 解析 pr_url（多行取合法匹配），参数含 title/body/base', async () => {
    let submitArgs = null;
    const t = makeIo({
      scriptMocks: {
        [FAKE_PATHS.prSubmit]: (args) => {
          submitArgs = args;
          return { code: 0, stdout: 'branch pushed\nhttps://github.com/acme/widget/pull/7\n' };
        },
      },
    });
    const steps = makeSteps({ root: t.root });
    const submitStep = findStep(steps, 'pr-submit');
    const runIdDir = path.join(t.root, 'run-dir');
    fs.mkdirSync(runIdDir, { recursive: true });
    fs.writeFileSync(path.join(runIdDir, 'pr-title.txt'), 'feat: x');
    const state = { runId: RUN_ID_A, baseHash: 'B1', base: 'main', params: {}, steps: { 'pr-meta': { status: 'done', outputs: { title: 'feat: x', bodyFile: '/fake/body.md' } } } };
    const res = await submitStep.run(mkCtx(t, state, runIdDir));
    assert.strictEqual(res.prUrl, 'https://github.com/acme/widget/pull/7');
    assert.deepStrictEqual(submitArgs.slice(1), ['--title-file', path.join(runIdDir, 'pr-title.txt'), '--body-file', '/fake/body.md', '--base', 'main']);
  });

  await test('pr-submit：stdout 无合法 pr_url（dry-run 形态）→ failed URL 校验文案', async () => {
    const t = makeIo({
      scriptMocks: { [FAKE_PATHS.prSubmit]: { code: 0, stdout: 'https://github.com/dry-run/pr/create\n' } },
    });
    const steps = makeSteps({ root: t.root });
    const submitStep = findStep(steps, 'pr-submit');
    const state = { runId: RUN_ID_A, baseHash: 'B1', base: 'main', params: {}, steps: { 'pr-meta': { status: 'done', outputs: { bodyFile: '/fake/body.md' } } } };
    await assert.rejects(submitStep.run(mkCtx(t, state)), /未解析到合法 pr_url/);
  });

  await test('pr-submit：exit 2 / 3 / 5 文案按 §3.7 逐档', async () => {
    const cases = [
      { code: 2, re: /git push 失败.*分支保护.*幂等更新/s, detail: 'remote rejected' },
      { code: 3, re: /gh 已认证但调用失败.*gh auth status/s, detail: 'api error' },
      { code: 5, re: /title\/body 文件缺失.*pr-title\.txt\/pr-body\.md/s, detail: 'not readable' },
    ];
    for (const c of cases) {
      const t = makeIo({
        scriptMocks: { [FAKE_PATHS.prSubmit]: { code: c.code, stdout: c.detail } },
      });
      const steps = makeSteps({ root: t.root });
      const submitStep = findStep(steps, 'pr-submit');
      const state = { runId: RUN_ID_A, baseHash: 'B1', base: 'main', params: {}, steps: { 'pr-meta': { status: 'done', outputs: { bodyFile: '/fake/body.md' } } } };
      await assert.rejects(submitStep.run(mkCtx(t, state)), (e) => {
        assert.ok(c.re.test(e.message), `exit ${c.code} 文案不匹配：${e.message}`);
        assertIncludes(e.message, c.detail);
        return true;
      });
    }
  });

  await test('pr-submit：exit 1 → 通用失败文案带输出摘要', async () => {
    const t = makeIo({
      scriptMocks: { [FAKE_PATHS.prSubmit]: { code: 1, stdout: 'Unknown arg: --bogus' } },
    });
    const steps = makeSteps({ root: t.root });
    const submitStep = findStep(steps, 'pr-submit');
    const state = { runId: RUN_ID_A, baseHash: 'B1', base: 'main', params: {}, steps: { 'pr-meta': { status: 'done', outputs: { bodyFile: '/fake/body.md' } } } };
    await assert.rejects(submitStep.run(mkCtx(t, state)), /pr-submit 失败（exit 1）.*Unknown arg/s);
  });

  await test('walker：step 返回 skipped 协议 → 落盘 skipped+reason 且计入终态 skippedSteps', async () => {
    const t = makeIo({ args: { _runId: 'wf-u2-skipproto' } });
    t.io.steps = [
      { id: 'a', run: async () => ({ v: 1 }) },
      { id: 'cond', run: async () => ({ skipped: true, reason: '条件不满足（测试）' }) },
      { id: 'b', run: async () => ({ v: 2 }) },
    ];
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push');
    assert.deepStrictEqual(result.skippedSteps, [{ step: 'cond', reason: '条件不满足（测试）' }]);
    const state = readStateFile(t.root, result.runId);
    assert.strictEqual(state.steps.cond.status, 'skipped');
    assert.strictEqual(state.steps.a.status, 'done');
    assert.strictEqual(state.steps.b.status, 'done');
  });

  await test('worktreeDirt：.review/ 脚本自持目录不计入工作区脏（冒烟实证防自挡）', () => {
    const out = '?? .review/\n M src/a.js\n?? .review/pr-workflow/\n?? new-file.txt\n';
    assert.strictEqual(
      lib.worktreeDirt(out),
      ' M src/a.js\n?? new-file.txt',
    );
    assert.strictEqual(lib.worktreeDirt('?? .review/\n'), '');
    assert.strictEqual(lib.worktreeDirt(''), '');
  });

  /* ── u3：门禁 steps（constraints / coverage-1 / metrics-1 / final-gates + simplify mock） ── */

  const PASS_COVERAGE_JSON = {
    verdict: 'pass', base: 'main', min_incremental: 80,
    packages: {
      'packages/runtime': {
        status: 'OK', incremental_pct: 92.3, covered_executable_added_lines: 120,
        executable_added_lines: 130, uncovered_files: [], files_without_lcov: [],
      },
    },
    files: {},
  };
  const FAIL_INSUFFICIENT_JSON = {
    verdict: 'fail', base: 'main', min_incremental: 80,
    packages: {
      'packages/renderer': {
        status: 'FAIL', reason: '增量覆盖率 62.0% < 80%', incremental_pct: 62.0,
        uncovered_files: ['packages/renderer/src/App.vue (7 uncovered / 10)'],
        files_without_lcov: ['packages/renderer/src/unloaded.ts'],
      },
    },
    files: {},
  };
  const FAIL_TEST_FAILURE_JSON = {
    verdict: 'fail', base: 'main', min_incremental: 80,
    packages: {
      'packages/runtime': { status: 'FAIL', reason: 'vtest exited 1: 2 tests failed' },
    },
    files: {},
  };

  // 门禁段全过 mocks（real-pi 凭证就绪 + coverage/metrics/premerge 产物齐备）
  function allGatesMocks(opts = {}) {
    return {
      env: opts.env !== undefined ? opts.env : { XIAOMI_TOKEN_PLAN_CN_API_KEY: 'k-test' },
      scriptMocks: Object.assign({
        [FAKE_PATHS.selectConstraints]: { code: 0, stdout: 'constraints written' },
        [FAKE_PATHS.coverageGate]: { code: 0, stdout: 'Gate-1.6 verdict=pass  min_incremental=80%  (base=main, pkgs=1)' },
        [FAKE_PATHS.metricsGate]: { code: 0, stdout: 'Gate-1.5 verdict=pass  fail=0 warn=1 covered=0(fallow-static)' },
        [FAKE_PATHS.preMerge]: { code: 0, stdout: '[pr-pre-merge] all checks passed ✓' },
      }, opts.scriptMocks),
      agent: opts.agent,
      presetFiles: Object.assign({
        '.review/constraints.md': '# constraints\n',
        '.review/coverage.json': JSON.stringify(PASS_COVERAGE_JSON),
        '.review/metrics.json': JSON.stringify({ verdict: 'pass', base: 'main', fail: [], warn: [], stats: {} }),
        '.review/premerge-result': 'timestamp="x"\nresult="PASS"\n',
      }, opts.presetFiles),
    };
  }

  const shArgsOf = (t, scriptPath) => t.recorded.sh.filter((c) => c[1] === scriptPath);

  // 门禁段注册表：simplify 以 mock 实现替换（隔离真实 agent；本段测试驱动 walker
  // 顺序语义，等价「cr-fix/simplify 成功收敛」）；cr-fix 走真实现，nested loop
  // 经 io.workflow mock 注入
  // cr-fix batch1 扫描源：门禁段测试的默认 reviewer agent（真文件，readdirSync 真实扫描）
  function seedReviewerAgent(root) {
    const dir = path.join(root, '.agents', 'skills', 'pr-cr-fix', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'review-generic.md'), '# generic reviewer\n');
  }

  function gatesSteps(root) {
    return makeSteps({ root, range: STEP_RANGE.gates }).map((s) => {
      if (s.id === 'simplify') return { id: 'simplify', run: async () => ({ applied: 0, proposals: 0 }) }; // simplify mock（cr-fix 走真实现，nested 经 io.workflow mock 注入）
      return s;
    });
  }

  await test('coverageTestInject 注入值分流：exit0=PASS；exit1 按覆盖率不足/测试失败分类；产物缺失 fail-closed', () => {
    assert.strictEqual(lib.coverageTestInject(0, null), 'PASS');
    assert.strictEqual(lib.coverageTestInject(1, FAIL_INSUFFICIENT_JSON), 'PASS'); // 测试全绿仅覆盖不足
    assert.strictEqual(lib.coverageTestInject(1, FAIL_TEST_FAILURE_JSON), 'FAIL');
    assert.strictEqual(lib.coverageTestInject(1, null), 'FAIL'); // fail-closed
    assert.strictEqual(lib.classifyCoverageExit1(FAIL_INSUFFICIENT_JSON), 'insufficient');
    assert.strictEqual(lib.classifyCoverageExit1(FAIL_TEST_FAILURE_JSON), 'test-failure');
    assert.strictEqual(lib.coveragePctOf(PASS_COVERAGE_JSON), 92.3);
  });

  await test('realPiPreflight（pi-fixture 同源）：env key / auth.json / models.json 三源正反', async () => {
    const providerKey = 'XIAOMI_TOKEN_PLAN_CN_API_KEY';
    // env 命中 → null
    const t1 = makeIo({ env: { [providerKey]: 'k' } });
    assert.strictEqual(lib.realPiPreflight(t1.io), null);
    // which pi 失败
    const t2 = makeIo({ cmdResults: { which: { code: 1, stdout: '' } } });
    assertIncludes(lib.realPiPreflight(t2.io), 'pi binary not found');
    // env 强制跳过态
    const t3 = makeIo({ env: { [providerKey]: 'k', TAIJI_SKIP_REAL_PI: '1' } });
    assertIncludes(lib.realPiPreflight(t3.io), 'TAIJI_SKIP_REAL_PI');
    // auth.json stored 条目命中（homedir mock 指向 temp root）
    const t4 = makeIo({
      presetFiles: { '.pi/agent/auth.json': JSON.stringify({ 'xiaomi-token-plan-cn': { key: 'stored-key' } }) },
    });
    Object.defineProperty(t4.io, 'homedir', { value: () => t4.root });
    assert.strictEqual(lib.realPiPreflight(t4.io), null);
    // models.json providers.apiKey 命中
    const t5 = makeIo({
      presetFiles: { '.pi/agent/models.json': JSON.stringify({ providers: { 'xiaomi-token-plan-cn': { apiKey: 'mk' } } }) },
    });
    Object.defineProperty(t5.io, 'homedir', { value: () => t5.root });
    assert.strictEqual(lib.realPiPreflight(t5.io), null);
    // 全缺 → 三源理由
    const t6 = makeIo({});
    assertIncludes(lib.realPiPreflight(t6.io), '三源均未命中');
  });

  await test('门禁段全链：constraints → coverage-1 → metrics-1 → final-gates 到 awaiting-push（outputs 契约核验）', async () => {
    const m = allGatesMocks();
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-full' } }, m));
    seedState(t.root, {
      status: 'running',
      steps: {
        preflight: { status: 'done', attempts: 1 },
        'static-gate': { status: 'done', attempts: 1, outputs: { result: 'PASS', changesetWarn: false } },
        changeset: { status: 'skipped', reason: '条件不满足' },
        'pr-meta': { status: 'done', attempts: 1, outputs: { title: 't', bodyFile: 'b.md' } },
        'skill-yaml': { status: 'skipped', reason: '条件不满足' },
        'pr-submit': { status: 'done', attempts: 1, outputs: { prUrl: 'https://github.com/a/b/pull/1' } },
      },
    });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push', `error=${result.error}`);
    assert.deepStrictEqual(result.gates, { coverage: 'pass', metrics: 'pass', premerge: 'PASS' });
    const state = readStateFile(t.root, RUN_ID_A);
    assert.strictEqual(state.steps.constraints.outputs.constraintsFile, path.join(t.root, '.review', 'constraints.md'));
    assert.strictEqual(state.steps['coverage-1'].outputs.coverageVerdict, 'pass');
    assert.strictEqual(state.steps['coverage-1'].outputs.coveragePct, 92.3);
    assert.strictEqual(state.steps['metrics-1'].outputs.metricsVerdict, 'pass');
    assert.deepStrictEqual(state.steps['final-gates'].outputs, {
      coverageVerdict: 'pass', coveragePct: 92.3, metricsVerdict: 'pass', premergeResult: 'PASS',
    });
  });

  await test('constraints：--base 传参断言 + 脚本失败文案 + exit0 但产物缺失', async () => {
    const m = allGatesMocks({});
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-c1' } }, m));
    seedState(t.root, { status: 'running' });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    await lib.runPipeline(t.io);
    const calls = shArgsOf(t, FAKE_PATHS.selectConstraints);
    assert.ok(calls.length >= 1);
    assert.deepStrictEqual(calls[0], ['node', FAKE_PATHS.selectConstraints, '--base', 'main']);
    // 脚本失败
    const m2 = allGatesMocks({ scriptMocks: { [FAKE_PATHS.selectConstraints]: { code: 1, stdout: 'constraints.json unreadable' } } });
    const t2 = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-c2' } }, m2));
    seedState(t2.root, { status: 'running' });
    seedReviewerAgent(t2.root);
    t2.io.steps = gatesSteps(t2.root);
    const r2 = await lib.runPipeline(t2.io);
    assert.strictEqual(r2.failedStep, 'constraints');
    assertIncludes(r2.error, 'select-constraints.mjs 失败');
    // exit 0 但产物缺失
    const t3 = makeIo({
      args: { runId: RUN_ID_A, _runId: 'wf-u3-c3' },
      env: { XIAOMI_TOKEN_PLAN_CN_API_KEY: 'k' },
      scriptMocks: {
        [FAKE_PATHS.selectConstraints]: { code: 0, stdout: 'ok' },
        [FAKE_PATHS.coverageGate]: { code: 0, stdout: 'Gate-1.6 verdict=pass' },
        [FAKE_PATHS.metricsGate]: { code: 0, stdout: 'Gate-1.5 verdict=pass' },
        [FAKE_PATHS.preMerge]: { code: 0, stdout: 'passed' },
      },
      presetFiles: {
        '.review/coverage.json': JSON.stringify(PASS_COVERAGE_JSON),
        '.review/metrics.json': JSON.stringify({ verdict: 'pass', base: 'main', fail: [] }),
        '.review/premerge-result': 'result="PASS"\n',
        // 注意：无 .review/constraints.md
      },
    });
    seedState(t3.root, { status: 'running' });
    seedReviewerAgent(t3.root);
    t3.io.steps = gatesSteps(t3.root);
    const r3 = await lib.runPipeline(t3.io);
    assert.strictEqual(r3.failedStep, 'constraints');
    assertIncludes(r3.error, '未产出');
  });

  await test('coverage-1：diff 含 packages/shared/**/src → 自动追加 --extra-packages；不含则不追加', async () => {
    const covArgsList = [];
    const m = allGatesMocks({
      scriptMocks: {
        [FAKE_PATHS.coverageGate]: (args) => {
          covArgsList.push(args);
          return { code: 0, stdout: 'Gate-1.6 verdict=pass  min_incremental=80%  (base=main, pkgs=1)' };
        },
      },
    });
    const t = makeIo(Object.assign({
      args: { runId: RUN_ID_A, _runId: 'wf-u3-cov1' },
      names: 'packages/shared/src/util.ts\n', // shared 包 src 改动
    }, m));
    seedState(t.root, { status: 'running' });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    await lib.runPipeline(t.io);
    assert.ok(covArgsList.length >= 1);
    assert.ok(covArgsList[0].includes('--extra-packages'), JSON.stringify(covArgsList[0]));
    assert.deepStrictEqual(
      covArgsList[0].slice(covArgsList[0].indexOf('--extra-packages')),
      ['--extra-packages', 'packages/runtime,packages/renderer'],
    );

    const covArgsList2 = [];
    const m2 = allGatesMocks({
      scriptMocks: {
        [FAKE_PATHS.coverageGate]: (args) => {
          covArgsList2.push(args);
          return { code: 0, stdout: 'Gate-1.6 verdict=pass  min_incremental=80%  (base=main, pkgs=1)' };
        },
      },
    });
    const t2 = makeIo(Object.assign({
      args: { runId: RUN_ID_A, _runId: 'wf-u3-cov2' },
      names: 'packages/runtime/src/a.ts\n', // 无 shared src 改动
    }, m2));
    seedState(t2.root, { status: 'running' });
    seedReviewerAgent(t2.root);
    t2.io.steps = gatesSteps(t2.root);
    await lib.runPipeline(t2.io);
    assert.ok(!covArgsList2[0].includes('--extra-packages'), JSON.stringify(covArgsList2[0]));
  });

  await test('coverage-1：exit 1（覆盖率不足）→ 派测试 agent 定点补（fixPrompt 含 uncovered_files 清单）→ 第 2 轮过', async () => {
    let covRuns = 0;
    const t = makeIo({
      args: { runId: RUN_ID_A, _runId: 'wf-u3-cov3' },
      env: { XIAOMI_TOKEN_PLAN_CN_API_KEY: 'k' },
      agent: async () => ({ value: {}, error: null }),
      presetFiles: {
        '.review/constraints.md': '# c\n',
        '.review/coverage.json': JSON.stringify(FAIL_INSUFFICIENT_JSON),
        '.review/metrics.json': JSON.stringify({ verdict: 'pass', base: 'main', fail: [] }),
        '.review/premerge-result': 'result="PASS"\n',
      },
      scriptMocks: {
        [FAKE_PATHS.selectConstraints]: { code: 0, stdout: 'ok' },
        [FAKE_PATHS.coverageGate]: () => {
          covRuns += 1;
          if (covRuns === 1) return { code: 1, stdout: 'Gate-1.6 verdict=fail' };
          // agent「补完测试」后的下一轮：产物写回 pass
          fs.writeFileSync(path.join(t.root, '.review', 'coverage.json'), JSON.stringify(PASS_COVERAGE_JSON));
          return { code: 0, stdout: 'Gate-1.6 verdict=pass' };
        },
        [FAKE_PATHS.metricsGate]: { code: 0, stdout: 'Gate-1.5 verdict=pass' },
        [FAKE_PATHS.preMerge]: { code: 0, stdout: '[pr-pre-merge] all checks passed ✓' },
      },
    });
    seedState(t.root, { status: 'running' });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push', `error=${result.error}`);
    assert.strictEqual(covRuns, 3); // coverage-1 两轮（fail→pass）+ final-gates ① 复跑 1 次
    const fixCalls = t.agentCalls.filter((c) => c.description === 'fix-coverage-1');
    assert.strictEqual(fixCalls.length, 1);
    assertIncludes(fixCalls[0].prompt, 'fix: gate coverage-1 round 1');
    assertIncludes(fixCalls[0].prompt, 'packages/renderer/src/App.vue (7 uncovered / 10)'); // uncovered_files 定点（条目 = 未覆盖/总行，I-13 语义）
    assertIncludes(fixCalls[0].prompt, 'packages/renderer/src/unloaded.ts'); // files_without_lcov
    const state = readStateFile(t.root, RUN_ID_A);
    assert.strictEqual(state.steps['coverage-1'].outputs.coverageVerdict, 'pass');
    assert.strictEqual(state.steps['coverage-1'].attempts, 1);
  });

  await test('coverage-1：exit 2（工具错误）→ failed 不自动重试（gate 1 次、agent 0 次）', async () => {
    let covRuns = 0;
    const m = allGatesMocks({
      scriptMocks: {
        [FAKE_PATHS.coverageGate]: () => {
          covRuns += 1;
          return { code: 2, stderr: 'ERROR: 记账不闭合' };
        },
      },
    });
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-cov4' } }, m));
    seedState(t.root, { status: 'running' });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'coverage-1');
    assert.strictEqual(covRuns, 1);
    assert.strictEqual(t.agentCalls.length, 0);
    assertIncludes(result.error, '工具错误，不自动重试');
  });

  await test('metrics-1：warn 放行原值透传；coverage.json 缺失（fallow 静态降级）不误判；fail→agent 修→过', async () => {
    // warn verdict 透传
    const m = allGatesMocks({
      presetFiles: {
        '.review/metrics.json': JSON.stringify({ verdict: 'warn', base: 'main', fail: [], warn: [{}], stats: { coverage_basis: 'fallow-static' } }),
      },
    });
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-m1' } }, m));
    seedState(t.root, { status: 'running' });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    const r1 = await lib.runPipeline(t.io);
    assert.strictEqual(r1.status, 'awaiting-push');
    assert.strictEqual(readStateFile(t.root, RUN_ID_A).steps['metrics-1'].outputs.metricsVerdict, 'warn');

    // coverage.json 缺失（metrics-gate 自身降级 fallow-static 后仍 exit 0）→ step 不误判
    const m2 = allGatesMocks({
      presetFiles: {
        '.review/metrics.json': JSON.stringify({ verdict: 'pass', base: 'main', fail: [], stats: { coverage_basis: 'fallow-static' } }),
      },
    });
    delete m2.presetFiles['.review/coverage.json'];
    const t2 = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-m2' } }, m2));
    seedState(t2.root, { status: 'running' });
    seedReviewerAgent(t2.root);
    t2.io.steps = gatesSteps(t2.root);
    const r2 = await lib.runPipeline(t2.io);
    assert.strictEqual(r2.status, 'awaiting-push');

    // fail → agent 修 → 第 2 轮过
    let metRuns = 0;
    const t3 = makeIo({
      args: { runId: RUN_ID_A, _runId: 'wf-u3-m3' },
      env: { XIAOMI_TOKEN_PLAN_CN_API_KEY: 'k' },
      presetFiles: {
        '.review/constraints.md': '# c\n',
        '.review/coverage.json': JSON.stringify(PASS_COVERAGE_JSON),
        '.review/premerge-result': 'result="PASS"\n',
      },
      scriptMocks: {
        [FAKE_PATHS.selectConstraints]: { code: 0, stdout: 'ok' },
        [FAKE_PATHS.coverageGate]: { code: 0, stdout: 'Gate-1.6 verdict=pass' },
        [FAKE_PATHS.metricsGate]: () => {
          metRuns += 1;
          if (metRuns === 1) return { code: 1, stdout: 'Gate-1.5 verdict=fail' };
          return { code: 0, stdout: 'Gate-1.5 verdict=pass' };
        },
        [FAKE_PATHS.preMerge]: { code: 0, stdout: '[pr-pre-merge] all checks passed ✓' },
      },
    });
    seedState(t3.root, { status: 'running' });
    seedReviewerAgent(t3.root);
    t3.io.steps = gatesSteps(t3.root);
    const r3 = await lib.runPipeline(t3.io);
    assert.strictEqual(r3.status, 'awaiting-push');
    assert.strictEqual(metRuns, 3); // metrics-1 两轮（fail→pass）+ final-gates ② 复跑 1 次
    const fixCalls = t3.agentCalls.filter((c) => c.description === 'fix-metrics-1');
    assert.strictEqual(fixCalls.length, 1);
    assertIncludes(fixCalls[0].prompt, 'fix: gate metrics-1 round 1');
  });

  await test('final-gates：③ 收到 ① 的注入值（--test-result PASS 传参断言）+ marker 解析', async () => {
    const m = allGatesMocks({
      scriptMocks: {
        [FAKE_PATHS.preMerge]: (args) => {
          if (args.includes('--test-result')) {
            const inject = args[args.indexOf('--test-result') + 1];
            fs.writeFileSync(path.join(t.root, '.review', 'premerge-result'), `result="${inject}"\n`);
            return { code: 0, stdout: '[pr-pre-merge] all checks passed ✓' };
          }
          return { code: 0, stdout: '?' };
        },
      },
    });
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-fg1' } }, m));
    seedState(t.root, { status: 'running' });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push', `error=${result.error}`);
    const withInject = shArgsOf(t, FAKE_PATHS.preMerge).filter((c) => c.includes('--test-result'));
    assert.ok(withInject.length >= 1, '③ 应以 --test-result 注入值执行');
    assert.deepStrictEqual(withInject[0], ['bash', FAKE_PATHS.preMerge, '--test-result', 'PASS', '--base', 'main']);
    assert.strictEqual(readStateFile(t.root, RUN_ID_A).steps['final-gates'].outputs.premergeResult, 'PASS');
  });

  await test('final-gates：real-pi 预检缺失 → failed（fail-fast，三动作零执行）', async () => {
    const m = allGatesMocks({ env: {} }); // 无凭证
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-fg2' } }, m));
    seedState(t.root, {
      status: 'running',
      steps: {
        constraints: { status: 'done', attempts: 1, outputs: { constraintsFile: 'c.md' } },
        'coverage-1': { status: 'done', attempts: 1, outputs: { coverageVerdict: 'pass', coveragePct: 92.3 } },
        'metrics-1': { status: 'done', attempts: 1, outputs: { metricsVerdict: 'pass' } },
        'cr-fix': { status: 'done', attempts: 1, outputs: { nestedRunId: ['wf-x'], terminated: 'clean', aggregatedFile: null } },
      },
    });
    t.io.steps = gatesSteps(t.root);
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'final-gates');
    assertIncludes(result.error, 'real-pi 凭证预检未过');
    assertIncludes(result.error, '三源均未命中');
    assertIncludes(result.error, '不得凭 skip 宣布 PASS');
    assert.strictEqual(shArgsOf(t, FAKE_PATHS.coverageGate).length, 0); // 预检先于三动作
    assert.strictEqual(t.agentCalls.length, 0);
  });

  await test('final-gates：输出检出 real-pi skip 标记（console.warn 与 describe 名两种形态）→ failed', async () => {
    for (const markerOut of [
      '[equivalence] 真实 pi（LLM turn）用例 skip：pi 凭证不可用：DEFAULT_MODEL 需要 API key',
      'completion backflow e2e real pi（skip：pi 凭证不可用：DEFAULT_MODEL 需要 API key）',
    ]) {
      const m = allGatesMocks({
        scriptMocks: { [FAKE_PATHS.preMerge]: { code: 0, stdout: markerOut } },
      });
      const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-fg3' } }, m));
      seedState(t.root, { status: 'running' });
    seedReviewerAgent(t.root);
      t.io.steps = gatesSteps(t.root);
      const result = await lib.runPipeline(t.io);
      assert.strictEqual(result.status, 'failed', `marker=${markerOut}`);
      assert.strictEqual(result.failedStep, 'final-gates');
      assertIncludes(result.error, 'real-pi skip 标记');
      assertIncludes(result.error, '不得凭 skip 宣布 PASS');
    }
  });

  await test('final-gates：收尾防线——三动作全过但工作区脏（.review/ 除外）→ failed', async () => {
    const m = allGatesMocks({});
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-fg4' } }, m));
    seedState(t.root, { status: 'running' });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    const origSh = t.io.sh;
    let statusCalls = 0;
    t.io.sh = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'status') {
        statusCalls += 1;
        if (statusCalls >= 2) return { code: 0, stdout: ' M unfixed.js\n' }; // 第 1 次是守卫 5（干净）；第 2 次是 final-gates 收尾（置脏）
        return origSh(cmd, args);
      }
      return origSh(cmd, args);
    };
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'final-gates');
    assertIncludes(result.error, '收尾防线');
    assertIncludes(result.error, 'unfixed.js');
    assertIncludes(result.error, 'git add <显式路径> && git commit');
  });

  await test('final-gates：① 恒败 → 内部子循环 3 轮上限 failed（gate 3 次、agent 2 次）', async () => {
    let covRuns = 0;
    const m = allGatesMocks({
      scriptMocks: {
        [FAKE_PATHS.coverageGate]: () => {
          covRuns += 1;
          return { code: 1, stdout: 'Gate-1.6 verdict=fail' };
        },
      },
      presetFiles: { '.review/coverage.json': JSON.stringify(FAIL_INSUFFICIENT_JSON) },
    });
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-fg5' } }, m));
    seedState(t.root, {
      status: 'running',
      steps: {
        constraints: { status: 'done', attempts: 1, outputs: { constraintsFile: 'c.md' } },
        'coverage-1': { status: 'done', attempts: 1, outputs: { coverageVerdict: 'pass', coveragePct: 92.3 } },
        'metrics-1': { status: 'done', attempts: 1, outputs: { metricsVerdict: 'pass' } },
        'cr-fix': { status: 'done', attempts: 1, outputs: { nestedRunId: ['wf-x'], terminated: 'clean', aggregatedFile: null } },
      },
    });
    t.io.steps = gatesSteps(t.root);
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'final-gates');
    assert.strictEqual(covRuns, lib.MAX_GATE_ROUNDS);
    assert.strictEqual(t.agentCalls.filter((c) => c.description === 'fix-final-gates').length, lib.MAX_GATE_ROUNDS - 1);
    assertIncludes(result.error, '3 轮修复子循环仍未通过');
  });

  await test('final-gates：③ exit 2（coverage.json base 不一致等注入校验失败）→ failed 不重试', async () => {
    let preRuns = 0;
    const m = allGatesMocks({
      scriptMocks: {
        [FAKE_PATHS.preMerge]: () => {
          preRuns += 1;
          return { code: 2, stderr: 'ERROR: .review/coverage.json 的 base="dev" 与本次 base="main" 不一致' };
        },
      },
    });
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-fg6' } }, m));
    seedState(t.root, { status: 'running' });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'final-gates');
    assert.strictEqual(preRuns, 1); // 工具错误不重试
    assertIncludes(result.error, '工具错误，不自动重试');
    assertIncludes(result.error, 'base="dev"');
  });

  await test('注册表占位清零：u5 后十二 step 全为真实现', async () => {
    const steps = makeSteps({ root: '/fake-root-placeholder' });
    assert.strictEqual(steps.length, 12);
    for (const s of steps) assert.ok(!s.id.startsWith('placeholder'), s.id);
    // 集成：前九步 done → walker 走到 cr-fix → failed
    const m = allGatesMocks({});
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u3-ph' } }, m));
    seedState(t.root, {
      status: 'running',
      steps: {
        preflight: { status: 'done', attempts: 1 },
        'static-gate': { status: 'done', attempts: 1, outputs: { result: 'PASS', changesetWarn: false } },
        changeset: { status: 'skipped', reason: 'c' },
        'pr-meta': { status: 'done', attempts: 1, outputs: { title: 't', bodyFile: 'b' } },
        'skill-yaml': { status: 'skipped', reason: 'c' },
        'pr-submit': { status: 'done', attempts: 1, outputs: { prUrl: 'https://github.com/a/b/pull/1' } },
        constraints: { status: 'done', attempts: 1, outputs: { constraintsFile: 'c.md' } },
        'coverage-1': { status: 'done', attempts: 1, outputs: { coverageVerdict: 'pass', coveragePct: 92.3 } },
        'metrics-1': { status: 'done', attempts: 1, outputs: { metricsVerdict: 'pass' } },
      },
    });
    t.io.steps = makeSteps({ root: t.root, range: STEP_RANGE.gates }); // 真注册表
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'cr-fix');
    assertIncludes(result.error, 'batch1 组装失败'); // u4：cr-fix 真实现——agents 目录为空 → 组装 fail-fast
  });



  /* ── u4：cr-fix step（terminated 映射 / 重试恰 1 次 / batch1 组装 / aggregatedFile） ── */

  function rflResult(terminated, runDir, extra = {}) {
    return {
      content: '',
      parsedOutput: Object.assign({ terminated, runDir, batches: 1, totalFixed: 2, message: `nested ${terminated}` }, extra),
    };
  }

  function crFixCtx(t, reviewers) {
    return {
      state: { runId: RUN_ID_A, base: 'main', baseHash: 'B1', params: { reviewers: reviewers || null, maxRounds: 10, skipSteps: [], allowExternalChanges: false } },
      params: { reviewers: reviewers || null, maxRounds: 10, skipSteps: [], allowExternalChanges: false },
      runIdDir: path.join(t.root, 'run-dir'),
      io: t.io,
      saveCheckpoint() {},
    };
  }

  async function driveCrFix(t, reviewers) {
    const step = findStep(makeSteps({ root: t.root }), 'cr-fix');
    return step.run(crFixCtx(t, reviewers));
  }

  function seedRflRunDir(root, runId, withAggregated) {
    const runDir = path.join(root, '.review-fix-loop', 'demo', runId);
    if (withAggregated) {
      fs.mkdirSync(path.join(runDir, 'batch-1', 'round-2'), { recursive: true });
      fs.writeFileSync(path.join(runDir, 'batch-1', 'round-2', 'aggregated.md'), '# aggregated\n');
    } else {
      fs.mkdirSync(runDir, { recursive: true });
    }
    return runDir;
  }

  await test('cr-fix：clean → outputs 契约（nestedRunId=runDir basename，aggregatedFile 定位 batch/round 深层）', async () => {
    const t = t0({
      workflow: async () => rflResult('clean', seedRflRunDir(t.root, 'wf-clean-1', true)),
    });
    const res = await driveCrFix(t);
    assert.strictEqual(res.terminated, 'clean');
    assert.deepStrictEqual(res.nestedRunId, ['wf-clean-1']); // runDir basename
    assert.strictEqual(res.aggregatedFile, path.join(t.root, '.review-fix-loop', 'demo', 'wf-clean-1', 'batch-1', 'round-2', 'aggregated.md')); // 深层定位
  });

  await test('cr-fix：nested 参数逐项断言（targetType/target/batch1/maxRounds/autoCommit/skipCleanAgents/aggregatorModel）', async () => {
    const t = t0();
    t.io.fs.mkdirSync(path.join(t.root, '.agents', 'skills', 'pr-cr-fix', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(t.root, '.agents', 'skills', 'pr-cr-fix', 'agents', 'review-b.md'), '# b\n');
    fs.writeFileSync(path.join(t.root, '.agents', 'skills', 'pr-cr-fix', 'agents', 'review-a.md'), '# a\n');
    await driveCrFix(t);
    assert.strictEqual(t.workflowCalls.length, 1);
    assert.strictEqual(t.workflowCalls[0].name, 'review-fix-loop');
    const p = t.workflowCalls[0].params;
    assert.strictEqual(p.targetType, 'git-diff');
    assert.strictEqual(p.target, 'main');
    const batchFiles = p.batch1.split(',');
    assert.deepStrictEqual(batchFiles, [
      path.join(t.root, '.agents', 'skills', 'pr-cr-fix', 'agents', 'review-a.md'),
      path.join(t.root, '.agents', 'skills', 'pr-cr-fix', 'agents', 'review-b.md'),
      path.join(t.root, '.agents', 'skills', 'pr-cr-fix', 'agents', 'review-generic.md'),
    ]); // 排序后绝对路径逗号拼接（含 t0 默认 generic reviewer）
    assert.strictEqual(p.maxRounds, 10);
    assert.strictEqual(p.autoCommit, true);
    assert.strictEqual(p.skipCleanAgents, true);
    assert.ok(!('aggregatorModel' in p), `缺省不传 = loop 跟随 run 模型（Gate B S1）：${JSON.stringify(p)}`);
  });

  await test('cr-fix：reviewers 白名单交集裁剪（substring 匹配）；全不匹配 → batch1 组装失败文案', async () => {
    const t = t0();
    const dir = path.join(t.root, '.agents', 'skills', 'pr-cr-fix', 'agents');
    t.io.fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'review-electron-build.md'), '# e\n');
    fs.writeFileSync(path.join(dir, 'review-extension-api.md'), '# x\n');
    fs.writeFileSync(path.join(dir, 'review-renderer-ui.md'), '# r\n');
    await driveCrFix(t, ['electron-build', 'renderer-ui']);
    const got = t.workflowCalls[0].params.batch1.split(',');
    assert.deepStrictEqual(got, [path.join(dir, 'review-electron-build.md'), path.join(dir, 'review-renderer-ui.md')]);
    // 全不匹配 → 空批次 fail-fast
    const t2 = t0();
    t2.io.fs.mkdirSync(path.join(t2.root, '.agents', 'skills', 'pr-cr-fix', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(t2.root, '.agents', 'skills', 'pr-cr-fix', 'agents', 'review-a.md'), '# a\n');
    await assert.rejects(driveCrFix(t2, ['nope']), /batch1 组装失败/);
  });

  await test('cr-fix：stuck → failed 不重试（nested 1 次），error 含 aggregated 绝对路径与两条处置分支', async () => {
    const runDir = path.join(t0().root, '.rfl', 'wf-stuck');
    const t = t0({ workflow: async () => rflResult('stuck', runDir) });
    fs.mkdirSync(path.join(runDir, 'batch-1', 'round-2'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'batch-1', 'round-2', 'aggregated.md'), '# aggregated\n');
    await assert.rejects(driveCrFix(t), (e) => {
      assertIncludes(e.message, '终态 stuck');
      assertIncludes(e.message, path.join(runDir, 'batch-1', 'round-2', 'aggregated.md')); // 存在性核验后的绝对路径
      assertIncludes(e.message, 'skipSteps:["cr-fix"]'); // 分支①
      assertIncludes(e.message, '修复 commit 后 resume'); // 分支②
      assertIncludes(e.message, 'nested stuck'); // message 透传
      return true;
    });
    assert.strictEqual(t.workflowCalls.length, 1); // stuck 不重试
  });

  await test('cr-fix：max-rounds 且 runDir 无 aggregated.md → 文案降级为 runDir；needs-redesign 同组 failed', async () => {
    const runDir = path.join(t0().root, '.rfl', 'wf-max');
    const t = t0({ workflow: async () => rflResult('max-rounds', runDir) });
    fs.mkdirSync(runDir, { recursive: true });
    await assert.rejects(driveCrFix(t), (e) => {
      assert.ok(!e.message.includes('aggregated.md'), `无报告场景不应出现文件路径：${e.message}`);
      assert.ok(e.message.includes(runDir), `降级 runDir：${e.message}`);
      return true;
    });
    const t2 = t0({ workflow: async () => rflResult('needs-redesign', path.join(t2.root, '.rfl', 'wf-nr')) });
    await assert.rejects(driveCrFix(t2), /终态 needs-redesign/);
  });

  await test('cr-fix：review-failure → 自动重试恰 1 次后 clean（nested 2 次、nestedRunId 数组 2 项）', async () => {
    let calls = 0;
    const t = t0({
      workflow: async () => {
        calls += 1;
        return calls === 1 ? rflResult('review-failure', path.join(t.root, '.rfl', 'wf-r1')) : rflResult('clean', path.join(t.root, '.rfl', 'wf-r2'));
      },
    });
    const res = await driveCrFix(t);
    assert.strictEqual(res.terminated, 'clean');
    assert.strictEqual(calls, 2); // 恰 1 次重试
    assert.deepStrictEqual(res.nestedRunId, ['wf-r1', 'wf-r2']);
  });

  await test('cr-fix：aggregator-failure / fix-failure 重试后再败 → failed（各 2 次）', async () => {
    for (const term of ['aggregator-failure', 'fix-failure']) {
      let calls = 0;
      const t = t0({
        workflow: async () => {
          calls += 1;
          return rflResult(term, path.join(t.root, '.rfl', `wf-${calls}`));
        },
      });
      await assert.rejects(driveCrFix(t), (e) => {
        assertIncludes(e.message, `连续 2 次 ${term}`);
        assertIncludes(e.message, 'resume');
        return true;
      });
      assert.strictEqual(calls, 2);
    }
  });

  await test('cr-fix：parsedOutput 缺省 → content JSON 兜底解析；未知 terminated → fail-closed failed', async () => {
    const t = t0({
      workflow: async () => ({ parsedOutput: null, content: JSON.stringify({ terminated: 'converged', runDir: path.join(t.root, '.rfl', 'wf-c') }) }),
    });
    fs.mkdirSync(path.join(t.root, '.rfl', 'wf-c'), { recursive: true });
    const res = await driveCrFix(t);
    assert.strictEqual(res.terminated, 'converged');
    // 未知值
    const t2 = t0({ workflow: async () => rflResult('frobnicated', path.join(t2.root, '.rfl', 'wf-u')) });
    await assert.rejects(driveCrFix(t2), (e) => {
      assertIncludes(e.message, '未知值 "frobnicated"');
      assertIncludes(e.message, 'fail-closed');
      return true;
    });
  });

  await test('A 项修复：全 done + status=failed（组装期残留）→ resume 重建 awaiting-push 快照而非回放旧 error', async () => {
    const m = allGatesMocks({});
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u4-rebuild' } }, m));
    const staleResult = { status: 'failed', runId: RUN_ID_A, failedStep: 'final-gates', error: 'io.homedir is not a function（历史残留）', resumeCommand: 'zflow ...', skippedSteps: [] };
    seedState(t.root, {
      status: 'failed',
      failedStep: null,
      error: null,
      lastHead: 'H1',
      result: staleResult,
      steps: {
        preflight: { status: 'done', attempts: 1 },
        'static-gate': { status: 'done', attempts: 1, outputs: { result: 'PASS', changesetWarn: false } },
        changeset: { status: 'skipped', reason: 'c' },
        'pr-meta': { status: 'done', attempts: 1, outputs: { title: 't', bodyFile: 'b.md' } },
        'skill-yaml': { status: 'skipped', reason: 'c' },
        'pr-submit': { status: 'done', attempts: 1, outputs: { prUrl: 'https://github.com/a/b/pull/3' } },
        constraints: { status: 'done', attempts: 1, outputs: { constraintsFile: 'c.md' } },
        'coverage-1': { status: 'done', attempts: 1, outputs: { coverageVerdict: 'pass', coveragePct: 92.3 } },
        'metrics-1': { status: 'done', attempts: 1, outputs: { metricsVerdict: 'pass' } },
        'cr-fix': { status: 'done', attempts: 1, outputs: { nestedRunId: ['wf-x'], terminated: 'clean', aggregatedFile: null } },
        simplify: { status: 'skipped', reason: 'c' },
        'final-gates': { status: 'done', attempts: 1, outputs: { coverageVerdict: 'pass', coveragePct: 92.3, metricsVerdict: 'pass', premergeResult: 'PASS' } },
      },
    });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push'); // 不再回放旧 failed 快照
    assert.strictEqual(result.prUrl, 'https://github.com/a/b/pull/3'); // 从 steps outputs 重建
    assert.strictEqual(result.terminated, 'clean');
    assert.deepStrictEqual(result.gates, { coverage: 'pass', metrics: 'pass', premerge: 'PASS' });
    const state = readStateFile(t.root, RUN_ID_A);
    assert.strictEqual(state.status, 'awaiting-push'); // state 被重写
    assert.strictEqual(state.error, null); // error 清空
    assert.strictEqual(state.failedStep, null);
    assert.deepStrictEqual(state.result, result);
  });

  await test('A 项反面：全 done + status=awaiting-push → 维持幂等回放（result 原样引用）', async () => {
    const snapshot = { status: 'awaiting-push', runId: RUN_ID_A, prUrl: 'https://github.com/a/b/pull/5', terminated: 'clean', simplify: null, gates: { coverage: 'pass', metrics: 'pass', premerge: 'PASS' }, skippedSteps: [] };
    const m = allGatesMocks({});
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u4-replay' } }, m));
    seedState(t.root, {
      status: 'awaiting-push',
      lastHead: 'H1',
      result: snapshot,
      steps: {
        preflight: { status: 'done', attempts: 1 },
        'static-gate': { status: 'done', attempts: 1, outputs: { result: 'PASS', changesetWarn: false } },
        changeset: { status: 'skipped', reason: 'c' },
        'pr-meta': { status: 'done', attempts: 1, outputs: { title: 't', bodyFile: 'b.md' } },
        'skill-yaml': { status: 'skipped', reason: 'c' },
        'pr-submit': { status: 'done', attempts: 1, outputs: { prUrl: snapshot.prUrl } },
        constraints: { status: 'done', attempts: 1, outputs: { constraintsFile: 'c.md' } },
        'coverage-1': { status: 'done', attempts: 1, outputs: { coverageVerdict: 'pass', coveragePct: 92.3 } },
        'metrics-1': { status: 'done', attempts: 1, outputs: { metricsVerdict: 'pass' } },
        'cr-fix': { status: 'done', attempts: 1, outputs: { nestedRunId: ['wf-x'], terminated: 'clean', aggregatedFile: null } },
        simplify: { status: 'skipped', reason: 'c' },
        'final-gates': { status: 'done', attempts: 1, outputs: { coverageVerdict: 'pass', coveragePct: 92.3, metricsVerdict: 'pass', premergeResult: 'PASS' } },
      },
    });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    const result = await lib.runPipeline(t.io);
    assert.deepStrictEqual(result, snapshot); // 原样回放
    assert.strictEqual(readStateFile(t.root, RUN_ID_A).status, 'awaiting-push'); // 状态不变
  });


  // u4 辅助：惰性 io 容器（默认建 batch1 扫描源；测试体内 mock 闭包可引用 t 本体）
  function t0(opts) {
    const t = makeIo(Object.assign({ args: { _runId: 'wf-u4' } }, opts));
    seedReviewerAgent(t.root);
    return t;
  }

  await test('A 项补强（u4 冒烟实证形态）：status=awaiting-push 但 result.status=failed 残留 → 重建而非回放', async () => {
    const staleFailed = { status: 'failed', runId: RUN_ID_A, failedStep: 'cr-fix', error: 'cr-fix batch1 组装失败（历史残留）', resumeCommand: 'zflow ...', skippedSteps: [] };
    const m = allGatesMocks({});
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-u4-rebuild2' } }, m));
    seedState(t.root, {
      status: 'awaiting-push', // status 已被上轮修复，但 result 快照仍是旧 failed
      lastHead: 'H1',
      result: staleFailed,
      steps: {
        preflight: { status: 'done', attempts: 1 },
        'static-gate': { status: 'done', attempts: 1, outputs: { result: 'PASS', changesetWarn: false } },
        changeset: { status: 'skipped', reason: 'c' },
        'pr-meta': { status: 'done', attempts: 1, outputs: { title: 't', bodyFile: 'b.md' } },
        'skill-yaml': { status: 'skipped', reason: 'c' },
        'pr-submit': { status: 'done', attempts: 1, outputs: { prUrl: 'https://github.com/a/b/pull/7' } },
        constraints: { status: 'done', attempts: 1, outputs: { constraintsFile: 'c.md' } },
        'coverage-1': { status: 'done', attempts: 1, outputs: { coverageVerdict: 'pass', coveragePct: 92.3 } },
        'metrics-1': { status: 'done', attempts: 1, outputs: { metricsVerdict: 'pass' } },
        'cr-fix': { status: 'done', attempts: 2, outputs: { nestedRunId: ['wf-real'], terminated: 'clean', aggregatedFile: null } },
        simplify: { status: 'skipped', reason: 'c' },
        'final-gates': { status: 'done', attempts: 1, outputs: { coverageVerdict: 'pass', coveragePct: 92.3, metricsVerdict: 'pass', premergeResult: 'PASS' } },
      },
    });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push'); // 旧 failed 快照不得借 status 蒙混回放
    assert.strictEqual(result.terminated, 'clean'); // 从真实 outputs 重建
    assert.deepStrictEqual(result.gates, { coverage: 'pass', metrics: 'pass', premerge: 'PASS' });
    const state = readStateFile(t.root, RUN_ID_A);
    assert.strictEqual(state.result.status, 'awaiting-push');
  });


  /* ── u5：simplify step（前置判定 / apply-report 两模式 / 工作区与报告校验） ── */

  function crFixDoneCtx(t, { terminated = 'clean', simplifyMode, dirty = false } = {}) {
    if (!t.io.fs.existsSync(path.join(t.root, '.agents', 'skills', 'pr-cr-fix', 'agents', 'simplify-apply.md'))) {
      fs.mkdirSync(path.join(t.root, '.agents', 'skills', 'pr-cr-fix', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(t.root, '.agents', 'skills', 'pr-cr-fix', 'agents', 'simplify-apply.md'), '# 契约（测试桩）\n覆盖声明\n先理解再改\nA 档（行为不变）\n禁止 git add -A\n');
    }
    if (dirty) t.git.porcelain = ' M half-done.js\n';
    const runIdDir = path.join(t.root, 'run-dir');
    const state = {
      runId: RUN_ID_A, base: 'main', baseHash: 'B1',
      params: { simplifyMode: simplifyMode || 'apply', reviewers: null, maxRounds: 10, skipSteps: [], allowExternalChanges: false },
      steps: { 'cr-fix': { status: 'done', attempts: 1, outputs: { nestedRunId: ['wf-1'], terminated, aggregatedFile: null } } },
    };
    return mkCtx(t, state, runIdDir);
  }

  function simplifyStepOf(root) {
    return findStep(makeSteps({ root }), 'simplify');
  }

  // simplify agent mock：写报告文件 + 返回计数（或按 opts 注入异常形态）
  function mockSimplify(t, { applied = 2, proposals = 3 } = {}) {
    t.io.agent = async (params) => {
      t.agentCalls.push(params);
      const m = String(params.prompt).match(/报告输出路径 = (\S+)/);
      if (m) {
        fs.mkdirSync(path.dirname(m[1]), { recursive: true });
        fs.writeFileSync(m[1], '# simplify report\n');
      }
      return { value: { applied, proposals }, error: null };
    };
  }

  await test('simplify：cr-fix clean（apply 默认）→ agent 执行，outputs {applied, proposals, reportFile} 契约', async () => {
    const t = t0();
    mockSimplify(t, { applied: 2, proposals: 3 });
    const res = await simplifyStepOf(t.root).run(crFixDoneCtx(t));
    assert.deepStrictEqual(res, { applied: 2, proposals: 3, reportFile: path.join(t.root, 'run-dir', 'simplify-report.md') });
    assert.strictEqual(t.agentCalls[0].description, 'simplify-apply');
    assert.strictEqual(t.agentCalls[0].timeoutMs, undefined); // apply 写操作不设墙钟超时
  });

  await test('simplify：converged 同样执行；prompt 含覆盖声明、契约全文片段、baseHash、禁 add -A、commit 模板、无超时说明', async () => {
    const t = t0();
    mockSimplify(t);
    await simplifyStepOf(t.root).run(crFixDoneCtx(t, { terminated: 'converged' }));
    const prompt = t.agentCalls[0].prompt;
    assertIncludes(prompt, 'simplifyMode=apply 发起');
    assertIncludes(prompt, '仅 A 档（行为不变）高置信项');
    assertIncludes(prompt, '先理解再改'); // 铁律摘录
    assertIncludes(prompt, 'A 档（行为不变）'); // 档位定义
    assertIncludes(prompt, '禁止 git add -A');
    assertIncludes(prompt, 'refactor: code-simplify — N 项');
    assertIncludes(prompt, 'baseHash = B1');
    assertIncludes(prompt, 'git diff B1...HEAD');
    assertIncludes(prompt, '不设墙钟超时');
    assert.ok(t.agentCalls[0].prompt.includes(path.join(t.root, 'run-dir', 'simplify-report.md')));
  });

  await test('simplify：非 clean（stuck/max-rounds）与 cr-fix 无记录 → skipped+reason（不派 agent 不重算 nested）', async () => {
    for (const terminated of ['stuck', 'max-rounds']) {
      const t = t0();
      mockSimplify(t);
      const res = await simplifyStepOf(t.root).run(crFixDoneCtx(t, { terminated }));
      assert.strictEqual(res.skipped, true, `terminated=${terminated}`);
      assertIncludes(res.reason, 'cr-fix 未 clean/converged');
      assert.strictEqual(t.agentCalls.length, 0); // 不派 agent
    }
    // cr-fix 无记录（被 skipSteps 或旧版本 state）
    const t2 = t0();
    mockSimplify(t2);
    const ctx2 = crFixDoneCtx(t2);
    delete ctx2.state.steps['cr-fix'];
    const res2 = await simplifyStepOf(t2.root).run(ctx2);
    assert.strictEqual(res2.skipped, true);
    assertIncludes(res2.reason, '未执行或被跳过');
    assert.strictEqual(t2.agentCalls.length, 0);
  });

  await test('simplify：report 模式 → prompt 含断点保留声明，outputs.applied=0，报告仍强制落盘', async () => {
    const t = t0();
    mockSimplify(t, { applied: 2, proposals: 5 }); // 即使 agent 谎报 applied，report 模式强制归 0
    const res = await simplifyStepOf(t.root).run(crFixDoneCtx(t, { simplifyMode: 'report' }));
    assert.strictEqual(res.applied, 0);
    assert.strictEqual(res.proposals, 5);
    const prompt = t.agentCalls[0].prompt;
    assertIncludes(prompt, 'simplifyMode=report 发起');
    assertIncludes(prompt, '确认断点完整保留');
    assert.ok(fs.existsSync(path.join(t.root, 'run-dir', 'simplify-report.md')));
  });

  await test('simplify：结构校验失败（value 空）/ agent error → failed 可操作文案', async () => {
    const t = t0({ agent: async () => ({ value: {}, error: null }) });
    await assert.rejects(simplifyStepOf(t.root).run(crFixDoneCtx(t)), /simplify agent 返回不符合契约/);
    const t2 = t0({ agent: async () => ({ value: null, error: 'quota exceeded' }) });
    await assert.rejects(simplifyStepOf(t2.root).run(crFixDoneCtx(t2)), /simplify agent 调用失败：quota exceeded/);
  });

  await test('simplify：声称 applied>0 但工作区脏（未 commit 半成品）→ failed 指引查看报告', async () => {
    const t = t0();
    mockSimplify(t, { applied: 2, proposals: 3 });
    const ctx = crFixDoneCtx(t, { dirty: true });
    await assert.rejects(simplifyStepOf(t.root).run(ctx), (e) => {
      assertIncludes(e.message, '未提交改动');
      assertIncludes(e.message, 'applied=2');
      assertIncludes(e.message, '半成品');
      assertIncludes(e.message, 'simplify-report.md');
      return true;
    });
  });

  await test('simplify：applied=0 却留脏（违规动码）→ failed；报告缺失 → failed', async () => {
    const t = t0();
    mockSimplify(t, { applied: 0, proposals: 2 });
    const ctx = crFixDoneCtx(t, { dirty: true });
    await assert.rejects(simplifyStepOf(t.root).run(ctx), /违规改动代码/);
    // 报告缺失（mock agent 未写报告）
    const t2 = t0({ agent: async () => ({ value: { applied: 0, proposals: 1 }, error: null }) });
    await assert.rejects(simplifyStepOf(t2.root).run(crFixDoneCtx(t2)), /未产出报告/);
  });

  await test('simplify：契约文件缺失 → failed 指向 simplify-apply.md', async () => {
    const t = t0();
    const ctx = crFixDoneCtx(t); // 先经 helper 建桩
    fs.rmSync(path.join(t.root, '.agents', 'skills', 'pr-cr-fix', 'agents', 'simplify-apply.md'), { force: true });
    await assert.rejects(simplifyStepOf(t.root).run(ctx), /simplify-apply\.md/);
  });


  await test('修复批：final-gates marker result="FAIL" → premergeResult 判 FAIL（行解析防御分支可达）', async () => {
    const m = allGatesMocks({
      presetFiles: { '.review/premerge-result': 'timestamp="smoke"\nresult="FAIL"\n' },
    });
    const t = makeIo(Object.assign({ args: { runId: RUN_ID_A, _runId: 'wf-fix-marker' } }, m));
    seedState(t.root, {
      status: 'running',
      steps: {
        constraints: { status: 'done', attempts: 1, outputs: { constraintsFile: 'c.md' } },
        'coverage-1': { status: 'done', attempts: 1, outputs: { coverageVerdict: 'pass', coveragePct: 92.3 } },
        'metrics-1': { status: 'done', attempts: 1, outputs: { metricsVerdict: 'pass' } },
        'cr-fix': { status: 'done', attempts: 1, outputs: { nestedRunId: ['wf-x'], terminated: 'clean', aggregatedFile: null } },
      },
    });
    seedReviewerAgent(t.root);
    t.io.steps = gatesSteps(t.root);
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.failedStep, 'final-gates');
    assertIncludes(result.error, 'marker result=FAIL');
    assert.strictEqual(lib.readPremergeMarker(t.io, t.root), 'FAIL');
  });

  await test('修复批：findAggregatedFile 数值序取最大（round-10 > round-2，防字典序）', () => {
    const t = t0();
    const runDir = path.join(t.root, '.rfl', 'wf-rounds');
    for (const r of ['round-2', 'round-10']) {
      fs.mkdirSync(path.join(runDir, 'batch-1', r), { recursive: true });
      fs.writeFileSync(path.join(runDir, 'batch-1', r, 'aggregated.md'), `# ${r}\n`);
    }
    assert.strictEqual(
      lib.findAggregatedFile(t.io, runDir),
      path.join(runDir, 'batch-1', 'round-10', 'aggregated.md'),
    );
  });


  /* ── Gate B S1：repoRoot 仓库根守卫 + repo 参数解析 ── */

  await test('S1：repoRoot 非 git 根 → fail-fast（不落锁/latest/state），文案指引 --repo', async () => {
    const t = makeIo({ args: { _runId: 'wf-s1' }, failToplevel: true });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.runId, null); // 守卫先于 runId 消费，未建任何 run
    assertIncludes(result.error, '不是有效 git 仓库');
    assertIncludes(result.error, '--repo');
    assertIncludes(result.error, '仓库根绝对路径');
    // fail-fast 先于任何落盘：stateDir 未创建
    assert.strictEqual(fs.existsSync(path.join(t.root, '.review', 'pr-workflow')), false);
    assert.ok(result.resumeCommand.includes('--repo'), result.resumeCommand);
  });

  await test('S1：repoRoot 是仓库子目录（toplevel ≠ repoRoot）→ fail-fast 带 toplevel 对照', async () => {
    const t = makeIo({ args: { _runId: 'wf-s1b' }, toplevelOverride: '/real/repo/root' });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '不是仓库根');
    assertIncludes(result.error, '/real/repo/root');
    assertIncludes(result.error, '--repo');
  });

  await test('S1：repoRoot 合法（toplevel === repoRoot）→ 守卫通过走全链（既有 mock 形态）', async () => {
    const m = allPassMocks();
    const t = makeIo(Object.assign({ args: { _runId: 'wf-s1-ok' } }, m));
    t.io.steps = makeSteps({ root: t.root, range: STEP_RANGE.prOnly });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push', `error=${result.error}`);
  });

  await test('S1：resolveRepoRoot 三态——repo 参数 > workspace 回落 > 双缺省 resolve(".")', () => {
    assert.strictEqual(lib.resolveRepoRoot({ repo: '/abs/repo' }, '/host/cwd'), path.resolve('/abs/repo'));
    assert.strictEqual(lib.resolveRepoRoot({}, '/host/cwd'), path.resolve('/host/cwd'));
    assert.strictEqual(lib.resolveRepoRoot({ repo: '' }, ''), path.resolve('.')); // 双缺省 → 进程 cwd
    assert.strictEqual(lib.resolveRepoRoot({ repo: '   ' }, null), path.resolve('.')); // 空白串视同缺省
  });


  await test('修复批：cr-fix aggregatorModel——显式传入透传 nested，缺省不传键（pi 侧无 zai-coding-cn）', async () => {
    const t = t0({ workflow: async () => rflResult('clean', path.join(t.root, '.rfl', 'wf-am')) });
    const step = findStep(makeSteps({ root: t.root }), 'cr-fix');
    const ctx = crFixCtx(t);
    ctx.state.params.aggregatorModel = 'builtin:bigmodel-coding-plan/GLM-5.3-Flash';
    ctx.params.aggregatorModel = 'builtin:bigmodel-coding-plan/GLM-5.3-Flash';
    await step.run(ctx);
    assert.strictEqual(t.workflowCalls[0].params.aggregatorModel, 'builtin:bigmodel-coding-plan/GLM-5.3-Flash');
    // 缺省：normalizeParams 归一为 null，nested 参数无该键
    assert.strictEqual(lib.normalizeParams({}).aggregatorModel, null);
    const t2 = t0({ workflow: async () => rflResult('clean', path.join(t2.root, '.rfl', 'wf-d')) });
    const ctx2 = crFixCtx(t2);
    await findStep(makeSteps({ root: t2.root }), 'cr-fix').run(ctx2);
    assert.ok(!('aggregatorModel' in t2.workflowCalls[0].params));
  });


  await test('Gate B：stacked PR（base≠main）→ ③ 携带 --base dev-0.9.13 与注入值（S1 现场回归）', async () => {
    const t = makeIo({
      args: { runId: RUN_ID_A, _runId: 'wf-gb-s1', base: 'dev-0.9.13' },
      env: { XIAOMI_TOKEN_PLAN_CN_API_KEY: 'k' },
      presetFiles: {
        '.review/constraints.md': '# c\n',
        '.review/coverage.json': JSON.stringify({ verdict: 'pass', base: 'dev-0.9.13', packages: { p: { status: 'OK', covered_executable_added_lines: 90, executable_added_lines: 100 } }, files: {} }),
        '.review/metrics.json': JSON.stringify({ verdict: 'pass', base: 'dev-0.9.13', fail: [] }),
        '.review/premerge-result': 'result="PASS"\n',
      },
      scriptMocks: {
        [FAKE_PATHS.selectConstraints]: { code: 0, stdout: 'ok' },
        [FAKE_PATHS.coverageGate]: (args) => {
          t.covArgs = args;
          return { code: 0, stdout: 'Gate-1.6 verdict=pass' };
        },
        [FAKE_PATHS.metricsGate]: { code: 0, stdout: 'Gate-1.5 verdict=pass' },
        [FAKE_PATHS.preMerge]: (args) => {
          t.preArgs = args;
          return { code: 0, stdout: '[pr-pre-merge] all checks passed ✓' };
        },
      },
    });
    seedState(t.root, {
      status: 'running',
      base: 'dev-0.9.13',
      steps: {
        preflight: { status: 'done', attempts: 1 },
        'static-gate': { status: 'done', attempts: 1, outputs: { result: 'PASS', changesetWarn: false } },
        changeset: { status: 'skipped', reason: 'c' },
        'pr-meta': { status: 'done', attempts: 1, outputs: { title: 't', bodyFile: 'b.md' } },
        'skill-yaml': { status: 'skipped', reason: 'c' },
        'pr-submit': { status: 'done', attempts: 1, outputs: { prUrl: 'https://github.com/a/b/pull/1' } },
        constraints: { status: 'done', attempts: 1, outputs: { constraintsFile: 'c.md' } },
        'coverage-1': { status: 'done', attempts: 1, outputs: { coverageVerdict: 'pass', coveragePct: 90.0 } },
        'metrics-1': { status: 'done', attempts: 1, outputs: { metricsVerdict: 'pass' } },
        'cr-fix': { status: 'done', attempts: 1, outputs: { nestedRunId: ['wf-x'], terminated: 'clean', aggregatedFile: null } },
        simplify: { status: 'skipped', reason: 'c' },
      },
    });
    t.io.steps = gatesSteps(t.root);
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push', `error=${result.error}`);
    assert.ok(t.covArgs.includes('--base') && t.covArgs.includes('dev-0.9.13'), JSON.stringify(t.covArgs)); // ① 同 base
    assert.deepStrictEqual(t.preArgs, [FAKE_PATHS.preMerge, '--test-result', 'PASS', '--base', 'dev-0.9.13']); // ③ 注入值 + --base 同值
  });


  /* ── Gate B S2：活性守卫主通道 pid 裁决（CLI 本地 kill -9 → 引擎 state 必然 stale） ── */

  await test('S2：主通道 running + 记录 pid 已死 → 接管放行（含判定 log），resume 续跑', async () => {
    const runs = [];
    const t = makeIo({
      args: { runId: RUN_ID_A, _runId: 'wf-s2-dead' },
      engineMap: { 'wf-stale': 'running' }, // 主通道读到 running
      pidMap: {}, // state.pid=222 默认 probePid → dead
      steps: [mkStep('s1', runs)],
    });
    seedState(t.root, { engineRunId: 'wf-stale', pid: 222, steps: { s1: { status: 'failed', attempts: 1, error: 'killed mid-run' } } });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push', `error=${result.error}`); // 接管放行并续跑
    assert.deepStrictEqual(runs, ['s1']);
    assertIncludes(t.recorded.logs.join('\n'), '判定原 run 已死，接管放行');
    assertIncludes(t.recorded.logs.join('\n'), 'CLI 本地 kill 的典型形态');
    const state = readStateFile(t.root, RUN_ID_A);
    assert.strictEqual(state.steps.s1.status, 'done'); // 断点 step 重跑完成
  });

  await test('S2：主通道 running + 记录 pid 存活 → 维持 fail-closed 拦截（daemon 活着且 run 在跑）', async () => {
    const t = makeIo({
      args: { runId: RUN_ID_A, _runId: 'wf-s2-alive' },
      engineMap: { 'wf-live': 'running' },
      pidMap: { 333: 'alive' },
    });
    seedState(t.root, { engineRunId: 'wf-live', pid: 333 });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'failed');
    assertIncludes(result.error, '仍在进行');
    assertIncludes(result.error, 'engineRunId=wf-live');
    assertIncludes(result.error, 'abort'); // 恢复出口指引（daemon 可达时有效）
    // fail-closed 未改写任何产物
    assert.strictEqual(fs.existsSync(path.join(stateDirOf(t.root), 'lock')), false);
  });

  await test('S2：主通道未知 status + pid 死 → 同样放行（running/未知同组裁决）', async () => {
    const t = makeIo({
      args: { runId: RUN_ID_A, _runId: 'wf-s2-weird' },
      engineMap: { 'wf-weird': 'frobnicated' },
    });
    seedState(t.root, { engineRunId: 'wf-weird', pid: 444 });
    const result = await lib.runPipeline(t.io);
    assert.strictEqual(result.status, 'awaiting-push', `error=${result.error}`);
    assertIncludes(t.recorded.logs.join('\n'), 'status=frobnicated');
  });


  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.error('\n失败清单：');
    for (const f of failed) console.error(`  - ${f.name}`);
    process.exitCode = 1;
  }
}

// 单次执行：finally 链挂清理、catch 链挂 runner 自身异常（两次独立调用 main()
// 会把全部用例跑两遍——修复批 F2 曾因此产生 222=111×2 假数字）
main()
  .finally(() => {
    // 统一清理（对齐头注释「测试结束删除」）：全部 mkdtemp root 登记于 tempRoots
    for (const root of tempRoots) {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); } catch { /* 已清理 */ }
    }
  })
  .catch((e) => {
    console.error('runner 自身异常：', e);
    process.exitCode = 1;
  });
