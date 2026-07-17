import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApproveDto {
  @ApiPropertyOptional({ description: '审批人' })
  @IsOptional()
  @IsString()
  reviewer?: string;

  @ApiPropertyOptional({ description: '审批意见' })
  @IsOptional()
  @IsString()
  comment?: string;
}

export class RejectDto {
  @ApiPropertyOptional({ description: '审批人' })
  @IsOptional()
  @IsString()
  reviewer?: string;

  @ApiProperty({ description: '驳回意见（必填）' })
  @IsNotEmpty()
  @IsString()
  comment: string;
}
