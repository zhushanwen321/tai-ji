/* eslint-disable no-magic-numbers -- mock fixture 数据（session/message/文件树等演示数据）的字面量数值属领域数据，非逻辑魔数 */
/**
 * Mock fixture —— 最小但结构完整的预制数据（D7：严格镜像 shared 类型）。
 *
 * - 8 个 SessionSummary（5 个演示态 + 3 个 agent 子会话 s3-c1/c2/c3），覆盖 D6 派生 5 态
 *   （error/waiting/done/running/stopped 各一）
 * - [u7a 模式/调度 fixture] s3 额外承载两个演示角色（同一会话，不是新增第三类）：
 *   ① 非默认模式会话：launchPresetId = builtin:session-dispatch（≠ 全局默认 builtin:full）→
 *      composer 只读模式 chip + 流顶声明行的渲染断言锚点；
 *   ② 子会话父节点：3 个 agent 派发子会话（spawnSource:'agent' + parentAgentSessionId:'s3'）→
 *      托盘第 4 件（session kind）计数与面板行断言锚点；子会话状态覆盖 运行中/完成/失败 三支。
 * - s1 多回合（error）：user / assistant text / tool_call(成功+失败) / thinking，
 *   末条 assistant status:error → error 态；覆盖 G2-006 契约所有块类型让 UC-2 可验收（回合折叠 pill 可验）
 * - s2 单回合（waiting）：末条 assistant 含 status:running 的 toolCall → waiting 脉冲
 * - s3 空会话（done）：验证空态欢迎语
 * - s4 流式中（running）：末条 assistant status:streaming → running 脉冲
 * - s5 已中断（stopped）：末条 assistant isInterrupted → stopped 灰态
 * - S3/S4 相关块（@/#// 命令、附件）不造（G2-002 DEFERRED）
 * - fixtureMessages 供 getHistory 回填；mock 运行时 chat.send 另起流式，不复用历史
 *
 * 内存介质（D7）：reload 重置，不写文件。
 */
import type { SessionSummary, Message } from '@taiji/shared'
import { BUILTIN_PRESET_IDS, textToSegments } from '@taiji/shared'

// E2E 构建期由 Vite define 注入 globalThis.__E2E_SAMPLE_PROJECT_CWD__（renderer/vite.config.ts）：
// E2E 构建时替换为 sample-project 绝对路径。vitest/非 E2E 构建时该属性 undefined → 空串兜底。
// 用 globalThis 访问 + 可选链：vitest 运行时无 define，globalThis 上无此属性 → undefined → 空串，不报错。
const E2E_SAMPLE_CWD = (globalThis as unknown as { __E2E_SAMPLE_PROJECT_CWD__?: string }).__E2E_SAMPLE_PROJECT_CWD__ ?? ''

const HOUR = 3_600_000
const DAY = 86_400_000
const MINUTE = 60_000
const NOW = Date.now()

export const fixtureSessions: SessionSummary[] = [
  {
    id: 's1',
    label: '重构 auth 模块',
    cwd: '/Users/dev/Code/taiji',
    gitBranch: 'refactor-auth',
    gitIsWorktree: true,
    status: 'active',
    lastActiveAt: NOW - 2 * HOUR,
    modelId: 'Anthropic/claude-sonnet-4.5',
    thinkingLevel: 'medium',
    tokenCount: 12_300,
  },
  {
    id: 's2',
    label: 'Lint 排查中',
    cwd: '/Users/dev/Code/taiji',
    gitBranch: 'refactor-auth',
    gitIsWorktree: true,
    status: 'active',
    lastActiveAt: NOW - 30 * MINUTE,
    modelId: 'Anthropic/claude-sonnet-4.5',
    tokenCount: 5_400,
  },
  {
    id: 's3',
    label: 'API 性能优化',
    cwd: '/Users/dev/Code/work-project',
    gitBranch: 'main',
    status: 'idle',
    lastActiveAt: NOW - 5 * DAY,
    modelId: 'OpenAI/gpt-5',
    tokenCount: 8_700,
    // [u7a] 非默认模式会话：调度模式（builtin:session-dispatch）≠ 全局默认 builtin:full
    // → composer 只读 chip 与流顶声明行的渲染断言锚点。同时是下方 3 个子会话的父节点。
    launchPresetId: BUILTIN_PRESET_IDS.SESSION_DISPATCH,
  },
  {
    id: 's4',
    label: 'Promise 代码评审',
    cwd: '/Users/dev/Code/work-project',
    status: 'active',
    lastActiveAt: NOW - 4 * MINUTE,
    modelId: 'Anthropic/claude-sonnet-4.5',
    tokenCount: 820,
  },
  {
    id: 's5',
    label: '状态机重构（已废弃）',
    cwd: '/Users/dev/Code/taiji',
    gitBranch: 'feat-fsm',
    gitIsWorktree: true,
    status: 'idle',
    lastActiveAt: NOW - 60 * MINUTE,
    modelId: 'Anthropic/claude-sonnet-4.5',
    tokenCount: 2_400,
  },
  // ── [u7a] 调度模式派发的子会话（parentAgentSessionId → s3）──────────────────────
  // 三支状态覆盖托盘 session 面板分支：c1 运行中（active + running toolCall）、
  // c2 完成态（done）、c3 失败态（error）。cwd 与父会话一致（S5：子会话在父 project 下可见）。
  {
    id: 's3-c1',
    label: '子会话：解析查询计划',
    cwd: '/Users/dev/Code/work-project',
    status: 'active',
    lastActiveAt: NOW - 5 * MINUTE,
    modelId: 'Anthropic/claude-sonnet-4.5',
    tokenCount: 1_800,
    spawnSource: 'agent',
    parentAgentSessionId: 's3',
  },
  {
    id: 's3-c2',
    label: '子会话：压测连接池',
    cwd: '/Users/dev/Code/work-project',
    status: 'done',
    lastActiveAt: NOW - 12 * MINUTE,
    modelId: 'Anthropic/claude-sonnet-4.5',
    tokenCount: 4_200,
    spawnSource: 'agent',
    parentAgentSessionId: 's3',
  },
  {
    id: 's3-c3',
    label: '子会话：回归用例跑批',
    cwd: '/Users/dev/Code/work-project',
    status: 'error',
    lastActiveAt: NOW - 25 * MINUTE,
    modelId: 'Anthropic/claude-sonnet-4.5',
    tokenCount: 900,
    spawnSource: 'agent',
    parentAgentSessionId: 's3',
  },
]

/**
 * 按 sessionId 索引的初始消息。
 * s1：2 个完整回合 —— 回合1（user + assistant 含 thinking + tool_call 成功 + 收尾 summary），
 *     回合2（user + assistant 含 tool_call 失败 + 错误块）。
 * s2：1 个纯文字回合（无工具无思考，验证无折叠条 turn）。
 * s3：空（验证空态）。
 */
export const fixtureMessages: Record<string, Message[]> = {
  s1: [
    // ── 回合 1：完整回合（思考 + 工具成功 + 总结）──
    {
      id: 'u1',
      role: 'user',
      content: textToSegments('帮我看一下 auth 模块的结构，把登录校验改成 async。'),
      status: 'complete',
      timestamp: NOW - 10 * MINUTE,
    },
    {
      id: 'a1',
      role: 'assistant',
      content:
        '已将 AuthService.login 改为 async，返回 Promise<Token>。字段校验下沉到 schema 层，API 失败回退 toast。',
      status: 'complete',
      timestamp: NOW - 9 * MINUTE,
      thinking: [
        {
          id: 'th1',
          content:
            '先确认字段范围（username / password），再建 schema 文件，最后改 Login.vue 接 toTypedSchema。',
          collapsed: true,
        },
      ],
      toolCalls: [
        {
          id: 'tc1',
          toolName: 'read_file',
          input: { path: 'src/auth/index.ts' },
          output: 'export function login() {}',
          status: 'completed',
          startTime: NOW - 9 * MINUTE,
          endTime: NOW - 9 * MINUTE + 200,
        },
        {
          id: 'tc2',
          toolName: 'edit_file',
          input: { path: 'src/auth/index.ts' },
          output: 'async login(): Promise<Token>',
          status: 'completed',
          startTime: NOW - 9 * MINUTE + 300,
          endTime: NOW - 9 * MINUTE + 800,
        },
      ],
      contentBlocks: [
        { type: 'thinking', refId: 'th1' },
        { type: 'toolCall', refId: 'tc1' },
        { type: 'toolCall', refId: 'tc2' },
        { type: 'text', refId: 'text' },
      ],
    },
    // ── 回合 2：含 tool_call 失败（整块红框，错误是 tool 属性）──
    {
      id: 'u2',
      role: 'user',
      content: textToSegments('把改动提交一下'),
      status: 'complete',
      timestamp: NOW - 3 * MINUTE,
    },
    {
      id: 'a2',
      role: 'assistant',
      // [M2 形态统一] 错误文本只住 error 字段，content 恒为崩溃前正文（演示场景：崩溃前正文为空）
      content: '',
      error: '提交时遇到文件锁，写入失败。请确认没有外部进程占用后重试。',
      status: 'error',
      timestamp: NOW - 2 * MINUTE,
      toolCalls: [
        {
          id: 'tc3',
          toolName: 'bash',
          input: { command: 'git commit -m "refactor auth"' },
          output: 'EBUSY: 文件被外部进程占用，写入失败',
          status: 'error',
          startTime: NOW - 2 * MINUTE,
          endTime: NOW - 2 * MINUTE + 120,
        },
      ],
      contentBlocks: [
        { type: 'toolCall', refId: 'tc3' },
        { type: 'text', refId: 'text' },
      ],
    },
  ],
  s2: [
    // ── 回合 1：末条 assistant 含 status:running 的 toolCall → waiting 脉冲态 ──
    {
      id: 'u3',
      role: 'user',
      content: textToSegments('跑一下 lint 看看还有没有问题'),
      status: 'complete',
      timestamp: NOW - 30 * MINUTE,
    },
    {
      id: 'a3',
      role: 'assistant',
      content: '',
      status: 'streaming',
      timestamp: NOW - 29 * MINUTE,
      toolCalls: [
        {
          id: 'tc4',
          toolName: 'bash',
          input: { command: 'npm run lint' },
          status: 'running',
          startTime: NOW - 29 * MINUTE,
        },
      ],
      contentBlocks: [{ type: 'toolCall', refId: 'tc4' }],
    },
  ],
  s3: [],
  s4: [
    // ── 回合 1：末条 assistant status:streaming（流式文本中）→ running 脉冲态 ──
    {
      id: 'u4',
      role: 'user',
      content: textToSegments('解释一下 Promise.allSettled 和 Promise.all 的区别'),
      status: 'complete',
      timestamp: NOW - 5 * MINUTE,
    },
    {
      id: 'a4',
      role: 'assistant',
      content: 'Promise.allSettled 会等所有 promise 完成（不短路），每个返回 {status, value/reason}…',
      status: 'streaming',
      timestamp: NOW - 4 * MINUTE,
    },
  ],
  s5: [
    // ── 回合 1：末条 assistant isInterrupted（用户 abort）→ stopped 灰态 ──
    {
      id: 'u5',
      role: 'user',
      content: textToSegments('把整个状态机重构一遍'),
      status: 'complete',
      timestamp: NOW - 60 * MINUTE,
    },
    {
      id: 'a5',
      role: 'assistant',
      content: '我先看一下现有的状态机实现，然后画一张状态转换图…',
      status: 'complete',
      isInterrupted: true,
      timestamp: NOW - 59 * MINUTE,
    },
  ],
  // ── [u7a] 子会话最小消息流：点开托盘面板行即 hydrate，状态分支可断言 ──
  // c1 末条 assistant 末位 toolCall status:running → 派生 waiting（进行中）
  's3-c1': [
    {
      id: 'u-c1',
      role: 'user',
      content: textToSegments('把 /api/orders 的查询计划解析一下，标出慢点。'),
      status: 'complete',
      timestamp: NOW - 6 * MINUTE,
    },
    {
      id: 'a-c1',
      role: 'assistant',
      content: '',
      status: 'streaming',
      timestamp: NOW - 5 * MINUTE,
      toolCalls: [
        {
          id: 'tc-c1',
          toolName: 'bash',
          input: { command: 'EXPLAIN ANALYZE SELECT * FROM orders' },
          status: 'running',
          startTime: NOW - 5 * MINUTE,
        },
      ],
      contentBlocks: [{ type: 'toolCall', refId: 'tc-c1' }],
    },
  ],
  // c2 末条 assistant 正常收尾 → 派生 done（完成态）
  's3-c2': [
    {
      id: 'u-c2',
      role: 'user',
      content: textToSegments('压测连接池，给出 P95。'),
      status: 'complete',
      timestamp: NOW - 20 * MINUTE,
    },
    {
      id: 'a-c2',
      role: 'assistant',
      content: '连接池在 200 并发下 P95 = 42ms，无排队超时。',
      status: 'complete',
      timestamp: NOW - 12 * MINUTE,
    },
  ],
  // c3 末条 assistant status:error → 派生 error（失败态，面板 error 色分支）
  's3-c3': [
    {
      id: 'u-c3',
      role: 'user',
      content: textToSegments('把回归用例跑一遍。'),
      status: 'complete',
      timestamp: NOW - 30 * MINUTE,
    },
    {
      id: 'a-c3',
      role: 'assistant',
      content: '',
      error: '用例容器启动失败：端口 5432 被占用。',
      status: 'error',
      timestamp: NOW - 25 * MINUTE,
    },
  ],
}

/**
 * E2E fixture session：cwd 指向 e2e/fixtures/sample-project（文件树渲染测试用）。
 *
 * 注入机制（方案 A，侵入小）：VITE_E2E === 'true' 时由 mock/index.ts 的 buildGroups
 * 优先注入此 session，让 W8 文件树 E2E 拿到带确定 cwd 的 session（无需 runtime 子进程）。
 *
 * cwd 路径在构建期由 Vite define 注入（__E2E_SAMPLE_PROJECT_CWD__，见 renderer/vite.config.ts）：
 * renderer 是浏览器环境读不到 process.env / __dirname，必须用构建期常量。
 * 非 E2E 构建时该常量为空串，buildGroups 检测 VITE_E2E 后才使用，故不影响 dev/prod。
 */
export const e2eTestSession: SessionSummary = {
  id: 'e2e-files',
  label: 'E2E 文件树测试',
  // 构建期注入的绝对路径（E2E 构建时 define 为 e2e/fixtures/sample-project 绝对路径，非 E2E 为空串）
  cwd: E2E_SAMPLE_CWD,
  status: 'active',
  lastActiveAt: Date.now(),
  modelId: 'Anthropic/claude-sonnet-4.5',
  tokenCount: 0,
}

let createSeq = 0

/** 创建新 session（内存 push，返回深拷贝避免外部突变 fixture） */
export function createSession(cwd?: string, label?: string): SessionSummary {
  createSeq += 1
  const session: SessionSummary = {
    id: `mock-${NOW + createSeq}`,
    label: label ?? `新会话 ${createSeq}`,
    // cwd 透传（#1）；undefined 时保持 mock 默认目录（与 runtime 回退 process.cwd() 同语义）
    cwd: cwd ?? '/Users/dev/Code/taiji',
    status: 'active',
    lastActiveAt: Date.now(),
    modelId: 'Anthropic/claude-sonnet-4.5',
    tokenCount: 0,
  }
  return session
}
