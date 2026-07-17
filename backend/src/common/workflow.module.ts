import { Global, Module } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { StateSnapshotService } from './state-snapshot.service';
import { OpencodeSdkService } from './opencode-sdk.service';

@Global()
@Module({
  providers: [WorkflowService, StateSnapshotService, OpencodeSdkService],
  exports: [WorkflowService, StateSnapshotService, OpencodeSdkService],
})
export class WorkflowModule {}
