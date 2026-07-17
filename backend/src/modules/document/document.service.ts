import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { FileService } from '../../common/file.service';
import { DocType } from '../../common/constants';

@Injectable()
export class DocumentService {
  constructor(
    private prisma: PrismaService,
    private fileService: FileService,
  ) {}

  /**
   * 获取项目最新版本文档列表
   */
  async getDocumentsByProject(projectId: string) {
    // 仅取 version 字段（轻量）。旧实现 include documents 会拉取所有版本文档到内存，
    // 且注释承诺的"查询后过滤"从未执行，纯粹是浪费的查询。
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, version: true },
    });

    if (!project) throw new NotFoundException('项目不存在');

    const latestDocs = await this.prisma.document.findMany({
      where: { projectId, version: project.version },
      orderBy: { docType: 'asc' },
    });

    return latestDocs.map((doc) => ({
      ...doc,
      downloadUrl: `/files${this.fileService.getRelativePath(doc.filePath)}`,
    }));
  }

  /**
   * 获取单份文档预览内容
   */
  async getDocumentPreview(projectId: string, taskId: string, docType: DocType) {
    const doc = await this.prisma.document.findFirst({
      where: { taskId, docType, projectId },
    });

    if (!doc) throw new NotFoundException(`文档不存在: ${docType}`);

    const content = this.fileService.readDocument(doc.filePath);
    return {
      ...doc,
      content,
      downloadUrl: `/files${this.fileService.getRelativePath(doc.filePath)}`,
    };
  }
}
