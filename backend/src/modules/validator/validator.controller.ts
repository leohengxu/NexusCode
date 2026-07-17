import { Controller, Post, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ValidatorService } from './validator.service';

@ApiTags('代码验证')
@Controller('api/validations')
export class ValidatorController {
  constructor(private readonly validatorService: ValidatorService) {}

  @Post(':projectId/start')
  @ApiOperation({ summary: '启动并行验证（功能/安全/性能/UI 盲审）' })
  async start(@Param('projectId') projectId: string) {
    // startValidation 内部已做并发守卫；建记录后 LLM 验证 fire-and-forget，此处 await 快速返回
    await this.validatorService.startValidation(projectId);
    return { message: '验证已启动', projectId };
  }

  @Get(':projectId')
  @ApiOperation({ summary: '获取验证结果' })
  async getStatus(@Param('projectId') projectId: string) {
    return this.validatorService.getValidationStatus(projectId);
  }
}
