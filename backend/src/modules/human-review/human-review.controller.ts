import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { HumanReviewService } from './human-review.service';

class FinalApproveDto {
  @IsOptional()
  @IsString()
  comment?: string;
}

class FinalRejectDto {
  @IsNotEmpty()
  @IsString()
  comment: string;
}

@ApiTags('最终审核')
@Controller('api/human-review')
export class HumanReviewController {
  constructor(private readonly humanReviewService: HumanReviewService) {}

  @Get(':projectId')
  @ApiOperation({ summary: '获取最终审核状态' })
  async getStatus(@Param('projectId') projectId: string) {
    return this.humanReviewService.getReviewStatus(projectId);
  }

  @Post(':projectId/approve')
  @ApiOperation({ summary: '最终审核通过，发布基线' })
  async approve(@Param('projectId') projectId: string, @Body() dto: FinalApproveDto) {
    return this.humanReviewService.finalApprove(projectId, dto.comment);
  }

  @Post(':projectId/reject')
  @ApiOperation({ summary: '最终审核驳回，进入返修' })
  async reject(@Param('projectId') projectId: string, @Body() dto: FinalRejectDto) {
    return this.humanReviewService.finalReject(projectId, dto.comment);
  }
}
