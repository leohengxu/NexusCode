import { BadRequestException, Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { FileService } from '../../common/file.service';
import { WorkflowService } from '../../common/workflow.service';
import { OpencodeSdkService } from '../../common/opencode-sdk.service';
import { CodegenService } from '../codegen/codegen.service';
import { ValidatorRole, ValidatorStatus, ProjectStatus, DocType, CodeGenRole } from '../../common/constants';
import * as fs from 'fs';
import * as path from 'path';

const VALIDATOR_PROMPTS: Record<string, string> = {
  FUNCTIONAL: `你是一个功能一致性验证专家。你的任务是对比 PRD 需求和生成的代码，验证功能完整性。

【验证维度】
1. API 端点是否全部实现（对照 API 契约）
2. 数据模型是否与 DDL 一致
3. 前端页面是否覆盖了 PRD 中的所有功能
4. 前后端接口对齐（请求/响应格式）

【判定标准】
- passed=true 当且仅当：无 critical 级别问题，且 major 级别问题不超过 2 个
- 存在任何 critical 问题 → passed=false
- score 必须 0-100，60 分以上才算通过

【输出格式（JSON）】
{
  "passed": true/false,
  "score": 0-100,
  "issues": [{ "severity": "critical|major|minor", "description": "问题描述", "location": "文件路径" }],
  "summary": "验证总结"
}`,

  SECURITY: `你是一个安全审计专家。你的任务是对生成的代码进行安全漏洞扫描。

【验证维度】
1. SQL 注入防护（参数化查询）
2. XSS 防护（输出转义）
3. CSRF 防护
4. 认证/授权检查（JWT 验证、角色权限）
5. 敏感数据泄露（API Key、密码硬编码）
6. 输入验证（参数校验、边界检查）

【判定标准】
- 存在任何 critical 安全漏洞 → passed=false
- 存在 2 个以上 major 问题 → passed=false
- score 必须 0-100，60 分以上才算通过

【输出格式（JSON）】
{
  "passed": true/false,
  "score": 0-100,
  "issues": [{ "severity": "critical|major|minor", "description": "安全问题描述", "location": "文件路径" }],
  "summary": "安全审计总结"
}`,

  PERFORMANCE: `你是一个性能优化专家。你的任务是对生成的代码进行性能审查。

【验证维度】
1. N+1 查询问题
2. 缺乏缓存策略
3. 大对象传输
4. 未使用懒加载
5. 循环内数据库查询
6. 缺少索引利用

【判定标准】
- 存在 critical 性能问题（如循环内查库） → passed=false
- 存在 3 个以上 major 问题 → passed=false
- score 必须 0-100，60 分以上才算通过

【输出格式（JSON）】
{
  "passed": true/false,
  "score": 0-100,
  "issues": [{ "severity": "critical|major|minor", "description": "性能问题描述", "location": "文件路径" }],
  "summary": "性能审查总结"
}`,

  UI: `你是一个 UI/UX 设计审核专家。你的任务是对生成的前端代码进行视觉规范审查。

【验证维度】
1. 响应式设计（移动端适配）
2. 加载状态处理（骨架屏/loading）
3. 空状态/错误状态处理
4. 交互反馈（toast/notification）
5. 表单验证（前端验证反馈）
6. 符合 Ant Design 设计规范

【判定标准】
- 缺少核心交互反馈 → passed=false
- 存在 3 个以上 major UI 问题 → passed=false
- score 必须 0-100，60 分以上才算通过

【输出格式（JSON）】
{
  "passed": true/false,
  "score": 0-100,
  "issues": [{ "severity": "critical|major|minor", "description": "UI问题描述", "location": "文件路径" }],
  "summary": "UI审查总结"
}`,
};

/** 分数阈值：低于此分数即使 LLM 说 passed=true 也判失败 */
const SCORE_THRESHOLD = 60;

/**
 * 从 LLM 文本输出中提取完整的 JSON 对象（平衡括号匹配）
 * 解决旧版正则 /\{[\s\S]*?\}/ 非贪婪匹配导致嵌套 JSON 被截断的问题
 */
function extractJsonObject(text: string): any | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const jsonStr = text.slice(start, i + 1);
        try {
          return JSON.parse(jsonStr);
        } catch {
          // 尝试清理后重新解析（去除尾部逗号等）
          const cleaned = jsonStr
            .replace(/,\s*}/g, '}')
            .replace(/,\s*]/g, ']');
          try {
            return JSON.parse(cleaned);
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

@Injectable()
export class ValidatorService {
  private readonly logger = new Logger(ValidatorService.name);

  constructor(
    private prisma: PrismaService,
    private fileService: FileService,
    private workflow: WorkflowService,
    private sdkService: OpencodeSdkService,
    @Inject(forwardRef(() => CodegenService))
    private codegenService: CodegenService,
  ) {
    this.logger.log(`Validator Agents 已初始化 (OpenCode SDK mode: ${this.sdkService.isUsingSdk() ? 'active' : 'fallback'})`);
  }

  async startValidation(projectId: string) {
    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        include: {
          codeGens: { orderBy: { iteration: 'desc' } },
          documents: true,
        },
      });
      if (!project) throw new Error('项目不存在');

      if (project.status !== ProjectStatus.PREVIEW) {
        throw new Error(`当前状态 ${project.status} 不允许启动验证`);
      }

      const docs = project.documents.filter(d => d.version === project.version);
      const completedCodeGens = project.codeGens.filter(c => c.status === 'COMPLETED');
      const latestIteration = completedCodeGens.reduce(
        (max, codeGen) => Math.max(max, codeGen.iteration),
        0,
      );
      const currentCodeGens = completedCodeGens.filter(c => c.iteration === latestIteration);
      const frontendCode = currentCodeGens.find(c => c.role === CodeGenRole.FRONTEND);
      const backendCode = currentCodeGens.find(c => c.role === CodeGenRole.BACKEND);

      if (!frontendCode || !backendCode) {
        throw new Error('当前代码迭代未同时完成前端和后端，不能启动验证');
      }

      // 验证 iteration 与被验证的代码 iteration 对齐（取代码记录的真实 iteration），
      // 避免因 iterationCount 与 codeGen iteration 脱节导致错位。
      const validationIteration = frontendCode?.iteration ?? backendCode?.iteration ?? (project.iterationCount + 1);
      const alreadyRunning = await this.prisma.validation.findFirst({
        where: { projectId, iteration: validationIteration, status: 'RUNNING' },
      });
      if (alreadyRunning) {
        this.logger.warn(`[Validator] 项目 ${projectId} iter${validationIteration} 验证已在进行中，忽略重复触发`);
        return;
      }

      const latestTask = await this.prisma.task.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
      });

      const readCode = (codeGen: any): string => {
        if (!codeGen) return '';
        // 优先读取提取后的真实代码文件目录（按 iteration 隔离），而非 LLM 原始 Markdown
        const role = codeGen?.role?.toLowerCase();
        if (role && typeof codeGen.iteration === 'number') {
          const codeDir = this.fileService.getCodeDir(projectId, codeGen.iteration, role);
          const realCode = this.readCodeFilesRecursive(codeDir);
          if (realCode) return realCode;
        }
        // fallback: 读 raw markdown
        if (codeGen?.filePath) {
          try { return this.fileService.readDocument(codeGen.filePath); } catch { }
        }
        return codeGen?.codeContent || '';
      };

      const apiDoc = docs.find(d => d.docType === DocType.API_CONTRACT);
      const readDoc = (doc: any): string => {
        if (doc?.filePath) {
          try { return this.fileService.readDocument(doc.filePath); } catch { }
        }
        return '';
      };

      const frontendContent = readCode(frontendCode);
      const backendContent = readCode(backendCode);

      const hasFrontend = frontendContent.trim().length > 0;
      const hasBackend = backendContent.trim().length > 0;

      if (!hasFrontend || !hasBackend) {
        throw new Error('当前代码迭代存在空代码文件，不能启动验证');
      }

      const context = this.buildValidationContext(
        latestTask?.prdContent || '',
        frontendContent,
        backendContent,
        readDoc(apiDoc),
        project.iterationCount,
      );

      const iteration = validationIteration;

      const validatorRoles = [ValidatorRole.FUNCTIONAL, ValidatorRole.SECURITY, ValidatorRole.PERFORMANCE, ValidatorRole.UI];

      const validationRecords = await Promise.all(
        validatorRoles.map(role =>
          this.prisma.validation.create({
            data: {
              projectId,
              role,
              status: 'RUNNING',
              codeGenId: frontendCode?.id || backendCode?.id,
              iteration,
            },
          }),
        ),
      );

      this.runParallelValidation(projectId, validationRecords, context, iteration).catch((err) => {
        this.logger.error(`[Validator] 并行验证失败: ${err.message}`);
      });
    } catch (error: any) {
      this.logger.error(`[Validator] 启动验证失败: ${error.message}`);
      throw new BadRequestException(error.message);
    }
  }

  private async runParallelValidation(
    projectId: string,
    records: any[],
    context: string,
    iteration: number,
  ) {
    try {
      const results = await Promise.all(
        records.map((record) =>
          this.runSingleValidation(record.id, record.role, context)
            .catch(err => ({
              role: record.role,
              passed: false,
              result: { error: err.message },
              score: 0,
              summary: err.message,
            })),
        ),
      );

      const allPassed = results.every(r => r.passed);

      for (let i = 0; i < records.length; i++) {
        const result = results[i];
        await this.prisma.validation.update({
          where: { id: records[i].id },
          data: {
            status: result.passed ? 'PASSED' : 'FAILED',
            result: JSON.stringify(result.result || {}),
            score: result.score ?? (result.passed ? 90 : 30),
            comments: result.summary,
          },
        });
      }

      if (allPassed) {
        await this.workflow.onValidationPassed(projectId);
      } else {
        // 只有真正验证失败的维度才进反馈（跳过的维度 passed=true，不会进这里）
        const failedResults = results.filter(r => !r.passed);
        const needsRework = await this.workflow.onValidationFailed(projectId, iteration, failedResults);
        if (needsRework) {
          const feedback = failedResults.map(r => {
            const issues = r.result?.issues || [];
            const issueDetails = Array.isArray(issues) && issues.length > 0
              ? '\n' + issues.map((i: any) => `  - [${i.severity || 'unknown'}] ${i.description || ''}${i.location ? ` (位置: ${i.location})` : ''}`).join('\n')
              : '';
            return `[${r.role}] ${r.summary}${issueDetails}`;
          }).join('\n\n');
          await this.codegenService.triggerRework(projectId, feedback);
        }
      }
    } catch (error: any) {
      this.logger.error(`[Validator] 验证流程失败: ${error.message}`);
      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.FAILED },
      });
    }
  }

  private async runSingleValidation(recordId: string, role: string, context: string) {
    const systemPrompt = VALIDATOR_PROMPTS[role] || VALIDATOR_PROMPTS.FUNCTIONAL;

    const userMessage = `请盲审以下代码（你只能看到最终产出，不能看到开发过程）：\n\n${context}\n\n请严格按照 JSON 格式输出验证结果，不要在 JSON 前后添加任何额外文字。`;

    const text = await this.sdkService.prompt(systemPrompt, userMessage, {
      temperature: 0.1,
      maxTokens: 8000,
    });

    // 使用平衡括号匹配提取完整 JSON（解决旧版正则截断嵌套 JSON 的问题）
    const parsed = extractJsonObject(text);
    if (!parsed) {
      return { role, passed: false, result: { error: '无法解析验证结果', raw: text.slice(0, 500) }, score: 0, summary: '验证结果解析失败' };
    }

    const llmPassed = parsed.passed === true;
    const score = typeof parsed.score === 'number' ? parsed.score : 50;
    // 评分阈值：即使 LLM 说 passed=true，score 低于阈值也判失败
    const finalPassed = llmPassed && score >= SCORE_THRESHOLD;

    return {
      role,
      passed: finalPassed,
      result: parsed,
      score,
      summary: parsed.summary || (finalPassed ? '验证通过' : '验证未通过'),
    };
  }

  /**
   * 递归读取代码目录下的所有文件，拼接为带文件路径标注的文本
   */
  private readCodeFilesRecursive(dir: string): string {
    if (!fs.existsSync(dir)) return '';
    const parts: string[] = [];

    const walk = (d: string) => {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const relPath = path.relative(dir, fullPath).replace(/\\/g, '/');
            parts.push(`// ===== ${relPath} =====\n${content}`);
          } catch { /* skip unreadable files */ }
        }
      }
    };

    walk(dir);
    return parts.join('\n\n');
  }

  private buildValidationContext(
    prdContent: string,
    frontendCode: string,
    backendCode: string,
    apiContract: string,
    iteration?: number,
  ): string {
    const sections: string[] = [];

    if (prdContent) sections.push(`## PRD 需求\n${this.truncate(prdContent, 10000)}`);
    if (apiContract) sections.push(`## API 契约\n${this.truncate(apiContract, 10000)}`);
    if (frontendCode) sections.push(`## 前端代码\n${this.truncate(frontendCode, 50000)}`);
    if (backendCode) sections.push(`## 后端代码\n${this.truncate(backendCode, 50000)}`);

    return sections.join('\n\n');
  }

  async getValidationStatus(projectId: string) {
    return this.prisma.validation.findMany({
      where: { projectId },
      orderBy: [{ iteration: 'desc' }, { role: 'asc' }],
    });
  }

  private truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '\n\n... (内容已截断) ...';
  }
}
