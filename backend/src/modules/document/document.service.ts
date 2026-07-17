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
   * 获取项目最新文档列表
   */
  async getDocumentsByProject(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        documents: {
          where: { version: { equals: undefined } }, // 将在查询后过滤
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!project) throw new NotFoundException('项目不存在');

    // 获取最新版本的文档
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
  async getDocumentPreview(taskId: string, docType: DocType) {
    const doc = await this.prisma.document.findFirst({
      where: { taskId, docType },
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
