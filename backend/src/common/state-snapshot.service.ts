import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * 状态快照服务 — 在每次状态转换前持久化完整项目状态
 *
 * 快照内容包含：项目状态、版本号、迭代次数、文档元数据、
 * 代码生成记录、验证结果、返修记录、审批记录。
 * 支持崩溃恢复和历史追溯。
 */
@Injectable()
export class StateSnapshotService {
  private readonly logger = new Logger(StateSnapshotService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * 为项目创建状态快照（在状态转换前调用）
   */
  async createSnapshot(projectId: string): Promise<void> {
    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        include: {
          documents: { orderBy: { createdAt: 'desc' } },
          approvals: { orderBy: { createdAt: 'desc' }, take: 10 },
          codeGens: { orderBy: [{ iteration: 'desc' }, { role: 'asc' }] },
          validations: { orderBy: [{ iteration: 'desc' }, { role: 'asc' }] },
          reworkRecords: { orderBy: { createdAt: 'desc' }, take: 10 },
        },
      });

      if (!project) {
        this.logger.warn(`[Snapshot] 项目 ${projectId} 不存在，跳过快照`);
        return;
      }

      const snapshot = {
        status: project.status,
        version: project.version,
        iterationCount: project.iterationCount,
        documents: project.documents.map(d => ({
          docType: d.docType,
          fileName: d.fileName,
          filePath: d.filePath,
          version: d.version,
          fileSize: d.fileSize,
        })),
        codeGens: project.codeGens.map(c => ({
          role: c.role,
          status: c.status,
          filePath: c.filePath,
          iteration: c.iteration,
          errorMsg: c.errorMsg,
        })),
        validations: project.validations.map(v => ({
          role: v.role,
          status: v.status,
          score: v.score,
          comments: v.comments,
          iteration: v.iteration,
        })),
        reworkRecords: project.reworkRecords.map(r => ({
          iteration: r.iteration,
          trigger: r.trigger,
          feedback: r.feedback.slice(0, 2000), // 限制反馈长度避免快照过大
          source: r.source,
        })),
        approvals: project.approvals.map(a => ({
          action: a.action,
          comment: a.comment,
          reviewer: a.reviewer,
        })),
        timestamp: new Date().toISOString(),
      };

      await this.prisma.stateSnapshot.create({
        data: {
          projectId,
          version: project.version,
          iteration: project.iterationCount,
          status: project.status,
          snapshot: JSON.stringify(snapshot),
        },
      });

      this.logger.log(`[Snapshot] 项目 ${projectId} 快照已创建 (status=${project.status}, v${project.version}, iter=${project.iterationCount})`);
    } catch (e: any) {
      // 快照失败不应阻断主流程
      this.logger.error(`[Snapshot] 创建快照失败: ${e?.message}`);
    }
  }

  /**
   * 获取项目的所有快照
   */
  async getSnapshots(projectId: string) {
    return this.prisma.stateSnapshot.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 获取最新快照
   */
  async getLatestSnapshot(projectId: string) {
    return this.prisma.stateSnapshot.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
