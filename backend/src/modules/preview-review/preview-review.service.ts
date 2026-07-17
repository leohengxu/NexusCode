import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { WorkflowService } from '../../common/workflow.service';
import { CodegenService } from '../codegen/codegen.service';
import { CodeGenRole, ProjectStatus, ReworkTrigger } from '../../common/constants';

@Injectable()
export class PreviewReviewService {
  private readonly logger = new Logger(PreviewReviewService.name);

  constructor(
    private prisma: PrismaService,
    private workflow: WorkflowService,
    private codegenService: CodegenService,
  ) {}

  /**
   * 预览通过 → 进入最终审核（PREVIEW → HUMAN_REVIEW）
   */
  async approve(projectId: string, comment?: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new BadRequestException('项目不存在');
    if (project.status !== ProjectStatus.PREVIEW) {
      throw new BadRequestException(`当前状态 ${project.status} 不允许代码预览审批`);
    }

    // 记录审批
    await this.prisma.approval.create({
      data: {
        projectId,
        reviewer: '代码预览',
        action: 'APPROVED',
        comment: comment || '代码预览通过，进入最终审核',
      },
    });

    // PREVIEW → HUMAN_REVIEW，统一走状态机、快照和实时事件。
    await this.workflow.onPreviewApproved(projectId);

    this.logger.log(`[PreviewReview] 项目 ${projectId} 代码预览通过，进入最终审核`);
    return { message: '代码预览通过，进入最终审核', newStatus: ProjectStatus.HUMAN_REVIEW };
  }

  /**
   * 预览驳回 → 返修（PREVIEW → REWORKING → 触发代码重新生成）
   */
  async reject(projectId: string, feedback: string) {
    if (!feedback || !feedback.trim()) {
      throw new BadRequestException('驳回时必须填写修改意见');
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new BadRequestException('项目不存在');
    const recoveringFromFailedPreview = project.status === ProjectStatus.FAILED;
    if (project.status !== ProjectStatus.PREVIEW && !recoveringFromFailedPreview) {
      throw new BadRequestException(`当前状态 ${project.status} 不允许代码预览驳回`);
    }

    if (recoveringFromFailedPreview) {
      const completedCodeGens = await this.prisma.codeGen.findMany({
        where: { projectId, status: 'COMPLETED' },
        select: { role: true, iteration: true },
      });
      const latestIteration = completedCodeGens.reduce(
        (max, codeGen) => Math.max(max, codeGen.iteration),
        0,
      );
      const latestRoles = new Set(
        completedCodeGens
          .filter(codeGen => codeGen.iteration === latestIteration)
          .map(codeGen => codeGen.role),
      );
      if (!latestRoles.has(CodeGenRole.FRONTEND) || !latestRoles.has(CodeGenRole.BACKEND)) {
        throw new BadRequestException('该失败项目没有完整的前后端代码产物，无法从预览反馈恢复');
      }
    }

    // 记录驳回审批
    await this.prisma.approval.create({
      data: {
        projectId,
        reviewer: '代码预览',
        action: 'REJECTED',
        comment: feedback,
      },
    });

    // PREVIEW/历史 FAILED → REWORKING。FAILED 仅在上方确认有完整代码时允许恢复。
    const iteration = project.iterationCount + 1;
    await this.workflow.onPreviewRejected(projectId, feedback, iteration);

    // 触发代码返修（带反馈）
    await this.codegenService.triggerRework(projectId, feedback);

    return {
      message: recoveringFromFailedPreview
        ? '已从历史超时失败状态恢复，将根据反馈重新生成代码'
        : '已驳回，将根据反馈重新生成代码',
      newStatus: ProjectStatus.REWORKING,
    };
  }
}
