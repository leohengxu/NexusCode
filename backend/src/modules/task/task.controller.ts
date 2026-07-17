import {
  Controller, Post, Get, Param, Body, UploadedFile,
  UseInterceptors, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { TaskService } from './task.service';
import { FileService } from '../../common/file.service';
import { CodegenService } from '../codegen/codegen.service';
import { WorkflowService } from '../../common/workflow.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { multerConfig } from '../../common/multer.config';
import * as fs from 'fs';

@ApiTags('任务管理')
@Controller('api/tasks')
export class TaskController {
  constructor(
    private readonly taskService: TaskService,
    private readonly fileService: FileService,
    private readonly codegenService: CodegenService,
    private readonly workflow: WorkflowService,
  ) {}

  /**
   * POST /api/tasks - 文本方式上传 PRD
   */
  @Post()
  @ApiOperation({ summary: '发起文档生成（文本方式提交PRD）' })
  async create(@Body() dto: CreateTaskDto) {
    return this.taskService.createTask(dto);
  }

  /**
   * POST /api/tasks/upload - 文件方式上传 PRD
   * 支持格式: .txt / .md / .markdown（UTF-8 纯文本）
   */
  @Post('upload')
  @ApiOperation({ summary: '发起文档生成（文件上传方式提交 PRD，支持 UTF-8 .txt/.md/.markdown）' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', multerConfig))
  async createWithFile(
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name?: string,
  ) {
    if (!file) throw new BadRequestException('请上传 PRD 文件');

    const cleanupUpload = () => {
      try { fs.unlinkSync(file.path); } catch { /* ignore cleanup failure */ }
    };

    // 读取 UTF-8 纯文本；二进制或非法 UTF-8 文件不能进入 LLM 流程。
    let prdContent: string;
    try {
      prdContent = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file.path));
    } catch {
      cleanupUpload();
      throw new BadRequestException('无法读取文件内容，请上传 UTF-8 纯文本文件');
    }

    if (!prdContent.trim()) {
      cleanupUpload();
      throw new BadRequestException('PRD 文件内容为空');
    }

    // 创建任务，传入 prdFilePath
    let project;
    try {
      project = await this.taskService.createTask(
        { name, prdContent },
        file.path, // 保存 PRD 文件路径
      );
    } catch (error) {
      cleanupUpload();
      throw error;
    }

    return project;
  }

  /**
   * GET /api/tasks - 获取所有项目列表
   */
  @Get()
  @ApiOperation({ summary: '获取所有项目列表' })
  async listProjects() {
    return this.taskService.getAllProjects();
  }

  /**
   * GET /api/tasks/:projectId - 查询项目/任务状态
   */
  @Get(':projectId')
  @ApiOperation({ summary: '查询任务状态' })
  async getStatus(@Param('projectId') projectId: string) {
    return this.taskService.getTaskStatus(projectId);
  }

  /**
   * POST /api/tasks/:projectId/rework - 手动触发返修
   */
  @Post(':projectId/rework')
  @ApiOperation({ summary: '手动触发返修（重新生成代码）' })
  async triggerRework(
    @Param('projectId') projectId: string,
    @Body('feedback') feedback: string,
  ) {
    if (!feedback || !feedback.trim()) {
      throw new BadRequestException('请提供返修反馈');
    }
    // 手动返修：先合法进入 REWORKING（并递增迭代计数），再触发代码重生成。
    // 计数递增只在 enterManualRework 一处发生，triggerRework 不再自增。
    await this.workflow.enterManualRework(projectId, feedback);
    await this.codegenService.triggerRework(projectId, feedback);
    return { message: '返修已触发，代码将根据反馈重新生成', projectId };
  }

  /**
   * GET /api/tasks/:projectId/full-status - 获取完整项目状态（含代码生成、验证、返修记录）
   */
  @Get(':projectId/full-status')
  @ApiOperation({ summary: '获取完整项目状态' })
  async getFullStatus(@Param('projectId') projectId: string) {
    return this.taskService.getFullStatus(projectId);
  }
}
