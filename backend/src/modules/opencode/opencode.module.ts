import { Module } from '@nestjs/common';
import { OpencodeService } from './opencode.service';
import { FileService } from '../../common/file.service';

@Module({
  providers: [OpencodeService, FileService],
  exports: [OpencodeService],
})
export class OpencodeModule {}
