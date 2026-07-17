import axios from 'axios';

const client = axios.create({
  baseURL: '/api',
  timeout: 120000,
  headers: import.meta.env.VITE_API_KEY
    ? { 'x-api-key': import.meta.env.VITE_API_KEY }
    : undefined,
});

// 任务管理
export const taskApi = {
  /** 文本方式发起文档生成 */
  create: (data: { name?: string; prdContent: string }) =>
    client.post('/tasks', data),

  /** 文件方式发起文档生成 */
  upload: (formData: FormData) =>
    client.post('/tasks/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),

  /** 查询任务状态 */
  getStatus: (projectId: string) => client.get(`/tasks/${projectId}`),

  /** 获取完整项目状态（含代码生成、验证、返修记录） */
  getFullStatus: (projectId: string) => client.get(`/tasks/${projectId}/full-status`),

  /** 获取所有项目列表 */
  getProjects: () => client.get('/tasks'),

  /** 手动触发返修 */
  triggerRework: (projectId: string, feedback: string) =>
    client.post(`/tasks/${projectId}/rework`, { feedback }),
};

// 文档管理
export const documentApi = {
  /** 获取项目文档列表 */
  getByProject: (projectId: string) => client.get(`/documents/${projectId}`),

  /** 获取文档预览 */
  preview: (projectId: string, taskId: string, docType: string) =>
    client.get(`/documents/${projectId}/preview`, { params: { taskId, docType } }),
};

// 审批管理（架构文档审批）
export const approvalApi = {
  /** 审批通过 */
  approve: (projectId: string, data?: { reviewer?: string; comment?: string }) =>
    client.post(`/approvals/${projectId}/approve`, data || {}),

  /** 审批驳回 */
  reject: (projectId: string, data: { comment: string; reviewer?: string }) =>
    client.post(`/approvals/${projectId}/reject`, data),

  /** 审批历史 */
  history: (projectId: string) => client.get(`/approvals/${projectId}/history`),
};

// 代码生成
export const codegenApi = {
  /** 启动代码生成 */
  start: (projectId: string) => client.post(`/codegen/${projectId}/start`),

  /** 获取代码生成状态 */
  getStatus: (projectId: string) => client.get(`/codegen/${projectId}/status`),

  /** 预览生成的代码 */
  preview: (projectId: string, role: string, iteration?: number) =>
    client.get(`/codegen/${projectId}/preview`, {
      params: { role, ...(iteration !== undefined ? { iteration } : {}) },
    }),

  /** 获取代码文件树 */
  getTree: (projectId: string, role: string) =>
    client.get(`/codegen/${projectId}/tree`, { params: { role } }),

  /** 读取单个文件内容 */
  getFile: (projectId: string, role: string, filePath: string) =>
    client.get(`/codegen/${projectId}/file`, { params: { role, path: filePath } }),
};

// 代码验证
export const validatorApi = {
  /** 启动验证 */
  start: (projectId: string) => client.post(`/validations/${projectId}/start`),

  /** 获取验证结果 */
  getStatus: (projectId: string) => client.get(`/validations/${projectId}`),
};

// 最终审核
export const humanReviewApi = {
  /** 获取最终审核状态 */
  getStatus: (projectId: string) => client.get(`/human-review/${projectId}`),

  /** 最终审核通过 */
  approve: (projectId: string, comment?: string) =>
    client.post(`/human-review/${projectId}/approve`, { comment }),

  /** 最终审核驳回 */
  reject: (projectId: string, comment: string) =>
    client.post(`/human-review/${projectId}/reject`, { comment }),
};

// 代码预览测试
export const previewReviewApi = {
  /** 预览通过，进入最终审核 */
  approve: (projectId: string, comment?: string) =>
    client.post(`/preview-review/${projectId}/approve`, { comment }),

  /** 预览驳回，提交修改意见触发返修 */
  reject: (projectId: string, comment: string) =>
    client.post(`/preview-review/${projectId}/reject`, { comment }),

  /** 启动/获取本地 Vite 预览服务 */
  startPreview: (projectId: string) =>
    client.get(`/preview-review/${projectId}/preview`),

  /** 查询本地预览服务状态 */
  previewStatus: (projectId: string) =>
    client.get(`/preview-review/${projectId}/preview/status`),

  /** 停止本地预览服务 */
  stopPreview: (projectId: string) =>
    client.post(`/preview-review/${projectId}/preview/stop`),
};
