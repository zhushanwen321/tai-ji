/**
 * parse-registry 用例（data-source-governance W24：许可表来自登记表）。
 *
 * 覆盖三面：markdown 表格解析纯函数（§1 主表收 / §3§4 不误收）、真实登记表文件加载
 * （条目集含 #1 与 P1）、许可表条目失真检测（findStaleEntries 纯函数）。
 * 运行：npx vitest run taste-lint（仓库根，builtin-ext-bundle.test.mjs 同款跑法）
 */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRegistryEntries,
  loadRegistryEntries,
  findStaleEntries,
  REGISTRY_PATH,
} from './parse-registry.mjs';

const SAMPLE_MARKDOWN = [
  '# 登记表',
  '## 1. 主表',
  '| 编号 | GUI 数据 | 权威源 |',
  '|---|---|---|',
  '| #1 | session 标签 | pi |',
  '| #2 | session 列表 | pi |',
  '| P1 | plugin sessionData | runtime |',
  '## 3. 写点表（行首非 #N 形态，不得误收）',
  '| 写点 | 位置 |',
  '|---|---|',
  '| 1. 活跃 rename | session-lifecycle.ts |',
  '## 4. 例外表（行首非 #N 形态，不得误收）',
  '| 项 | 登记内容 |',
  '|---|---|',
  '| ① 非活跃 rename | persistSessionName |',
].join('\n');

test('parse: §1 主表行首 #N / PN 收入，§3 §4 其他行式不误收', () => {
  const entries = parseRegistryEntries(SAMPLE_MARKDOWN);
  expect([...entries].sort()).toEqual(['#1', '#2', 'P1']);
});

test('parse: 空表格 / 无主表内容 → 空集（loadRegistryEntries 会 fail loud）', () => {
  expect(parseRegistryEntries('# 无表格文档\n正文').size).toBe(0);
  expect(parseRegistryEntries('').size).toBe(0);
});

test('load: 真实登记表文件解析（条目集 ≥ 13 且含 #1/#12/P1）', () => {
  const entries = loadRegistryEntries();
  expect(entries.size, `登记表条目数 ${entries.size} < 13`).toBeGreaterThanOrEqual(13);
  for (const expected of ['#1', '#12', 'P1']) {
    expect(entries.has(expected), `登记表缺条目 ${expected}`).toBe(true);
  }
});

test('load: REGISTRY_PATH 指向仓库内登记表真实路径', () => {
  expect(
    REGISTRY_PATH.endsWith('docs/architecture/data-source-registry.md'),
    `路径异常：${REGISTRY_PATH}`,
  ).toBe(true);
});

test('findStaleEntries: 许可表条目全部在登记表内 → 空（通过）', () => {
  const registry = new Set(['#1', '#2']);
  const permitted = [
    { suffix: 'a.ts', entries: ['#1'] },
    { suffix: 'b.ts', entries: ['#1', '#2'] },
  ];
  expect(findStaleEntries(permitted, registry)).toEqual([]);
});

test('findStaleEntries: 条目失效（登记表删条目/改号后）→ 检出失效引用', () => {
  const registry = new Set(['#1']);
  const permitted = [
    { suffix: 'a.ts', entries: ['#1'] },
    { suffix: 'b.ts', entries: ['#9'] },
  ];
  const stale = findStaleEntries(permitted, registry);
  expect(stale).toHaveLength(1);
  expect(stale[0].entry).toBe('#9');
  expect(stale[0].suffix).toBe('b.ts');
});

// ── CRAP 定向：parseRegistryEntries 正则分支的畸形/边界行（解析分支全覆盖）──

test('parse: 边界合法形态 → 收入（无空格 / 多空格 / 前导零 / 多位 P）', () => {
  const md = [
    '| 编号 | GUI 数据 |',
    '|---|---|',
    '|#3|', // 无空格（\s* 零次）
    '|  #4  |', // 多空格
    '| #05 |', // 前导零：#\d+ 独立条目（非 #5 归一）
    '| P12 |', // 多位 P 条目
  ].join('\n');
  const entries = parseRegistryEntries(md);
  expect([...entries].sort()).toEqual(['#05', '#3', '#4', 'P12']);
});

test('parse: 畸形行 → 不误收（非数字编号 / 裸 P / 分隔行 / 行中段 / 前缀字符 / 无闭合 pipe 且下一行非表格）', () => {
  const md = [
    '| 编号 | GUI 数据 |',
    '|---|---|', // 分隔行（- 开头，不匹配）
    '| #abc |', // 非数字编号
    '| P |', // 裸 P 无数字
    '| x#7 |', // 首列前有字符（行首锚定）
    '见 | #8 | 的说明', // 行中段（非行首，^ 锚定不命中）
    '| #6', // 无闭合 pipe，且下一行非 | 开头 → \s* 越不过非竖杠行
    '正文段落',
    '| #9 | 备注 |', // 合法形态 + 附加列 → 仍收入（对照）
  ].join('\n');
  const entries = parseRegistryEntries(md);
  expect([...entries]).toEqual(['#9']);
});

test('parse: 无闭合 pipe 行紧邻下一表格行 → 跨行命中 + 吞掉邻行（\\s 含换行的宽松面，现状锁定）', () => {
  // `\s*` 可消费换行：`| #6` + 下一行以 | 开头 → #6 被收入；且 matchAll 消费掉下一行
  // 行首的 `|`，紧邻的合法行 `| #10 |` 反而被跳过（lastIndex 已越过其行首锚点）。
  // 此形态仅在登记表自身已 malformed 时出现；用例锁定现状（跨行收 + 邻行漏收），
  // 防正则改动时该双面行为意外漂移。
  const md = ['| #6', '| #10 |'].join('\n');
  expect([...parseRegistryEntries(md)]).toEqual(['#6']);
  // 对照：无畸形行时 #10 正常收入
  expect([...parseRegistryEntries('| #10 |')]).toEqual(['#10']);
});

test('parse: 同条目多行重复 → Set 去重（许可表校验语义与条目数无关）', () => {
  const md = '| #1 | a |\n| #1 | b |\n| #1 | c |';
  expect([...parseRegistryEntries(md)]).toEqual(['#1']);
});

test('findStaleEntries: 空许可表 → 空（无失效可检）；同一失效条目被多文件引用 → 逐条检出', () => {
  expect(findStaleEntries([], new Set())).toEqual([]);
  const stale = findStaleEntries(
    [
      { suffix: 'a.ts', entries: ['#gone'] },
      { suffix: 'b.ts', entries: ['#gone'] },
    ],
    new Set(['#1']),
  );
  expect(stale).toEqual([
    { entry: '#gone', suffix: 'a.ts' },
    { entry: '#gone', suffix: 'b.ts' },
  ]);
});

// ── CRAP 定向：loadRegistryEntries fail-loud 与缓存（data: URL 变异模块，不落盘）──

/** 经 data: URL 加载变异版 parse-registry（REGISTRY_RELPATH 替换为目标相对路径）。 */
async function loadMutatedRegistry(relpath) {
  // data: URL 模块的 import.meta.url 非 file 协议（fileURLToPath 会抛 scheme 错），
  // ROOT 表达式替换为测试侧计算的仓库根绝对路径（与 lib 模块原表达式同值）
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const mutated = readFileSync(new URL('./parse-registry.mjs', import.meta.url), 'utf8')
    .replaceAll("join(dirname(fileURLToPath(import.meta.url)), '..', '..')", JSON.stringify(repoRoot))
    .replaceAll("join('docs', 'architecture', 'data-source-registry.md')", JSON.stringify(relpath));
  if (mutated.includes("join('docs', 'architecture', 'data-source-registry.md')")) {
    throw new Error('mutation anchor not found');
  }
  return import(`data:text/javascript;base64,${Buffer.from(mutated, 'utf8').toString('base64')}`);
}

test('load: 登记表文件缺失 → fail loud（错误含路径与恢复指引，不静默空集）', async () => {
  const mod = await loadMutatedRegistry('docs/missing-registry-probe.md');
  expect(() => mod.loadRegistryEntries()).toThrow(/missing-registry-probe\.md/);
  expect(() => mod.loadRegistryEntries()).toThrow(/恢复文件后重跑 lint/);
});

test('load: 文件存在但解析 0 条目（格式漂移）→ fail loud（错误指向 §1 主表行首格式）', async () => {
  // package.json 存在但无表格行——模拟登记表被改坏为 0 条目形态
  const mod = await loadMutatedRegistry('package.json');
  expect(() => mod.loadRegistryEntries()).toThrow(/解析出 0 条目/);
  expect(() => mod.loadRegistryEntries()).toThrow(/§1 主表格式/);
});

test('load: 模块级缓存——二次调用返回同一 Set 引用（lint 全程只读一次）', () => {
  const first = loadRegistryEntries();
  expect(loadRegistryEntries()).toBe(first);
});
