import { Module } from '@nestjs/common';
import { PreviewReviewService } from './preview-review.service';
import { PreviewReviewController } from './preview-review.controller';
import { LocalPreviewService } from './local-preview.service';
import { CodegenModule } from '../codegen/codegen.module';
import { FileService } from '../../common/file.service';

@Module({
  imports: [CodegenModule],
  controllers: [PreviewReviewController],
  providers: [PreviewReviewService, LocalPreviewService, FileService],
  exports: [PreviewReviewService, LocalPreviewService],
})
export class PreviewReviewModule {}
