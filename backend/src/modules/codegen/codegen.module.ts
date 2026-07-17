import { Module } from '@nestjs/common';
import { CodegenService } from './codegen.service';
import { CodegenController } from './codegen.controller';
import { FileService } from '../../common/file.service';

@Module({
  imports: [],
  controllers: [CodegenController],
  providers: [CodegenService, FileService],
  exports: [CodegenService],
})
export class CodegenModule {}
