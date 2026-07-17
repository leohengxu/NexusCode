import React, { useState, useEffect } from 'react';
import { Spin, Button, Empty, Typography } from 'antd';
import { DownloadOutlined, CodeOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { DocType } from '../types';
import { documentApi } from '../services/api';

const { Title } = Typography;

let mermaidInitialized = false;

async function renderMermaid(id: string, code: string): Promise<string> {
  const { default: mermaid } = await import('mermaid');
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'strict',
      fontFamily: 'inherit',
    });
    mermaidInitialized = true;
  }
  const { svg } = await mermaid.render(id, code);
  return svg;
}

/** 合法的 Mermaid 图类型关键字 */
const VALID_DIAGRAM_TYPES = [
  'flowchart', 'graph', 'sequencediagram', 'classdiagram', 'statediagram',
  'erdiagram', 'gantt', 'pie', 'gitgraph', 'mindmap', 'timeline',
  'journey', 'quadrantchart', 'requirementdiagram', 'c4context',
  'c4container', 'c4component', 'c4dynamic', 'c4deployment',
  'zenuml', 'sankey', 'xychart', 'blockdiagram', 'packet',
];

/** 尝试从原始文本中提取有效的 Mermaid 图声明 */
function extractMermaidContent(raw: string): string | null {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  // 检查是否以合法图类型开头
  for (const type of VALID_DIAGRAM_TYPES) {
    if (lower.startsWith(type)) {
      return trimmed;
    }
  }

  // 尝试在文本中查找第一个合法图声明（处理 LLM 在 mermaid 块前加描述文字的情况）
  for (const type of VALID_DIAGRAM_TYPES) {
    const idx = lower.indexOf(`\n${type}`);  // 换行后紧跟图类型
    if (idx >= 0) {
      return trimmed.slice(idx + 1);  // 从换行后的图声明开始
    }
  }

  // 无法识别任何有效图类型
  return null;
}

/**
 * 预处理 Mermaid 代码，修复 LLM 常见语法错误。
 */
function sanitizeMermaid(code: string): string {
  // 先提取有效内容，LLM 可能在 mermaid 块前加描述文字
  const extracted = extractMermaidContent(code);
  if (!extracted) return code.trim(); // 无法识别，返回原始内容让 mermaid 自行报错

  const sanitized = extracted.trim();
  const lower = sanitized.toLowerCase();

  // ── C4 图（C4Context / C4Container / C4Component / C4Dynamic / C4Deployment）──
  if (/^c4(context|container|component|dynamic|deployment)/i.test(lower)) {
    return sanitizeC4Diagram(sanitized);
  }

  // ── flowchart / graph 专项修复 ──
  if (lower.startsWith('flowchart') || lower.startsWith('graph')) {
    return sanitizeFlowchart(sanitized);
  }

  // ── sequenceDiagram 专项修复 ──
  if (lower.startsWith('sequencediagram')) {
    return sanitizeSequenceDiagram(sanitized);
  }

  // ── erDiagram 专项修复 ──
  if (lower.startsWith('erdiagram')) {
    return sanitizeErDiagram(sanitized);
  }

  return sanitized;
}

/**
 * 预处理 sequenceDiagram，修复 LLM 常见错误。
 * - 给包含特殊字符的 participant / actor 别名加双引号
 */
function sanitizeSequenceDiagram(code: string): string {
  const lines = code.split('\n');
  const out: string[] = [];

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      out.push('');
      continue;
    }

    // participant / actor 别名修复
    const participantMatch = trimmed.match(/^(participant|actor)\s+(\w+)\s+as\s+(.+)$/);
    if (participantMatch) {
      const [, type, id, rawAlias] = participantMatch;
      let alias = rawAlias.trim();
      // 如果别名已被引号包裹，去掉外层统一处理
      if (/^".*"$/.test(alias)) { alias = alias.slice(1, -1); }
      else if (/^'.*'$/.test(alias)) { alias = alias.slice(1, -1); }
      out.push(`    ${type} ${id} as "${alias}"`);
      continue;
    }

    out.push(raw);
  }

  return out.join('\n');
}

/**
 * 预处理 erDiagram，修复 LLM 常见错误。
 * - 保留 entity body（旧实现会全部删除导致图失效）
 * - 修复属性行可能的 name: type 顺序
 * - 修复关系标签引号
 */
function sanitizeErDiagram(code: string): string {
  const lines = code.split('\n');
  const out: string[] = [];
  let insideEntity = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      out.push('');
      continue;
    }

    // erDiagram 声明
    if (/^erDiagram$/i.test(trimmed)) {
      out.push('erDiagram');
      continue;
    }

    // 关系行：A rel B : "label"
    const relMatch = trimmed.match(
      /^([\w]+)\s+([|o}{]{1,2}(?:--|\.\.)[|o|}{]{1,2})\s+([\w]+)\s*(?::\s*(.+))?$/,
    );
    if (relMatch) {
      const [, from, rel, to, rawLabel] = relMatch;
      const label = rawLabel ? rawLabel.trim().replace(/^["']|["']$/g, '') : '';
      const labelPart = label ? ` : "${label}"` : '';
      out.push(`    ${from} ${rel} ${to}${labelPart}`);
      continue;
    }

    // entity 头行
    if (/^[\w]+\s*\{$/.test(trimmed)) {
      insideEntity = true;
      out.push(raw);
      continue;
    }

    // entity 结束行
    if (trimmed === '}') {
      insideEntity = false;
      out.push(raw);
      continue;
    }

    // entity 属性行：修复 name: type 为 type name
    if (insideEntity) {
      const attrMatch = trimmed.match(/^[\w_]+\s*:\s*[\w()\[\]]+/);
      if (attrMatch) {
        const parts = trimmed.split(/\s*:\s*/);
        if (parts.length >= 2) {
          const name = parts[0].trim();
          const rest = parts.slice(1).join(':');
          const [type, ...descriptors] = rest.trim().split(/\s+/);
          const comment = rest.includes('"') ? rest.replace(/^[^"]+/, '').trim() : '';
          const main = `${type} ${name}`;
          out.push(`        ${main}${descriptors.length ? ' ' + descriptors.filter(d => !d.includes('"')).join(' ') : ''}${comment ? ' ' + comment : ''}`);
          continue;
        }
      }
    }

    out.push(raw);
  }

  return out.join('\n');
}

/** 规范化字符串参数：把中文引号/单引号统一为双引号，并做简单转义 */
function normalizeC4Arg(arg: string): string {
  const trimmed = arg.trim();
  // 已经是双引号
  if (/^".*"$/.test(trimmed)) {
    const inner = trimmed.slice(1, -1).replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    return `"${inner}"`;
  }
  // 单引号包裹
  if (/^'.*'$/.test(trimmed)) {
    return `"${trimmed.slice(1, -1).replace(/"/g, '\\"')}"`;
  }
  // 中文引号包裹
  if (/^[“”].*[“”]$/.test(trimmed)) {
    return `"${trimmed.slice(1, -1).replace(/"/g, '\\"')}"`;
  }
  // 数字或合法标识符保持原样
  if (/^(\d+|[A-Za-z_][A-Za-z0-9_]*)$/.test(trimmed)) {
    return trimmed;
  }
  // 其他内容强制加双引号
  return `"${trimmed.replace(/"/g, '\\"')}"`;
}

/** 按逗号拆分 C4 宏参数，忽略引号内的逗号 */
function parseC4Args(argsStr: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoteChar = '';
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (!quoteChar && (ch === '"' || ch === "'" || ch === '“' || ch === '”')) {
      quoteChar = ch;
      current += ch;
    } else if (quoteChar && ch === quoteChar) {
      quoteChar = '';
      current += ch;
    } else if (!quoteChar && ch === ',') {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/** 修复 C4 图常见 LLM 语法错误 */
function sanitizeC4Diagram(code: string): string {
  const lines = code.split('\n');
  const out: string[] = [];

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // 图类型声明：统一为首字母大写的标准写法
    const typeMatch = trimmed.match(/^c4(context|container|component|dynamic|deployment)$/i);
    if (typeMatch) {
      out.push(`C4${typeMatch[1][0].toUpperCase()}${typeMatch[1].slice(1)}`);
      continue;
    }

    // title 行
    if (trimmed.toLowerCase().startsWith('title ')) {
      const rest = trimmed.slice(6).trim();
      out.push(`  title ${normalizeC4Arg(rest)}`);
      continue;
    }

    // C4 宏调用：Person, System, Rel, Boundary 等
    const macroMatch = trimmed.match(
      /^(Person(?:_Ext)?|System(?:_Ext|Db|Queue)?|Container(?:_Ext|Db|Queue)?|Component(?:_Ext)?|Enterprise_Boundary|System_Boundary|Boundary|Rel(?:_U|_D|_L|_R)?|UpdateElementStyle|UpdateBoundaryStyle|UpdateRelStyle)\s*\((.*)\)\s*(\{?)\s*$/,
    );
    if (macroMatch) {
      const [, macro, argsStr, brace] = macroMatch;
      const args = parseC4Args(argsStr).map(normalizeC4Arg);
      out.push(`  ${macro}(${args.join(', ')})${brace || ''}`);
      continue;
    }

    // 单独的大括号
    if (trimmed === '{' || trimmed === '}') {
      out.push(`  ${trimmed}`);
      continue;
    }

    // 注释保留
    if (trimmed.startsWith('%%')) {
      out.push(raw);
      continue;
    }

    // 无法识别的行直接丢弃，避免污染语法
    out.push(raw);
  }

  return out.join('\n');
}

/**
 * 预处理 flowchart / graph 语法，修复 LLM 常见错误。
 * - 移除对 subgraph 的 style 指令（subgraph 不支持 style）
 * - 将 subgraph style 转为 classDef + class
 * - 给包含特殊字符的边标签加引号
 * - 将边标签中的 \\n 转为 <br/>
 * - 将节点标签中的 \\n 转为 <br/>
 */
function sanitizeFlowchart(code: string): string {
  const lines = code.split('\n');
  const out: string[] = [];
  const subgraphNames = new Set<string>();

  // 第一遍：收集 subgraph 名
  for (const raw of lines) {
    const trimmed = raw.trim();
    const subMatch = trimmed.match(/^subgraph\s+(\w+)\s*(?:\[.*?\])?\s*$/);
    if (subMatch) {
      subgraphNames.add(subMatch[1]);
    }
  }

  // 修复节点标签中的字面量 \\n（不是实际换行符，是 LLM 输出的 "\\n"）
  const fixNodeLabel = (raw: string): string =>
    raw.replace(/\[(".*?")\]/g, (_, inner: string) => {
      // inner 是双引号包着的内容
      const content = inner.slice(1, -1).replace(/\\n/g, '<br/>');
      return `["${content}"]`;
    });

  // 第二遍：处理每一行
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) {
      out.push('');
      continue;
    }

    // 修复 Direction → direction（Mermaid 10.x 要求小写）
    line = line.replace(/^Direction\b/i, 'direction');

    // style 指令 —— 检查目标是否为 subgraph
    const styleMatch = line.match(/^style\s+(\w+)\s+(.+)$/);
    if (styleMatch) {
      const [, targetId, styleProps] = styleMatch;
      if (subgraphNames.has(targetId)) {
        // subgraph 不能用 style，转为 classDef + class
        const props = styleProps.split(',').map((s: string) => s.trim());
        const className = `cls_${targetId}`;
        out.push(`    classDef ${className} ${props.join(',')}`);
        out.push(`    class ${targetId} ${className}`);
        continue;
      }
      // 正常节点 style，保留
      out.push(line);
      continue;
    }

    // 边定义：-->|label| , -->|"label"| 等
    const edgePattern = /^(.+?)(-->|==>|---|===|-\.-)\|(.+)\|\s*(.+?)\s*$/;
    const edgeMatch = line.match(edgePattern);
    if (edgeMatch) {
      const [, from, arrow, rawLabel, to] = edgeMatch;
      let label = rawLabel.trim();

      // 去掉已有的外层引号
      if (/^".*"$/.test(label)) { label = label.slice(1, -1); }
      else if (/^'.*'$/.test(label)) { label = label.slice(1, -1); }

      // \\n → <br/>
      label = label.replace(/\\n/g, '<br/>');

      // 节点标签中的 \\n 也修复
      const fixedFrom = fixNodeLabel(from.trim());
      const fixedTo = fixNodeLabel(to.trim());

      // 统一用双引号包裹边标签
      out.push(`    ${fixedFrom} ${arrow}|"${label}"| ${fixedTo}`);
      continue;
    }

    // 普通节点行：修复节点标签中的 \\n
    out.push(fixNodeLabel(line));
  }

  return out.join('\n');
}

/** 当 C4 图仍然无法渲染时，降级为稳定的 flowchart TB */
function c4DiagramToFlowchart(code: string): string {
  const lines = code.split('\n');
  const nodes: string[] = [];
  const edges: string[] = [];
  const boundaryStack: string[] = [];
  let title = '';

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    if (trimmed.toLowerCase().startsWith('title ')) {
      title = trimmed.slice(6).trim().replace(/^["']|["']$/g, '');
      continue;
    }
    if (/^C4/i.test(trimmed) && !/^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(trimmed)) continue;

    const macroMatch = trimmed.match(
      /^(Person(?:_Ext)?|System(?:_Ext|Db|Queue)?|Container(?:_Ext|Db|Queue)?|Component(?:_Ext)?|Enterprise_Boundary|System_Boundary|Boundary|Rel(?:_U|_D|_L|_R)?)\s*\((.*)\)\s*(\{?)\s*$/,
    );
    if (macroMatch) {
      const [, macro, argsStr, brace] = macroMatch;
      const args = parseC4Args(argsStr).map((a) =>
        a.trim().replace(/^["'“”]|["'“”]$/g, '').replace(/"/g, '\\"'),
      );

      if (macro.includes('Boundary')) {
        boundaryStack.push(args[0]);
        nodes.push(`    subgraph ${args[0]}["${args[1] || args[0]}"]`);
      } else if (macro.startsWith('Rel')) {
        edges.push(`    ${args[0]} -->|"${args[2] || ''}${args[3] ? ` (${args[3]})` : ''}"| ${args[1]}`);
      } else {
        const alias = args[0];
        const label = args[1] || alias;
        const desc = args[2] ? `\\n${args[2]}` : '';
        nodes.push(`    ${alias}["${label}${desc}"]`);
      }
      continue;
    }

    // C4 边界的大括号可能单独成行；subgraph 已在边界宏处开启，故忽略单独的 '{'
    if (trimmed === '{') continue;

    if (trimmed === '}') {
      if (boundaryStack.length > 0) {
        boundaryStack.pop();
        nodes.push(`    end`);
      }
      continue;
    }
  }

  return `flowchart TB\n${title ? `    subgraph _["${title}"]\n` : ''}${nodes.join('\n')}\n${edges.join('\n')}${title ? '\n    end' : ''}`;
}

interface Props {
  projectId: string;
  taskId: string;
  docType: DocType;
  downloadUrl?: string;
}

/** Mermaid 图表渲染组件：严格模式客户端渲染，失败时显示源代码。 */
const MermaidBlock: React.FC<{ code: string }> = ({ code }) => {
  const [svg, setSvg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSvg(null);

    const id = `mermaid-${Math.random().toString(36).slice(2, 8)}`;
    const sanitized = sanitizeMermaid(code);

    renderMermaid(id, sanitized)
      .then((rendered) => {
        if (!cancelled) { setSvg(rendered); setLoading(false); }
      })
      .catch((err: any) => {
        console.warn('Mermaid client render failed:', err?.message);
        if (cancelled) return;
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [code]);

  // 加载中
  if (loading) {
    return <div style={{ textAlign: 'center', padding: 24 }}><Spin size="small" /></div>;
  }

  // 客户端渲染成功
  if (svg) {
    return (
      <div style={{ background: '#fafafa', padding: 16, borderRadius: 8, border: '1px solid #e8e8e8', marginBottom: 16, overflow: 'auto', textAlign: 'center' }}>
        <img
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          alt="Mermaid 图表"
          style={{ maxWidth: '100%' }}
        />
      </div>
    );
  }

  // 最终降级：代码块 + Mermaid Live Editor 链接
  let liveUrl = '';
  try {
    liveUrl = `https://mermaid.live/edit#base64:${btoa(unescape(encodeURIComponent(code)))}`;
  } catch { liveUrl = 'https://mermaid.live'; }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ background: '#f6f8fa', borderRadius: 8, border: '1px solid #e1e4e8', overflow: 'hidden' }}>
        <div style={{ background: '#f0f0f0', padding: '8px 12px', fontSize: 12, color: '#666', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Mermaid 图表源代码</span>
          {liveUrl && (
            <a href={liveUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
              在 Mermaid Live Editor 中查看 →
            </a>
          )}
        </div>
        <pre style={{ margin: 0, padding: 12, fontSize: 12, lineHeight: 1.6, overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {code}
        </pre>
      </div>
    </div>
  );
};

const DocumentPreview: React.FC<Props> = ({ projectId, taskId, docType, downloadUrl }) => {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = () => {
    if (!content) return;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${docType.toLowerCase()}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  useEffect(() => {
    setLoading(true);
    setError(null);
    documentApi
      .preview(projectId, taskId, docType)
      .then((res) => {
        setContent(res.data.content);
      })
      .catch((err) => {
        setError(err.response?.data?.message || '加载失败');
      })
      .finally(() => setLoading(false));
  }, [projectId, taskId, docType]);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <Spin />
        <p>加载文档中...</p>
      </div>
    );
  }

  if (error) {
    return <Empty description={error} />;
  }

  if (!content) {
    return <Empty description="文档为空" />;
  }

  // 所有文档统一用 Markdown 渲染（含 Mermaid、代码高亮）
  const docLabels: Record<DocType, string> = {
    TECH_STACK: '技术栈选型',
    MODULE_DESIGN: '技术架构文档',
    API_CONTRACT: '接口文档',
    DATA_MODEL: '数据库文档',
  };

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={5} style={{ margin: 0 }}>
          <CodeOutlined /> {docLabels[docType]}
        </Title>
        {downloadUrl && (
          <Button
            type="primary"
            icon={<DownloadOutlined />}
            onClick={handleDownload}
            disabled={!content}
          >
            下载文件
          </Button>
        )}
      </div>

      <div
        style={{
          background: '#fff',
          border: '1px solid #f0f0f0',
          borderRadius: 8,
          padding: 24,
          maxHeight: 600,
          overflow: 'auto',
        }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '');
              const codeStr = String(children).replace(/\n$/, '');
              const inline = !match;

              if (!inline && match?.[1] === 'mermaid') {
                return <MermaidBlock code={codeStr} />;
              }

              if (!inline && match) {
                return (
                  <SyntaxHighlighter
                    style={oneLight}
                    language={match[1]}
                    PreTag="div"
                    showLineNumbers
                    customStyle={{ borderRadius: 8, fontSize: 13 }}
                  >
                    {codeStr}
                  </SyntaxHighlighter>
                );
              }

              return (
                <code {...props} className={className} style={{ background: '#f5f5f5', padding: '2px 6px', borderRadius: 4 }}>
                  {children}
                </code>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
};

export default DocumentPreview;
