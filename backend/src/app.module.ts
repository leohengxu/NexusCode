import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { PrismaModule } from './common/prisma.module';
import { WorkflowModule } from './common/workflow.module';
import { EventsModule } from './common/events.module';
import { FilesGuardMiddleware } from './common/files-guard.middleware';
import { TaskModule } from './modules/task/task.module';
import { DocumentModule } from './modules/document/document.module';
import { ApprovalModule } from './modules/approval/approval.module';
import { OpencodeModule } from './modules/opencode/opencode.module';
import { CodegenModule } from './modules/codegen/codegen.module';
import { ValidatorModule } from './modules/validator/validator.module';
import { HumanReviewModule } from './modules/human-review/human-review.module';
import { PreviewReviewModule } from './modules/preview-review/preview-review.module';
import { ApiKeyGuard } from './common/api-key.guard';

@Module({
  imports: [
    // 静态文件服务 - 允许前端下载文档（敏感文件由 FilesGuardMiddleware 拦截）
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'),
      serveRoot: '/files',
    }),
    PrismaModule,
    EventsModule,
    WorkflowModule,
    OpencodeModule,
    TaskModule,
    DocumentModule,
    ApprovalModule,
    CodegenModule,
    ValidatorModule,
    PreviewReviewModule,
    HumanReviewModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ApiKeyGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // 在 /files 静态服务前拦截敏感文件（PRD 原文 / debug / 原始 Markdown）
    consumer.apply(FilesGuardMiddleware).forRoutes('files');
  }
}
