import { Injectable, Logger } from '@nestjs/common';
import { DocType } from '../../common/constants';
import {
  OpencodeConfig,
  loadOpencodeConfig,
  isOpencodeConfigured,
} from './opencode.config';
import { OpencodeSdkService } from '../../common/opencode-sdk.service';

// ───────────────────────────── System Prompts ─────────────────────────────
//
// 所有 prompt 对齐 .opencode/skills/engineering-docs 规范：
//   - 技术栈选型     → technical-blueprint 风格
//   - 技术架构文档   → system-architecture-document (C4 模型 + ADR)
//   - 接口文档       → api-design-document (RESTful + OpenAPI 3.1)
//   - 数据库文档     → database-design-document (3NF + ERD + DDL)
// ──────────────────────────────────────────────────────────────────────────

const TECH_STACK_SYSTEM = `你是一个资深软件架构师。根据 PRD 生成一份**技术栈选型文档**（纯 Markdown）。

参考 engineering-docs/technical-blueprint 标准，以权衡分析为中心。

【文档标题】
"# <项目正式名称> 技术栈选型"

【必须包含的章节】
1. 项目概述 — 一句话描述项目核心功能与规模预期
2. 技术选型总览 — 对比表格：层次 | 技术方案 | 版本 | 选型理由 | 备选方案
3. 前端技术栈详细分析
4. 后端技术栈详细分析
5. 数据库与存储选型
6. 中间件与基础设施
7. 部署方案（容器化/CI-CD/环境规划）
8. 技术风险评估
9. 版本清单（精确版本号表格）

【输出要求】
- 纯 Markdown，无外层代码块包裹
- 不包含任何审批标记或状态文字
- 这是展示型参考文档，不参与审批流程
- 每个选型附带 2+ 备选方案对比`;

const MODULE_DESIGN_SYSTEM = `你是一个资深软件架构师。根据 PRD 和已确定的技术栈，生成一份**技术架构文档**（纯 Markdown）。

严格参考 engineering-docs/system-architecture-document 模板规范：
- C4 模型：Level 1 系统上下文 → Level 2 容器架构 → Level 3 组件架构
- 4+1 视图：逻辑视图、进程视图、开发视图、部署视图、场景
- ADR 日志记录关键架构决策

【文档标题】
"# <项目正式名称> 技术架构文档"

【必须包含的章节】
1. 执行摘要 — 架构理念、核心设计原则
2. 系统上下文 (C4 Level 1) — Mermaid flowchart 展示系统与外部交互
3. 容器架构 (C4 Level 2) — Mermaid flowchart 展示服务/数据库/队列等容器
4. 组件架构 (C4 Level 3) — 核心模块内部组件图
5. 部署视图 — Mermaid flowchart 展示物理部署拓扑
6. 关键业务流程 — 至少 2 个 Mermaid sequenceDiagram
7. 模块职责说明表 — 模块名 | 职责 | 对外接口 | 依赖
8. 非功能性设计 — 性能/安全/可用性/可扩展性（每项可测量目标）
9. 技术决策记录 (ADR) — 至少 3 条，格式：上下文 → 决策 → 理由 → 替代方案
10. 已知技术债务

【Mermaid 图语法要求】
- 必须用 \`\`\`mermaid 代码块，不能省略语言标识
- **节点 ID 和 subgraph 名必须用英文**（如 node1, sub1, api, db），中文内容放在方括号标签内
  - 正确：subgraph users["用户角色"] / node1["旅行者"]
  - 错误：subgraph 用户["用户角色"] / 旅行者["旅行者"]
- flowchart 用 TB 方向
- sequenceDiagram 参与者用英文 ID + 中文别名：participant user as "旅行者"
- 不要在 subgraph 内使用 direction 指令
- 每个图下方加简短文字说明

【输出要求】
- 纯 Markdown，无外层代码块包裹
- 使用 🔶 Assumption 和 🔵 Open Question 标记假设和待确认项`;

const API_CONTRACT_SYSTEM = `你是一个资深 API 设计师。根据 PRD、技术栈和模块设计，生成一份**接口文档**（纯 Markdown）。

严格参考 engineering-docs/api-design-document 模板规范：
- Richardson 成熟度模型 Level 2+
- RESTful 资源建模（名词、复数、嵌套表示所有权）
- RFC 7807 Problem Details 错误格式
- OpenAPI 3.1 规范

【文档标题】
"# <项目正式名称> 接口文档"

【必须包含的章节】
1. 概述 — Base URL、认证方式(JWT Bearer)、通用响应格式、错误码规范
2. 通用约定 — 请求头、分页参数、排序、筛选
3. 资源模型 — 列出所有资源及其关系，Mermaid erDiagram
4. 认证与授权 — 角色权限矩阵表格
5. API 版本化策略 — 版本号、弃用策略
6. 接口详细定义 — 按模块分组，每个接口包含：
   - 路径 \`METHOD /api/v1/xxx\`
   - 描述
   - 请求参数表格（参数名|类型|必填|说明）
   - 请求示例（JSON 代码块）
   - 响应示例（JSON 代码块）
   - 错误码表
7. 错误处理 — 标准错误码目录表（HTTP状态码|错误码|说明|解决方案）
8. 速率限制
9. OpenAPI 3.1 规范（YAML 代码块，完整可用的 swagger 文档）
10. 安全检查清单

【输出要求】
- 纯 Markdown，无外层代码块包裹
- 字段名与数据库文档严格对应
- 使用 🔶 Assumption 标记未确认的端点设计`;

const DATA_MODEL_SYSTEM = `你是一个资深数据库架构师。根据 PRD、技术栈、模块设计和 API 契约，生成一份**数据库设计文档**（纯 Markdown）。

严格参考 engineering-docs/database-design-document 模板规范：
- 范式要求：至少 3NF，有意反范式必须文档化
- 索引原则：每个 FK 必须有索引；WHERE/JOIN/ORDER BY 列必须索引
- 数据完整性：FK 约束不可仅在应用层；CHECK 约束；金额用 DECIMAL
- 所有图表使用 Mermaid

【文档标题】
"# <项目正式名称> 数据库设计文档"

【必须包含的章节】
1. 数据库概述 — 选型说明、字符集(UTF8MB4)、排序规则、版本
2. ER 图 — Mermaid erDiagram，展示所有核心实体关系
3. 核心表设计 — 每张表单独小节：
   - 表说明（一句话用途）
   - 字段表格（字段名|类型|约束|默认值|说明）
   - 索引表格（索引名|字段|类型|说明）
   - 关联关系说明
4. 索引策略 — 热查询模式与索引覆盖分析
5. 范式决策 — 3NF 遵循情况，如有反范式说明理由
6. 约束与数据完整性 — 引用完整性规则 + 应用层校验规则
7. 敏感数据分类 — PII/敏感字段标注
8. 完整 DDL — SQL 代码块，兼容 PostgreSQL，标注 MySQL 差异
9. 迁移计划 — 初始化脚本策略 + 回滚方案
10. 开放问题 — 🔵 标记待确认项

【输出要求】
- 纯 Markdown，无外层代码块包裹
- 所有字段名与 API 接口文档严格对应
- DDL 包含完整 COMMENT 注释
- 使用 🔶 Assumption 和 🔵 Open Question 标记`;

// ───────────────────────────── Interfaces ─────────────────────────────

interface GenerateResult {
  docType: DocType;
  content: string;
}

export interface ThinkingStep {
  step: number;
  total: number;
  title: string;
  thought: string;
  status: 'pending' | 'running' | 'done';
  timestamp: string;
}

export interface GenerateOptions {
  prdContent: string;
  rejectionComment?: string;
  onProgress?: (step: ThinkingStep) => void | Promise<void>;
}

// ───────────────────────────── Service ─────────────────────────────

@Injectable()
export class OpencodeService {
  private readonly logger = new Logger(OpencodeService.name);
  private readonly config: OpencodeConfig;

  constructor(private sdkService: OpencodeSdkService) {
    // 宽松加载，避免缺配置时构造函数抛错导致整个模块（乃至应用）无法启动。
    // 真正调用 LLM 前（invoke）再做严格校验。
    this.config = loadOpencodeConfig(false);

    this.logger.log(`架构师 Agent 已初始化 (OpenCode SDK mode)`);
    this.logger.log(`  Model  : ${this.config.model}`);
    this.logger.log(`  URL    : ${this.config.baseURL}`);
    this.logger.log(`  SDK    : ${this.sdkService.isUsingSdk() ? 'active' : 'fallback (LangChain)'}`);
  }

  /**
   * 架构师 Agent 编排：分 5 个思考步骤顺序生成，每步传递前面的上下文确保一致性
   */
  async generateDocuments(options: GenerateOptions): Promise<{ projectName: string; results: GenerateResult[] }> {
    const { prdContent, rejectionComment, onProgress } = options;
    const prd = this.truncate(prdContent, 32000);
    const rejectionNote = rejectionComment
      ? `\n\n【驳回意见】${rejectionComment}\n请根据以上意见全量重新生成。`
      : '';

    const results: GenerateResult[] = [];
    let projectName = '';

    const steps = [
      { step: 1, total: 5, title: '解析 PRD 核心需求', thought: '阅读 PRD，提取产品名称、功能边界、非功能需求。' },
      { step: 2, total: 5, title: '技术栈选型', thought: '根据功能规模与约束，对比前端/后端/数据库/中间件方案。' },
      { step: 3, total: 5, title: '技术架构设计', thought: '基于 C4 模型与 4+1 视图设计系统结构、模块边界、部署拓扑。' },
      { step: 4, total: 5, title: '接口设计', thought: '设计 RESTful 资源、端点、请求/响应格式与 OpenAPI 3.1 规范。' },
      { step: 5, total: 5, title: '数据库设计', thought: '基于接口契约生成 ER 图、DDL、索引策略与数据完整性规则。' },
    ];

    const notify = async (index: number, status: ThinkingStep['status'], overrideThought?: string) => {
      if (!onProgress) return;
      const base = steps[index - 1];
      try {
        await onProgress({
          step: base.step,
          total: base.total,
          title: base.title,
          thought: overrideThought ?? base.thought,
          status,
          timestamp: new Date().toISOString(),
        });
      } catch (e: any) {
        // 进度回调失败不应中断主流程
        this.logger.warn(`[OpencodeService] onProgress 回调失败: ${e?.message || e}`);
      }
    };

    try {
      // ── Step 1: 解析需求 ──（进度提示，不产出文档）
      await notify(1, 'running');
      await this.sleep(300);
      await notify(1, 'done', '已提取 PRD 核心需求与项目背景。');

      // ── Step 2: 技术栈选型 ──
      this.logger.log('Agent [1/4] 生成技术栈选型 (technical-blueprint)...');
      await notify(2, 'running');
      const techStack = await this.invoke(TECH_STACK_SYSTEM, prd, rejectionNote);
      projectName = this.extractProjectName(techStack);
      results.push({ docType: DocType.TECH_STACK, content: techStack });
      await notify(2, 'done', projectName
        ? `已确定项目名称为「${projectName}」，并输出技术栈选型方案。`
        : '已输出技术栈选型方案。');

      // ── Step 3: 技术架构文档 (system-architecture-document) ──
      this.logger.log('Agent [2/4] 生成技术架构文档 (C4 model + ADR)...');
      await notify(3, 'running');
      const moduleCtx = `## 技术栈选型\n${this.truncate(techStack, 8000)}`;
      const moduleDesign = await this.invoke(MODULE_DESIGN_SYSTEM, prd, rejectionNote, moduleCtx);
      results.push({ docType: DocType.MODULE_DESIGN, content: moduleDesign });
      await notify(3, 'done', '已生成 C4 系统/容器/组件视图、部署视图与 ADR。');

      // ── Step 4: 接口文档 (api-design-document) ──
      this.logger.log('Agent [3/4] 生成接口文档 (OpenAPI 3.1)...');
      await notify(4, 'running');
      const apiCtx =
        `## 技术栈选型\n${this.truncate(techStack, 6000)}\n\n` +
        `## 技术架构\n${this.truncate(moduleDesign, 6000)}`;
      const apiContract = await this.invoke(API_CONTRACT_SYSTEM, prd, rejectionNote, apiCtx);
      results.push({ docType: DocType.API_CONTRACT, content: apiContract });
      await notify(4, 'done', '已生成接口文档、资源模型与 OpenAPI 3.1 规范。');

      // ── Step 5: 数据库文档 (database-design-document) ──
      this.logger.log('Agent [4/4] 生成数据库文档 (3NF + ERD + DDL)...');
      await notify(5, 'running');
      const dataCtx =
        `## 技术栈选型\n${this.truncate(techStack, 4000)}\n\n` +
        `## 技术架构\n${this.truncate(moduleDesign, 4000)}\n\n` +
        `## 接口文档\n${this.truncate(apiContract, 6000)}`;
      const dataModel = await this.invoke(DATA_MODEL_SYSTEM, prd, rejectionNote, dataCtx);
      results.push({ docType: DocType.DATA_MODEL, content: dataModel });
      await notify(5, 'done', '已生成 ER 图、完整 DDL 与索引策略。');

      this.logger.log(`架构师 Agent 完成 4 份文档，项目: ${projectName}`);
      return { projectName, results };
    } catch (error: any) {
      throw this.classifyError(error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 从技术栈文档第一行提取项目名称
   */
  private extractProjectName(techStackContent: string): string {
    const lines = techStackContent.split('\n');
    const firstLine = lines[0].trim();
    const match = firstLine.match(/^#\s+(.+?)\s*技术栈选型/);
    if (match && match[1].trim()) return match[1].trim();
    const fallback = firstLine.match(/^#\s+(.+)/);
    return fallback ? fallback[1].trim() : '';
  }

  /**
   * 通用 LLM 调用 — 通过 OpenCode SDK（或 LangChain 回退）
   */
  private async invoke(
    systemPrompt: string,
    prd: string,
    rejectionNote: string,
    context?: string,
  ): Promise<string> {
    if (!isOpencodeConfigured()) {
      throw new Error(
        '缺少 OPENCODE_API_KEY 或 OPENCODE_MODEL，无法调用 LLM。请在 backend/.env 中配置后重启服务。',
      );
    }

    const userMessage = `## PRD 文档\n${prd}${rejectionNote}\n${context || ''}\n请严格按照要求输出文档。`;

    const response = await this.sdkService.prompt(systemPrompt, userMessage, {
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    });

    return this.stripCodeBlock(response);
  }

  private stripCodeBlock(text: string): string {
    const trimmed = text.trim();
    const match = trimmed.match(/^```[\w]*\s*\n?([\s\S]*?)\n?```$/);
    return match ? match[1].trim() : trimmed;
  }

  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    this.logger.warn(`内容过长 (${text.length} chars)，截断至 ${maxChars} chars`);
    return text.slice(0, maxChars) + '\n\n... (内容已截断) ...';
  }

  private classifyError(error: any): Error {
    const msg = error?.message || '';
    if (msg.includes('401') || msg.includes('403')) {
      return new Error('LLM 认证失败，请检查 OPENCODE_API_KEY 配置\n访问 https://opencode.ai/auth 获取 API Key');
    }
    if (msg.includes('429')) return new Error('LLM 请求频率过高，请稍后重试');
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) return new Error('LLM 请求超时');
    return new Error(`LLM 调用失败: ${msg.slice(0, 200)}`);
  }
}
