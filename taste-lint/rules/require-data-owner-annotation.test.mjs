/**
 * require-data-owner-annotation 规则用例（data-source-governance R3）。
 *
 * W4 首版（stores/ 范围）+ W24 扩围（renderer/core 全域 + 空容器口径 + 登记表运行时解析）。
 * vitest + eslint Linter 直挂规则；条目校验经 taste-lint/lib/parse-registry.mjs
 * 读真实登记表（登记表驱动）。parser 换 typescript-eslint：扩围用例含 TS 泛型
 * ref<Set<string>>(new Set()) 真实形态（useChat 同款）。
 * 运行：npx vitest run taste-lint（仓库根，builtin-ext-bundle.test.mjs 同款跑法）
 */
import { test, expect } from 'vitest';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './require-data-owner-annotation.mjs';

const RULE_ID = 'taste/require-data-owner-annotation';
const STORES_FILE = 'packages/renderer/src/stores/probe.ts';

function lint(code, filename = STORES_FILE) {
  const linter = new Linter();
  return linter.verify(
    code,
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      plugins: { taste: { rules: { 'require-data-owner-annotation': rule } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename },
  );
}

// ── W4 首版用例（保留）────────────────────────────────────────────────────

test('R3: 模块级 new Map 无注解 → 报错且文案指向登记表', () => {
  const messages = lint('const cache = new Map()\nexport const size = () => cache.size\n');
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toMatch(/@data-owner/);
  expect(messages[0].message).toMatch(/data-source-registry\.md/);
});

test('R3: 模块级 ref 无注解 → 报错', () => {
  const messages = lint('const counter = ref(0)\nexport const read = () => counter.value\n');
  expect(messages).toHaveLength(1);
});

test('R3: 相邻上方注释 @data-owner #1 → 通过', () => {
  const messages = lint('// @data-owner #1\nconst cache = new Map()\n');
  expect(messages).toHaveLength(0);
});

test('R3: 同行尾注释 @data-owner P1 → 通过', () => {
  const messages = lint('const cache = new Map() // @data-owner P1\n');
  expect(messages).toHaveLength(0);
});

test('R3: 引用不存在的登记条目 #99 → 报错（条目必须真实——登记表解析驱动）', () => {
  const messages = lint('// @data-owner #99\nconst cache = new Map()\n');
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toMatch(/#99/);
});

test('R3: 函数作用域内声明（非模块级）→ 通过', () => {
  const messages = lint(
    'export function setup() {\n  const local = new Map()\n  return local\n}\n',
  );
  expect(messages).toHaveLength(0);
});

test('R3: 测试文件豁免 → 通过', () => {
  const messages = lint('const cache = new Map()\n', 'packages/renderer/src/stores/probe.test.ts');
  expect(messages).toHaveLength(0);
});

test('R3: useSessionScopedState 原语本体豁免 → 通过', () => {
  const messages = lint(
    'const registry = new Set()\nexport const add = (fn) => registry.add(fn)\n',
    'packages/core/src/foundation/use-session-scoped-state.ts',
  );
  expect(messages).toHaveLength(0);
});

test('R3: 行内豁免注释 taste:allow-no-data-owner → 通过', () => {
  const messages = lint('// taste:allow-no-data-owner\nconst cache = new Map()\n');
  expect(messages).toHaveLength(0);
});

// ── W24 扩围用例 ──────────────────────────────────────────────────────────

test('R3/W24: composables/ 模块级缓存（W4 范围外）→ 报错（扩围生效）', () => {
  const messages = lint(
    'const cache = new Map()\nexport const read = () => cache.size\n',
    'packages/renderer/src/composables/probe.ts',
  );
  expect(messages).toHaveLength(1);
});

test('R3/W24: core 包模块级缓存 → 报错（扩围生效）', () => {
  const messages = lint(
    'const cache = new Map()\nexport const read = () => cache.size\n',
    'packages/core/src/coordination/probe.ts',
  );
  expect(messages).toHaveLength(1);
});

test('R3/W24: runtime 包模块级缓存 → 通过（范围外：runtime 非 GUI 数据层）', () => {
  const messages = lint(
    'const cache = new Map()\nexport const read = () => cache.size\n',
    'packages/runtime/src/services/session/probe.ts',
  );
  expect(messages).toHaveLength(0);
});

test('R3/W24: 常量查表（字面量初始化容器）→ 通过（W24 检测口径）', () => {
  const messages = lint(
    "const EXTS = new Set(['png', 'jpg'])\nexport const is = (e) => EXTS.has(e)\n" +
      "const NAMES = new Map([['a', 1]])\nexport const get = (k) => NAMES.get(k)\n",
  );
  expect(messages).toHaveLength(0);
});

test('R3/W24: TS 泛型响应式声明 ref<Set<string>>(new Set()) → 报错（useChat 真实形态）', () => {
  const messages = lint(
    'const flags = ref<Set<string>>(new Set())\nexport const has = (k) => flags.value.has(k)\n',
  );
  expect(messages).toHaveLength(1);
});

test('R3/W24: 扩围后豁免注释对 composables 生效 → 通过', () => {
  const messages = lint(
    '// taste:allow-no-data-owner\nconst timers = new Map()\nexport const clear = () => timers.clear()\n',
    'packages/renderer/src/composables/features/probe.ts',
  );
  expect(messages).toHaveLength(0);
});

test('R3/W24: export const 声明 + 紧贴豁免注释 → 通过（attach 边界：注释挂外层 ExportNamedDeclaration）', () => {
  const messages = lint(
    '// taste:allow-no-data-owner\nexport const signal = ref(null)\n',
    'packages/core/src/domain/drawer/probe.ts',
  );
  expect(messages).toHaveLength(0);
});

test('R3/W24: docstring 块中部的 @data-owner → 归属下方声明（源码行回溯）', () => {
  const messages = lint(
    '/**\n * 模块级缓存说明。\n * @data-owner #2\n */\nconst cache = new Map()\n',
  );
  expect(messages).toHaveLength(0);
});
