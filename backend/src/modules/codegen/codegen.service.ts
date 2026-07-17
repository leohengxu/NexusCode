import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { FileService } from '../../common/file.service';
import { WorkflowService } from '../../common/workflow.service';
import { OpencodeSdkService } from '../../common/opencode-sdk.service';
import { CodeGenRole, ProjectStatus, DocType } from '../../common/constants';
import { parseGeneratedCode, buildFileTree, FileTreeNode, ExtractedFile } from '../../common/code-parser';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 代码生成 maxTokens，从 LLM_MAX_TOKENS 统一取值（与 planner/validator 共享同一配置口）。
 * 默认 16000，过小会导致输出截断 → 验证失败 → 无限返修。
 */
const CODEGEN_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || '16000', 10);

/** 写盘前要求的最小可用磁盘空间（字节），不足则拒绝写入 */
const MIN_FREE_DISK_BYTES = 50 * 1024 * 1024; // 50MB

/** Limit prior-source context so a rework prompt remains within the model's usable input window. */
const REWORK_SOURCE_CONTEXT_MAX_CHARS = 24_000;

type ReworkSource = {
  context: string;
  iteration: number;
};

type ReworkSources = Partial<Record<'FRONTEND' | 'BACKEND', ReworkSource>>;

const FRONTEND_SYSTEM = `你是一个资深前端开发工程师。根据架构设计文档，生成完整的前端项目代码。

【技术栈】
- React 18 + TypeScript + Vite
- Ant Design 5 组件库
- Axios HTTP 客户端
- React Router 6

【语法要求 - 必须遵守】
- 必须使用 ESM 语法：import / export default / export { } / export const
- 严禁使用 CommonJS 语法：require() / module.exports / exports.xxx
- 动态导入用 await import() 而非 require()
- 所有文件均为 ES Module，不要在函数体内使用 require()
- @ant-design/icons 只能使用该包真实导出的图标名；点赞和点踩分别使用 LikeOutlined、DislikeOutlined
- 聊天消息自动滚动只能操作消息列表容器自身的 scrollTop/scrollTo，禁止用 scrollIntoView 带动宿主页面或 iframe 外层滚动

【输出格式 - 必须严格遵守】
每个文件用单独的代码块标注路径，格式如下（路径前不要加反引号）：

正确的格式（左边三个反引号 + 语言 + 冒号 + 路径，不包含多余的反引号）：
\`\`\`tsx:src/pages/Example.tsx
// 代码内容
\`\`\`

错误的格式（不要这样）：
\`\`\`tsx:\`src/pages/Example.tsx\`  ← 不要在路径外套反引号
\`\`\`tsx
// src/pages/Example.tsx  ← 不要将路径写在注释里

每个文件前加简短说明，输出内容要精简、可运行。

生成以下文件：
1. src/api/client.ts - Axios 实例
2. src/api/endpoints.ts - API 接口定义
3. src/pages/Dashboard.tsx - 仪表盘页面
4. src/pages/ListPage.tsx - 列表页面  
5. src/pages/DetailPage.tsx - 详情页面
6. src/components/Layout.tsx - 布局组件
7. src/App.tsx - 主应用
8. src/main.tsx - 入口文件
9. src/router.tsx - 路由配置`;

const BACKEND_SYSTEM = `你是一个资深后端开发工程师（NestJS）。根据架构设计文档，生成完整的后端项目代码。

【技术栈】
- NestJS + TypeScript
- Prisma ORM + PostgreSQL
- Swagger/OpenAPI
- JWT 认证 (fastify-jwt)

【输出格式 - 必须严格遵守】
每个文件用单独的代码块标注路径，格式如下（路径前不要加反引号）：

正确的格式：
\`\`\`ts:src/modules/example/example.service.ts
// 代码内容
\`\`\`

错误的格式（不要这样）：
\`\`\`ts:\`src/modules/example/example.service.ts\`  ← 不要在路径外套反引号
\`\`\`ts
// src/modules/example/example.service.ts  ← 不要将路径写在注释里

每个文件前加简短说明，输出内容要精简、可运行。

生成以下文件：
1. src/app.module.ts - 根模块
2. src/main.ts - 入口文件
3. src/common/prisma.service.ts - Prisma 服务
4. src/modules/auth/auth.module.ts - 认证模块
5. src/modules/auth/auth.controller.ts - 认证控制器
6. src/modules/auth/auth.service.ts - 认证服务
7. src/modules/users/users.module.ts - 用户模块
8. src/modules/users/users.controller.ts - 用户控制器
9. src/modules/users/users.service.ts - 用户服务
10. prisma/schema.prisma - 数据模型`;

@Injectable()
export class CodegenService {
  private readonly logger = new Logger(CodegenService.name);
  private antDesignIconExports?: Set<string>;

  constructor(
    private prisma: PrismaService,
    private fileService: FileService,
    private workflow: WorkflowService,
    private sdkService: OpencodeSdkService,
  ) {
    this.logger.log(`Worker Agent (CodeGen) 已初始化 (OpenCode SDK mode: ${this.sdkService.isUsingSdk() ? 'active' : 'fallback'})`);
  }

  /**
   * 计算下一个安全的 codeGen iteration 号。
   * 取「该项目已有 codeGen 记录的最大 iteration + 1」与 floor 的较大者，
   * 保证单调递增，避免与历史/脏数据撞 @@unique([projectId,role,iteration])。
   */
  private async nextCodeGenIteration(projectId: string, floor: number): Promise<number> {
    const latest = await this.prisma.codeGen.findFirst({
      where: { projectId },
      orderBy: { iteration: 'desc' },
      select: { iteration: true },
    });
    const maxExisting = latest?.iteration ?? 0;
    return Math.max(maxExisting + 1, floor);
  }

  async startCodeGeneration(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { documents: true },
    });
    if (!project) throw new Error('项目不存在');

    // 并发保护：已有 RUNNING 的代码生成记录说明正在进行中，拒绝重复触发，
    // 否则会创建重复记录并可能触发 @@unique([projectId,role,iteration]) 冲突崩溃。
    const running = await this.prisma.codeGen.findFirst({
      where: { projectId, status: { in: ['PENDING', 'RUNNING'] } },
    });
    if (running) {
      this.logger.warn(`[CodeGen] 项目 ${projectId} 已有代码生成进行中，忽略重复触发`);
      throw new Error('代码生成已在进行中，请勿重复触发');
    }

    const docs = project.documents.filter(d => d.version === project.version);
    const apiContract = docs.find(d => d.docType === DocType.API_CONTRACT);
    const dataModel = docs.find(d => d.docType === DocType.DATA_MODEL);
    const moduleDesign = docs.find(d => d.docType === DocType.MODULE_DESIGN);

    const context = [
      apiContract ? `## API 契约\n${apiContract.filePath ? this.fileService.readDocument(apiContract.filePath).slice(0, 10000) : ''}` : '',
      dataModel ? `## 数据模型\n${dataModel.filePath ? this.fileService.readDocument(dataModel.filePath).slice(0, 8000) : ''}` : '',
      moduleDesign ? `## 架构设计\n${moduleDesign.filePath ? this.fileService.readDocument(moduleDesign.filePath).slice(0, 8000) : ''}` : '',
    ].filter(Boolean).join('\n\n');

    // iteration 取「已有 codeGen 最大 iteration + 1」与「iterationCount + 1」的较大者，
    // 保证单调递增、不与历史记录撞 @@unique([projectId,role,iteration])。
    const iteration = await this.nextCodeGenIteration(projectId, project.iterationCount + 1);

    const [frontendRecord, backendRecord] = await this.prisma.$transaction([
      this.prisma.codeGen.create({
        data: { projectId, role: CodeGenRole.FRONTEND, status: 'PENDING', iteration },
      }),
      this.prisma.codeGen.create({
        data: { projectId, role: CodeGenRole.BACKEND, status: 'PENDING', iteration },
      }),
    ]);

    try {
      await this.workflow.startDevelopment(projectId);
      await this.prisma.codeGen.updateMany({
        where: { id: { in: [frontendRecord.id, backendRecord.id] } },
        data: { status: 'RUNNING', startTime: new Date() },
      });
    } catch (error) {
      await this.prisma.codeGen.deleteMany({
        where: { id: { in: [frontendRecord.id, backendRecord.id] }, status: 'PENDING' },
      }).catch(() => {});
      throw error;
    }

    // LLM 重活 fire-and-forget，使入口能快速返回（守卫/状态转换已同步完成）
    this.generateCodeParallel(projectId, frontendRecord.id, backendRecord.id, context, iteration)
      .catch((err) => this.logger.error(`[CodeGen] 并行代码生成失败: ${err.message}`));
  }

  private async generateCodeParallel(
    projectId: string,
    frontendId: string,
    backendId: string,
    context: string,
    iteration: number,
    reworkSources?: ReworkSources,
  ) {
    let frontendSuccess = false;
    let backendSuccess = false;

    const workerTask = async (
      role: 'FRONTEND' | 'BACKEND',
      recordId: string,
      systemPrompt: string,
    ) => {
      try {
        const reworkSource = reworkSources?.[role];
        const workerContext = `${context}${reworkSource?.context || ''}`;
        const result = await this.generateWorkerCode(role, systemPrompt, workerContext);
        const meta = await this.saveExtractedFiles(
          projectId,
          role,
          result,
          iteration,
          reworkSource?.iteration,
        );
        await this.prisma.codeGen.update({
          where: { id: recordId },
          data: {
            status: 'COMPLETED', endTime: new Date(),
            filePath: meta.rawPath, codeContent: result.slice(0, 50000),
            tree: JSON.stringify(meta.tree),
          },
        });
        await this.workflow.onCodeGenProgress(projectId, role, 'COMPLETED');
        this.logger.log(`[CodeGen] ${role} 代码生成完成，${meta.fileCount} 个文件`);
        return true;
      } catch (err: any) {
        this.logger.error(`[CodeGen] ${role} Worker 失败: ${err.message}`);
        await this.prisma.codeGen.update({
          where: { id: recordId },
          data: { status: 'FAILED', endTime: new Date(), errorMsg: err.message },
        }).catch(() => {});
        await this.workflow.onCodeGenProgress(projectId, role, 'FAILED');
        return false;
      }
    };

    try {
      const [feOk, beOk] = await Promise.all([
        workerTask('FRONTEND', frontendId, FRONTEND_SYSTEM),
        workerTask('BACKEND', backendId, BACKEND_SYSTEM),
      ]);
      frontendSuccess = feOk;
      backendSuccess = beOk;

      if (!frontendSuccess || !backendSuccess) {
        // 两个 Worker 必须作为一个原子结果处理，不能拿半套代码进入预览/验证。
        const failedRoles = [
          !frontendSuccess ? CodeGenRole.FRONTEND : null,
          !backendSuccess ? CodeGenRole.BACKEND : null,
        ].filter(Boolean).join(', ');
        const failedGen = await this.prisma.codeGen.findFirst({
          where: { projectId, status: 'FAILED' },
          orderBy: { endTime: 'desc' },
        });
        const latestTask = await this.prisma.task.findFirst({
          where: { projectId },
          orderBy: { createdAt: 'desc' },
        });
        if (latestTask && failedGen) {
          await this.prisma.task.update({
            where: { id: latestTask.id },
            data: { errorMsg: `代码生成失败：${failedRoles} - ${failedGen?.errorMsg || 'Worker 未完成'}` },
          });
        }
        await this.prisma.project.update({
          where: { id: projectId },
          data: { status: ProjectStatus.FAILED },
        });
        await this.workflow.onError(projectId, `代码生成未完整完成，失败角色：${failedRoles}`);
        return;
      }

      // 代码生成完成 → 进入预览测试阶段
      await this.workflow.onCodeGenCompleted(projectId);
    } catch (error: any) {
      this.logger.error(`[CodeGen] 代码生成协调失败: ${error.message}`);
      if (!frontendSuccess) {
        await this.prisma.codeGen.update({ where: { id: frontendId }, data: { status: 'FAILED', endTime: new Date(), errorMsg: error.message } }).catch(() => {});
      }
      if (!backendSuccess) {
        await this.prisma.codeGen.update({ where: { id: backendId }, data: { status: 'FAILED', endTime: new Date(), errorMsg: error.message } }).catch(() => {});
      }
      // 记录错误信息到 task 表
      const latestTask = await this.prisma.task.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } }).catch(() => null);
      if (latestTask) {
        await this.prisma.task.update({ where: { id: latestTask.id }, data: { errorMsg: `代码生成失败：${error.message}` } }).catch(() => {});
      }
      await this.prisma.project.update({ where: { id: projectId }, data: { status: ProjectStatus.FAILED } });
      await this.workflow.onError(projectId, error.message);
    }
  }

  private async generateWorkerCode(
    role: string,
    systemPrompt: string,
    context: string,
  ): Promise<string> {
    try {
      const userMessage = `请根据以下架构设计生成 ${role} 代码：\n\n${context}\n\n请按照要求输出完整代码。`;

      this.logger.log(`[CodeGen] ${role} Worker 开始调用 LLM (context 长度: ${context.length} chars)`);

      const content = await this.sdkService.prompt(systemPrompt, userMessage, {
        temperature: 0.2,
        maxTokens: CODEGEN_MAX_TOKENS,
      });

      this.logger.log(`[CodeGen] ${role} Worker LLM 返回: ${content.length} chars (preview: ${content.slice(0, 200).replace(/\n/g, '\\n')})`);

      if (!content || content.trim().length < 50) {
        const preview = content ? `"${content.slice(0, 300)}"` : '(null/undefined)';
        throw new Error(`生成的内容为空或过短 (length=${content?.length || 0}, preview=${preview})`);
      }
      return content;
    } catch (err: any) {
      this.logger.error(`[CodeGen] ${role} Worker 调用失败: ${err.message}`);
      throw err;
    }
  }

  async triggerRework(projectId: string, feedback: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { documents: true },
    });
    if (!project) throw new Error('项目不存在');

    // 并发保护：已有 RUNNING 代码生成时拒绝重复返修
    const running = await this.prisma.codeGen.findFirst({
      where: { projectId, status: { in: ['PENDING', 'RUNNING'] } },
    });
    if (running) {
      this.logger.warn(`[CodeGen] 项目 ${projectId} 已有代码生成进行中，忽略重复返修`);
      throw new Error('代码生成已在进行中，请勿重复触发返修');
    }

    // 迭代号由上游（onValidationFailed / onHumanReviewRejected / enterManualRework）
    // 在进入 REWORKING 时已设置到 project.iterationCount。以其为下限，但取「已有
    // codeGen 最大 iteration + 1」的较大者，避免与历史记录撞 @@unique。
    const iteration = await this.nextCodeGenIteration(projectId, project.iterationCount);

    const docs = project.documents.filter(d => d.version === project.version);
    const apiContract = docs.find(d => d.docType === DocType.API_CONTRACT);
    const dataModel = docs.find(d => d.docType === DocType.DATA_MODEL);
    const moduleDesign = docs.find(d => d.docType === DocType.MODULE_DESIGN);

    const context = [
      apiContract ? `## API 契约\n${apiContract.filePath ? this.fileService.readDocument(apiContract.filePath).slice(0, 10000) : ''}` : '',
      dataModel ? `## 数据模型\n${dataModel.filePath ? this.fileService.readDocument(dataModel.filePath).slice(0, 8000) : ''}` : '',
      moduleDesign ? `## 架构设计\n${moduleDesign.filePath ? this.fileService.readDocument(moduleDesign.filePath).slice(0, 8000) : ''}` : '',
    ].filter(Boolean).join('\n\n');

    const feedbackCtx = `\n\n## 返修反馈\n${feedback}\n\n这是对已有项目的定向修改。仅输出需要修改或新增的完整文件，不要重新生成无关文件。保持现有功能、路由和 API 契约不变，除非反馈明确要求。`;
    const reworkSources = await this.getReworkSources(projectId);

    const [frontendRecord, backendRecord] = await this.prisma.$transaction([
      this.prisma.codeGen.create({
        data: { projectId, role: CodeGenRole.FRONTEND, status: 'PENDING', iteration },
      }),
      this.prisma.codeGen.create({
        data: { projectId, role: CodeGenRole.BACKEND, status: 'PENDING', iteration },
      }),
    ]);

    try {
      await this.workflow.startRework(projectId);
      await this.prisma.codeGen.updateMany({
        where: { id: { in: [frontendRecord.id, backendRecord.id] } },
        data: { status: 'RUNNING', startTime: new Date() },
      });
    } catch (error) {
      await this.prisma.codeGen.deleteMany({
        where: { id: { in: [frontendRecord.id, backendRecord.id] }, status: 'PENDING' },
      }).catch(() => {});
      throw error;
    }

    // LLM 重活 fire-and-forget
    this.generateCodeParallel(
      projectId,
      frontendRecord.id,
      backendRecord.id,
      context + feedbackCtx,
      iteration,
      reworkSources,
    )
      .catch((err) => this.logger.error(`[CodeGen] 返修代码生成失败: ${err.message}`));
  }

  /**
   * Supplies each worker with a bounded view of its last completed implementation.
   * The full directory is copied before generated changes are applied, so omitted files
   * remain intact even when the model returns a focused rework patch.
   */
  private async getReworkSources(projectId: string): Promise<ReworkSources> {
    const result: ReworkSources = {};
    for (const role of ['FRONTEND', 'BACKEND'] as const) {
      const record = await this.prisma.codeGen.findFirst({
        where: { projectId, role, status: 'COMPLETED' },
        orderBy: { iteration: 'desc' },
        select: { iteration: true },
      });
      if (!record) continue;

      const baseDir = this.fileService.getCodeDir(projectId, record.iteration, role);
      if (!fs.existsSync(baseDir)) continue;

      const files = this.readSourceFiles(baseDir, REWORK_SOURCE_CONTEXT_MAX_CHARS);
      result[role] = {
        iteration: record.iteration,
        context: files.length
          ? `\n\n## Previous ${role} source (reference for this targeted rework)\n${files
            .map(file => '```' + this.languageForFile(file.path) + ':' + file.path + '\n' + file.content + '\n```')
            .join('\n\n')}`
          : '',
      };
    }
    return result;
  }

  private readSourceFiles(baseDir: string, maxChars: number): ExtractedFile[] {
    const files: ExtractedFile[] = [];
    const visit = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
        } else if (entry.isFile()) {
          files.push({
            path: path.relative(baseDir, fullPath).split(path.sep).join('/'),
            content: fs.readFileSync(fullPath, 'utf-8'),
            language: this.languageForFile(fullPath),
          });
        }
      }
    };
    visit(baseDir);

    const priority = (file: ExtractedFile) => {
      if (file.path.startsWith('src/pages/') || file.path.startsWith('src/modules/')) return 0;
      if (file.path.startsWith('src/api/')) return 1;
      if (file.path.startsWith('src/')) return 2;
      return 3;
    };
    let usedChars = 0;
    return files
      .sort((a, b) => priority(a) - priority(b) || a.path.localeCompare(b.path))
      .filter((file) => {
        const nextChars = usedChars + file.path.length + file.content.length + 32;
        if (nextChars > maxChars) return false;
        usedChars = nextChars;
        return true;
      });
  }

  private languageForFile(filePath: string): string {
    const extension = path.extname(filePath).slice(1);
    return extension || 'text';
  }

  private normalizeFrontendIconImports(files: ExtractedFile[]): void {
    const iconExports = this.getAntDesignIconExports();
    if (iconExports.size === 0) return;

    const semanticFallbacks: Record<string, string> = {
      ThumbsUpOutlined: 'LikeOutlined',
      ThumbsDownOutlined: 'DislikeOutlined',
    };
    const importPattern = /import\s*\{([\s\S]*?)\}\s*from\s*(['"])@ant-design\/icons\2\s*;?/g;

    for (const file of files) {
      if (!/\.[jt]sx?$/.test(file.path)) continue;
      file.content = file.content.replace(importPattern, (_statement, specifierText: string, quote: string) => {
        const specifiers = specifierText.split(',').map(specifier => specifier.trim()).filter(Boolean);
        const normalized = specifiers.map((specifier) => {
          const match = specifier.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
          if (!match) return specifier;

          const importedName = match[1];
          const localName = match[2] || importedName;
          if (iconExports.has(importedName)) return specifier;

          const replacement = semanticFallbacks[importedName] || 'QuestionCircleOutlined';
          this.logger.warn(
            `[CodeGen] Invalid @ant-design/icons export ${importedName} in ${file.path}; using ${replacement}`,
          );
          return replacement === localName ? replacement : `${replacement} as ${localName}`;
        });
        return `import { ${normalized.join(', ')} } from ${quote}@ant-design/icons${quote};`;
      });
    }
  }

  private getAntDesignIconExports(): Set<string> {
    if (this.antDesignIconExports) return this.antDesignIconExports;
    try {
      const frontendRoot = process.env.FRONTEND_ROOT || path.resolve(process.cwd(), '..', 'frontend');
      const modulePath = require.resolve('@ant-design/icons', { paths: [frontendRoot] });
      this.antDesignIconExports = new Set(Object.keys(require(modulePath)));
    } catch (error: any) {
      this.logger.warn(`[CodeGen] Unable to inspect @ant-design/icons exports: ${error.message}`);
      this.antDesignIconExports = new Set();
    }
    return this.antDesignIconExports;
  }

  private async saveExtractedFiles(
    projectId: string,
    role: string,
    markdown: string,
    iteration: number,
    sourceIteration?: number,
  ): Promise<{ rawPath: string; tree: FileTreeNode; fileCount: number }> {
    // 写盘前检查磁盘空间，不足时明确报错而非写盘中途失败
    const disk = this.fileService.checkDiskSpace(MIN_FREE_DISK_BYTES);
    if (!disk.ok) {
      const availMB = Math.round(disk.available / 1024 / 1024);
      throw new Error(`磁盘空间不足（可用 ${availMB}MB，需至少 50MB），无法保存代码`);
    }

    const baseDir = this.fileService.getCodeDir(projectId, iteration, role);
    if (fs.existsSync(baseDir)) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    if (sourceIteration !== undefined) {
      const sourceDir = this.fileService.getCodeDir(projectId, sourceIteration, role);
      if (fs.existsSync(sourceDir)) {
        fs.cpSync(sourceDir, baseDir, { recursive: true, force: true, dereference: false });
      }
    }

    const rawPath = path.join(
      this.fileService.getProjectDir(projectId),
      `generated_iter${iteration}_${role.toLowerCase()}.md`,
    );
    this.fileService.saveDocumentRaw(rawPath, markdown);

    const files = parseGeneratedCode(markdown);
    if (files.length === 0) {
      const debugPath = path.join(
        this.fileService.getProjectDir(projectId),
        `debug_iter${iteration}_${role.toLowerCase()}_output.md`,
      );
      this.fileService.saveDocumentRaw(debugPath, markdown);
      this.logger.error(`[CodeGen] ${role} LLM 输出已保存到 ${debugPath}，提取到 0 个文件`);
      throw new Error(`LLM 输出中未解析到任何代码文件，请检查模型输出格式 (debug: ${debugPath})`);
    }
    if (role === CodeGenRole.FRONTEND) {
      this.normalizeFrontendIconImports(files);
    }
    for (const file of files) {
      const fullPath = this.fileService.resolveWithin(baseDir, file.path);
      const dirName = path.dirname(fullPath);
      if (!fs.existsSync(dirName)) {
        fs.mkdirSync(dirName, { recursive: true });
      }
      fs.writeFileSync(fullPath, file.content, 'utf-8');
    }

    const allFiles = this.readSourceFiles(baseDir, Number.MAX_SAFE_INTEGER);
    const tree = buildFileTree(allFiles);

    this.logger.log(`[CodeGen] ${role} 代码已提取: ${files.length} 个文件 → ${baseDir}`);
    return { rawPath, tree, fileCount: allFiles.length };
  }

  /**
   * 获取文件树
   */
  async getFileTree(projectId: string, role: CodeGenRole): Promise<FileTreeNode | null> {
    const record = await this.prisma.codeGen.findFirst({
      where: { projectId, role, status: 'COMPLETED' },
      orderBy: { iteration: 'desc' },
    });
    if (!record?.tree) return null;
    return JSON.parse(record.tree);
  }

  /**
   * 读取单个文件内容。按该 role 最新 COMPLETED 记录的 iteration 定位目录。
   */
  async getFileContent(projectId: string, role: CodeGenRole, filePath: string): Promise<string | null> {
    const record = await this.prisma.codeGen.findFirst({
      where: { projectId, role, status: 'COMPLETED' },
      orderBy: { iteration: 'desc' },
    });
    if (!record) return null;

    const baseDir = this.fileService.getCodeDir(projectId, record.iteration, role);
    const resolved = this.fileService.resolveWithin(baseDir, filePath);

    if (!fs.existsSync(resolved)) return null;
    return fs.readFileSync(resolved, 'utf-8');
  }

  /**
   * 获取某个角色最新完成的代码生成记录
   */
  async getLatestCodeGen(projectId: string, role: CodeGenRole) {
    return this.prisma.codeGen.findFirst({
      where: { projectId, role, status: 'COMPLETED' },
      orderBy: { iteration: 'desc' },
    });
  }

  /**
   * 获取代码生成状态
   */
  async getCodeGenStatus(projectId: string) {
    return this.prisma.codeGen.findMany({
      where: { projectId },
      orderBy: [{ iteration: 'desc' }, { role: 'asc' }],
    });
  }

  async getCodePreview(projectId: string, role: CodeGenRole, iteration?: number) {
    const where: any = { projectId, role };
    if (iteration) where.iteration = iteration;

    const record = await this.prisma.codeGen.findFirst({
      where,
      orderBy: { iteration: 'desc' },
    });
    if (!record) throw new Error('代码生成记录不存在');

    let content = '';
    if (record.filePath) {
      content = this.fileService.readDocument(record.filePath);
    } else {
      content = record.codeContent || '';
    }

    return { ...record, content };
  }
}
