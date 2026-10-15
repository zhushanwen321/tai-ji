/**
 * workflow-dag-collapse —— DAG 解析产物收尾纯函数：不可区分调用点合并。
 *
 * 规则（登记于 docs/adr/decisions.md ADR-0105 补记 + workflow-dag-parser 头注释）：
 * 同 (phase, templateName, kind) 的调用点在 D2 蓝图-实例匹配与视图两侧天然不可区分
 * ——同 phase 等值 + 同模板正则 + 字面段总长相等恒并列歧义，保留多个只会互致歧义：
 * 任一实例命中并列候选即判歧义进「未匹配实例」分组，该 agent 家族在 DAG 图上整体
 * 失去挂接（实测形态：① helper 投影把「派发 + 原位重试」投成两个全通配 `*` 节点；
 * ② 同字面模板双直呼节点——aggregate 派发与其重试分支）。合并语义：组内最前行号者
 * 为代表节点（出现序平局），边端点重写到代表后按 (from,to) 优先级去重（dataflow >
 * conditional > sequence，与解析器候选去重同口径；loop-back 边不参与去重——与
 * loops.backEdgeId 按 loopId 配对引用，删并会孤儿化回边引用），合并产生的自环边丢弃
 * （前向伪自环直接滤除；合并收敛出的 loop-back 伪自环随配对 loop 条目一并剔除，
 * 未被合并波及的单节点循环体原生回边自环保留），并行组/循环成员 id
 * 同步重映射去重（保序）。不同 phase / 不同模板不合并——可区分的调用点保持
 * 一节点一调用点。空节点图原 dag 原样返回；其余（含全单例组）走完整重建返回新 dag。
 */
import type { WorkflowDag, WorkflowDagEdge, WorkflowDagNode } from "./workflow-dag-parser.ts";

/** 分组/去重键分隔符（节点 id 与模板名不含 \u0000，无碰撞面）。 */
const KEY_SEP = "\u0000";

/** 前向边同 (from,to) 收口优先级（dataflow 最信息密集，与解析器 dedupeEdges 同词表同值——loop-back 键仅为词表完整性，不参与收口）。 */
const EDGE_PRIORITY: Record<WorkflowDagEdge["kind"], number> = {
  sequence: 0,
  conditional: 1,
  dataflow: 2,
  "loop-back": 0,
};

/**
 * 合并同 (phase, templateName, kind) 的不可区分调用点：返回合并后的新 WorkflowDag
 * （输入不可变；代表节点 id 保留，被并节点 id 从边/组/循环中重映射消解）。
 */
export function collapseDuplicateCallSites(dag: WorkflowDag): WorkflowDag {
  const groups = new Map<string, WorkflowDagNode[]>();
  for (const node of dag.nodes) {
    const key = `${node.phase}${KEY_SEP}${node.templateName}${KEY_SEP}${node.kind}`;
    const members = groups.get(key) ?? [];
    members.push(node);
    groups.set(key, members);
  }
  const representativeByNodeId = new Map<string, string>();
  const survivors: WorkflowDagNode[] = [];
  for (const members of groups.values()) {
    const representative = members.reduce((a, b) => (b.line < a.line ? b : a));
    survivors.push(representative);
    for (const member of members) representativeByNodeId.set(member.id, representative.id);
  }
  if (representativeByNodeId.size === 0) return dag;

  const remapId = (id: string): string => representativeByNodeId.get(id) ?? id;
  // 前向边：端点重映射 + 同 (from,to) 优先级收口，合并产生的自环丢弃（重映射后两端
  // 点同节点，边无信息量且会渲染成横穿节点卡片的直线）；loop-back：只重映射不去重
  // （每条 loop-back 被某 loop.backEdgeId 配对引用——去重会孤儿化引用，结构校验红线）。
  // loop-back 自环分两态：未被合并波及的单节点循环体回边是解析器原生自环（合法结构，
  // layout 走回边总线渲染，保留）；合并产生的自环是伪结构——含多节点循环体收敛为单
  // 代表的情形，也含原生自环节点本身被并入他组（端点被重映射）的情形——随其配对
  // loop 条目一并剔除（单删边会孤儿化 backEdgeId 引用）
  const forward = new Map<string, WorkflowDagEdge>();
  const loopBack: WorkflowDagEdge[] = [];
  const droppedBackEdgeIds = new Set<string>();
  for (const edge of dag.edges) {
    const from = remapId(edge.from);
    const to = remapId(edge.to);
    const remapped: WorkflowDagEdge = { ...edge, from, to };
    const merged = from !== edge.from || to !== edge.to;
    if (edge.kind === "loop-back") {
      if (merged && from === to) {
        droppedBackEdgeIds.add(remapped.id);
        continue;
      }
      loopBack.push(remapped);
      continue;
    }
    if (from === to) continue;
    const key = `${remapped.from}${KEY_SEP}${remapped.to}`;
    const existing = forward.get(key);
    if (existing === undefined || EDGE_PRIORITY[edge.kind] > EDGE_PRIORITY[existing.kind]) {
      forward.set(key, remapped);
    }
  }

  const remapIds = (nodeIds: string[]): string[] => [...new Set(nodeIds.map(remapId))];
  return {
    nodes: survivors,
    edges: [...forward.values(), ...loopBack],
    phases: dag.phases,
    parallelGroups: dag.parallelGroups.map((group) => ({ nodeIds: remapIds(group.nodeIds) })),
    loops: dag.loops
      .map((loop) => ({ ...loop, nodeIds: remapIds(loop.nodeIds) }))
      .filter((loop) => !droppedBackEdgeIds.has(loop.backEdgeId)),
  };
}
