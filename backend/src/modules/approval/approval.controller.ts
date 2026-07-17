import { Controller, Post, Get, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ApprovalService } from './approval.service';
import { ApproveDto, RejectDto } from './dto/approval.dto';

@ApiTags('审批管理')
@Controller('api/approvals')
export class ApprovalController {
  constructor(private readonly approvalService: ApprovalService) {}

  /**
   * POST /api/approvals/:projectId/approve - 审批通过
   */
  @Post(':projectId/approve')
  @ApiOperation({ summary: '审批通过' })
  async approve(
    @Param('projectId') projectId: string,
    @Body() dto: ApproveDto,
  ) {
    return this.approvalService.approve(projectId, dto);
  }

  /**
   * POST /api/approvals/:projectId/reject - 审批驳回
   */
  @Post(':projectId/reject')
  @ApiOperation({ summary: '审批驳回（触发全量重新生成）' })
  async reject(
    @Param('projectId') projectId: string,
    @Body() dto: RejectDto,
  ) {
    return this.approvalService.reject(projectId, dto);
  }

  /**
   * GET /api/approvals/:projectId/history - 审批历史
   */
  @Get(':projectId/history')
  @ApiOperation({ summary: '获取审批历史' })
  async getHistory(@Param('projectId') projectId: string) {
    return this.approvalService.getApprovalHistory(projectId);
  }
}
