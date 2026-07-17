// 项目状态
export type ProjectStatus =
  | 'PENDING'
  | 'GENERATING'
  | 'PENDING_REVIEW'
  | 'DEVELOPING'
  | 'PREVIEW'
  | 'VALIDATING'
  | 'REWORKING'
  | 'HUMAN_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'FAILED';

// 文档类型
export type DocType = 'TECH_STACK' | 'MODULE_DESIGN' | 'API_CONTRACT' | 'DATA_MODEL';

// 代码生成角色
export type CodeGenRole = 'FRONTEND' | 'BACKEND';

// 验证角色
export type ValidatorRole = 'FUNCTIONAL' | 'SECURITY' | 'PERFORMANCE' | 'UI';

// 项目信息
export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  version: number;
  iterationCount: number;
  basePath: string;
  createdAt: string;
  updatedAt: string;
  tasks: Task[];
  documents: Document[];
  approvals: Approval[];
  codeGens: CodeGenRecord[];
  validations: ValidationRecord[];
  reworkRecords: ReworkRecord[];
}

// 任务信息
export interface Task {
  id: string;
  projectId: string;
  status: string;
  prdContent: string;
  prdFilePath?: string;
  startTime?: string;
  endTime?: string;
  errorMsg?: string;
  retryCount: number;
  thinking?: string;
  createdAt: string;
}

// 文档信息
export interface Document {
  id: string;
  taskId: string;
  projectId: string;
  docType: DocType;
  fileName: string;
  filePath: string;
  version: number;
  fileSize: number;
  content?: string;
  downloadUrl?: string;
  createdAt: string;
}

// 审批记录
export interface Approval {
  id: string;
  projectId: string;
  reviewer: string;
  action: 'APPROVED' | 'REJECTED';
  comment?: string;
  createdAt: string;
}

// 代码生成记录
export interface CodeGenRecord {
  id: string;
  projectId: string;
  role: CodeGenRole;
  status: string;
  codeContent?: string;
  filePath?: string;
  errorMsg?: string;
  startTime?: string;
  endTime?: string;
  iteration: number;
  createdAt: string;
  content?: string;
}

// 验证记录
export interface ValidationRecord {
  id: string;
  projectId: string;
  role: ValidatorRole;
  codeGenId?: string;
  status: string;
  result?: string;
  score?: number;
  comments?: string;
  iteration: number;
  createdAt: string;
}

// 返修记录
export interface ReworkRecord {
  id: string;
  projectId: string;
  iteration: number;
  trigger: string;
  feedback: string;
  source: string;
  createdAt: string;
}

// 状态标签映射
export const STATUS_LABELS: Record<ProjectStatus, string> = {
  PENDING: '待处理',
  GENERATING: '生成中',
  PENDING_REVIEW: '待审批',
  DEVELOPING: '开发中',
  PREVIEW: '代码预览',
  VALIDATING: '验证中',
  REWORKING: '返修中',
  HUMAN_REVIEW: '待最终审核',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  FAILED: '生成失败',
};

export const STATUS_COLORS: Record<ProjectStatus, string> = {
  PENDING: 'default',
  GENERATING: 'processing',
  PENDING_REVIEW: 'warning',
  DEVELOPING: 'processing',
  PREVIEW: 'cyan',
  VALIDATING: 'processing',
  REWORKING: 'warning',
  HUMAN_REVIEW: 'warning',
  APPROVED: 'success',
  REJECTED: 'error',
  FAILED: 'error',
};

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  TECH_STACK: '技术栈选型',
  MODULE_DESIGN: '模块划分与架构',
  API_CONTRACT: 'API 契约',
  DATA_MODEL: '数据模型',
};

export const VALIDATOR_LABELS: Record<ValidatorRole, string> = {
  FUNCTIONAL: '功能验证',
  SECURITY: '安全验证',
  PERFORMANCE: '性能验证',
  UI: 'UI验证',
};

export const CODE_GEN_LABELS: Record<CodeGenRole, string> = {
  FRONTEND: '前端开发',
  BACKEND: '后端开发',
};

export const VALIDATOR_ICONS: Record<ValidatorRole, string> = {
  FUNCTIONAL: '✅',
  SECURITY: '🔒',
  PERFORMANCE: '⚡',
  UI: '🎨',
};

export const CODE_GEN_ICONS: Record<CodeGenRole, string> = {
  FRONTEND: '🖥️',
  BACKEND: '⚙️',
};
