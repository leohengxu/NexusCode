// 任务状态枚举
export enum ProjectStatus {
  PENDING = 'PENDING',
  GENERATING = 'GENERATING',
  PENDING_REVIEW = 'PENDING_REVIEW',
  DEVELOPING = 'DEVELOPING',
  PREVIEW = 'PREVIEW',
  REWORKING = 'REWORKING',
  HUMAN_REVIEW = 'HUMAN_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  FAILED = 'FAILED',
}

export enum TaskStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum DocType {
  TECH_STACK = 'TECH_STACK',
  MODULE_DESIGN = 'MODULE_DESIGN',
  API_CONTRACT = 'API_CONTRACT',
  DATA_MODEL = 'DATA_MODEL',
}

export enum ApprovalAction {
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum CodeGenRole {
  FRONTEND = 'FRONTEND',
  BACKEND = 'BACKEND',
}

export enum CodeGenStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REWORKING = 'REWORKING',
}

export enum ValidatorRole {
  FUNCTIONAL = 'FUNCTIONAL',
  SECURITY = 'SECURITY',
  PERFORMANCE = 'PERFORMANCE',
  UI = 'UI',
}

export enum ValidatorStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  PASSED = 'PASSED',
  FAILED = 'FAILED',
  ERROR = 'ERROR',
}

export enum ReworkTrigger {
  VALIDATOR = 'VALIDATOR',
  PREVIEW = 'PREVIEW',
  HUMAN_REVIEW = 'HUMAN_REVIEW',
}

// 状态流转规则的唯一权威定义在 workflow.graph.ts 的 VALID_TRANSITIONS，
// 由 WorkflowService 统一校验。此处不再重复定义，避免两套表不一致导致改错地方。

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  [DocType.TECH_STACK]: '技术栈选型',
  [DocType.MODULE_DESIGN]: '技术架构文档',
  [DocType.API_CONTRACT]: '接口文档',
  [DocType.DATA_MODEL]: '数据库文档',
};

// 统一 Markdown 格式
export const DOC_TYPE_EXTENSIONS: Record<DocType, string> = {
  [DocType.TECH_STACK]: '.md',
  [DocType.MODULE_DESIGN]: '.md',
  [DocType.API_CONTRACT]: '.md',
  [DocType.DATA_MODEL]: '.md',
};
