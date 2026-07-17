import React, { useState, useEffect } from 'react';
import { Spin, Empty, Segmented, Alert, Space, Tag, Typography } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import {
  SandpackProvider,
  SandpackPreview,
  SandpackLayout,
} from '@codesandbox/sandpack-react';
import { codegenApi } from '../services/api';
// Sandpack 依赖 CodeSandbox 云端打包器，在受限网络下会超时；
// 当前项目已切换到 LocalPreview，保留本组件作为备用。

const { Text } = Typography;

// ── 不含 axios, 纯浏览器兼容 ──
const SANDPACK_DEPS: Record<string, string> = {
  react: '18.2.0',
  'react-dom': '18.2.0',
  antd: '5.29.3',
  '@ant-design/icons': '5.6.1',
  '@ant-design/icons-svg': '4.5.0',
  'react-router-dom': '6.28.0',
  dayjs: '1.11.13',
};

// ── 替换 axios 的 mock 客户端 ──
const MOCK_CLIENT_CODE = `
// Sandpack mock client — 所有 API 返回空数据，避免 axios→Node builtins 报错
const client = {
  get:  () => Promise.resolve({ data: { code: 0, data: null as any, items: [] as any[], pagination: { page:1, page_size:20, total:0, total_pages:0 } } }),
  post: () => Promise.resolve({ data: { code: 0, data: {} } }),
  put:  () => Promise.resolve({ data: { code: 0, data: {} } }),
  patch:() => Promise.resolve({ data: { code: 0, data: {} } }),
  delete:()=> Promise.resolve({ data: { code: 0 } }),
  defaults: { headers: { common: {} } },
};
client.interceptors = { request: { use:()=>{} }, response: { use:()=>{} } };
export function injectAuth(){}
export default client;
`.trim();

// ── 替换 endpoints 的 mock ──
const MOCK_ENDPOINTS_CODE = `
export const authApi = {
  login:  (d:any)=>Promise.resolve({data:{code:0,data:{user:{id:"1",email:"demo",name:"预览用户",role:"super_admin" as any,department:"",is_active:true}} as any}}),
  refresh:(d:any)=>Promise.resolve({data:{code:0,data:{}} as any}),
  me:     ()=>Promise.resolve({data:{code:0,data:{id:"1",email:"demo",name:"预览用户",role:"super_admin" as any,department:"",is_active:true}} as any}),
};
export const qaApi = {
  ask:       (d:any)=>Promise.resolve({data:{code:0,data:{conversation_id:"1",message_id:"1",answer:"Mock",sources:[] as any[],intent:"",confidence:0.9}} as any}),
  askStream: (d:any, cb:any)=>()=>{},
  regenerate:(id:string,t?:number)=>Promise.resolve({data:{code:0,data:{}} as any}),
};
export const conversationApi = {
  list:   (p?:any)=>Promise.resolve({data:{code:0,data:{items:[] as any[],pagination:{page:1,page_size:20,total:0,total_pages:0}}} as any}),
  detail: (id:string)=>Promise.resolve({data:{code:0,data:{id:"1",title:"Demo",messages:[]}} as any}),
  remove: (id:string)=>Promise.resolve({data:{code:0}} as any),
};
export const documentApi = {
  list:   (p?:any)=>Promise.resolve({data:{code:0,data:{items:[] as any[],pagination:{page:1,page_size:20,total:0,total_pages:0}}} as any}),
  upload: (fd:any,p?:any)=>Promise.resolve({data:{code:0,data:{document_id:"1"}} as any}),
  remove: (id:string)=>Promise.resolve({data:{code:0}} as any),
};
export const categoryApi = {
  list:   (p?:any)=>Promise.resolve({data:{code:0,data:[] as any[]} as any}),
  tree:   ()=>Promise.resolve({data:{code:0,data:[] as any[]} as any}),
  create: (d:any)=>Promise.resolve({data:{code:0,data:{}} as any}),
  update: (id:string,d:any)=>Promise.resolve({data:{code:0,data:{}} as any}),
  remove: (id:string)=>Promise.resolve({data:{code:0}} as any),
};
export const feedbackApi = {
  submit: (d:any)=>Promise.resolve({data:{code:0,data:{}} as any}),
};
export const favoriteApi = {
  list:   (p?:any)=>Promise.resolve({data:{code:0,data:{items:[] as any[],pagination:{page:1,page_size:20,total:0,total_pages:0}}} as any}),
  add:    (d:any)=>Promise.resolve({data:{code:0,data:{}} as any}),
  remove: (id:string)=>Promise.resolve({data:{code:0}} as any),
};
export const dashboardApi = {
  stats: ()=>Promise.resolve({data:{code:0,data:{total_documents:12,total_conversations:34,total_users:5,total_feedbacks:8,recent_queries:[{query:"如何请假",count:15},{query:"差旅标准",count:12}],category_distribution:[{name:"人事制度",count:25},{name:"财务制度",count:18},{name:"IT规范",count:15}],daily_queries:[]}} as any}),
};
export const userApi = {
  list:  (p?:any)=>Promise.resolve({data:{code:0,data:{items:[{id:"1",email:"demo",name:"预览用户",role:"super_admin" as any,department:"",is_active:true}],pagination:{page:1,page_size:20,total:1,total_pages:1}}} as any}),
  updateRole:(id:string,r:string)=>Promise.resolve({data:{code:0,data:{}} as any}),
};
export const auditLogApi = {
  list: (p?:any)=>Promise.resolve({data:{code:0,data:{items:[] as any[],pagination:{page:1,page_size:20,total:0,total_pages:0}}} as any}),
};
`.trim();

interface Props { projectId: string; }

// ── 核心：将读取到的文件转成 Sandpack files 对象 ──
function buildSandpackFiles(
  rawFiles: Array<{ path: string; content: string }>,
): Record<string, { code: string }> {
  const out: Record<string, { code: string }> = {};

  // 预置不变的 mock 文件
  out['/src/api/client.ts']     = { code: MOCK_CLIENT_CODE };
  out['/src/api/endpoints.ts']  = { code: MOCK_ENDPOINTS_CODE };
  out['/package.json'] = { code: JSON.stringify({ name: 'preview', private: true, dependencies: SANDPACK_DEPS }) };

  for (const f of rawFiles) {
    // 跳过这些文件（用 mock 版本或根本不需要）
    if (isSkipped(f.path)) continue;

    let p = normalizePath(f.path);
    let code = f.content;

    // 修复 require() → 兼容 ESM
    code = code.replace(/require\(['"](\..*?)['"]\)/g, (_, mod: string) => {
      // require('../stores/AuthContext') → 保留在适当位置，用 import 模拟
      // 实际上这个 require 在 App.tsx 里，我们直接替换为 inline 调用
      return `({ useAuth() { return { tokens: null, isAuthenticated: false, loading: false, login: ()=>Promise.resolve(), logout: ()=>{} }; } })`;
    });

    // Ant Design locale 的 zhCN 直接从 antd/locale/zh_CN 导入——Sandpack 应该支持
    out[p] = { code };
  }

  return out;
}

function isSkipped(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  if (n.endsWith('package.json'))     return true; // 注入不含 axios 的版本
  if (n.endsWith('tsconfig.json'))     return true;
  if (n.endsWith('tsconfig.node.json'))return true;
  if (n.endsWith('vite.config.ts'))    return true;
  if (n.endsWith('api/client.ts') || n.endsWith('api/client.js')) return true;
  if (n.endsWith('api/endpoints.ts') || n.endsWith('api/endpoints.js')) return true;
  return false;
}

function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  // tsx/ts/css 确保在 /src/ 下
  if (/(\.tsx?|\.css)$/.test(s) && !s.startsWith('/src/')) s = '/src' + s;
  return s;
}

async function collectAllFiles(
  projectId: string,
  node: any,
  acc: Array<{ path: string; content: string }> = [],
): Promise<Array<{ path: string; content: string }>> {
  if (!node) return acc;
  if (node.type === 'file') {
    try {
      const res = await codegenApi.getFile(projectId, 'FRONTEND', node.path);
      const c = res.data?.content || '';
      if (c.trim()) acc.push({ path: node.path, content: c });
    } catch { /* skip unreadable */ }
  } else if (node.type === 'dir' && node.children) {
    for (const ch of node.children) await collectAllFiles(projectId, ch, acc);
  }
  return acc;
}

// ── 组件 ──
const SandpackPreviewComponent: React.FC<Props> = ({ projectId }) => {
  const [loading, setLoading] = useState(true);
  const [spFiles, setSpFiles]     = useState<Record<string, any> | null>(null);
  const [pages, setPages]         = useState<string[]>([]);
  const [error, setError]         = useState<string | null>(null);
  const [vm, setVm]               = useState<'browser' | 'responsive'>('browser');

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const tr = await codegenApi.getTree(projectId, 'FRONTEND');
        const tree = tr.data?.tree;
        if (!tree?.children?.length) {
          if (!cancel) { setError('暂无前端代码'); setLoading(false); }
          return;
        }
        const files = await collectAllFiles(projectId, tree);
        if (!files.length) {
          if (!cancel) { setError('未能读取到任何代码文件'); setLoading(false); }
          return;
        }

        // 确保有 index.html
        const hasHtml = files.some(f => /index\.html$/.test(f.path));
        if (!hasHtml) files.push({ path: '/index.html', content: '<!DOCTYPE html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>\n<body><div id="root"></div></body>\n</html>' });

        // 确保有入口 src/index.tsx
        const hasIndex = files.some(f => /[/\\]src[/\\](index|main)\.tsx?$/.test(f.path));
        if (!hasIndex) {
          const appf = files.find(f => /[/\\]App(_.+)?\.tsx$/.test(f.path) || /[/\\]App\.tsx$/.test(f.path));
          const mod = appf ? appf.path.replace(/\\/g,'/').replace(/^.*\//,'').replace(/\.tsx$/,'') : 'App';
          files.push({
            path: '/src/index.tsx',
            content: `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './${mod}';\n\nReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);`,
          });
        }

        const built = buildSandpackFiles(files);
        // 校验 build 结果一定有 package.json
        if (!built['/package.json']) built['/package.json'] = { code: JSON.stringify({ name: 'preview', private: true, dependencies: SANDPACK_DEPS }) };

        if (!cancel) {
          setSpFiles(built);
          setPages(getPages(files));
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancel) { setError(e?.message || '加载失败'); setLoading(false); }
      }
    })();
    return () => { cancel = true; };
  }, [projectId]);

  if (loading) return <div style={{ textAlign: 'center', padding: 60 }}><Spin indicator={<LoadingOutlined style={{ fontSize: 36 }} spin />} /><p style={{ marginTop: 12, color: '#666' }}>正在加载前端代码…</p></div>;
  if (error || !spFiles) return <Empty description={error || '暂无前端代码'} style={{ padding: 40 }} />;

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <Space size="small" wrap>
          <Segmented size="small" value={vm} onChange={v => setVm(v as any)} options={[{ value: 'browser', label: '桌面端' }, { value: 'responsive', label: '移动端' }]} />
          {pages.length > 0 && <Text type="secondary" style={{ fontSize: 12 }}>检测到 {pages.length} 个页面</Text>}
        </Space>
        <Space size={4} wrap>{pages.map(p => <Tag key={p} style={{ fontSize: 11 }}>{p}</Tag>)}</Space>
      </div>

      <div style={{ border: '1px solid #e8e8e8', borderRadius: 8, overflow: 'hidden', height: vm === 'responsive' ? 667 : 560, width: vm === 'responsive' ? 375 : '100%', margin: vm === 'responsive' ? '0 auto' : 0, transition: 'width 0.3s, height 0.3s' }}>
        <SandpackProvider
          template="react-ts"
          files={spFiles}
          customSetup={{ dependencies: SANDPACK_DEPS }}
          style={{ height: '100%' }}
        >
          <SandpackLayout style={{ border: 'none', borderRadius: 0, height: '100%' }}>
            <SandpackPreview style={{ height: '100%' }} showNavigator showRefreshButton />
          </SandpackLayout>
        </SandpackProvider>
      </div>

      <Alert type="info" showIcon style={{ marginTop: 12, fontSize: 12 }}
        message={<Text style={{ fontSize: 12 }}>此预览通过浏览器沙箱渲染，API 调用已替换为 mock 数据。部分功能（登录验证等）无法完全展示。如需完整测试，建议本地启动前后端。</Text>} />
    </div>
  );
};

function getPages(files: Array<{ path: string }>): string[] {
  const set = new Set<string>();
  for (const f of files) {
    const m = f.path.match(/pages[\/\\](.+)\.tsx?$/);
    if (m) set.add(m[1]);
  }
  return [...set].slice(0, 8);
}

export default SandpackPreviewComponent;
