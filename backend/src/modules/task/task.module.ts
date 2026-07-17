import { Module } from '@nestjs/common';
import { TaskService } from './task.service';
import { TaskController } from './task.controller';
import { OpencodeModule } from '../opencode/opencode.module';
import { CodegenModule } from '../codegen/codegen.module';
import { FileService } from '../../common/file.service';

@Module({
  imports: [OpencodeModule, CodegenModule],
  controllers: [TaskController],
  providers: [TaskService, FileService],
  exports: [TaskService],
})
export class TaskModule {}
