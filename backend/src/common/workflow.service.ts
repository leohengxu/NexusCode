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
   * 校验状态转换是否合法，返回转换前的状态供 CAS 更新使用。
   */
  private async validateAndTransition(projectId: string, toStatus: ProjectStatus): Promise<string> {
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
    return fromStatus;
  }

  /**
   * CAS（Compare-And-Swap）状态更新：仅当项目状态仍为 expectedStatus 时才更新。
   * 防止两个并发请求基于同一旧状态各自通过校验后产生重复审批/重复迭代/状态覆盖。
   */
  private async casUpdate(projectId: string, expectedStatus: string, data: Record<string, any>): Promise<void> {
    const result = await this.prisma.project.updateMany({
      where: { id: projectId, status: expectedStatus },
      data,
    });
    if (result.count === 0) {
      throw new BadRequestException(
        `状态已被并发修改：期望 ${expectedStatus}，请刷新后重试`,
      );
    }
  }

  async onCodeGenCompleted(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new BadRequestException('项目不存在');

    // 容错：若项目已被看门狗误判为 FAILED，但代码实际已生成成功，
    // 允许从 FAILED 恢复到 PREVIEW，避免成功成果因竞态被丢弃。
    if (project.status === ProjectStatus.FAILED) {
      this.logger.warn(
        `[Workflow] 项目 ${projectId} 当前为 FAILED（可能被看门狗误杀），代码生成已完成，恢复到 PREVIEW`,
      );
      await this.snapshot.createSnapshot(projectId);
      await this.casUpdate(projectId, ProjectStatus.FAILED, { status: ProjectStatus.PREVIEW });
      this.events.emitStatusChange(projectId, ProjectStatus.PREVIEW);
      return;
    }

    const fromStatus = await this.validateAndTransition(projectId, ProjectStatus.PREVIEW);
    await this.snapshot.createSnapshot(projectId);
    await this.casUpdate(projectId, fromStatus, { status: ProjectStatus.PREVIEW });
    this.events.emitStatusChange(projectId, ProjectStatus.PREVIEW);
    this.logger.log(`[Workflow] 项目 ${projectId} 代码生成完成，进入预览测试阶段`);
  }

  async onValidationFailed(projectId: string, iteration: number, failedResults: any[]): Promise<boolean> {
    const fromStatus = await this.validateAndTransition(projectId, ProjectStatus.REWORKING);
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
    await this.casUpdate(projectId, fromStatus, { status: ProjectStatus.REWORKING, iterationCount: iteration });
    this.events.emitStatusChange(projectId, ProjectStatus.REWORKING, { iteration, feedback });

    this.logger.log(`[Workflow] 项目 ${projectId} 验证未通过，进入返修 (迭代 ${iteration})`);
    return true;
  }

  async onValidationPassed(projectId: string) {
    const fromStatus = await this.validateAndTransition(projectId, ProjectStatus.HUMAN_REVIEW);
    await this.snapshot.createSnapshot(projectId);
    await this.casUpdate(projectId, fromStatus, { status: ProjectStatus.HUMAN_REVIEW });
    this.events.emitStatusChange(projectId, ProjectStatus.HUMAN_REVIEW, { reason: 'all_passed' });
    this.logger.log(`[Workflow] 项目 ${projectId} 验证全部通过，进入人工最终审核`);
  }

  async onPreviewApproved(projectId: string) {
    const fromStatus = await this.validateAndTransition(projectId, ProjectStatus.HUMAN_REVIEW);
    await this.snapshot.createSnapshot(projectId);
    await this.casUpdate(projectId, fromStatus, { status: ProjectStatus.HUMAN_REVIEW });
    this.events.emitStatusChange(projectId, ProjectStatus.HUMAN_REVIEW, { reason: 'preview_approved' });
  }

  async onFinalApproved(projectId: string) {
    const fromStatus = await this.validateAndTransition(projectId, ProjectStatus.APPROVED);
    await this.snapshot.createSnapshot(projectId);
    await this.casUpdate(projectId, fromStatus, { status: ProjectStatus.APPROVED });
    this.events.emitStatusChange(projectId, ProjectStatus.APPROVED);
  }

  async onHumanReviewRejected(projectId: string, comment: string, currentIteration: number): Promise<boolean> {
    const fromStatus = await this.validateAndTransition(projectId, ProjectStatus.REWORKING);
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

    await this.casUpdate(projectId, fromStatus, { status: ProjectStatus.REWORKING, iterationCount: currentIteration });
    this.events.emitStatusChange(projectId, ProjectStatus.REWORKING, { iteration: currentIteration, feedback: comment });

    this.logger.log(`[Workflow] 项目 ${projectId} 人工审核驳回，进入返修 (迭代 ${currentIteration})`);
    return true;
  }

  /**
   * 预览测试驳回 → REWORKING → DEVELOPING（返修闭环）。
   * 与 onHumanReviewRejected 不同：此方法用于代码预览阶段的人工反馈返修。
   */
  async onPreviewRejected(projectId: string, comment: string, currentIteration: number): Promise<boolean> {
    const fromStatus = await this.validateAndTransition(projectId, ProjectStatus.REWORKING);
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

    await this.casUpdate(projectId, fromStatus, { status: ProjectStatus.REWORKING, iterationCount: currentIteration });
    this.events.emitStatusChange(projectId, ProjectStatus.REWORKING, { iteration: currentIteration, feedback: comment });

    this.logger.log(`[Workflow] 项目 ${projectId} 预览测试驳回，进入返修 (迭代 ${currentIteration})`);
    return true;
  }

  /**
   * 审批通过后进入开发阶段：PENDING_REVIEW → DEVELOPING（走状态机校验）。
   * 替代原先 codegen.service 里绕过状态机的裸写 status。
   */
  async startDevelopment(projectId: string) {
    const fromStatus = await this.validateAndTransition(projectId, ProjectStatus.DEVELOPING);
    await this.snapshot.createSnapshot(projectId);
    await this.casUpdate(projectId, fromStatus, { status: ProjectStatus.DEVELOPING });
    this.events.emitStatusChange(projectId, ProjectStatus.DEVELOPING, { rework: false });
  }

  async startRework(projectId: string) {
    const fromStatus = await this.validateAndTransition(projectId, ProjectStatus.DEVELOPING);
    await this.snapshot.createSnapshot(projectId);
    await this.casUpdate(projectId, fromStatus, { status: ProjectStatus.DEVELOPING });
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

    const fromStatus = await this.validateAndTransition(projectId, ProjectStatus.REWORKING);
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

    await this.casUpdate(projectId, fromStatus, { status: ProjectStatus.REWORKING, iterationCount: iteration });
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

  /**
   * 标记项目失败（走状态机校验 + 快照 + 事件）。
   * 供看门狗等异常恢复路径使用，替代裸 prisma.project.update，
   * 保证状态转换可追溯，且不绕过状态机。
   */
  async onFailed(projectId: string, reason: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return;
    // 已是终态则不再转换
    if (project.status === ProjectStatus.FAILED || project.status === ProjectStatus.APPROVED) return;
    let fromStatus: string;
    try {
      fromStatus = await this.validateAndTransition(projectId, ProjectStatus.FAILED);
    } catch (e: any) {
      // 某些状态下 FAILED 可能不在合法转换中，记录后放弃，避免抛错中断看门狗
      this.logger.warn(`[Workflow] 项目 ${projectId} 无法从 ${project.status} 转为 FAILED: ${e?.message}`);
      return;
    }
    await this.snapshot.createSnapshot(projectId);
    await this.casUpdate(projectId, fromStatus, { status: ProjectStatus.FAILED });
    this.events.emitStatusChange(projectId, ProjectStatus.FAILED, { reason });
    this.logger.warn(`[Workflow] 项目 ${projectId} 标记为 FAILED: ${reason}`);
  }

  async onError(projectId: string, message: string) {
    this.events.emitError(projectId, message);
  }

  async onThinkingStep(projectId: string, step: any) {
    this.events.emitThinkingStep(projectId, step);
  }
}
