import { Module } from '@nestjs/common';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { FileService } from '../../common/file.service';
import { TaskModule } from '../task/task.module';
import { CodegenModule } from '../codegen/codegen.module';

@Module({
  imports: [TaskModule, CodegenModule],
  controllers: [ApprovalController],
  providers: [ApprovalService, FileService],
})
export class ApprovalModule {}
