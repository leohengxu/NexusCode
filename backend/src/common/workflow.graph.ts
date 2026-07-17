/**
 * LangGraph 工作流状态机
 *
 * 使用 LangGraph StateGraph 定义完整的工作流状态流转：
 * PENDING → GENERATING → PENDING_REVIEW → DEVELOPING → PREVIEW
 *   → HUMAN_REVIEW → APPROVED
 *   → REWORKING (返修闭环) → DEVELOPING
 *   → REJECTED / FAILED (终态)
 *
 * 替代原有 constants.ts 中手写的 STATE_TRANSITIONS 常量表，
 * 提供 LangGraph 原生的状态校验、条件路由和 MemorySaver 检查点能力。
 */
import { StateGraph, Annotation, START, END, MemorySaver } from '@langchain/langgraph';
import { ProjectStatus } from './constants';

// ── 状态定义 ──
const WorkflowState = Annotation.Root({
  projectId: Annotation<string>(),
  status: Annotation<ProjectStatus>(),
  version: Annotation<number>({ reducer: (_, v) => v, default: () => 1 }),
  iteration: Annotation<number>({ reducer: (_, v) => v, default: () => 0 }),
  errorMessage: Annotation<string | undefined>({ reducer: (_, v) => v, default: () => undefined }),
});

export type WorkflowStateType = typeof WorkflowState.State;

// ── 节点：每个状态对应一个 pass-through 节点 ──
// 节点不做业务逻辑，仅返回当前状态（业务逻辑在 WorkflowService 中执行）
const passThrough = async (state: WorkflowStateType) => state;

// ── 条件路由函数 ──
const routeFromPending = (state: WorkflowStateType): string => {
  return state.errorMessage ? ProjectStatus.FAILED : ProjectStatus.GENERATING;
};

const routeFromGenerating = (state: WorkflowStateType): string => {
  if (state.errorMessage) return ProjectStatus.FAILED;
  return ProjectStatus.PENDING_REVIEW;
};

const routeFromPendingReview = (state: WorkflowStateType): string => {
  // 审批结果由外部触发决定，这里返回默认路径
  return ProjectStatus.DEVELOPING;
};

const routeFromDeveloping = (state: WorkflowStateType): string => {
  if (state.errorMessage) return ProjectStatus.FAILED;
  return ProjectStatus.PREVIEW;
};

const routeFromPreview = (state: WorkflowStateType): string => {
  if (state.errorMessage) return ProjectStatus.FAILED;
  return ProjectStatus.HUMAN_REVIEW;
};

const routeFromReworking = (state: WorkflowStateType): string => {
  return ProjectStatus.DEVELOPING;
};

const routeFromHumanReview = (state: WorkflowStateType): string => {
  return ProjectStatus.APPROVED;
};

const routeFromRejected = (state: WorkflowStateType): string => {
  if (state.errorMessage) return ProjectStatus.FAILED;
  return ProjectStatus.GENERATING;
};

// ── 构建状态图 ──
const graphBuilder = new StateGraph(WorkflowState)
  .addNode(ProjectStatus.PENDING, passThrough)
  .addNode(ProjectStatus.GENERATING, passThrough)
  .addNode(ProjectStatus.PENDING_REVIEW, passThrough)
  .addNode(ProjectStatus.DEVELOPING, passThrough)
  .addNode(ProjectStatus.PREVIEW, passThrough)
  .addNode(ProjectStatus.REWORKING, passThrough)
  .addNode(ProjectStatus.HUMAN_REVIEW, passThrough)
  .addNode(ProjectStatus.APPROVED, passThrough)
  .addNode(ProjectStatus.REJECTED, passThrough)
  .addNode(ProjectStatus.FAILED, passThrough)
  // 入口
  .addEdge(START, ProjectStatus.PENDING)
  // PENDING → GENERATING | FAILED
  .addConditionalEdges(ProjectStatus.PENDING, routeFromPending, [
    ProjectStatus.GENERATING,
    ProjectStatus.FAILED,
  ])
  // GENERATING → PENDING_REVIEW | FAILED
  .addConditionalEdges(ProjectStatus.GENERATING, routeFromGenerating, [
    ProjectStatus.PENDING_REVIEW,
    ProjectStatus.FAILED,
  ])
  // PENDING_REVIEW → DEVELOPING | REJECTED
  .addConditionalEdges(ProjectStatus.PENDING_REVIEW, routeFromPendingReview, [
    ProjectStatus.DEVELOPING,
    ProjectStatus.REJECTED,
  ])
  // DEVELOPING → PREVIEW | FAILED
  .addConditionalEdges(ProjectStatus.DEVELOPING, routeFromDeveloping, [
    ProjectStatus.PREVIEW,
    ProjectStatus.FAILED,
  ])
  // PREVIEW → HUMAN_REVIEW | REWORKING | FAILED
  .addConditionalEdges(ProjectStatus.PREVIEW, routeFromPreview, [
    ProjectStatus.HUMAN_REVIEW,
    ProjectStatus.REWORKING,
    ProjectStatus.FAILED,
  ])
  // REWORKING → DEVELOPING | FAILED
  .addConditionalEdges(ProjectStatus.REWORKING, routeFromReworking, [
    ProjectStatus.DEVELOPING,
    ProjectStatus.FAILED,
  ])
  // HUMAN_REVIEW → APPROVED | REWORKING | REJECTED
  .addConditionalEdges(ProjectStatus.HUMAN_REVIEW, routeFromHumanReview, [
    ProjectStatus.APPROVED,
    ProjectStatus.REWORKING,
    ProjectStatus.REJECTED,
  ])
  // REJECTED → GENERATING | FAILED
  .addConditionalEdges(ProjectStatus.REJECTED, routeFromRejected, [
    ProjectStatus.GENERATING,
    ProjectStatus.FAILED,
  ])
  // 终态
  .addEdge(ProjectStatus.APPROVED, END)
  .addEdge(ProjectStatus.FAILED, END);

// ── 编译图（带 MemorySaver 检查点）──
const checkpointer = new MemorySaver();
export const workflowGraph = graphBuilder.compile({ checkpointer });

// ── 合法状态转换表（从图中提取，供 WorkflowService 校验）──
export const VALID_TRANSITIONS: Record<string, string[]> = {
  [ProjectStatus.PENDING]: [ProjectStatus.GENERATING, ProjectStatus.FAILED],
  [ProjectStatus.GENERATING]: [ProjectStatus.PENDING_REVIEW, ProjectStatus.FAILED],
  [ProjectStatus.PENDING_REVIEW]: [ProjectStatus.DEVELOPING, ProjectStatus.REJECTED],
  [ProjectStatus.DEVELOPING]: [ProjectStatus.PREVIEW, ProjectStatus.FAILED, ProjectStatus.REWORKING],
  [ProjectStatus.PREVIEW]: [ProjectStatus.HUMAN_REVIEW, ProjectStatus.REWORKING, ProjectStatus.FAILED],
  [ProjectStatus.REWORKING]: [ProjectStatus.DEVELOPING, ProjectStatus.FAILED],
  [ProjectStatus.HUMAN_REVIEW]: [ProjectStatus.APPROVED, ProjectStatus.REWORKING, ProjectStatus.REJECTED],
  [ProjectStatus.REJECTED]: [ProjectStatus.GENERATING, ProjectStatus.FAILED],
  [ProjectStatus.APPROVED]: [],
  // 允许拥有完整代码产物的历史失败项目通过人工反馈进入返修恢复。
  [ProjectStatus.FAILED]: [ProjectStatus.PENDING, ProjectStatus.REWORKING],
};

/**
 * 校验状态转换是否合法
 */
export function isValidTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * 获取从当前状态可以到达的下一个状态列表
 */
export function getNextStates(currentStatus: string): string[] {
  return VALID_TRANSITIONS[currentStatus] || [];
}
