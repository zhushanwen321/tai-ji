/**
 * no-unbounded-while-true 规则用例（complexity-debt-full-repayment U01 / 判定锚定，修前绿）。
 *
 * 覆盖面：walkStatements 判定主路径正反用例——无限循环变体（裸循环体 / 空体 / 只递增不比较 /
 * 只比较不递增 / 标识符错位 / 普通 = 赋值不算递增 / 普通赋值右侧比较不收集 / for-of 内层
 * break 不下潜 / for 头部 init-test-update 不收集 / 嵌套 while(true) 只豁免内层）、合法
 * 有界形态（break-return-throw 直退、if 三分支退出、计数器模式含前后缀与 -=、比较藏在
 * 调用参数 / 逻辑链 / 三元 / 变量声明的穿透收集、try-catch-finally、switch case、
 * block / for / do-while 下潜）、豁免通道（文件名四形态、文件级注释 trim 全等 + 位置无关）、
 * 单语句体放行（body 非 BlockStatement 直接放行的现行为漏报边界）、非 while(true) 字面量
 * 不触发。词法序边界：豁免注释写在循环之后仍豁免；计数器比较先于 / 晚于递增均有界。
 * vitest + eslint Linter 直挂规则（no-chat-ops-in-components.test.mjs 同款跑法），
 * parser 用 typescript-eslint 内层（本规则只看 JS 语句形态，无需 vue 外层）。
 * 运行：npx vitest run taste-lint（仓库根，与 CI ci.yml 同命令）
 */
import { test, expect } from 'vitest';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './no-unbounded-while-true.mjs';

const RULE_ID = 'taste/no-unbounded-while-true';
const PROBE_FILE = 'packages/runtime/src/services/probe.ts';

/** 普通 .ts 文件（规则面：除豁免通道外全路径生效） */
function lintTs(code, filename = PROBE_FILE) {
  const linter = new Linter();
  return linter.verify(
    code,
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      plugins: { taste: { rules: { 'no-unbounded-while-true': rule } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename },
  );
}

const lines = (...xs) => xs.join('\n');

// —— 无限循环变体：报 ——

test('裸循环体（无退出、无计数器）报错，messageId 与文案锚定', () => {
  const messages = lintTs(lines('while (true) {', '  work();', '}'));
  expect(messages).toHaveLength(1);
  expect(messages[0].ruleId).toBe(RULE_ID);
  expect(messages[0].severity).toBe(2);
  expect(messages[0].message).toContain('while(true) 循环缺少迭代上限保护');
  expect(messages[0].message).toContain('MAX_ITERATIONS');
});

test('空循环体同样报错', () => {
  const messages = lintTs(lines('while (true) {', '}'));
  expect(messages).toHaveLength(1);
});

test('计数器递增但无比较表达式 → 报', () => {
  const messages = lintTs(lines('while (true) {', '  i++;', '  work();', '}'));
  expect(messages).toHaveLength(1);
});

test('比较表达式但无计数器递增 → 报', () => {
  const messages = lintTs(lines('while (true) {', '  if (i < MAX) {', '    work();', '  }', '}'));
  expect(messages).toHaveLength(1);
});

test('递增与比较标识符错位（j++ 配 i < MAX）→ 报', () => {
  const messages = lintTs(lines('while (true) {', '  j++;', '  if (i < MAX) {', '    work();', '  }', '}'));
  expect(messages).toHaveLength(1);
});

test('普通 = 赋值不算计数器递增（i = i + 1）→ 报', () => {
  const messages = lintTs(lines('while (true) {', '  i = i + 1;', '  if (i < MAX) {', '    work();', '  }', '}'));
  expect(messages).toHaveLength(1);
});

test('比较藏在普通赋值右侧不被收集（done = i >= MAX）→ 报', () => {
  const messages = lintTs(lines('while (true) {', '  i++;', '  done = i >= MAX;', '}'));
  expect(messages).toHaveLength(1);
});

test('for-of 循环体不下潜：内层 break 不豁免外层 → 报', () => {
  const messages = lintTs(lines('while (true) {', '  for (const item of items) {', '    break;', '  }', '}'));
  expect(messages).toHaveLength(1);
});

test('for 语句头部（init/test/update）不参与收集 → 报', () => {
  const messages = lintTs(lines('while (true) {', '  for (let k = 0; k < N; k++) {', '    tick(k);', '  }', '}'));
  expect(messages).toHaveLength(1);
});

test('嵌套 while(true)：内层 break 只豁免内层，外层仍报且仅报 1 处', () => {
  const messages = lintTs(lines('while (true) {', '  while (true) {', '    break;', '  }', '}'));
  expect(messages).toHaveLength(1);
  expect(messages[0].line).toBe(1); // 报在外层 WhileStatement，内层（第 2 行）有界不报
});

test('单语句体放行（body 非 BlockStatement 直接判有界——现行为漏报边界）', () => {
  expect(lintTs('while (true) spin();')).toHaveLength(0);
  expect(lintTs('while (true) i++;')).toHaveLength(0);
});

// —— 合法有界形态：不报 ——

test('break / return / throw 直接退出 → 不报', () => {
  expect(lintTs(lines('while (true) {', '  break;', '}'))).toHaveLength(0);
  // return 需包进函数（顶层 return 是语法错误，与规则判定无关）
  expect(lintTs(lines('function probe() {', '  while (true) {', '    return results;', '  }', '}'))).toHaveLength(0);
  expect(lintTs(lines('while (true) {', '  throw new Error("x");', '}'))).toHaveLength(0);
});

test('if 分支内的退出（block consequent / 单语句 consequent / alternate）→ 不报', () => {
  expect(lintTs(lines('while (true) {', '  if (i >= MAX) {', '    break;', '  }', '  work();', '}'))).toHaveLength(0);
  expect(lintTs(lines('while (true) {', '  if (done) break;', '  work();', '}'))).toHaveLength(0);
  expect(lintTs(lines('while (true) {', '  if (done) work();', '  else break;', '}'))).toHaveLength(0);
  expect(lintTs(lines('function probe() {', '  while (true) {', '    if (!ready) return;', '    work();', '  }', '}'))).toHaveLength(0);
});

test('计数器模式（前后缀递增、-= 递减、递增先于 / 晚于比较）→ 不报', () => {
  // 比较先于递增
  expect(lintTs(lines('while (true) {', '  if (i < MAX) {', '    work();', '  }', '  i++;', '}'))).toHaveLength(0);
  // 递增先于比较
  expect(lintTs(lines('while (true) {', '  i++;', '  if (i < MAX) {', '    work();', '  }', '}'))).toHaveLength(0);
  // 前缀 ++i
  expect(lintTs(lines('while (true) {', '  ++i;', '  if (i >= MAX) {', '    work();', '  }', '}'))).toHaveLength(0);
  // -= 递减 + <= 比较
  expect(lintTs(lines('while (true) {', '  i -= 1;', '  if (i <= 0) {', '    work();', '  }', '}'))).toHaveLength(0);
});

test('比较表达式的穿透收集（调用参数 / 逻辑链 / 三元 / 变量声明初始化）→ 不报', () => {
  // 比较藏在调用参数里
  expect(lintTs(lines('while (true) {', '  i += 1;', '  tick(i < MAX);', '}'))).toHaveLength(0);
  // 逻辑链 &&
  expect(lintTs(lines('while (true) {', '  i++;', '  if (i < MAX && !stopped) {', '    work();', '  }', '}'))).toHaveLength(0);
  // 三元表达式
  expect(lintTs(lines('while (true) {', '  i++;', "  fn(i > MAX ? 'a' : 'b');", '}'))).toHaveLength(0);
  // 变量声明初始化式中的比较（与普通赋值右侧形成对照）
  expect(lintTs(lines('while (true) {', '  i++;', '  const done = i >= MAX;', '}'))).toHaveLength(0);
});

test('try-catch / try-finally 内退出 → 不报', () => {
  expect(lintTs(lines('while (true) {', '  try {', '    work();', '  } catch (err) {', '    break;', '  }', '}'))).toHaveLength(0);
  expect(lintTs(lines('while (true) {', '  try {', '    work();', '  } finally {', '    break;', '  }', '}'))).toHaveLength(0);
});

test('switch case 内 break → 不报', () => {
  const messages = lintTs(lines(
    'while (true) {',
    '  switch (state) {',
    "    case 'done':",
    '      break;',
    '    default:',
    "      state = 'next';",
    '  }',
    '}',
  ));
  expect(messages).toHaveLength(0);
});

test('block / for / do-while 下潜后命中退出 → 不报', () => {
  expect(lintTs(lines('while (true) {', '  {', '    break;', '  }', '}'))).toHaveLength(0);
  expect(lintTs(lines('while (true) {', '  for (;;) {', '    break;', '  }', '}'))).toHaveLength(0);
  expect(lintTs(lines('while (true) {', '  do {', '    break;', '  } while (cond);', '}'))).toHaveLength(0);
});

// —— 豁免通道 ——

test('文件名豁免（.test. / .spec. / __tests__ / /migrations/）→ 不报', () => {
  const bare = lines('while (true) {', '  work();', '}');
  for (const filename of [
    'packages/runtime/src/services/probe.test.ts',
    'packages/runtime/src/services/probe.spec.ts',
    'packages/runtime/src/__tests__/probe.ts',
    'packages/runtime/src/migrations/probe.ts',
  ]) {
    expect(lintTs(bare, filename), filename).toHaveLength(0);
  }
});

test('文件级注释豁免（// 与 /* */ 形态，写在循环之前或之后均豁免）', () => {
  const bare = lines('while (true) {', '  work();', '}');
  expect(lintTs(lines('// taste:allow-unbounded-loop', bare))).toHaveLength(0);
  expect(lintTs(lines('/* taste:allow-unbounded-loop */', bare))).toHaveLength(0);
  // 词法序边界：豁免注释在循环之后同样生效（getAllComments 全文件收集，位置无关）
  expect(lintTs(lines(bare, '// taste:allow-unbounded-loop'))).toHaveLength(0);
});

test('注释带附加说明则不构成豁免（trim 后须全等）→ 仍报', () => {
  const messages = lintTs(lines('// taste:allow-unbounded-loop legacy init', 'while (true) {', '  work();', '}'));
  expect(messages).toHaveLength(1);
});

// —— visitor 触发边界：非 while(true) 字面量 ——

test('非 while(true) 形态不触发（while(1) / while(cond) / while(!!true) / for(;;)）', () => {
  expect(lintTs(lines('while (1) {', '}'))).toHaveLength(0);
  expect(lintTs(lines('while (cond) {', '}'))).toHaveLength(0);
  expect(lintTs(lines('while (!!true) {', '}'))).toHaveLength(0);
  expect(lintTs(lines('for (;;) {', '}'))).toHaveLength(0);
});
