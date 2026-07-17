import { useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

// 优先使用环境变量，否则基于当前页面 hostname 推导后端地址（避免硬编码 localhost 导致部署失效）
const WS_URL = import.meta.env.VITE_WS_URL || `http://${window.location.hostname}:3000`;

type EventHandler = (data: any) => void;

export function useWebSocket(projectId?: string) {
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef<Map<string, Set<EventHandler>>>(new Map());

  useEffect(() => {
    const socket = io(`${WS_URL}/ws`, {
      transports: ['websocket', 'polling'],
      auth: { apiKey: import.meta.env.VITE_API_KEY },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => {
      console.log('[WS] 已连接');
      if (projectId) {
        socket.emit('subscribe', projectId);
      }
    });

    socket.on('disconnect', () => {
      console.log('[WS] 已断开');
    });

    socketRef.current = socket;

    return () => {
      if (projectId) {
        socket.emit('unsubscribe', projectId);
      }
      socket.disconnect();
      socketRef.current = null;
    };
  }, [projectId]);

  const on = useCallback((event: string, handler: EventHandler) => {
    if (!handlersRef.current.has(event)) {
      handlersRef.current.set(event, new Set());
    }
    handlersRef.current.get(event)!.add(handler);

    // Socket.IO 允许在连接建立前注册监听器，避免连接稍晚建立时丢失事件。
    socketRef.current?.on(event, handler);

    return () => {
      handlersRef.current.get(event)?.delete(handler);
      socketRef.current?.off(event, handler);
    };
  }, []);

  const subscribe = useCallback((pid: string) => {
    socketRef.current?.emit('subscribe', pid);
  }, []);

  const unsubscribe = useCallback((pid: string) => {
    socketRef.current?.emit('unsubscribe', pid);
  }, []);

  return { on, subscribe, unsubscribe, socket: socketRef };
}
