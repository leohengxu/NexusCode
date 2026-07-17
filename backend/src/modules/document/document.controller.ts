import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { DocumentService } from './document.service';
import { DocType } from '../../common/constants';

@ApiTags('文档管理')
@Controller('api/documents')
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  /**
   * GET /api/documents/:projectId - 获取项目下的所有文档
   */
  @Get(':projectId')
  @ApiOperation({ summary: '获取项目文档列表' })
  async getDocuments(@Param('projectId') projectId: string) {
    return this.documentService.getDocumentsByProject(projectId);
  }

  /**
   * GET /api/documents/:projectId/preview?taskId=xxx&docType=TECH_STACK
   */
  @Get(':projectId/preview')
  @ApiOperation({ summary: '获取文档预览内容' })
  @ApiQuery({ name: 'taskId', required: true })
  @ApiQuery({ name: 'docType', required: true, enum: DocType })
  async preview(
    @Param('projectId') projectId: string,
    @Query('taskId') taskId: string,
    @Query('docType') docType: DocType,
  ) {
    return this.documentService.getDocumentPreview(projectId, taskId, docType);
  }
}
