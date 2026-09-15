/**
 * 品味规则：禁止缺少迭代上限的 while(true) 循环
 *
 * while(true) 本身不保证终止，如果循环体没有计数器递增 + 条件检查，
 * 或 break/return/throw 等退出路径，就是潜在的无限循环 bug。
 *
 * 判定为"有界"的条件（满足任一即可）：
 *   1. 循环体内有 break / return / throw
 *   2. 有 UpdateExpression（i++）或 += 赋值，且同一标识符出现在比较表达式中
 *
 * 豁免：测试文件、迁移文件、含 // taste:allow-unbounded-loop 注释的文件
 */

/** 直接退出语句（break/return/throw）——循环体内出现即视为有界 */
function isDirectExit(stmt) {
  return (
    stmt.type === 'BreakStatement' ||
    stmt.type === 'ReturnStatement' ||
    stmt.type === 'ThrowStatement'
  );
}

/** 语句位置既可能是单语句也可能是语句列表（if 分支 / 循环体），统一成列表 */
function toStatementList(node) {
  return Array.isArray(node) ? node : [node];
}

/** if 语句：检查条件中的比较，递归两个分支 */
function walkIfStatement(stmt, state) {
  collectComparedIds(stmt.test, state);
  if (stmt.consequent) walkStatements(toStatementList(stmt.consequent), state);
  if (stmt.alternate) walkStatements(toStatementList(stmt.alternate), state);
}

/** try-catch：递归 block 和 handler */
function walkTryStatement(stmt, state) {
  walkStatements(stmt.block?.body ?? [], state);
  if (stmt.handler?.body) walkStatements(stmt.handler.body.body ?? [], state);
  if (stmt.finalizer) walkStatements(stmt.finalizer.body ?? [], state);
}

/** for / do-while：递归进入 body（循环头部的 init/test/update 不参与收集） */
function walkLoopBody(stmt, state) {
  if (stmt.body) walkStatements(toStatementList(stmt.body), state);
}

/** switch：递归每个 case 的语句列表 */
function walkSwitchStatement(stmt, state) {
  for (const c of stmt.cases ?? []) {
    walkStatements(c.consequent ?? [], state);
  }
}

/** 嵌套 block（如 for 循环体） */
function walkBlockStatement(stmt, state) {
  walkStatements(stmt.body, state);
}

/** 表达式语句：检查更新表达式和赋值表达式，其余表达式递归找比较 */
function walkExpressionStatement(stmt, state) {
  const expr = stmt.expression;

  // i++ / ++i / i-- / --i
  if (expr.type === 'UpdateExpression') {
    const arg = expr.argument;
    if (arg.type === 'Identifier') state.updatedIds.add(arg.name);
    return;
  }

  // i += 1 / i -= 1
  if (
    expr.type === 'AssignmentExpression' &&
    (expr.operator === '+=' || expr.operator === '-=') &&
    expr.left.type === 'Identifier'
  ) {
    state.updatedIds.add(expr.left.name);
    return;
  }

  // 表达式中可能嵌套比较（如函数调用参数），递归检查
  collectComparedIds(expr, state);
}

/** 声明初始化式中可能有比较（const done = i >= MAX；普通赋值的右侧不在此列） */
function walkVariableDeclaration(stmt, state) {
  for (const decl of stmt.declarations ?? []) {
    if (decl.init) collectComparedIds(decl.init, state);
  }
}

// 表驱动分发，落空（嵌套 while(true)、for-of/for-in、单语句 if 分支之外的所有形态）静默
// 跳过——与原 if 链逐分支等价
const STATEMENT_WALKERS = new Map([
  ['IfStatement', walkIfStatement],
  ['TryStatement', walkTryStatement],
  ['ForStatement', walkLoopBody],
  ['DoWhileStatement', walkLoopBody],
  ['SwitchStatement', walkSwitchStatement],
  ['BlockStatement', walkBlockStatement],
  ['ExpressionStatement', walkExpressionStatement],
  ['VariableDeclaration', walkVariableDeclaration],
]);

/**
 * 递归遍历语句列表，收集：
 * - 直接退出语句（break/return/throw）
 * - 被递增的标识符（i++, ++i, i += 1）
 * - 出现在比较表达式中的标识符（i < MAX）
 */
function walkStatements(nodes, state) {
  for (const stmt of nodes) {
    if (!stmt) continue;

    if (isDirectExit(stmt)) {
      state.hasDirectExit = true;
      continue;
    }

    const walker = STATEMENT_WALKERS.get(stmt.type);
    if (walker) walker(stmt, state);
  }
}

const COMPARISON_OPERATORS = ['<', '>', '<=', '>=', '===', '!==', '==', '!='];

/**
 * 从表达式中收集出现在比较运算符两侧的标识符
 */
function collectComparedIds(expr, state) {
  if (!expr) return;

  if (expr.type === 'BinaryExpression') {
    if (COMPARISON_OPERATORS.includes(expr.operator)) {
      if (expr.left.type === 'Identifier') state.comparedIds.add(expr.left.name);
      if (expr.right.type === 'Identifier') state.comparedIds.add(expr.right.name);
    }
    collectComparedIds(expr.left, state);
    collectComparedIds(expr.right, state);
    return;
  }

  // 穿透 LogicalExpression（&& / ||）和 ConditionalExpression（?:）
  if (expr.type === 'LogicalExpression') {
    collectComparedIds(expr.left, state);
    collectComparedIds(expr.right, state);
    return;
  }
  if (expr.type === 'ConditionalExpression') {
    collectComparedIds(expr.test, state);
    collectComparedIds(expr.consequent, state);
    collectComparedIds(expr.alternate, state);
    return;
  }

  // 穿透 CallExpression 参数（如 fn(i < MAX)）
  if (expr.type === 'CallExpression') {
    for (const arg of expr.arguments ?? []) collectComparedIds(arg, state);
    return;
  }
}

/**
 * 检查 while(true) 循环体是否有迭代上限保护
 * @param {import('eslint').Rule.Node} whileNode
 * @returns {boolean} true = 有界，不需要报告
 */
function checkHasLimit(whileNode) {
  const body = whileNode.body;
  // 单语句 body 无法可靠分析，放过
  if (body.type !== 'BlockStatement') return true;

  const state = { hasDirectExit: false, updatedIds: new Set(), comparedIds: new Set() };
  walkStatements(body.body, state);

  // 有直接退出语句（break/return/throw），视为有界
  if (state.hasDirectExit) return true;

  // 有计数器递增 + 同一计数器出现在比较表达式中，视为有界
  for (const id of state.updatedIds) {
    if (state.comparedIds.has(id)) return true;
  }

  return false;
}

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow while(true) loops without iteration limit',
    },
    schema: [],
    messages: {
      unboundedLoop:
        'while(true) 循环缺少迭代上限保护。添加 MAX_ITERATIONS 常量 + 计数器检查，' +
        '防止意外无限循环。',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode?.() ?? null;
    const filename = context.filename ?? context.getFilename?.() ?? '';

    return {
      WhileStatement(node) {
        // 仅匹配 while(true) / while (true)
        if (
          node.test.type !== 'Literal' ||
          node.test.value !== true
        ) return;

        // 豁免：测试文件、迁移文件
        if (
          filename.includes('.test.') ||
          filename.includes('.spec.') ||
          filename.includes('__tests__') ||
          filename.includes('/migrations/')
        ) return;

        // 豁免：文件级注释
        if (sourceCode) {
          const comments = sourceCode.getAllComments();
          if (comments.some((c) => c.value.trim() === 'taste:allow-unbounded-loop')) return;
        }

        if (!checkHasLimit(node)) {
          context.report({ node, messageId: 'unboundedLoop' });
        }
      },
    };
  },
};
