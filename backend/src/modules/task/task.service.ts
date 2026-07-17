import { Injectable, BadRequestException, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { OpencodeService } from '../opencode/opencode.service';
import { FileService } from '../../common/file.service';
import { WorkflowService } from '../../common/workflow.service';
import { StateSnapshotService } from '../../common/state-snapshot.service';
import { ProjectStatus, TaskStatus, DocType } from '../../common/constants';
import { CreateTaskDto } from './dto/create-task.dto';

@Injectable()
export class TaskService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskService.name);
  private watchdogTimer: NodeJS.Timeout | null = null;
  private static readonly STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 分钟

  constructor(
    private prisma: PrismaService,
    private opencode: OpencodeService,
    private fileService: FileService,
    private workflow: WorkflowService,
    private snapshot: StateSnapshotService,
  ) {}

  onModuleInit() {
    // 启动看门狗：每 60 秒检查一次卡住的项目
    this.watchdogTimer = setInterval(() => this.checkStuckProjects(), 60_000);
    this.logger.log('[Watchdog] 看门狗已启动，每 60 秒检查卡住的项目');
  }

  onModuleDestroy() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * 看门狗：检测并恢复卡在中间状态的项目
   *
   * 判定依据使用实体级 startTime（task.startTime / codeGen.startTime），
   * 而非 project.updatedAt —— 因为 LLM 调用期间 project 记录不会被更新，
   * updatedAt 不刷新会导致进行中的长任务被误杀。
   *
   * - GENERATING：最新 RUNNING task 的 startTime 超过阈值 → FAILED
   * - DEVELOPING：所有 RUNNING codeGen 的 startTime 超过阈值（或无 RUNNING 记录却停在 DEVELOPING）→ FAILED
   *
   * 标记失败时走 WorkflowService.onFailed（状态机校验 + 快照 + 事件），
   * 不再裸 prisma.project.update，避免绕过状态机导致后台任务完成后状态转换冲突。
   */
  private async checkStuckProjects() {
    try {
      const threshold = new Date(Date.now() - TaskService.STUCK_THRESHOLD_MS);

      // ── GENERATING：基于 task.startTime 判断 ──
      const generatingProjects = await this.prisma.project.findMany({
        where: { status: ProjectStatus.GENERATING },
        select: { id: true, name: true },
      });

      for (const project of generatingProjects) {
        const runningTask = await this.prisma.task.findFirst({
          where: { projectId: project.id, status: TaskStatus.RUNNING },
          orderBy: { startTime: 'desc' },
          select: { id: true, startTime: true },
        });

        // 没有 RUNNING task（状态脱节），或 task 已运行超阈值 → 判定卡住
        const stuck = !runningTask || (runningTask.startTime && runningTask.startTime < threshold);
        if (!stuck) continue;

        this.logger.warn(`[Watchdog] 项目 ${project.id} (${project.name}) 文档生成超时，标记为 FAILED`);

        if (runningTask) {
          await this.prisma.task.update({
            where: { id: runningTask.id },
            data: { status: TaskStatus.FAILED, endTime: new Date(), errorMsg: '看门狗检测：文档生成超时' },
          }).catch((e: any) => this.logger.error(`[Watchdog] 更新任务状态失败: ${e?.message}`));
        }

        await this.workflow.onFailed(project.id, '文档生成超时（看门狗检测）')
          .catch((e: any) => this.logger.error(`[Watchdog] 标记项目失败失败: ${e?.message}`));
      }

      // ── DEVELOPING：基于 codeGen.startTime 判断 ──
      const developingProjects = await this.prisma.project.findMany({
        where: { status: ProjectStatus.DEVELOPING },
        select: { id: true, name: true },
      });

      for (const project of developingProjects) {
        const runningCodeGens = await this.prisma.codeGen.findMany({
          where: { projectId: project.id, status: 'RUNNING' },
          select: { id: true, startTime: true },
        });

        // 没有 RUNNING codeGen 却停在 DEVELOPING，或所有 RUNNING codeGen 都超阈值 → 卡住
        const stuck = runningCodeGens.length === 0 ||
          runningCodeGens.every(c => c.startTime && c.startTime < threshold);
        if (!stuck) continue;

        this.logger.warn(`[Watchdog] 项目 ${project.id} (${project.name}) 代码生成超时，标记为 FAILED`);

        if (runningCodeGens.length > 0) {
          await this.prisma.codeGen.updateMany({
            where: { id: { in: runningCodeGens.map(c => c.id) } },
            data: { status: 'FAILED', endTime: new Date(), errorMsg: '看门狗检测：代码生成超时' },
          }).catch((e: any) => this.logger.error(`[Watchdog] 更新代码生成状态失败: ${e?.message}`));
        }

        // 标记 RUNNING validation 为 FAILED
        await this.prisma.validation.updateMany({
          where: { projectId: project.id, status: 'RUNNING' },
          data: { status: 'FAILED', comments: '看门狗检测：验证超时' },
        }).catch((e: any) => this.logger.error(`[Watchdog] 更新验证状态失败: ${e?.message}`));

        await this.workflow.onFailed(project.id, '代码生成超时（看门狗检测）')
          .catch((e: any) => this.logger.error(`[Watchdog] 标记项目失败失败: ${e?.message}`));
      }
    } catch (e: any) {
      this.logger.error(`[Watchdog] 看门狗执行失败: ${e?.message}`);
    }
  }

  /**
   * 创建文档生成任务
   * 状态流转: PENDING → GENERATING
   */
  async createTask(dto: CreateTaskDto, prdFilePath?: string) {
    // 1. 创建项目
    const project = await this.prisma.project.create({
      data: {
        name: dto.name || `项目_${Date.now()}`,
        status: ProjectStatus.GENERATING,
        basePath: this.fileService.getProjectDir(''),
      },
    });

    const projectBasePath = this.fileService.getProjectDir(project.id);
    await this.prisma.project.update({
      where: { id: project.id },
      data: { basePath: projectBasePath },
    });
    project.basePath = projectBasePath;

    // 2. 确保版本目录存在
    this.fileService.getVersionDir(project.id, project.version);

    // 3. 创建任务
    const task = await this.prisma.task.create({
      data: {
        projectId: project.id,
        status: TaskStatus.RUNNING,
        prdContent: dto.prdContent,
        prdFilePath: prdFilePath || null,
        startTime: new Date(),
      },
    });

    // 4. 异步生成文档（不阻塞响应）
    this.generateDocuments(project.id, task.id, dto.prdContent).catch((err) => {
      console.error(`[TaskService] 文档生成失败:`, err.message);
    });

    return { projectId: project.id, taskId: task.id, status: ProjectStatus.GENERATING };
  }

  /**
   * 驳回后重新生成文档（公开方法，供 ApprovalService 调用）
   */
  async regenerateDocuments(projectId: string) {
    const latestTask = await this.prisma.task.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    if (!latestTask?.prdContent) throw new Error('无法找到原始 PRD 内容');

    const task = await this.prisma.task.create({
      data: {
        projectId,
        status: TaskStatus.RUNNING,
        prdContent: latestTask.prdContent,
        startTime: new Date(),
      },
    });

    // 异步执行，不阻塞审批响应
    this.generateDocuments(projectId, task.id, latestTask.prdContent).catch((err) => {
      console.error(`[TaskService] 驳回重新生成失败:`, err.message);
    });

    return { taskId: task.id };
  }

  /**
   * 异步调用 LLM 生成四份文档
   */
  private async generateDocuments(projectId: string, taskId: string, prdContent: string) {
    try {
      const project = await this.prisma.project.findUnique({ where: { id: projectId } });
      if (!project) throw new Error('项目不存在');

      // 如果驳回要归档旧版本
      let rejectionComment: string | undefined;
      if (project.status === ProjectStatus.REJECTED) {
        const lastApproval = await this.prisma.approval.findFirst({
          where: { projectId, action: 'REJECTED' },
          orderBy: { createdAt: 'desc' },
        });
        rejectionComment = lastApproval?.comment || undefined;

        // 归档旧版本
        this.fileService.archiveVersion(projectId, project.version);

        // 版本号 +1
        await this.prisma.project.update({
          where: { id: projectId },
          data: { version: project.version + 1, status: ProjectStatus.GENERATING },
        });
      }

      const newVersion = project.status === ProjectStatus.REJECTED
        ? project.version + 1
        : project.version;

      // 确保版本目录
      this.fileService.getVersionDir(projectId, newVersion);

      // 调用 LLM（返回 { projectName, results }），并收集流式思考步骤 + 实时推送
      const { projectName: extractedName, results } = await this.opencode.generateDocuments({
        prdContent,
        rejectionComment,
        onProgress: async (step) => {
          await this.appendThinking(taskId, step);
          // 心跳：刷新 project.updatedAt，让看门狗感知到文档生成仍在进行
          // （LLM 调用期间 project 不会被其他逻辑更新，updatedAt 不刷新会触发误杀）
          await this.prisma.project.update({
            where: { id: projectId },
            data: { updatedAt: new Date() },
          }).catch(() => {});
          await this.workflow.onThinkingStep(projectId, step).catch(() => {});
        },
      });

      // 如果 LLM 提取到了项目名称，更新项目
      if (extractedName && extractedName !== project.name) {
        await this.prisma.project.update({
          where: { id: projectId },
          data: { name: extractedName },
        });
        console.log(`[TaskService] 项目名称更新: "${project.name}" → "${extractedName}"`);
      }

      // 保存文档到文件系统 + 数据库元数据
      // 写盘前检查磁盘空间，不足则明确报错
      const disk = this.fileService.checkDiskSpace(20 * 1024 * 1024); // 20MB 富余
      if (!disk.ok) {
        const availMB = Math.round(disk.available / 1024 / 1024);
        throw new Error(`磁盘空间不足（可用 ${availMB}MB），无法保存文档`);
      }

      const savePromises = results.map(async (result) => {
        const { fileName, filePath, fileSize } = this.fileService.saveDocument(
          projectId,
          newVersion,
          result.docType,
          result.content,
        );

        return this.prisma.document.create({
          data: {
            taskId,
            projectId,
            docType: result.docType,
            fileName,
            filePath,
            version: newVersion,
            fileSize,
          },
        });
      });

      await Promise.all(savePromises);

      // 更新任务状态
      await this.prisma.task.update({
        where: { id: taskId },
        data: { status: TaskStatus.COMPLETED, endTime: new Date() },
      });

      // 状态转换前创建快照
      await this.snapshot.createSnapshot(projectId);

      // 更新项目状态 → PENDING_REVIEW
      await this.prisma.project.update({
        where: { id: projectId },
        data: { status: ProjectStatus.PENDING_REVIEW },
      });

      console.log(`[TaskService] 项目 ${projectId} 文档生成完成`);
    } catch (error: any) {
      console.error(`[TaskService] 文档生成失败:`, error.message);

      // 加固 catch 块：每个 DB 更新独立 try/catch，防止某个失败导致项目永久卡住
      try {
        await this.prisma.task.update({
          where: { id: taskId },
          data: {
            status: TaskStatus.FAILED,
            endTime: new Date(),
            errorMsg: error.message,
          },
        });
      } catch (e: any) {
        this.logger.error(`[TaskService] 更新 task 状态失败: ${e?.message}`);
      }

      try {
        await this.prisma.project.update({
          where: { id: projectId },
          data: { status: ProjectStatus.FAILED },
        });
      } catch (e: any) {
        this.logger.error(`[TaskService] 更新 project 状态失败: ${e?.message}`);
      }

      try {
        await this.workflow.onError(projectId, error.message);
      } catch (e: any) {
        this.logger.error(`[TaskService] 发送错误通知失败: ${e?.message}`);
      }
    }
  }

  /**
   * 将 LLM 思考步骤追加到任务记录（JSON 数组）
   */
  private async appendThinking(taskId: string, step: any) {
    try {
      const task = await this.prisma.task.findUnique({ where: { id: taskId } });
      if (!task) return;

      const existing: any[] = task.thinking ? JSON.parse(task.thinking) : [];
      const idx = existing.findIndex((s) => s.step === step.step);
      if (idx >= 0) {
        existing[idx] = step;
      } else {
        existing.push(step);
      }
      existing.sort((a, b) => a.step - b.step);

      await this.prisma.task.update({
        where: { id: taskId },
        data: { thinking: JSON.stringify(existing) },
      });
    } catch (e: any) {
      console.error('[TaskService] 保存 thinking 失败:', e?.message || e);
    }
  }

  /**
   * 获取所有项目列表
   */
  async getAllProjects() {
    return this.prisma.project.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        status: true,
        version: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * 查询任务状态
   */
  async getTaskStatus(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        tasks: { orderBy: { createdAt: 'desc' }, take: 5 },
        documents: { orderBy: { createdAt: 'desc' } },
        approvals: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!project) throw new BadRequestException('项目不存在');

    return project;
  }

  /**
   * 获取完整项目状态（含代码生成、验证、返修记录）
   */
  async getFullStatus(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        tasks: { orderBy: { createdAt: 'desc' }, take: 5 },
        documents: { orderBy: { createdAt: 'desc' } },
        approvals: { orderBy: { createdAt: 'desc' }, take: 10 },
        codeGens: { orderBy: [{ iteration: 'desc' }, { role: 'asc' }] },
        validations: { orderBy: [{ iteration: 'desc' }, { role: 'asc' }] },
        reworkRecords: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
    });

    if (!project) throw new BadRequestException('项目不存在');
    return project;
  }

  /**
   * 获取文档内容（预览用）
   */
  async getDocument(taskId: string, docType: DocType) {
    const doc = await this.prisma.document.findFirst({
      where: { taskId, docType },
    });

    if (!doc) throw new BadRequestException('文档不存在');

    const content = this.fileService.readDocument(doc.filePath);
    return {
      ...doc,
      content,
      downloadUrl: `/files${this.fileService.getRelativePath(doc.filePath)}`,
    };
  }
}
