import React, { useState, useEffect, useCallback } from 'react';
import {
  Layout, Menu, Typography, Spin, Empty, Button, Space, Badge, Tooltip, theme,
  ConfigProvider, Card, Row, Col, Statistic, Tag, Input, Segmented,
} from 'antd';
import {
  UploadOutlined, FileTextOutlined, CodeOutlined, CheckCircleOutlined,
  ClockCircleOutlined, ExclamationCircleOutlined, PlusOutlined,
  SearchOutlined, ReloadOutlined, FolderOpenOutlined, ProjectOutlined,
  SettingOutlined, BarsOutlined, AppstoreOutlined,
} from '@ant-design/icons';
import { taskApi } from './services/api';

const PrdUpload = React.lazy(() => import('./pages/PrdUpload'));
const ProjectDetail = React.lazy(() => import('./pages/ProjectDetail'));

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;

const PROJECT_ID_KEY = 'fastcode_active_project';

interface ProjectItem {
  id: string;
  name: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const STATUS_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  PENDING:         { label: '等待中', color: 'default', icon: <ClockCircleOutlined /> },
  GENERATING:     { label: '文档生成中', color: 'processing', icon: <FileTextOutlined /> },
  PENDING_REVIEW: { label: '待审批', color: 'warning', icon: <ExclamationCircleOutlined /> },
  DEVELOPING:     { label: '代码开发中', color: 'processing', icon: <CodeOutlined /> },
  VALIDATING:     { label: '验证中', color: 'processing', icon: <CodeOutlined /> },
  REWORKING:      { label: '返修中', color: 'warning', icon: <ExclamationCircleOutlined /> },
  HUMAN_REVIEW:   { label: '待最终审核', color: 'warning', icon: <ExclamationCircleOutlined /> },
  APPROVED:       { label: '已通过', color: 'success', icon: <CheckCircleOutlined /> },
  REJECTED:       { label: '已驳回', color: 'error', icon: <ExclamationCircleOutlined /> },
  FAILED:         { label: '失败', color: 'error', icon: <ExclamationCircleOutlined /> },
};

const App: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false);
  const [currentPage, setCurrentPage] = useState<'dashboard' | 'upload' | 'project'>('dashboard');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    () => localStorage.getItem(PROJECT_ID_KEY) || null,
  );
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');

  const setAndPersistProjectId = (id: string | null) => {
    setActiveProjectId(id);
    if (id) {
      localStorage.setItem(PROJECT_ID_KEY, id);
    } else {
      localStorage.removeItem(PROJECT_ID_KEY);
    }
  };

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const res = await taskApi.getProjects();
      setProjects(res.data || []);
    } catch {
      // silent
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  useEffect(() => {
    if (activeProjectId) {
      setCurrentPage('project');
    }
  }, [activeProjectId]);

  const validProject = projects.find((p) => p.id === activeProjectId);

  const handleProjectCreated = (projectId: string) => {
    setAndPersistProjectId(projectId);
    setCurrentPage('project');
    setTimeout(() => loadProjects(), 2000);
  };

  const filteredProjects = projects.filter(p =>
    !searchText || p.name.toLowerCase().includes(searchText.toLowerCase())
  );

  const ProjectCard = ({ p }: { p: ProjectItem }) => {
    const meta = STATUS_META[p.status] || { label: p.status, color: 'default', icon: null };
    return (
      <Badge.Ribbon text={meta.label} color={meta.color === 'processing' ? 'blue' : meta.color === 'warning' ? 'orange' : meta.color === 'success' ? 'green' : meta.color === 'error' ? 'red' : undefined}>
        <Card
          hoverable
          size="small"
          style={{ marginBottom: 16, borderRadius: 12, overflow: 'hidden' }}
          onClick={() => {
            setAndPersistProjectId(p.id);
            setCurrentPage('project');
          }}
        >
          <Space direction="vertical" style={{ width: '100%' }} size={4}>
            <Text strong ellipsis style={{ fontSize: 14 }}>{p.name}</Text>
            <Space size={4}>
              <Tag>v{p.version}</Tag>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {new Date(p.createdAt).toLocaleDateString()}
              </Text>
            </Space>
          </Space>
        </Card>
      </Badge.Ribbon>
    );
  };

  const menuItems = [
    { key: 'dashboard', icon: <AppstoreOutlined />, label: '仪表盘' },
    { key: 'upload', icon: <UploadOutlined />, label: '新建项目' },
  ];

  if (projects.length > 0) {
    menuItems.push({
      type: 'group',
      key: 'projects-group',
      label: '最近项目',
      children: projects.slice(0, 8).map((p) => ({
        key: `project-${p.id}`,
        icon: <FolderOpenOutlined />,
        label: p.name,
      })),
    } as any);
  }

  const handleMenuClick = ({ key }: { key: string }) => {
    if (key === 'dashboard') { setCurrentPage('dashboard'); setAndPersistProjectId(null); }
    else if (key === 'upload') { setCurrentPage('upload'); }
    else if (key.startsWith('project-')) {
      const pid = key.replace('project-', '');
      setAndPersistProjectId(pid);
      setCurrentPage('project');
    }
  };

  const renderContent = () => {
    if (currentPage === 'upload') {
      return <PrdUpload onCreated={handleProjectCreated} />;
    }
    if (currentPage === 'project' && validProject && activeProjectId) {
      return (
        <ProjectDetail
          projectId={activeProjectId}
          onBack={() => { setCurrentPage('dashboard'); setAndPersistProjectId(null); }}
        />
      );
    }
    if (currentPage === 'project' && !activeProjectId && projects.length === 0) {
      return (
        <div style={{ textAlign: 'center', padding: 80, color: '#999' }}>
          <ProjectOutlined style={{ fontSize: 64, marginBottom: 16 }} />
          <p>请先上传 PRD 创建项目</p>
          <Button type="primary" onClick={() => setCurrentPage('upload')}>新建项目</Button>
        </div>
      );
    }
    return renderDashboard();
  };

  const renderDashboard = () => (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <Row gutter={24} align="middle">
          <Col flex="auto">
            <Title level={4} style={{ margin: 0 }}>项目列表</Title>
            <Text type="secondary">共 {projects.length} 个项目</Text>
          </Col>
          <Col>
            <Space>
              <Input
                prefix={<SearchOutlined />}
                placeholder="搜索项目..."
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                style={{ width: 200 }}
                allowClear
              />
              <Segmented
                value={viewMode}
                onChange={v => setViewMode(v as any)}
                options={[
                  { value: 'card', icon: <AppstoreOutlined /> },
                  { value: 'list', icon: <BarsOutlined /> },
                ]}
              />
              <Button icon={<ReloadOutlined />} onClick={loadProjects}>刷新</Button>
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCurrentPage('upload')}>
                新建项目
              </Button>
            </Space>
          </Col>
        </Row>
      </div>

      {projectsLoading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
      ) : filteredProjects.length === 0 ? (
        <Card style={{ textAlign: 'center', padding: 40 }}>
          <Empty description={searchText ? '没有匹配的项目' : '暂无项目，请先创建'} />
        </Card>
      ) : viewMode === 'card' ? (
        <Row gutter={[16, 16]}>
          {filteredProjects.map(p => (
            <Col key={p.id} xs={24} sm={12} md={8} lg={6}>
              <ProjectCard p={p} />
            </Col>
          ))}
        </Row>
      ) : (
        <Card>
          {filteredProjects.map(p => {
            const meta = STATUS_META[p.status] || { label: p.status, color: 'default', icon: null };
            return (
              <div
                key={p.id}
                onClick={() => { setAndPersistProjectId(p.id); setCurrentPage('project'); }}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '12px 16px', cursor: 'pointer', borderRadius: 8,
                  borderBottom: '1px solid #f0f0f0', transition: 'background 0.2s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f5')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <Space>
                  <FolderOpenOutlined style={{ fontSize: 18, color: '#1677ff' }} />
                  <div>
                    <Text strong>{p.name}</Text>
                    <div><Text type="secondary" style={{ fontSize: 12 }}>v{p.version} · {new Date(p.createdAt).toLocaleString()}</Text></div>
                  </div>
                </Space>
                <Tag color={meta.color === 'processing' ? 'blue' : meta.color === 'warning' ? 'orange' : meta.color === 'success' ? 'green' : meta.color === 'error' ? 'red' : undefined}>
                  {meta.icon} {meta.label}
                </Tag>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', background: '#001529', padding: '0 24px', position: 'sticky', top: 0, zIndex: 100 }}>
        <Title level={4} style={{ color: '#fff', margin: 0, whiteSpace: 'nowrap' }}>
          FastCode
        </Title>
        <Text style={{ color: '#ffffff88', marginLeft: 12, fontSize: 13 }}>代码全流程生成平台</Text>
        <div style={{ flex: 1 }} />
        <Space>
          <Tooltip title="项目数">
            <Badge count={projects.length} size="small" style={{ backgroundColor: '#1677ff' }}>
              <Button type="text" icon={<ProjectOutlined />} style={{ color: '#fff' }} />
            </Badge>
          </Tooltip>
        </Space>
      </Header>
      <Layout>
        <Sider
          width={200}
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          style={{
            position: 'sticky',
            top: 64,
            alignSelf: 'flex-start',
            height: 'calc(100vh - 64px)',
            overflow: 'auto',
            background: '#fff',
            borderRight: '1px solid #f0f0f0',
            zIndex: 90,
          }}
        >
          <Menu
            mode="inline"
            selectedKeys={[currentPage === 'dashboard' ? 'dashboard' : currentPage === 'upload' ? 'upload' : activeProjectId ? `project-${activeProjectId}` : 'dashboard']}
            style={{ height: '100%', borderRight: 0 }}
            onClick={handleMenuClick}
            items={menuItems}
          />
        </Sider>
        <Content style={{ padding: 24, background: '#f5f5f5', minHeight: 'calc(100vh - 64px)', overflow: 'auto' }}>
          <React.Suspense fallback={<div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>}>
            {renderContent()}
          </React.Suspense>
        </Content>
      </Layout>
    </Layout>
  );
};

export default App;
