import { Module } from '@nestjs/common';
import { HumanReviewService } from './human-review.service';
import { HumanReviewController } from './human-review.controller';
import { CodegenModule } from '../codegen/codegen.module';

@Module({
  imports: [CodegenModule],
  controllers: [HumanReviewController],
  providers: [HumanReviewService],
  exports: [HumanReviewService],
})
export class HumanReviewModule {}
