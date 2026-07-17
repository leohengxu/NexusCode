import React, { useState, useEffect } from 'react';
import {
  Card, Space, Typography, Spin, Empty, Segmented, Modal,
  Input, Tag, Alert,
} from 'antd';
import {
  FolderOutlined, FolderOpenOutlined, FileOutlined,
  CodeOutlined, SearchOutlined,
  FileTextOutlined, JavaScriptOutlined, Html5Outlined,
} from '@ant-design/icons';
import { codegenApi } from '../services/api';
import type { CodeGenRecord } from '../types';

const { Text } = Typography;

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
  language?: string;
  size?: number;
}

interface Props {
  projectId: string;
  codeGens?: CodeGenRecord[];
}

const LANG_ICONS: Record<string, React.ReactNode> = {
  tsx: <CodeOutlined style={{ color: '#3178c6' }} />,
  ts: <CodeOutlined style={{ color: '#3178c6' }} />,
  js: <JavaScriptOutlined style={{ color: '#f7df1e' }} />,
  jsx: <CodeOutlined style={{ color: '#61dafb' }} />,
  css: <Html5Outlined style={{ color: '#1572b6' }} />,
  html: <Html5Outlined style={{ color: '#e34f26' }} />,
  json: <FileTextOutlined style={{ color: '#292929' }} />,
  prisma: <FileTextOutlined style={{ color: '#2d3748' }} />,
  yaml: <FileTextOutlined style={{ color: '#6c5ce7' }} />,
  md: <FileTextOutlined style={{ color: '#083fa1' }} />,
};

function getLangFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return ext;
}

const FileTree: React.FC<{
  nodes: FileNode[];
  depth: number;
  selectedFile: string | null;
  onSelect: (path: string) => void;
}> = ({ nodes, depth, selectedFile, onSelect }) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(depth === 0 ? nodes.filter(n => n.type === 'dir').map(n => n.path) : []));

  const toggle = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div>
      {nodes.map(node => (
        <div key={node.path}>
          {node.type === 'dir' ? (
            <div>
              <div
                onClick={() => toggle(node.path)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
                  cursor: 'pointer', borderRadius: 4, fontSize: 13,
                  paddingLeft: 12 + depth * 16,
                  transition: 'background 0.15s',
                }}
                className="tree-node-hover"
                onMouseEnter={e => (e.currentTarget.style.background = '#f0f0f0')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {expanded.has(node.path) ? (
                  <FolderOpenOutlined style={{ color: '#faad14', fontSize: 14 }} />
                ) : (
                  <FolderOutlined style={{ color: '#faad14', fontSize: 14 }} />
                )}
                <Text style={{ fontSize: 13 }}>{node.name}</Text>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {node.children?.length || 0} items
                </Text>
              </div>
              {expanded.has(node.path) && node.children && (
                <FileTree
                  nodes={node.children}
                  depth={depth + 1}
                  selectedFile={selectedFile}
                  onSelect={onSelect}
                />
              )}
            </div>
          ) : (
            <div
              onClick={() => onSelect(node.path)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px',
                cursor: 'pointer', borderRadius: 4, fontSize: 13,
                paddingLeft: 12 + depth * 16,
                background: selectedFile === node.path ? '#e6f4ff' : 'transparent',
                transition: 'background 0.15s',
              }}
              className="tree-node-hover"
              onMouseEnter={e => {
                if (selectedFile !== node.path) e.currentTarget.style.background = '#f5f5f5';
              }}
              onMouseLeave={e => {
                if (selectedFile !== node.path) e.currentTarget.style.background = 'transparent';
              }}
            >
              {LANG_ICONS[getLangFromPath(node.path)] || <FileOutlined style={{ color: '#999' }} />}
              <Text style={{ fontSize: 13 }}>{node.name}</Text>
              {node.size != null && (
                <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
                  {node.size > 1000 ? `${(node.size / 1000).toFixed(1)}k` : `${node.size}B`}
                </Text>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

const CodeFileTree: React.FC<Props> = ({ projectId, codeGens }) => {
  const [tab, setTab] = useState<'FRONTEND' | 'BACKEND'>('FRONTEND');
  const [tree, setTree] = useState<FileNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [fileModalOpen, setFileModalOpen] = useState(false);
  const [searchText, setSearchText] = useState('');

  const currentCodeGen = codeGens?.filter(c => c.role === tab).sort((a, b) => b.iteration - a.iteration)[0];
  const isRunning = currentCodeGen?.status === 'RUNNING';
  const isFailed = currentCodeGen?.status === 'FAILED';

  const loadTree = async (role: 'FRONTEND' | 'BACKEND') => {
    setLoading(true);
    setSelectedFile(null);
    setFileContent(null);
    try {
      const res = await codegenApi.getTree(projectId, role);
      setTree(res.data.tree || null);
    } catch {
      setTree(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTree(tab);
  }, [tab, projectId]);

  const handleFileSelect = async (filePath: string) => {
    setSelectedFile(filePath);
    setContentLoading(true);
    setFileModalOpen(true);
    try {
      const res = await codegenApi.getFile(projectId, tab, filePath);
      setFileContent(res.data.content || '// 文件为空');
    } catch {
      setFileContent('// 加载失败');
    } finally {
      setContentLoading(false);
    }
  };

  const filterTree = (node: FileNode, query: string): FileNode | null => {
    if (!query) return node;
    if (node.type === 'file') {
      return node.name.toLowerCase().includes(query.toLowerCase()) ? node : null;
    }
    const filteredChildren = (node.children || [])
      .map(c => filterTree(c, query))
      .filter(Boolean) as FileNode[];
    if (filteredChildren.length > 0) {
      return { ...node, children: filteredChildren };
    }
    return node.name.toLowerCase().includes(query.toLowerCase()) ? node : null;
  };

  const displayTree = tree && searchText ? filterTree(tree, searchText) : tree;

  return (
    <Card
      size="small"
      title={
        <Space>
          <CodeOutlined />
          <span>代码目录</span>
        </Space>
      }
      extra={
        <Segmented
          size="small"
          value={tab}
          onChange={v => setTab(v as 'FRONTEND' | 'BACKEND')}
          options={[
            { value: 'FRONTEND', label: '前端' },
            { value: 'BACKEND', label: '后端' },
          ]}
        />
      }
      style={{ borderRadius: 12 }}
      bodyStyle={{ padding: 0 }}
    >
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f0' }}>
        <Input
          size="small"
          prefix={<SearchOutlined />}
          placeholder="搜索文件..."
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          allowClear
        />
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : isRunning ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
          <p style={{ marginTop: 12, color: '#666' }}>代码生成进行中，请稍候...</p>
        </div>
      ) : isFailed ? (
        <Alert type="error" message="代码生成失败"
          description={currentCodeGen?.errorMsg || '未知错误'}
          style={{ margin: 12 }} showIcon />
      ) : !displayTree ? (
        <Empty description="暂无代码文件" style={{ padding: 40 }} />
      ) : (
        <div style={{ maxHeight: 500, overflow: 'auto', padding: '4px 0' }}>
          <FileTree
            nodes={displayTree.children || []}
            depth={0}
            selectedFile={selectedFile}
            onSelect={handleFileSelect}
          />
        </div>
      )}

      <Modal
        title={<Space><CodeOutlined /> {selectedFile}</Space>}
        open={fileModalOpen}
        onCancel={() => setFileModalOpen(false)}
        footer={null}
        width="80%"
        style={{ top: 20 }}
      >
        {contentLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : (
          <pre style={{
            background: '#1e1e1e', color: '#d4d4d4', padding: 16, borderRadius: 8,
            fontSize: 13, maxHeight: '70vh', overflow: 'auto', whiteSpace: 'pre-wrap',
            fontFamily: "'Cascadia Code', 'Fira Code', monospace", lineHeight: 1.6,
          }}>
            {fileContent || '// 无内容'}
          </pre>
        )}
      </Modal>
    </Card>
  );
};

export default CodeFileTree;
