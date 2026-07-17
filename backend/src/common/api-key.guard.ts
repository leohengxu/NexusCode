import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { getApiKeyFromHeaders, isApiKeyValid, isLocalAuthBypassAllowed } from './api-key';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (isLocalAuthBypassAllowed()) return true;
    if (!process.env.API_KEY?.trim()) {
      throw new InternalServerErrorException('服务未配置 API_KEY');
    }

    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    if (!isApiKeyValid(getApiKeyFromHeaders(request.headers))) {
      throw new UnauthorizedException('缺少有效的 API Key');
    }
    return true;
  }
}
