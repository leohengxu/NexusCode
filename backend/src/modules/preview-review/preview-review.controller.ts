import {
  Controller, Post, Get, Param, Body, HttpException, InternalServerErrorException,
} from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PreviewReviewService } from './preview-review.service';
import { LocalPreviewService } from './local-preview.service';

class PreviewApproveDto {
  @IsOptional()
  @IsString()
  comment?: string;
}

class PreviewRejectDto {
  @IsNotEmpty()
  @IsString()
  comment: string;
}

@ApiTags('代码预览测试')
@Controller('api/preview-review')
export class PreviewReviewController {
  constructor(
    private readonly previewReviewService: PreviewReviewService,
    private readonly localPreviewService: LocalPreviewService,
  ) {}

  @Post(':projectId/approve')
  @ApiOperation({ summary: '代码预览通过，进入最终审核' })
  async approve(@Param('projectId') projectId: string, @Body() dto: PreviewApproveDto) {
    return this.previewReviewService.approve(projectId, dto.comment);
  }

  @Post(':projectId/reject')
  @ApiOperation({ summary: '代码预览驳回，根据反馈重新生成代码' })
  async reject(@Param('projectId') projectId: string, @Body() dto: PreviewRejectDto) {
    return this.previewReviewService.reject(projectId, dto.comment);
  }

  @Get(':projectId/preview')
  @ApiOperation({ summary: '启动/获取本地 Vite 预览服务' })
  async preview(@Param('projectId') projectId: string) {
    try {
      return await this.localPreviewService.startPreview(projectId);
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException(`预览服务启动失败：${error?.message || error}`);
    }
  }

  @Post(':projectId/preview/stop')
  @ApiOperation({ summary: '停止本地 Vite 预览服务' })
  async stopPreview(@Param('projectId') projectId: string) {
    return this.localPreviewService.stopPreview(projectId);
  }

  @Get(':projectId/preview/status')
  @ApiOperation({ summary: '查询本地 Vite 预览服务状态' })
  async previewStatus(@Param('projectId') projectId: string) {
    return this.localPreviewService.getStatus(projectId);
  }
}
