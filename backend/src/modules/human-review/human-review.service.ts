import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { WorkflowService } from '../../common/workflow.service';
import { CodegenService } from '../codegen/codegen.service';
import { ProjectStatus } from '../../common/constants';

@Injectable()
export class HumanReviewService {
  private readonly logger = new Logger(HumanReviewService.name);

  constructor(
    private prisma: PrismaService,
    private workflow: WorkflowService,
    private codegenService: CodegenService,
  ) {}

  async getReviewStatus(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        codeGens: { orderBy: [{ iteration: 'desc' }, { role: 'asc' }] },
        validations: { orderBy: [{ iteration: 'desc' }, { role: 'asc' }] },
        reworkRecords: { orderBy: { iteration: 'desc' } },
        approvals: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!project) throw new BadRequestException('项目不存在');
    return project;
  }

  async finalApprove(projectId: string, comment?: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new BadRequestException('项目不存在');
    if (project.status !== ProjectStatus.HUMAN_REVIEW) {
      throw new BadRequestException(`当前状态 ${project.status} 不允许最终审批`);
    }

    await this.prisma.approval.create({
      data: {
        projectId,
        reviewer: '最终审核',
        action: 'APPROVED',
        comment: comment || '最终审核通过，基线已发布',
      },
    });

    await this.workflow.onFinalApproved(projectId);

    this.logger.log(`[HumanReview] 项目 ${projectId} 最终审核通过，基线已发布`);
    return { message: '最终审核通过，基线已发布', newStatus: ProjectStatus.APPROVED };
  }

  async finalReject(projectId: string, comment: string) {
    if (!comment || !comment.trim()) {
      throw new BadRequestException('驳回时必须填写意见');
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new BadRequestException('项目不存在');
    if (project.status !== ProjectStatus.HUMAN_REVIEW) {
      throw new BadRequestException(`当前状态 ${project.status} 不允许驳回操作`);
    }

    await this.prisma.approval.create({
      data: {
        projectId,
        reviewer: '最终审核',
        action: 'REJECTED',
        comment,
      },
    });

    const currentIteration = project.iterationCount + 1;

    await this.workflow.onHumanReviewRejected(projectId, comment, currentIteration);
    await this.codegenService.triggerRework(projectId, comment);
    return { message: '已驳回，将进入返修流程', newStatus: ProjectStatus.REWORKING };
  }
}
