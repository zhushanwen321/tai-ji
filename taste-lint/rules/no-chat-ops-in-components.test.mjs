/**
 * no-chat-ops-in-components 规则用例（renderer-deepening D6③ / 验收 A8）。
 *
 * 覆盖面：组件 script / template 表达式的 ops 访问拦截（message 指向 facet SSOT）、
 * readers 字段放行、非组件文件放行（composable .ts / 组件目录外 .vue）、工厂直调、
 * 工厂包装（含声明晚于使用点的词法序陷阱）、无 import 边同名变量放行；三个 visitor
 * 的正反用例——create 文件域 gate（.spec/.test.vue 测试壳）、ImportDeclaration
 * （createChatStore/core 深路径激活、import type 与非 store source 放行）、
 * ReturnStatement / 表达式体箭头（FunctionExpression / 对象方法 / 箭头工厂命中、
 * return 非 store 放行）。
 * vitest + eslint Linter 直挂规则（no-instance-level-session-state.test.mjs 同款跑法），
 * parser 与 taste-lint/vue.mjs 同构：vue-eslint-parser 外层 + typescript-eslint 内层。
 * 运行：npx vitest run taste-lint（仓库根）
 */
import { test, expect } from 'vitest';
import { Linter } from 'eslint';
import vueParser from 'vue-eslint-parser';
import tseslint from 'typescript-eslint';
import rule from './no-chat-ops-in-components.mjs';

const RULE_ID = 'taste/no-chat-ops-in-components';
const COMPONENT_FILE = 'packages/renderer/src/components/panel/probe.vue';

/** 与仓库 taste-lint/vue.mjs 的 .vue 块同构的最小配置 */
function lintVue(code, filename = COMPONENT_FILE) {
  const linter = new Linter();
  return linter.verify(
    code,
    {
      files: ['**/*.vue'],
      languageOptions: {
        parser: vueParser,
        parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
      },
      plugins: { taste: { rules: { 'no-chat-ops-in-components': rule } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename },
  );
}

/** 普通 .ts 文件（composable 面：规则只约束组件目录 .vue） */
function lintTs(code, filename = 'packages/renderer/src/composables/panel/probe.ts') {
  const linter = new Linter();
  return linter.verify(
    code,
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      plugins: { taste: { rules: { 'no-chat-ops-in-components': rule } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename },
  );
}

const sfc = (scriptBody, template = '<div />') =>
  `<script setup lang="ts">\n${scriptBody}\n</script>\n<template>${template}</template>\n`;

test('组件 script 内 ops 字段调用报错，message 指向 facet 定义文件', () => {
  const messages = lintVue(
    sfc([
      "import { useChatStore } from '@/stores/chat'",
      'const chat = useChatStore()',
      "chat.evictIfNeeded()",
    ].join('\n')),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].ruleId).toBe(RULE_ID);
  expect(messages[0].message).toContain('evictIfNeeded');
  expect(messages[0].message).toContain('packages/core/src/domain/chat/store.ts');
});

test('组件 template 表达式内 ops 字段访问同样报错', () => {
  const messages = lintVue(
    sfc(
      [
        "import { useChatStore } from '@/stores/chat'",
        'const chat = useChatStore()',
      ].join('\n'),
      '<div>{{ chat.testInternals.armStreamingTimer("s1") }}</div>',
    ),
  );
  // template 表达式经 vue-eslint-parser 参与 ESTree 遍历：testInternals 命中 ops 清单
  expect(messages.length).toBeGreaterThanOrEqual(1);
  expect(messages.some((m) => m.ruleId === RULE_ID && m.message.includes('testInternals'))).toBe(true);
});

test('readers 面字段（状态 ref + 纯读方法）放行', () => {
  const messages = lintVue(
    sfc(
      [
        "import { useChatStore } from '@/stores/chat'",
        'const chat = useChatStore()',
        'const n = chat.getMessages("s1").length',
        'const active = chat.isActive("s1")',
        'const failed = chat.failedHistory.has("s1")',
      ].join('\n'),
      '<div>{{ chat.isGenerating("s1") }}</div>',
    ),
  );
  expect(messages).toHaveLength(0);
});

test('工厂直调形态 useChatStore().hydrate(...) 报错', () => {
  const messages = lintVue(
    sfc([
      "import { useChatStore } from '@/stores/chat'",
      'useChatStore().hydrate("s1", [])',
    ].join('\n')),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toContain('hydrate');
});

test('工厂包装函数（声明晚于使用点）的 ops 访问报错——Program:exit 词法序消解', () => {
  const messages = lintVue(
    sfc([
      "import { useChatStore } from '@/stores/chat'",
      'const chat = getChat()',
      'chat.touchLru("s1")',
      'function getChat() { return useChatStore() }',
    ].join('\n')),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toContain('touchLru');
});

test('composable 文件（.ts，任意路径）不受限', () => {
  const messages = lintTs([
    "import { useChatStore } from '@/stores/chat'",
    'const chat = useChatStore()',
    'chat.setMessages("s1", [])',
  ].join('\n'));
  expect(messages).toHaveLength(0);
});

test('组件目录外的 .vue 不受限', () => {
  const messages = lintVue(
    sfc([
      "import { useChatStore } from '@/stores/chat'",
      'const chat = useChatStore()',
      'chat.disposeSession("s1")',
    ].join('\n')),
    'packages/renderer/src/composables/panel/probe.vue',
  );
  expect(messages).toHaveLength(0);
});

test('无 import 边的同名变量放行（同名巧合不误报）', () => {
  const messages = lintVue(
    sfc([
      'const chat = { evictIfNeeded: () => 1 }',
      'chat.evictIfNeeded()',
    ].join('\n')),
  );
  expect(messages).toHaveLength(0);
});

test('组件 __tests__ 下的 .vue 测试壳放行', () => {
  const messages = lintVue(
    sfc([
      "import { useChatStore } from '@/stores/chat'",
      'const chat = useChatStore()',
      'chat.evictIfNeeded()',
    ].join('\n')),
    'packages/renderer/src/components/panel/__tests__/probe.vue',
  );
  expect(messages).toHaveLength(0);
});

test('组件目录下 .spec.vue / .test.vue 命名文件放行', () => {
  for (const filename of [
    'packages/renderer/src/components/panel/probe.spec.vue',
    'packages/renderer/src/components/panel/probe.test.vue',
  ]) {
    const messages = lintVue(
      sfc([
        "import { useChatStore } from '@/stores/chat'",
        'const chat = useChatStore()',
        'chat.evictIfNeeded()',
      ].join('\n')),
      filename,
    );
    expect(messages, filename).toHaveLength(0);
  }
});

// —— ImportDeclaration visitor 正反用例 ——

test('ImportDeclaration：core 包出口 import createChatStore 激活工厂', () => {
  const messages = lintVue(
    sfc([
      "import { createChatStore } from '@taiji/core'",
      'const chat = createChatStore()',
      'chat.disposeSession("s1")',
    ].join('\n')),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toContain('disposeSession');
});

test('ImportDeclaration：core 深路径 import 同样激活工厂', () => {
  const messages = lintVue(
    sfc([
      "import { useChatStore } from '@taiji/core/domain/chat/store'",
      'useChatStore().abortPending("s1")',
    ].join('\n')),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toContain('abortPending');
});

test('ImportDeclaration：import type 形态不激活工厂', () => {
  const messages = lintVue(
    sfc([
      "import type { useChatStore } from '@/stores/chat'",
      'const chat = useChatStore()',
      'chat.evictIfNeeded()',
    ].join('\n')),
  );
  expect(messages).toHaveLength(0);
});

test('ImportDeclaration：非 store source 的同名 import 不激活工厂', () => {
  const messages = lintVue(
    sfc([
      "import { useChatStore } from '@/lib/somewhere-else'",
      'const chat = useChatStore()',
      'chat.evictIfNeeded()',
    ].join('\n')),
  );
  expect(messages).toHaveLength(0);
});

// —— ReturnStatement / ArrowFunctionExpression visitor 正反用例 ——

test('ReturnStatement：const FunctionExpression 工厂包装命中', () => {
  const messages = lintVue(
    sfc([
      "import { useChatStore } from '@/stores/chat'",
      'const grab = function () { return useChatStore() }',
      'const chat = grab()',
      'chat.clearPendingSend("s1")',
    ].join('\n')),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toContain('clearPendingSend');
});

test('ReturnStatement：对象方法工厂经解构调用命中', () => {
  const messages = lintVue(
    sfc([
      "import { useChatStore } from '@/stores/chat'",
      'const holders = { grab() { return useChatStore() } }',
      'const { grab } = holders',
      'const chat = grab()',
      'chat.setHandingOff("s1", true)',
    ].join('\n')),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toContain('setHandingOff');
});

test('ReturnStatement：return 非 store 表达式的包装函数放行', () => {
  const messages = lintVue(
    sfc([
      "import { useChatStore } from '@/stores/chat'",
      'function grab() { return { evictIfNeeded: () => 1 } }',
      'const chat = grab()',
      'chat.evictIfNeeded()',
    ].join('\n')),
  );
  expect(messages).toHaveLength(0);
});

test('表达式体箭头工厂（声明晚于使用点）命中——Program:exit 词法序消解', () => {
  const messages = lintVue(
    sfc([
      "import { useChatStore } from '@/stores/chat'",
      'const chat = grab()',
      'chat.markSessionError("s1", new Error("x"))',
      'const grab = () => useChatStore()',
    ].join('\n')),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].message).toContain('markSessionError');
});
