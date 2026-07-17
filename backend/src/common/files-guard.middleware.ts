import {
  Injectable,
  NestMiddleware,
  ForbiddenException,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { getApiKeyFromHeaders, isApiKeyValid, isLocalAuthBypassAllowed } from './api-key';

/**
 * 静态文件访问守卫中间件
 *
 * uploads/ 通过 /files 静态暴露，但其中包含不应对外下载的敏感文件：
 *   - debug_*.md        LLM 原始调试输出
 *   - generated_*.md    LLM 原始 Markdown（未提取的代码原文）
 *   - prd/ 与 prd_*     用户上传的 PRD 原文
 *
 * 前端合法下载的是 v{n}/ 下的架构文档（.md），以及通过 /api/codegen 端点读取的代码。
 * 本中间件拦截对敏感模式的 /files 请求，返回 403。
 */
@Injectable()
export class FilesGuardMiddleware implements NestMiddleware {
  // 敏感路径片段（不区分大小写）
  private static readonly BLOCKED_PATTERNS = [
    /\/prd\//i,          // PRD 目录
    /\/prd_/i,           // 项目目录内的 prd_ 前缀文件
    /\/debug_/i,         // 调试输出
    /\/generated_/i,     // LLM 原始 Markdown
  ];

  use(req: Request, _res: Response, next: NextFunction) {
    if (!isLocalAuthBypassAllowed()) {
      if (!process.env.API_KEY?.trim()) {
        throw new InternalServerErrorException('服务未配置 API_KEY');
      }
      if (!isApiKeyValid(getApiKeyFromHeaders(req.headers as Record<string, unknown>))) {
        throw new UnauthorizedException('缺少有效的 API Key');
      }
    }

    // req.path 形如 /{projectId}/v1/xxx.md（已剥离 /files 前缀由 ServeStatic 处理，
    // 但中间件挂在 /files 上时 req.path 仍含相对路径），统一用 originalUrl 兜底判断。
    // decodeURIComponent 对非法 % 序列会抛 URIError，需捕获避免 500。
    let target = req.originalUrl || req.path || '';
    try {
      target = decodeURIComponent(target);
    } catch {
      // 非法编码序列，保留原始字符串进行模式匹配
    }

    for (const pattern of FilesGuardMiddleware.BLOCKED_PATTERNS) {
      if (pattern.test(target)) {
        throw new ForbiddenException('该文件不允许下载');
      }
    }
    next();
  }
}
