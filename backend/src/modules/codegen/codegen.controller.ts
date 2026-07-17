import { Controller, Post, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { CodegenService } from './codegen.service';
import { CodeGenRole } from '../../common/constants';

@ApiTags('代码生成')
@Controller('api/codegen')
export class CodegenController {
  constructor(private readonly codegenService: CodegenService) {}

  @Post(':projectId/start')
  @ApiOperation({ summary: '启动并行代码生成（前端 + 后端 Worker Agents）' })
  async start(@Param('projectId') projectId: string) {
    // 并发保护：service 内部也有守卫，这里先行返回明确提示
    try {
      await this.codegenService.startCodeGeneration(projectId);
    } catch (err: any) {
      return { message: err.message, projectId, started: false };
    }
    return { message: '代码生成已启动', projectId, started: true };
  }

  @Get(':projectId/status')
  @ApiOperation({ summary: '获取代码生成状态' })
  async getStatus(@Param('projectId') projectId: string) {
    return this.codegenService.getCodeGenStatus(projectId);
  }

  @Get(':projectId/preview')
  @ApiOperation({ summary: '预览生成的代码' })
  @ApiQuery({ name: 'role', required: true, enum: CodeGenRole })
  @ApiQuery({ name: 'iteration', required: false })
  async preview(
    @Param('projectId') projectId: string,
    @Query('role') role: CodeGenRole,
    @Query('iteration') iteration?: string,
  ) {
    return this.codegenService.getCodePreview(projectId, role, iteration ? parseInt(iteration) : undefined);
  }

  @Get(':projectId/tree')
  @ApiOperation({ summary: '获取代码文件树（类似GitHub目录结构）' })
  @ApiQuery({ name: 'role', required: true, enum: CodeGenRole })
  async getTree(
    @Param('projectId') projectId: string,
    @Query('role') role: CodeGenRole,
  ) {
    const tree = await this.codegenService.getFileTree(projectId, role);
    if (!tree) return { tree: null, message: '暂无代码文件' };
    return { tree };
  }

  @Get(':projectId/file')
  @ApiOperation({ summary: '获取单个文件内容' })
  @ApiQuery({ name: 'role', required: true, enum: CodeGenRole })
  @ApiQuery({ name: 'path', required: true })
  async getFile(
    @Param('projectId') projectId: string,
    @Query('role') role: CodeGenRole,
    @Query('path') filePath: string,
  ) {
    const content = await this.codegenService.getFileContent(projectId, role, filePath);
    if (content === null) return { content: null, message: '文件不存在' };
    return { content, path: filePath };
  }
}
