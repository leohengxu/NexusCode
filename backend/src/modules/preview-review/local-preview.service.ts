import * as path from 'path';
import * as fs from 'fs';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { pathToFileURL } from 'url';
import { CodegenService } from '../codegen/codegen.service';
import { FileService } from '../../common/file.service';
import { CodeGenRole } from '../../common/constants';

interface PreviewInstance {
  projectId: string;
  iteration: number;
  port: number;
  url: string;
  server: ViteDevServer;
  startedAt: Date;
}

interface ViteDevServer {
  listen(): Promise<void>;
  close(): Promise<void>;
}

const dynamicEsmImport: (specifier: string) => Promise<any> =
  new Function('specifier', 'return import(specifier)') as any;

/**
 * 本地 Vite 预览服务
 *
 * 用前端项目里的 vite + @vitejs/plugin-react 直接启动生成代码目录，
 * 通过 alias 把 react/antd/axios 等依赖指向前端 node_modules，避免在沙箱里重新安装依赖。
 */
@Injectable()
export class LocalPreviewService {
  private readonly logger = new Logger(LocalPreviewService.name);
  private readonly instances = new Map<string, PreviewInstance>();
  private readonly portStart = 45700;
  private readonly portEnd = 45800;
  private readonly frontendRoot: string;

  constructor(
    private readonly codegenService: CodegenService,
    private readonly fileService: FileService,
  ) {
    // 假设后端目录是 backend/，前端目录是 ../frontend
    this.frontendRoot = process.env.FRONTEND_ROOT || path.resolve(process.cwd(), '..', 'frontend');
  }

  /**
   * 获取或启动项目的前端预览服务
   */
  async startPreview(projectId: string): Promise<{ url: string; port: number; started: boolean; iteration: number }> {
    const codeGens = await this.codegenService.getCodeGenStatus(projectId);
    const latestIteration = codeGens.reduce(
      (max, codeGen) => Math.max(max, codeGen.iteration),
      0,
    );
    const record = codeGens.find(
      codeGen => codeGen.role === CodeGenRole.FRONTEND
        && codeGen.iteration === latestIteration
        && codeGen.status === 'COMPLETED',
    );
    if (!record) {
      throw new BadRequestException('当前代码迭代没有完整的前端产物，无法预览');
    }

    const existing = this.instances.get(projectId);
    if (existing) {
      const alive = await this.isPortAlive(existing.port);
      if (alive && existing.iteration === record.iteration) {
        return {
          url: existing.url,
          port: existing.port,
          started: false,
          iteration: existing.iteration,
        };
      }

      const reason = alive
        ? `代码已从 iter${existing.iteration} 更新到 iter${record.iteration}`
        : `端口 ${existing.port} 已不可用`;
      this.logger.log(`[Preview] 项目 ${projectId} ${reason}，切换预览实例`);
      this.instances.delete(projectId);
      try { await existing.server.close(); } catch { /* ignore */ }
    }

    const root = path.resolve(
      this.fileService.getCodeDir(projectId, record.iteration, CodeGenRole.FRONTEND),
    );
    if (!fs.existsSync(root)) {
      throw new Error(`前端代码目录不存在: ${root}`);
    }

    const indexHtml = path.join(root, 'index.html');
    if (!fs.existsSync(indexHtml)) {
      this.logger.warn(`[Preview] ${root} 缺少 index.html，尝试自动创建入口`);
      this.ensureIndexHtml(root);
    }

    const port = await this.findFreePort();
    const url = `http://127.0.0.1:${port}/?previewIteration=${record.iteration}`;

    // Vite 8 与 React 插件均为 ESM。先按 frontendRoot 解析真实入口，再用原生 import 加载。
    const viteEntry = require.resolve('vite', { paths: [this.frontendRoot] });
    const reactPluginEntry = require.resolve('@vitejs/plugin-react', { paths: [this.frontendRoot] });
    const [vite, reactPlugin] = await Promise.all([
      dynamicEsmImport(pathToFileURL(viteEntry).href),
      dynamicEsmImport(pathToFileURL(reactPluginEntry).href),
    ]);

    // Mock client：替换生成的 api/client.ts，所有 API 调用返回空数据，
    // 避免预览环境无后端导致 axios 请求 404/网络错误。
    const MOCK_CLIENT_CODE = `const client = {
  get:  () => Promise.resolve({ data: { code: 0, data: null, items: [], pagination: { page:1, page_size:20, total:0, total_pages:0 } } }),
  post: () => Promise.resolve({ data: { code: 0, data: {} } }),
  put:  () => Promise.resolve({ data: { code: 0, data: {} } }),
  patch:() => Promise.resolve({ data: { code: 0, data: {} } }),
  delete:()=> Promise.resolve({ data: { code: 0 } }),
  defaults: { headers: { common: {} } },
};
client.interceptors = { request: { use:()=>{} }, response: { use:()=>{} } };
export function injectAuth(){}
export default client;`;

    // Mock AuthContext：替换生成的 stores/AuthContext.tsx，始终返回已登录状态，
    // 让 ProtectedRoute 放行，预览能看到所有页面。
    // 用 createElement 而非 JSX，避免 transform 阶段 JSX 未被编译的问题。
    const MOCK_AUTH_CONTEXT_CODE = `import { createElement, createContext, useContext } from 'react'

const mockAuth = {
  user: { id: '1', email: 'demo@preview.com', name: '预览用户', role: 'super_admin', department: '', is_active: true },
  tokens: { access_token: 'mock-token', refresh_token: 'mock-refresh', token_type: 'Bearer', expires_in: 3600 },
  isAuthenticated: true,
  loading: false,
  login: () => Promise.resolve(),
  logout: () => {},
  refreshToken: () => Promise.resolve(),
}

const AuthContext = createContext(mockAuth)

export function AuthProvider({ children }) {
  return createElement(AuthContext.Provider, { value: mockAuth }, children)
}

export function useAuth() {
  return useContext(AuthContext) || mockAuth
}`;

    // Mock endpoints：替换生成的 api/endpoints.ts，提供完整的 API mock 数据，
    // 让所有页面（Dashboard/Documents/Conversations/Categories/Users 等）能正常渲染。
    // 关键：响应格式是 res.data.data.{items,pagination}，匹配生成代码的预期结构。
    const MOCK_ENDPOINTS_CODE = `export const authApi = {
  login:  (d)=>Promise.resolve({data:{code:0,data:{user:{id:"1",email:"demo@preview.com",name:"预览用户",role:"super_admin",department:"",is_active:true},tokens:{access_token:"mock",refresh_token:"mock",token_type:"Bearer",expires_in:3600}}}}),
  refresh:(d)=>Promise.resolve({data:{code:0,data:{access_token:"mock",refresh_token:"mock"}}}),
  me:     ()=>Promise.resolve({data:{code:0,data:{id:"1",email:"demo@preview.com",name:"预览用户",role:"super_admin",department:"",is_active:true}}}),
};
export const qaApi = {
  ask:       (d)=>Promise.resolve({data:{code:0,data:{conversation_id:"1",message_id:"1",answer:"这是 Mock 回答（预览环境无后端）。",sources:[],intent:"",confidence:0.9}}}),
  askStream: (d,cb)=>()=>{},
  regenerate:(id,t)=>Promise.resolve({data:{code:0,data:{}}}),
};
export const conversationApi = {
  list:   (p)=>Promise.resolve({data:{code:0,data:{items:[],pagination:{page:1,page_size:20,total:0,total_pages:0}}}}),
  detail: (id)=>Promise.resolve({data:{code:0,data:{id:"1",title:"演示会话",messages:[]}}}),
  remove: (id)=>Promise.resolve({data:{code:0}}),
};
export const documentApi = {
  list:   (p)=>Promise.resolve({data:{code:0,data:{items:[],pagination:{page:1,page_size:20,total:0,total_pages:0}}}}),
  upload: (fd,p)=>Promise.resolve({data:{code:0,data:{document_id:"1"}}}),
  remove: (id)=>Promise.resolve({data:{code:0}}),
};
export const categoryApi = {
  list:   (p)=>Promise.resolve({data:{code:0,data:[]}}),
  tree:   ()=>Promise.resolve({data:{code:0,data:[]}}),
  create: (d)=>Promise.resolve({data:{code:0,data:{}}}),
  update: (id,d)=>Promise.resolve({data:{code:0,data:{}}}),
  remove: (id)=>Promise.resolve({data:{code:0}}),
};
export const feedbackApi = {
  submit: (d)=>Promise.resolve({data:{code:0,data:{}}}),
};
export const favoriteApi = {
  list:   (p)=>Promise.resolve({data:{code:0,data:{items:[],pagination:{page:1,page_size:20,total:0,total_pages:0}}}}),
  add:    (d)=>Promise.resolve({data:{code:0,data:{}}}),
  remove: (id)=>Promise.resolve({data:{code:0}}),
};
export const dashboardApi = {
  stats: ()=>{
    const categories=[{name:"人事制度",count:25},{name:"财务制度",count:18},{name:"IT规范",count:15}];
    const activities=[
      {id:"activity-1",user_id:"user-1",user_name:"王小明",action:"login",resource_type:"auth",resource_id:"session-1",created_at:"2026-07-16T09:20:00.000Z"},
      {id:"activity-2",user_id:"user-2",user_name:"李四",action:"create",resource_type:"document",resource_id:"travel-policy",created_at:"2026-07-15T16:45:00.000Z"}
    ];
    return Promise.resolve({data:{code:0,data:{
      total_documents:12,total_conversations:34,total_users:5,total_feedbacks:8,
      today_queries:9,avg_response_time:680,
      top_categories:categories,recent_activities:activities,
      recent_queries:[{query:"如何请假",count:15},{query:"差旅标准",count:12}],
      category_distribution:categories,daily_queries:[]
    }}});
  },
};
export const userApi = {
  list:  (p)=>Promise.resolve({data:{code:0,data:{items:[{id:"1",email:"demo@preview.com",name:"预览用户",role:"super_admin",department:"",is_active:true}],pagination:{page:1,page_size:20,total:1,total_pages:1}}}}),
  updateRole:(id,r)=>Promise.resolve({data:{code:0,data:{}}}),
};
export const auditLogApi = {
  list: (p={})=>{
    const logs=[
      {id:"audit-1",user_id:"user-1",user_name:"王小明",action:"login",resource_type:"auth",resource_id:"session-1",ip_address:"10.10.0.21",created_at:"2026-07-16T09:20:00.000Z"},
      {id:"audit-2",user_id:"user-2",user_name:"李四",action:"create",resource_type:"document",resource_id:"travel-policy",ip_address:"10.10.0.34",created_at:"2026-07-15T16:45:00.000Z"},
      {id:"audit-3",user_id:"user-3",user_name:"张三",action:"update",resource_type:"user",resource_id:"user-3",ip_address:"10.10.0.18",created_at:"2026-07-15T14:10:00.000Z"},
      {id:"audit-4",user_id:"user-1",user_name:"王小明",action:"delete",resource_type:"document",resource_id:"expired-notice",ip_address:"10.10.0.21",created_at:"2026-07-14T11:30:00.000Z"}
    ];
    const search=String(p.search||"").trim().toLowerCase();
    const filtered=logs.filter(log=>{
      const matchesSearch=!search||Object.values(log).some(value=>String(value).toLowerCase().includes(search));
      const matchesAction=!p.action||log.action===p.action;
      const matchesResource=!p.resource_type||log.resource_type===p.resource_type;
      const matchesStart=!p.created_at__gte||log.created_at>=p.created_at__gte;
      const matchesEnd=!p.created_at__lte||log.created_at<=p.created_at__lte;
      return matchesSearch&&matchesAction&&matchesResource&&matchesStart&&matchesEnd;
    });
    const page=Math.max(1,Number(p.page)||1);
    const pageSize=Math.max(1,Number(p.page_size)||20);
    const total=filtered.length;
    return Promise.resolve({data:{code:0,data:{items:filtered.slice((page-1)*pageSize,page*pageSize),pagination:{page,page_size:pageSize,total,total_pages:Math.max(1,Math.ceil(total/pageSize))}}}});
  },
};`;

    // Vite 插件：1) 注入预览布局兜底 CSS  2) 替换 api/client 为 mock
    //            3) 替换 api/endpoints 为完整 mock  4) 替换 AuthContext 为已登录 mock
    //            5) 把 CommonJS require() 替换为 ESM 兼容的 mock
    const previewTransformPlugin = {
      name: 'preview-transform',
      // 注入 CSS：兜底修复生成代码 Layout 组件的 Sider 覆盖内容 bug
      transformIndexHtml(html: string) {
        const previewSession = `<script>
localStorage.setItem('access_token', 'mock-token');
localStorage.setItem('user_role', 'super_admin');
localStorage.setItem('user_name', '预览用户');
</script>`;
        const fixCss = `<style>
/* 预览布局兜底：生成代码的 Layout Sider 是 position:fixed 但内容 marginLeft:0，
   导致第一个内容卡片被侧边栏盖住。这里强制让主内容区域有正确左偏移。 */
.ant-layout > .ant-layout { margin-left: 220px !important; }
@media (max-width: 991px) {
  .ant-layout > .ant-layout { margin-left: 0 !important; }
}
</style>`;
        return html.replace('</head>', `${previewSession}${fixCss}</head>`);
      },
      transform(code: string, id: string) {
        if (!/\.(tsx?|jsx?)$/.test(id)) return null;

        // 1. 替换 api/client 为 mock，避免真实 API 请求打到不存在的后端
        if (/api[\\/]client\.(ts|tsx|js)$/.test(id)) {
          return MOCK_CLIENT_CODE;
        }

        // 2. 替换 api/endpoints 为完整 mock，让所有页面能正常渲染
        if (/api[\\/]endpoints\.(ts|tsx|js)$/.test(id)) {
          return MOCK_ENDPOINTS_CODE;
        }

        // 3. 替换 AuthContext 为 mock，始终已登录，绕过 ProtectedRoute
        if (/stores[\\/]AuthContext\.(ts|tsx)$/.test(id)) {
          return MOCK_AUTH_CONTEXT_CODE;
        }

        // 3. 把 CommonJS require() 替换为 ESM 兼容的 mock
        if (!code.includes('require(')) return null;
        return code.replace(
          /require\(['"](\.\.?\/[^'"]+)['"]\)/g,
          (_m: string, mod: string) => {
            if (mod.includes('AuthContext')) {
              return `((()=>{function useAuth(){return{user:{id:'1',name:'预览用户',role:'super_admin'},tokens:{access_token:'mock'},isAuthenticated:true,loading:false,login:()=>Promise.resolve(),logout:()=>{}}}return{useAuth}})())`;
            }
            return '({})';
          },
        );
      },
    };

    const server: ViteDevServer = await vite.createServer({
      configFile: false,
      root,
      plugins: [previewTransformPlugin, reactPlugin.default()],
      server: {
        port,
        host: '127.0.0.1',
        fs: {
          strict: true,
          allow: [root, path.join(this.frontendRoot, 'node_modules')],
        },
        headers: {
          'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*;",
        },
      },
      resolve: {
        preserveSymlinks: true,
        alias: this.buildAliases(),
      },
      optimizeDeps: {
        include: [
          'react',
          'react-dom/client',
          'react-router-dom',
          'antd',
          '@ant-design/icons',
          'axios',
          'dayjs',
        ],
        force: true,
      },
    });

    await server.listen();

    const instance: PreviewInstance = {
      projectId,
      iteration: record.iteration,
      port,
      url,
      server,
      startedAt: new Date(),
    };
    this.instances.set(projectId, instance);
    this.logger.log(`[Preview] 项目 ${projectId} 预览服务已启动: ${url}`);

    return { url, port, started: true, iteration: record.iteration };
  }

  /**
   * 停止预览服务
   */
  async stopPreview(projectId: string): Promise<{ stopped: boolean }> {
    const instance = this.instances.get(projectId);
    if (!instance) return { stopped: false };
    // 先从 Map 移除，避免 close 期间其它请求命中半死实例
    this.instances.delete(projectId);
    // server.close() 可能卡住（esbuild/ws 关闭慢），加 5 秒超时保护
    await Promise.race([
      instance.server.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    this.logger.log(`[Preview] 项目 ${projectId} 预览服务已停止`);
    return { stopped: true };
  }

  /**
   * 查询预览状态
   */
  getStatus(projectId: string): {
    running: boolean;
    iteration?: number;
    url?: string;
    port?: number;
    startedAt?: Date;
  } {
    const instance = this.instances.get(projectId);
    if (!instance) return { running: false };
    return {
      running: true,
      iteration: instance.iteration,
      url: instance.url,
      port: instance.port,
      startedAt: instance.startedAt,
    };
  }

  /**
   * 构建依赖别名，指向本地前端 node_modules
   */
  private buildAliases(): Record<string, string> {
    const nm = (m: string) => path.join(this.frontendRoot, 'node_modules', m);
    return {
      react: nm('react'),
      'react-dom': nm('react-dom'),
      'react-dom/client': nm('react-dom/client'),
      'react/jsx-runtime': nm('react/jsx-runtime'),
      'react/jsx-dev-runtime': nm('react/jsx-dev-runtime'),
      'react-router-dom': nm('react-router-dom'),
      antd: nm('antd'),
      'antd/locale/zh_CN': nm('antd/locale/zh_CN'),
      '@ant-design/icons': nm('@ant-design/icons'),
      '@ant-design/icons-svg': nm('@ant-design/icons-svg'),
      axios: nm('axios'),
      dayjs: nm('dayjs'),
    };
  }

  /**
   * 检查端口是否仍在监听（用于健康检查）
   */
  private async isPortAlive(port: number): Promise<boolean> {
    const net = await import('net');
    return new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ port, host: '127.0.0.1' });
      sock.setTimeout(1000);
      sock.once('connect', () => { sock.end(); resolve(true); });
      sock.once('error', () => resolve(false));
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
    });
  }

  private async findFreePort(): Promise<number> {
    const net = await import('net');
    for (let p = this.portStart; p < this.portEnd; p++) {
      const ok = await new Promise<boolean>((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
          server.close(() => resolve(true));
        });
        server.listen(p, '127.0.0.1');
      });
      if (ok) return p;
    }
    throw new Error('没有可用的预览端口');
  }

  private ensureIndexHtml(root: string): void {
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Preview</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
    fs.writeFileSync(path.join(root, 'index.html'), html, 'utf-8');
  }
}
