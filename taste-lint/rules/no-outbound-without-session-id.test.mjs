/**
 * no-outbound-without-session-id 规则用例（review-findings P2-S5，关键规则 #7 静态化）。
 *
 * 用例分三组：正例（合法形态通过）/ 反例（缺失报错）/ 豁免（行内登记注释 + 静态
 * 盲区放行）。vitest + eslint Linter 直挂规则（no-instance-level-session-state.test.mjs
 * 同款跑法），parser 与 taste-lint/base.mjs 的 .ts 块同构（typescript-eslint）。
 * 运行：cd taste-lint && npx vitest run
 */
import { test, expect } from 'vitest';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './no-outbound-without-session-id.mjs';

const RULE_ID = 'taste/no-outbound-without-session-id';

/** 与 taste-lint/base.mjs 的 TS 文件规则块同构的最小配置 */
function lintTs(code) {
  const linter = new Linter();
  return linter.verify(
    code,
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      plugins: { taste: { rules: { 'no-outbound-without-session-id': rule } } },
      rules: { [RULE_ID]: 'error' },
    },
    { filename: 'packages/runtime/src/transport/probe.ts' },
  );
}

// ── 正例：带 sessionId 的合法形态 ────────────────────────────────

test('正例：publish 第 1 参在位 + payload 字面量带 sessionId 键 → 不报', () => {
  const messages = lintTs(
    "messageBus.publish(sessionId, { type: 'message.complete', payload: { sessionId, entries } });",
  );
  expect(messages).toHaveLength(0);
});

test('正例：payload shorthand `{ sessionId }` 与显式键都认 → 不报', () => {
  const messages = lintTs(
    [
      "bus.publish(sid, { type: 'message.error', payload: { sessionId } });",
      "bus.publish(sid, { type: 'message.error', payload: { sessionId: otherSid } });",
    ].join('\n'),
  );
  expect(messages).toHaveLength(0);
});

test('正例：publish 转发形态（message 是变量，静态盲区）→ 不报', () => {
  const messages = lintTs('publish(sid, msg);');
  expect(messages).toHaveLength(0);
});

test('正例：payload 函数构造（静态盲区，btw.list 同构）→ 不报', () => {
  const messages = lintTs(
    "bus.publish(mainSid, { type: 'btw.list', payload: buildBtwThreadListPayload(svc, mainSid) });",
  );
  expect(messages).toHaveLength(0);
});

test('正例：payload 对象含 spread（键可能由 spread 携带，保守放行）→ 不报', () => {
  const messages = lintTs(
    "bus.publish(sid, { type: 'x', payload: { ...base } });",
  );
  expect(messages).toHaveLength(0);
});

test('正例：sendError details 字面量带 sessionId（可含 hint 等扩展键）→ 不报', () => {
  const messages = lintTs(
    "ctx.sendError(ws, 'fetch_failed', errMsg, msg.id, { sessionId: fetchSid, hint });",
  );
  expect(messages).toHaveLength(0);
});

test('正例：sendError 省略第 5 参（invalid_payload 无 sid 可传的合法形态）→ 不报', () => {
  const messages = lintTs(
    "ctx.sendError(ws, 'invalid_payload', 'providerId required', msg.id);",
  );
  expect(messages).toHaveLength(0);
});

test('正例：排除集方法名不查——broadcast / send / reply 的 payload 无 sessionId → 不报', () => {
  const messages = lintTs(
    [
      "broker.broadcast({ type: 'app.info', payload: { appVersion } });",
      "ctx.send(ws, { type: 'btw.remove', id: msg.id, payload: { vid } });",
      "ctx.reply(ws, msg.id, 'btw.remove', { vid });",
    ].join('\n'),
  );
  expect(messages).toHaveLength(0);
});

// ── 反例：sessionId 位缺失 → 报错 ────────────────────────────────

test('反例：publish 第 1 参为字面量 undefined → 报 missingSessionIdArg', () => {
  const messages = lintTs(
    "messageBus.publish(undefined, { type: 'x', payload: { sessionId: sid } });",
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].severity).toBe(2);
  expect(messages[0].message).toContain('关键规则 #7');
  expect(messages[0].message).toContain('第 1 参');
});

test('反例：publish 字面量 payload 缺 sessionId 键 → 报 payloadWithoutSessionId（消息含恢复动作）', () => {
  const messages = lintTs(
    "messageBus.publish(sessionId, { type: 'message.complete', payload: { entries } });",
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].severity).toBe(2);
  expect(messages[0].message).toContain('payload');
  expect(messages[0].message).toContain('sessionId');
  expect(messages[0].message).toContain('taste:allow-outbound-without-session-id');
});

test('反例：publish 第 2 参字面量 payload 为空对象 → 报 payloadWithoutSessionId', () => {
  const messages = lintTs(
    "messageBus.publish(sessionId, { type: 'x', payload: {} });",
  );
  expect(messages).toHaveLength(1);
});

test('反例：sendError details 字面量缺 sessionId 键 → 报 errorDetailsWithoutSessionId（MF-3-4 同族形态）', () => {
  const messages = lintTs(
    "ctx.sendError(ws, 'install_failed', errMsg, msg.id, { hint: 'check path' });",
  );
  expect(messages).toHaveLength(1);
  expect(messages[0].severity).toBe(2);
  expect(messages[0].message).toContain('sendError');
  expect(messages[0].message).toContain('sessionId');
});

test('反例：多行调用形态（实装常见跨行 publish）缺 sessionId 键 → 报错', () => {
  const messages = lintTs(
    [
      'messageBus.publish(sessionId, {',
      "  type: 'session.occupancy',",
      '  payload: { occupancy },',
      '});',
    ].join('\n'),
  );
  expect(messages).toHaveLength(1);
});

// ── 豁免：行内登记注释 ──────────────────────────────────────────

test('豁免：调用点上一行登记注释 → 不报', () => {
  const messages = lintTs(
    [
      '// taste:allow-outbound-without-session-id — btw.list 消费端走 onGlobalType global 通道',
      "bus.publish(mainSid, { type: 'btw.list', payload: { threads } });",
    ].join('\n'),
  );
  expect(messages).toHaveLength(0);
});

test('豁免：sendError details 缺键 + 登记注释 → 不报', () => {
  const messages = lintTs(
    [
      '// taste:allow-outbound-without-session-id — 全局性失败，无会话归属',
      "ctx.sendError(ws, 'parse_error', 'Invalid JSON', msg.id, { hint });",
    ].join('\n'),
  );
  expect(messages).toHaveLength(0);
});

test('豁免登记注释不误伤下一行之外的非豁免调用 → 仍报', () => {
  const messages = lintTs(
    [
      '// taste:allow-outbound-without-session-id — 登记注释只豁免紧邻调用',
      'const noop = 1;',
      "bus.publish(sid, { type: 'x', payload: { noSidHere: true } });",
    ].join('\n'),
  );
  expect(messages).toHaveLength(1);
});
