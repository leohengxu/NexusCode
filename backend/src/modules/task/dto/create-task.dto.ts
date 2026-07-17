import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTaskDto {
  @ApiPropertyOptional({ description: '项目名称' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: 'PRD 文档内容（文本）' })
  @IsNotEmpty()
  @IsString()
  prdContent: string;
}
