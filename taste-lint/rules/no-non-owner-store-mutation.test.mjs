/**
 * no-non-owner-store-mutation 规则用例（data-source-governance R2）。
 *
 * W4 首版（直呼检测）+ W24 扩展（文件内调用图：形参转发 / 方法引用传递 / 工厂包装）。
 * 收紧是超集不是替换：W4 直呼用例全部保留。
 * vitest + eslint Linter 直挂规则，不依赖仓库 eslint.config；许可表条目经
 * taste-lint/lib/parse-registry.mjs 读真实登记表（登记表驱动的联测面）。
 * 运行：npx vitest run taste-lint（仓库根，builtin-ext-bundle.test.mjs 同款跑法）
 */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './no-non-owner-store-mutation.mjs';

const RULE_ID = 'taste/no-non-owner-store-mutation';

function lintWith(ruleModule, code, filename = 'packages/renderer/src/stores/probe.ts') {
  const linter = new Linter();
  return linter.verify(
    code,
    {
      // flat config 默认不 lint .ts 扩展，须显式 files 才对 .ts 文件名生效；
      // parser 用 typescript-eslint（对齐仓库真实 lint，type-only import 用例需要 TS 语法）
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      plugins: { taste: { rules: { 'no-non-owner-store-mutation': ruleModule } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename },
  );
}

function lint(code, filename = 'packages/renderer/src/stores/probe.ts') {
  return lintWith(rule, code, filename);
}

// ── W4 直呼用例（保留：收紧是超集，不是替换）──────────────────────────────

test('R2: import session store 后直调 applySnapshot → 报错且文案指向登记表', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function rename(id, label) {\n' +
      '  const store = useSessionStore()\n' +
      '  store.applySnapshot(id, { label })\n' +
      '}\n',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toMatch(/applySnapshot/);
  expect(messages[0].message).toMatch(/data-source-registry\.md/);
});

test('R2: 工厂调用直连 useSessionStore().applySnapshot({}) → 报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function load() {\n' +
      '  useSessionStore().applySnapshot({ groups: [] })\n' +
      '}\n',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toMatch(/applySnapshot/);
});

test('R2: store 声明晚于引用它的函数体（词法序盲点）→ 仍报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function rename(id, label) {\n' +
      '  sessionStore.applySnapshot(id, { label })\n' +
      '}\n' +
      'const sessionStore = useSessionStore()\n',
  );
  expect(messages).toHaveLength(1);
});

test('R2: 许可文件（useSidebar.ts）直调 → 通过', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function load() {\n' +
      '  const session = useSessionStore()\n' +
      '  session.applySnapshot({ groups: [] })\n' +
      '  session.applySnapshot("sid", { label: "name" })\n' +
      '}\n',
    'packages/renderer/src/composables/features/sidebar/useSidebar.ts',
  );
  expect(messages).toHaveLength(0);
});

test('R2: 非受管 mutation（revive）→ 通过', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function wake(id) {\n' +
      '  const store = useSessionStore()\n' +
      '  store.revive(id)\n' +
      '}\n',
  );
  expect(messages).toHaveLength(0);
});

test('R2: type-only import（core port 注入形态）→ 通过', () => {
  const messages = lint(
    'import type { createSessionStore } from "./store"\n' +
      'export function rename(store, id, label) {\n' +
      '  store.applySnapshot(id, { label })\n' +
      '}\n',
  );
  expect(messages).toHaveLength(0);
});

test('R2: 测试文件豁免 → 通过', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'const store = useSessionStore()\n' +
      'store.applySnapshot("sid", { label: "name" })\n',
    'packages/renderer/src/stores/probe.test.ts',
  );
  expect(messages).toHaveLength(0);
});

test('R2: 行内豁免注释 taste:allow-non-owner-mutation → 通过', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function rename(id, label) {\n' +
      '  const store = useSessionStore()\n' +
      '  // taste:allow-non-owner-mutation\n' +
      '  store.applySnapshot(id, { label })\n' +
      '}\n',
  );
  expect(messages).toHaveLength(0);
});

// ── W24 调用图用例（一层转发起步）──────────────────────────────────────────

test('R2/W24: 三层转发（load → applyVia(形参 s) → mutation）→ 报错，W4 直呼形态不报的超集', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'function applyVia(s, snapshot) {\n' +
      '  s.applySnapshot(snapshot)\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  const store = useSessionStore()\n' +
      '  applyVia(store, snapshot)\n' +
      '}\n',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toMatch(/applySnapshot/);
  expect(messages[0].message).toMatch(/形参 s/);
  expect(messages[0].message).toMatch(/data-source-registry\.md/);
});

test('R2/W24: 同转发结构但实参非 store（未绑定写通道）→ 通过（超集不扩大误报面）', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'function applyVia(s, snapshot) {\n' +
      '  s.applySnapshot(snapshot)\n' +
      '}\n' +
      'export function load(other, snapshot) {\n' +
      '  applyVia(other, snapshot)\n' +
      '}\n' +
      'const keepFactoryVisible = useSessionStore\n',
  );
  expect(messages).toHaveLength(0);
});

test('R2/W24: 方法引用传递 wire(store.applySnapshot) → 报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function wire(apply) {\n' +
      '  apply({ groups: [] })\n' +
      '}\n' +
      'export function setup() {\n' +
      '  const store = useSessionStore()\n' +
      '  wire(store.applySnapshot)\n' +
      '}\n',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toMatch(/applySnapshot/);
  expect(messages[0].message).toMatch(/值传递|脱离/);
  // detachedMethodRef 文案与同规则其他 message 一致：含登记表路径（可操作性闭环）
  expect(messages[0].message).toMatch(/data-source-registry\.md/);
});

test('R2/W24: 工厂包装 getStore().applySnapshot → 报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'function getStore() {\n' +
      '  return useSessionStore()\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  getStore().applySnapshot(snapshot)\n' +
      '}\n',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toMatch(/getStore/);
});

test('R2/W24: 许可文件内的转发形态 → 通过（owner 文件内部组织自由）', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'function applyVia(s, snapshot) {\n' +
      '  s.applySnapshot(snapshot)\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  const store = useSessionStore()\n' +
      '  applyVia(store, snapshot)\n' +
      '}\n',
    'packages/renderer/src/composables/features/model/useModel.ts',
  );
  expect(messages).toHaveLength(0);
});

test('R2/W24: 无工厂 import 边的文件（port 注入）转发形态 → 通过（S1 语义层管辖）', () => {
  const messages = lint(
    'import type { useSessionStore } from "@/stores/session"\n' +
      'function applyVia(s, snapshot) {\n' +
      '  s.applySnapshot(snapshot)\n' +
      '}\n' +
      'export function orchestrate(store, snapshot) {\n' +
      '  applyVia(store, snapshot)\n' +
      '}\n',
  );
  expect(messages).toHaveLength(0);
});

test('R2/W24: 转发违规 + 行内豁免注释 → 通过', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'function applyVia(s, snapshot) {\n' +
      '  // taste:allow-non-owner-mutation\n' +
      '  s.applySnapshot(snapshot)\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  const store = useSessionStore()\n' +
      '  applyVia(store, snapshot)\n' +
      '}\n',
  );
  expect(messages).toHaveLength(0);
});

// ── W24 R2 逃逸收口用例（verifier 打回 major：双重逃逸静默绕过路径）─────────

test('R2/W24: 表达式体箭头工厂 const grab = () => useSessionStore() → grab().applySnapshot 报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'const grab = () => useSessionStore()\n' +
      'export function load(snapshot) {\n' +
      '  grab().applySnapshot(snapshot)\n' +
      '}\n',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toMatch(/grab/);
});

test('R2/W24: 表达式体箭头 body 引用的实例绑定声明晚于箭头（词法序陷阱）→ 仍报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'const grab = () => s\n' +
      'const s = useSessionStore()\n' +
      'export function load(snapshot) {\n' +
      '  grab().applySnapshot(snapshot)\n' +
      '}\n',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toMatch(/grab/);
});

test('R2/W24: 对象方法包装 box.grab().applySnapshot（MemberExpression receiver）→ 报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'const box = {\n' +
      '  grab() {\n' +
      '    return useSessionStore()\n' +
      '  },\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  box.grab().applySnapshot(snapshot)\n' +
      '}\n',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toMatch(/grab/);
});

test('R2/W24: 非 store 的表达式体箭头 / 对象方法返回值调 applySnapshot → 通过（收口不扩大误报面）', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'const keepFactoryVisible = useSessionStore\n' +
      'function other() {\n' +
      '  return { v: 1 }\n' +
      '}\n' +
      'const get = () => other()\n' +
      'const box = {\n' +
      '  fetch() {\n' +
      '    return other()\n' +
      '  },\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  get().applySnapshot(snapshot)\n' +
      '  box.fetch().applySnapshot(snapshot)\n' +
      '}\n',
  );
  expect(messages).toHaveLength(0);
});

// ── W24 对抗审查修复回归（findings-confirmation-report.md #10）───────────────

test('R2/W24: 无 store import 的文件 + 许可表 stale 条目 → 仍报 stalePermittedEntry（stale 检查先于 factoryBindings 提前 return）', async () => {
  // 临时把 PERMITTED_FILES/WATCHED_MUTATIONS 的条目改为登记表不存在的编号（#999/#998）。
  // ESM 绑定不可写，经源码文本变换生成临时规则模块。不落盘（旧版写 .tmp 探针文件会被
  // fallow 判 unresolved import）：改经 data: URL 动态加载——data: 模块内相对导入不可
  // 解析，故先把 '../lib/parse-registry.mjs' 改写为绝对 file:// URL 再编码。
  const ruleUrl = new URL('./no-non-owner-store-mutation.mjs', import.meta.url);
  const registryUrl = new URL('../lib/parse-registry.mjs', import.meta.url);
  const mutated = readFileSync(ruleUrl, 'utf8')
    .replaceAll(`'../lib/parse-registry.mjs'`, `'${registryUrl.href}'`)
    .replaceAll(`'#1'`, `'#999'`)
    .replaceAll(`'#2'`, `'#998'`);
  const mutatedRule = (
    await import(`data:text/javascript;base64,${Buffer.from(mutated, 'utf8').toString('base64')}`)
  ).default;

  // 被 lint 文件无任何 store import（core 包典型形态）——stale 检查若仍在
  // factoryBindings.size === 0 提前 return 之后，这里静默 0 报（红性锚点）
  const messages = lintWith(
    mutatedRule,
    'export function helper() { return 1 }\n',
    'packages/core/src/domain/session/helper.ts',
  );
  expect(messages.length).toBeGreaterThanOrEqual(1);
  expect(messages.every((m) => m.messageId === 'stalePermittedEntry')).toBe(true);
  expect(messages[0].message).toMatch(/#999/);
  expect(messages[0].message).toMatch(/data-source-registry\.md/);
});

test('R2/W24: 同名形参双函数 f(store)/g(store) 并存 → 两处转发均报（形参通道多函数绑定，非 last-write-wins）', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function f(store) {\n' +
      '  store.applySnapshot({ groups: [] })\n' +
      '}\n' +
      'export function g(store) {\n' +
      '  store.applySnapshot({ groups: [] })\n' +
      '}\n' +
      'export function setup() {\n' +
      '  const s = useSessionStore()\n' +
      '  f(s)\n' +
      '  g(s)\n' +
      '}\n',
  );
  // last-write-wins 版 paramOwnerFn 只保留后写通道（g），f 体内调用漏报 → 仅 1 条（红性锚点）
  expect(messages).toHaveLength(2);
  expect(messages.every((m) => m.messageId === 'forwardedMutation')).toBe(true);
});

// ── CRAP 定向：classify/report 内部分支的边界输入（规则行为回归锁定）─────────

test('R2/CRAP: import 别名 useSessionStore as getStore → 别名通道直调仍报错（ImportSpecifier local.name 分支）', () => {
  const messages = lint(
    'import { useSessionStore as getStore } from "@/stores/session"\n' +
      'export function load() {\n' +
      '  getStore().applySnapshot({ groups: [] })\n' +
      '}\n',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].messageId).toBe('nonOwnerMutation');
  expect(messages[0].message).toMatch(/applySnapshot/);
});

test('R2/CRAP: 同名工厂名 import 自非 store 源（@/stores/workflow）→ 无 import 边，直调通过（STORE_SOURCE_RE 负分支）', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/workflow"\n' +
      'export function load() {\n' +
      '  useSessionStore().applySnapshot({ groups: [] })\n' +
      '}\n',
  );
  expect(messages).toHaveLength(0);
});

test('R2/CRAP: 同名形参双函数，仅其一被喂 store → 未喂函数体内调用不报（fnStack 裁决精度，非文件级形参名匹配）', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function fed(s) {\n' +
      '  s.applySnapshot({ groups: [] })\n' +
      '}\n' +
      'export function notFed(s) {\n' +
      '  s.applySnapshot({ groups: [] })\n' +
      '}\n' +
      'export function setup() {\n' +
      '  const store = useSessionStore()\n' +
      '  fed(store)\n' +
      '}\n',
  );
  // 只报 fed 体内 1 条；notFed 的同名形参未绑定 store 实参（若按文件级形参名匹配会误报 2 条）
  expect(messages).toHaveLength(1);
  expect(messages[0].messageId).toBe('forwardedMutation');
});

test('R2/CRAP: 值位置方法引用 const h = store.applySnapshot（VariableDeclarator init）→ detachedMethodRef 报错', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function setup() {\n' +
      '  const store = useSessionStore()\n' +
      '  const h = store.applySnapshot\n' +
      '  h({ groups: [] })\n' +
      '}\n',
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].messageId).toBe('detachedMethodRef');
  expect(messages[0].message).toMatch(/applySnapshot/);
});

test('R2/CRAP: 声明不追踪的间接形态（数组元素 / computed key 接收者）→ 通过（docstring 已知边界回归锁定）', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'const box = {\n' +
      '  grab() {\n' +
      '    return useSessionStore()\n' +
      '  },\n' +
      '}\n' +
      'export function load(snapshot) {\n' +
      '  const stores = [useSessionStore()]\n' +
      '  stores[0].applySnapshot(snapshot)\n' +
      '  box["grab"]().applySnapshot(snapshot)\n' +
      '}\n',
  );
  // stores[0]（MemberExpression object）不入候选；box["grab"]（computed key property 非
  // Identifier）入候选但 classify null——两形态均为 docstring「已知检出边界」，维持 S1
  expect(messages).toHaveLength(0);
});

test('R2/CRAP: 行内豁免注释位于调用之后（trailing comment）→ 通过（hasInlineAllowComment 的 commentsAfter 分支）', () => {
  const messages = lint(
    'import { useSessionStore } from "@/stores/session"\n' +
      'export function rename(id, label) {\n' +
      '  const store = useSessionStore()\n' +
      '  store.applySnapshot(id, { label }) // taste:allow-non-owner-mutation\n' +
      '}\n',
  );
  expect(messages).toHaveLength(0);
});
