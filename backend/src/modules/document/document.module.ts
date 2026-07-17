import { Module } from '@nestjs/common';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';
import { FileService } from '../../common/file.service';

@Module({
  controllers: [DocumentController],
  providers: [DocumentService, FileService],
})
export class DocumentModule {}
