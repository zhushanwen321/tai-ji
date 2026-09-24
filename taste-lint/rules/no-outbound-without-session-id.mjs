/**
 * 治理护栏：runtime → 前端出站消息必须带 sessionId（AGENTS.md 关键规则 #7，
 * review-findings P2-S5——PR #20 MF-3-4 漏网形态的静态防线）。
 *
 * 实装核实（以 runtime 源码为准，两个正交出站通道，见 message-bus.ts IMessageBus
 * docstring 与 message-broker.ts IMessageBroker）：
 *
 * - `publish(sessionId, message)`——session 级 push 型消息的唯一出口（IMessageBus）。
 *   检查两处：
 *   ① 第 1 参（sessionId 位）缺失 / 字面量 undefined → 报错。当前签名必填 string，
 *     tsc 已拦，本条是「出站必须带 sessionId」的显式规约（未来签名改可选时规则仍守住）。
 *   ② message 为对象字面量且 payload 为对象字面量但缺 sessionId 键 → 报错。这是
 *     真实漏网形态：前端 useChat.ts 对 session 级消息恒等校验
 *     `msg.payload.sessionId === sid`（ADR-0049），缺字段的消息被静默丢弃——正是
 *     规则 #7「缺失的消息应被前端忽略」描述的 bug。
 * - `sendError(ws, code, message, id?, details?)`——sessionId 在第 5 参 details 键上
 *   （ErrorDetails.sessionId，message-context.ts）。检查：details 为对象字面量但缺
 *   sessionId 键 → 报错（MF-3-4 同族：传了 details 却漏写 sessionId 键）。
 *   只查「字面量缺键」，不查「第 5 参缺失」——invalid_payload 校验失败等分支无 sid
 *   可传，省略 details 是合法形态（MF-3-4 处置时 :175/:159/:169 同款裁决）。
 *
 * 排除集（出站方法但不查，逐条理由）：
 * - `broadcast`——语义反向：全局通道的合法消息 payload 均无 sessionId；session 级
 *   消息误走 broadcast 由 message-broker.ts 运行时哨兵 warn（02 文档 D1-2）。
 * - `send` / `reply`——RPC reply 通道按 msg.id 路由 pending Promise，sessionId 非功能
 *   必需（MF-3-4 处置原话「按 msg.id 路由功能无损坏」）；且 reply payload 大量合法
 *   无 sessionId 形态（btw.remove reply { vid } 等）。
 *
 * 盲区（静态不可判定，放行）：payload / details / message 非对象字面量（变量、函数
 * 构造、spread 承载）——btw.list 的 buildBtwThreadListPayload(...) 构造 payload 无
 * sessionId 键，消费端走前端 global 通道（onGlobalType），是登记过的合法形态。
 *
 * 误报豁免走行内登记注释 taste:allow-outbound-without-session-id（与
 * taste:allow-instance-level-session-state 同机制——通用静默豁免注释已被仓内
 * 禁用注释守卫拦截，登记注释要求注明为什么该帧可以不带 sessionId）。
 */
const INLINE_ALLOW_RE = /taste:allow-outbound-without-session-id/;

/** publish 第 1 参 = sessionId 位（message-bus.ts IMessageBus.publish）。 */
const PUBLISH_SESSION_ID_ARG_INDEX = 0;
/** publish 第 2 参 = message。 */
const PUBLISH_MESSAGE_ARG_INDEX = 1;
/** sendError 第 5 参 = details（message-context.ts MessageHandlerContext.sendError）。 */
const SEND_ERROR_DETAILS_ARG_INDEX = 4;

/** CallExpression 的 callee 名（MemberExpression 取 property，Identifier 取自身）；不匹配返回 null。 */
function calleeName(callNode) {
  const callee = callNode.callee;
  if (callee.type === 'MemberExpression' && !callee.computed) {
    const prop = callee.property;
    if (prop.type === 'Identifier') return prop.name;
    if (prop.type === 'Literal' && typeof prop.value === 'string') return prop.value;
    return null;
  }
  if (callee.type === 'MemberExpression' && callee.computed) {
    const prop = callee.property;
    if (prop.type === 'Literal' && typeof prop.value === 'string') return prop.value;
    return null;
  }
  if (callee.type === 'Identifier') return callee.name;
  return null;
}

/** 对象字面量里是否存在指定字面量键（shorthand `{ sessionId }` 也算）。 */
function hasLiteralKey(objectNode, keyName) {
  return objectNode.properties.some((prop) => {
    if (prop.type !== 'Property') return false;
    if (prop.key.type === 'Identifier') return prop.key.name === keyName;
    if (prop.key.type === 'Literal') return prop.value === keyName;
    return false;
  });
}

/** 对象字面量里是否存在 spread（`{ ...x }`）——spread 可能携带任意键，键级检查退为盲区。 */
function hasSpread(objectNode) {
  return objectNode.properties.some((prop) => prop.type === 'SpreadElement');
}

/** 取对象字面量里指定字面量键的 property 节点（找不到返回 undefined）。 */
function findLiteralProperty(objectNode, keyName) {
  return objectNode.properties.find((prop) => {
    if (prop.type !== 'Property') return false;
    if (prop.key.type === 'Identifier') return prop.key.name === keyName;
    if (prop.key.type === 'Literal') return prop.value === keyName;
    return false;
  });
}

/** 调用点是否带行内豁免登记注释（调用行或紧邻上一行）。 */
function hasInlineAllow(context, callNode) {
  const sourceCode = context.sourceCode ?? context.getSourceCode();
  const line = callNode.loc.start.line;
  return sourceCode.getAllComments().some((comment) => {
    if (!INLINE_ALLOW_RE.test(comment.value)) return false;
    return (
      comment.loc.start.line === line ||
      comment.loc.end.line === line ||
      comment.loc.end.line === line - 1
    );
  });
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow runtime→frontend outbound calls whose sessionId slot is missing (AGENTS.md key rule #7)',
    },
    messages: {
      missingSessionIdArg:
        '出站 publish 的 sessionId 实参缺失/为 undefined —— 关键规则 #7：session 级消息必须带 sessionId，缺失的消息会被前端忽略。恢复：publish(sessionId, message) 第 1 参传目标 session id。',
      payloadWithoutSessionId:
        '出站消息 payload 字面量缺 sessionId 字段 —— 前端按 payload.sessionId 恒等校验过滤会话消息（关键规则 #7，ADR-0049），缺字段的消息将被静默丢弃。恢复：payload 内补 sessionId 键；确属无 sid 语义的帧（消费端走 global 通道）时，在调用点上一行加 taste:allow-outbound-without-session-id 登记注释并注明理由。',
      errorDetailsWithoutSessionId:
        'sendError 的 details 字面量缺 sessionId 字段 —— 关键规则 #7：sendError 必须传 sessionId（错误帧关联会话，renderer 可路由归属）。恢复：details 内补 sessionId 键；无 sid 可传时省略第 5 参，或加 taste:allow-outbound-without-session-id 登记注释并注明理由。',
    },
  },
  create(context) {
    function checkPublish(callNode) {
      const sidArg = callNode.arguments[PUBLISH_SESSION_ID_ARG_INDEX];
      if (!sidArg || (sidArg.type === 'Identifier' && sidArg.name === 'undefined')) {
        context.report({ node: callNode, messageId: 'missingSessionIdArg' });
        return;
      }
      const messageArg = callNode.arguments[PUBLISH_MESSAGE_ARG_INDEX];
      if (!messageArg || messageArg.type !== 'ObjectExpression') return;
      const payloadProp = findLiteralProperty(messageArg, 'payload');
      if (!payloadProp || payloadProp.value.type !== 'ObjectExpression') return;
      const payloadNode = payloadProp.value;
      if (hasLiteralKey(payloadNode, 'sessionId')) return;
      if (hasSpread(payloadNode)) return;
      context.report({ node: payloadNode, messageId: 'payloadWithoutSessionId' });
    }

    function checkSendError(callNode) {
      const detailsArg = callNode.arguments[SEND_ERROR_DETAILS_ARG_INDEX];
      if (!detailsArg || detailsArg.type !== 'ObjectExpression') return;
      if (hasLiteralKey(detailsArg, 'sessionId')) return;
      if (hasSpread(detailsArg)) return;
      context.report({ node: detailsArg, messageId: 'errorDetailsWithoutSessionId' });
    }

    return {
      CallExpression(node) {
        const name = calleeName(node);
        if (name !== 'publish' && name !== 'sendError') return;
        if (hasInlineAllow(context, node)) return;
        if (name === 'publish') checkPublish(node);
        else checkSendError(node);
      },
    };
  },
};
