/**
 * 品味规则：catch 块必须有实质错误处理
 *
 * 空 catch 吞掉错误；仅 console.error 对用户无感知。
 * 参考：CodeTaste 反模式 "异步操作无 UI 反馈" + "忽略底层错误"
 *
 * [HISTORICAL] best-effort 放行：catch 块内含解释性注释（说明降级策略 / 为何不传播）
 * 时放行 consoleOnly 检测。插件 hook、best-effort 数据改写等场景，失败用原始数据
 * 降级是合理的实质处理——强制 toast/重抛会错误地把非业务错误（插件 bug）暴露给用户。
 * 注释要求：catch body 内至少一条非空注释行（// 或 /*），说明降级意图。
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow catch blocks that silently swallow errors',
    },
    messages: {
      emptyCatch: '空 catch 块吞掉了错误，至少需要记录日志。',
      consoleOnly:
        'catch 块只有 console 调用 —— 底层错误未传播给调用方或用户。考虑：返回错误响应 / 设置错误状态 / toast 提示 / 重抛。或在 catch 内加注释说明降级策略（best-effort 场景）。',
    },
  },
  create(context) {
    function isOnlyConsole(body) {
      if (body.length !== 1) return false;
      const stmt = body[0];
      return (
        stmt.type === 'ExpressionStatement' &&
        stmt.expression.type === 'CallExpression' &&
        stmt.expression.callee.type === 'MemberExpression' &&
        stmt.expression.callee.object.type === 'Identifier' &&
        stmt.expression.callee.object.name === 'console'
      );
    }

    /** catch body 内是否含解释性注释（说明降级策略 / 为何不传播）。 */
    function hasExplanatoryComment(catchNode) {
      const sourceCode = context.sourceCode ?? context.getSourceCode();
      const comments = sourceCode.getCommentsInside(catchNode.body);
      return comments.some((c) => c.value.trim().length > 0);
    }

    return {
      CatchClause(node) {
        const body = node.body?.body;
        if (!body) return;

        if (body.length === 0) {
          context.report({ node, messageId: 'emptyCatch' });
        } else if (isOnlyConsole(body)) {
          // best-effort 放行：含解释性注释说明降级策略的 catch 不报（如插件 hook 失败降级）
          if (hasExplanatoryComment(node)) return;
          context.report({ node, messageId: 'consoleOnly' });
        }
      },
    };
  },
};
