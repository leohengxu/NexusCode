import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { EventsGateway } from './events.gateway';
import { StateSnapshotService } from './state-snapshot.service';
import { ProjectStatus, ValidatorRole, CodeGenRole, ReworkTrigger } from './constants';
import { isValidTransition, getNextStates } from './workflow.graph';

@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);

  constructor(
    private prisma: PrismaService,
    private events: EventsGateway,
    private snapshot: StateSnapshotService,
  ) {}

  /**
   * 使用 LangGraph 状态机校验状态转换是否合法
   */
  private async validateAndTransition(projectId: string, toStatus: ProjectStatus, extraData?: Record<string, any>) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new BadRequestException('项目不存在');

    const fromStatus = project.status;
    if (!isValidTransition(fromStatus, toStatus)) {
      const allowed = getNextStates(fromStatus);
      throw new BadRequestException(
        `非法状态转换: ${fromStatus} → ${toStatus}（允许的目标: ${allowed.join(', ') || '无'}）`,
      );
    }

    this.logger.log(`[Workflow] LangGraph 状态转换校验通过: ${fromStatus} → ${toStatus}`);
  }

  async onCodeGenCompleted(projectId: string) {
    await this.validateAndTransition(projectId, ProjectStatus.PREVIEW);
    await this.snapshot.createSnapshot(projectId);
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.PREVIEW },
    });
    this.events.emitStatusChange(projectId, ProjectStatus.PREVIEW);
    this.logger.log(`[Workflow] 项目 ${projectId} 代码生成完成，进入预览测试阶段`);
  }

  async onValidationFailed(projectId: string, iteration: number, failedResults: any[]): Promise<boolean> {
    await this.validateAndTransition(projectId, ProjectStatus.REWORKING);
    const feedback = failedResults.map(r => `[${r.role}] ${r.summary}`).join('\n\n');

    await this.snapshot.createSnapshot(projectId);

    await this.prisma.reworkRecord.create({
      data: {
        projectId,
        iteration,
        trigger: ReworkTrigger.VALIDATOR,
        feedback,
        source: failedResults.map(r => r.role).join(','),
      },
    });

    // iterationCount 权威递增点（唯一）：进入 REWORKING 时设为本轮迭代号。
    // triggerRework 不再自增，避免双写导致计数翻倍。
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.REWORKING, iterationCount: iteration },
    });
    this.events.emitStatusChange(projectId, ProjectStatus.REWORKING, { iteration, feedback });

    this.logger.log(`[Workflow] 项目 ${projectId} 验证未通过，进入返修 (迭代 ${iteration})`);
    return true;
  }

  async onValidationPassed(projectId: string) {
    await this.validateAndTransition(projectId, ProjectStatus.HUMAN_REVIEW);
    await this.snapshot.createSnapshot(projectId);
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.HUMAN_REVIEW },
    });
    this.events.emitStatusChange(projectId, ProjectStatus.HUMAN_REVIEW, { reason: 'all_passed' });
    this.logger.log(`[Workflow] 项目 ${projectId} 验证全部通过，进入人工最终审核`);
  }

  async onPreviewApproved(projectId: string) {
    await this.validateAndTransition(projectId, ProjectStatus.HUMAN_REVIEW);
    await this.snapshot.createSnapshot(projectId);
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.HUMAN_REVIEW },
    });
    this.events.emitStatusChange(projectId, ProjectStatus.HUMAN_REVIEW, { reason: 'preview_approved' });
  }

  async onFinalApproved(projectId: string) {
    await this.validateAndTransition(projectId, ProjectStatus.APPROVED);
    await this.snapshot.createSnapshot(projectId);
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.APPROVED },
    });
    this.events.emitStatusChange(projectId, ProjectStatus.APPROVED);
  }

  async onHumanReviewRejected(projectId: string, comment: string, currentIteration: number): Promise<boolean> {
    await this.validateAndTransition(projectId, ProjectStatus.REWORKING);
    await this.snapshot.createSnapshot(projectId);

    await this.prisma.reworkRecord.create({
      data: {
        projectId,
        iteration: currentIteration,
        trigger: ReworkTrigger.HUMAN_REVIEW,
        feedback: comment,
        source: 'HUMAN',
      },
    });

    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.REWORKING, iterationCount: currentIteration },
    });
    this.events.emitStatusChange(projectId, ProjectStatus.REWORKING, { iteration: currentIteration, feedback: comment });

    this.logger.log(`[Workflow] 项目 ${projectId} 人工审核驳回，进入返修 (迭代 ${currentIteration})`);
    return true;
  }

  /**
   * 预览测试驳回 → REWORKING → DEVELOPING（返修闭环）。
   * 与 onHumanReviewRejected 不同：此方法用于代码预览阶段的人工反馈返修。
   */
  async onPreviewRejected(projectId: string, comment: string, currentIteration: number): Promise<boolean> {
    await this.validateAndTransition(projectId, ProjectStatus.REWORKING);
    await this.snapshot.createSnapshot(projectId);

    await this.prisma.reworkRecord.create({
      data: {
        projectId,
        iteration: currentIteration,
        trigger: ReworkTrigger.PREVIEW,
        feedback: comment,
        source: 'HUMAN',
      },
    });

    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.REWORKING, iterationCount: currentIteration },
    });
    this.events.emitStatusChange(projectId, ProjectStatus.REWORKING, { iteration: currentIteration, feedback: comment });

    this.logger.log(`[Workflow] 项目 ${projectId} 预览测试驳回，进入返修 (迭代 ${currentIteration})`);
    return true;
  }

  /**
   * 审批通过后进入开发阶段：PENDING_REVIEW → DEVELOPING（走状态机校验）。
   * 替代原先 codegen.service 里绕过状态机的裸写 status。
   */
  async startDevelopment(projectId: string) {
    await this.validateAndTransition(projectId, ProjectStatus.DEVELOPING);
    await this.snapshot.createSnapshot(projectId);
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.DEVELOPING },
    });
    this.events.emitStatusChange(projectId, ProjectStatus.DEVELOPING, { rework: false });
  }

  async startRework(projectId: string) {
    await this.validateAndTransition(projectId, ProjectStatus.DEVELOPING);
    await this.snapshot.createSnapshot(projectId);
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.DEVELOPING },
    });
    this.events.emitStatusChange(projectId, ProjectStatus.DEVELOPING, { rework: true });
  }

  /**
   * 手动返修入口（供 task.controller 的 /rework 端点使用）。
   * 与验证失败/人工驳回不同，手动返修时项目可能停在任意可返修状态，
   * 需要先合法进入 REWORKING（并递增迭代计数），再由调用方转入 DEVELOPING。
   * iterationCount 的递增在此处一次完成，triggerRework 不再自增。
   */
  async enterManualRework(projectId: string, feedback: string): Promise<number> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new BadRequestException('项目不存在');

    await this.validateAndTransition(projectId, ProjectStatus.REWORKING);
    await this.snapshot.createSnapshot(projectId);

    const iteration = project.iterationCount + 1;

    await this.prisma.reworkRecord.create({
      data: {
        projectId,
        iteration,
        trigger: ReworkTrigger.HUMAN_REVIEW,
        feedback,
        source: 'HUMAN',
      },
    });

    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.REWORKING, iterationCount: iteration },
    });
    this.events.emitStatusChange(projectId, ProjectStatus.REWORKING, { iteration, feedback });

    this.logger.log(`[Workflow] 项目 ${projectId} 手动触发返修 (迭代 ${iteration})`);
    return iteration;
  }

  async onCodeGenProgress(projectId: string, role: string, status: string) {
    this.events.emitCodeGenProgress(projectId, role, status);
  }

  async onValidationProgress(projectId: string, role: string, status: string, result?: any) {
    this.events.emitValidationResult(projectId, role, status, result);
  }

  async onError(projectId: string, message: string) {
    this.events.emitError(projectId, message);
  }

  async onThinkingStep(projectId: string, step: any) {
    this.events.emitThinkingStep(projectId, step);
  }
}
