import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { getApiKeyFromHeaders, isApiKeyValid, isLocalAuthBypassAllowed } from './api-key';

@WebSocketGateway({
  // 与 HTTP 保持一致的 CORS origin（避免生产环境 WS 用 * 而 HTTP 受限的不一致）
  cors: { origin: process.env.CORS_ORIGIN || 'http://localhost:5173', credentials: true },
  namespace: '/ws',
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private clientProjects = new Map<string, Set<string>>();

  handleConnection(client: Socket) {
    const apiKey = client.handshake.auth?.apiKey
      || getApiKeyFromHeaders(client.handshake.headers as Record<string, unknown>);
    if (!isLocalAuthBypassAllowed() && !isApiKeyValid(apiKey)) {
      client.disconnect(true);
      return;
    }
    console.log(`[WS] 客户端已连接: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`[WS] 客户端已断开: ${client.id}`);
    this.clientProjects.delete(client.id);
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(client: Socket, projectId: string) {
    if (!projectId) return;
    const room = `project:${projectId}`;
    client.join(room);
    if (!this.clientProjects.has(client.id)) {
      this.clientProjects.set(client.id, new Set());
    }
    this.clientProjects.get(client.id)!.add(projectId);
    console.log(`[WS] ${client.id} 订阅项目 ${projectId}`);
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(client: Socket, projectId: string) {
    if (!projectId) return;
    const room = `project:${projectId}`;
    client.leave(room);
    this.clientProjects.get(client.id)?.delete(projectId);
    console.log(`[WS] ${client.id} 取消订阅项目 ${projectId}`);
  }

  emitProjectEvent(projectId: string, event: string, data: any) {
    this.server.to(`project:${projectId}`).emit(event, {
      projectId,
      event,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  emitStatusChange(projectId: string, status: string, extra?: any) {
    this.emitProjectEvent(projectId, 'status:change', { status, ...extra });
  }

  emitThinkingStep(projectId: string, step: any) {
    this.emitProjectEvent(projectId, 'thinking:step', step);
  }

  emitCodeGenProgress(projectId: string, role: string, status: string, extra?: any) {
    this.emitProjectEvent(projectId, 'codegen:progress', { role, status, ...extra });
  }

  emitValidationResult(projectId: string, role: string, status: string, result?: any) {
    this.emitProjectEvent(projectId, 'validation:result', { role, status, result });
  }

  emitError(projectId: string, message: string) {
    this.emitProjectEvent(projectId, 'error', { message });
  }
}
