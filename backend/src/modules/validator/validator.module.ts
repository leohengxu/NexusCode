import { Module, forwardRef } from '@nestjs/common';
import { ValidatorService } from './validator.service';
import { ValidatorController } from './validator.controller';
import { FileService } from '../../common/file.service';
import { CodegenModule } from '../codegen/codegen.module';

@Module({
  imports: [forwardRef(() => CodegenModule)],
  controllers: [ValidatorController],
  providers: [ValidatorService, FileService],
  exports: [ValidatorService],
})
export class ValidatorModule {}
