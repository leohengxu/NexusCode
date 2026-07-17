import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { TaskService } from '../task/task.service';
import { CodegenService } from '../codegen/codegen.service';
import { StateSnapshotService } from '../../common/state-snapshot.service';
import { ProjectStatus, ApprovalAction } from '../../common/constants';
import { ApproveDto, RejectDto } from './dto/approval.dto';

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private prisma: PrismaService,
    private taskService: TaskService,
    private codegenService: CodegenService,
    private snapshot: StateSnapshotService,
  ) {}

  /**
   * 审批通过 → 自动触发 Worker Agents 并行开发
   * 状态流转: PENDING_REVIEW → APPROVED → DEVELOPING
   */
  async approve(projectId: string, dto: ApproveDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new BadRequestException('项目不存在');

    if (project.status !== ProjectStatus.PENDING_REVIEW) {
      throw new BadRequestException(`当前状态 ${project.status} 不允许审批操作`);
    }

    // 先确认开发任务已成对创建并完成状态切换，再落审批记录。
    await this.codegenService.startCodeGeneration(projectId);

    const approval = await this.prisma.approval.create({
      data: {
        projectId,
        reviewer: dto.reviewer || '架构师',
        action: ApprovalAction.APPROVED,
        comment: dto.comment || '审批通过',
      },
    });

    return {
      message: '审批通过，技术栈基线已发布，并行代码生成已启动',
      approval,
      newStatus: ProjectStatus.DEVELOPING,
    };
  }

  /**
   * 审批驳回 → 自动触发全量重新生成
   * 状态流转: PENDING_REVIEW → REJECTED → GENERATING → PENDING_REVIEW
   */
  async reject(projectId: string, dto: RejectDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new BadRequestException('项目不存在');

    if (project.status !== ProjectStatus.PENDING_REVIEW) {
      throw new BadRequestException(`当前状态 ${project.status} 不允许审批操作`);
    }

    if (!dto.comment || dto.comment.trim().length === 0) {
      throw new BadRequestException('驳回时必须填写审批意见');
    }

    // 1. 创建驳回记录
    const approval = await this.prisma.approval.create({
      data: {
        projectId,
        reviewer: dto.reviewer || '架构师',
        action: ApprovalAction.REJECTED,
        comment: dto.comment,
      },
    });

    // 2. 状态转换前创建快照
    await this.snapshot.createSnapshot(projectId);

    // 3. 更新项目状态为 REJECTED
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.REJECTED },
    });

    // 4. 异步触发重新生成（不阻塞响应）
    this.taskService.regenerateDocuments(projectId).catch((err) => {
      console.error(`[ApprovalService] 重新生成触发失败:`, err.message);
    });

    return {
      message: '已驳回，系统将根据审批意见全量重新生成文档',
      approval,
      newStatus: ProjectStatus.REJECTED,
    };
  }

  /**
   * 获取审批历史
   */
  async getApprovalHistory(projectId: string) {
    return this.prisma.approval.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
