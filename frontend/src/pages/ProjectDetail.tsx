import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card, Tag, Tabs, Spin, Alert, Descriptions, Space, Typography, Empty,
  Button, Steps, Row, Col, Tooltip, Progress, Divider, App,
} from 'antd';
import {
  CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined,
  ReloadOutlined, ArrowLeftOutlined, FileTextOutlined, CodeOutlined,
  SafetyOutlined, ThunderboltOutlined, EyeOutlined, RobotOutlined,
  ExperimentOutlined, UserOutlined, ApiOutlined, DatabaseOutlined,
} from '@ant-design/icons';
import { Project, DocType, ProjectStatus, STATUS_LABELS, STATUS_COLORS } from '../types';
import { taskApi, codegenApi, previewReviewApi, humanReviewApi } from '../services/api';
import { useWebSocket } from '../hooks/useWebSocket';
import DocumentPreview from '../components/DocumentPreview';
import ApprovalPanel from '../components/ApprovalPanel';
import DevelopmentProgress from '../components/DevelopmentProgress';
import ValidationResults from '../components/ValidationResults';
import ReworkStatus from '../components/ReworkStatus';
import FinalReviewPanel from '../components/FinalReviewPanel';
import PreviewReviewPanel from '../components/PreviewReviewPanel';
import CodeFileTree from '../components/CodeFileTree';

const { Title, Text } = Typography;

interface Props {
  projectId: string;
  onBack: () => void;
}

interface ThinkingStep {
  step: number; total: number; title: string; thought: string;
  status: 'pending' | 'running' | 'done'; timestamp: string;
}

const STEP_TITLES = ['解析 PRD', '技术栈选型', '技术架构设计', '接口设计', '数据库设计'];

const PIPELINE_STAGES = [
  { key: 'GENERATING', label: '文档生成', icon: <FileTextOutlined />, color: '#1677ff' },
  { key: 'PENDING_REVIEW', label: '架构审批', icon: <UserOutlined />, color: '#fa8c16' },
  { key: 'DEVELOPING', label: '代码开发', icon: <CodeOutlined />, color: '#722ed1' },
  { key: 'PREVIEW', label: '预览测试', icon: <ExperimentOutlined />, color: '#13c2c2' },
  { key: 'HUMAN_REVIEW', label: '最终审核', icon: <EyeOutlined />, color: '#eb2f96' },
  { key: 'APPROVED', label: '基线发布', icon: <CheckCircleOutlined />, color: '#52c41a' },
];

const STAGE_ORDER: Record<string, number> = {
  PENDING: -1, GENERATING: 0, PENDING_REVIEW: 1, REJECTED: 1,
  DEVELOPING: 2, PREVIEW: 3, REWORKING: 2,
  HUMAN_REVIEW: 4, APPROVED: 5, FAILED: -2,
};

/** 当项目 FAILED 时，根据已有数据推断实际到达的最大阶段，允许用户查看已完成内容 */
function computeRealStage(project: any | null): number {
  if (!project) return 0;
  const hasDocs = project.documents?.length > 0;
  const hasCode = project.codeGens?.length > 0;
  const hasValidations = project.validations?.length > 0;
  // 检查是否有验证结果（而不仅仅是空记录）
  const hasValidationResults = project.validations?.some(
    (v: any) => v.status === 'PASSED' || v.status === 'FAILED' || v.result
  );
  const status = project.status as string;

  if (status === 'APPROVED') return 5;
  if (status === 'HUMAN_REVIEW') return 4;
  if (status === 'PREVIEW' || hasValidationResults || status === 'VALIDATING') return 3;
  if (hasCode) return 2;
  if (hasDocs) return 1;
  if (status === 'GENERATING') return 0;
  return 0;
}

const STAGE_STATUS = {
  PENDING: 'wait', GENERATING: 'process', PENDING_REVIEW: 'process',
  APPROVED: 'finish', REJECTED: 'error', FAILED: 'error',
  DEVELOPING: 'process', PREVIEW: 'process', REWORKING: 'process',
  HUMAN_REVIEW: 'process',
} as Record<string, 'wait' | 'process' | 'finish' | 'error'>;

function parseThinking(thinking?: string): ThinkingStep[] {
  if (!thinking) return [];
  try {
    return JSON.parse(thinking).sort((a: any, b: any) => a.step - b.step);
  } catch { return []; }
}

function buildSteps(thinking?: string): ThinkingStep[] {
  const saved = parseThinking(thinking);
  return STEP_TITLES.map((title, idx) => {
    const s = saved.find((x: any) => x.step === idx + 1);
    return s || { step: idx + 1, total: STEP_TITLES.length, title, thought: '', status: 'pending' as const, timestamp: '' };
  });
}

const ProjectDetail: React.FC<Props> = ({ projectId, onBack }) => {
  const { message } = App.useApp();
  const [project, setProject] = useState<Project | null>(null);
  const [fullProject, setFullProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewActiveTab, setReviewActiveTab] = useState<DocType>('MODULE_DESIGN');
  // 用户可点击 Pipeline 图标查看历史阶段内容
  const [selectedStage, setSelectedStage] = useState<number>(0);
  const isManualNavigation = useRef(false);
  const { on } = useWebSocket(projectId);
  // 请求版本号：轮询与 WS 事件并发触发 fetchData 时，丢弃过期响应避免旧数据覆盖新状态
  const fetchSeqRef = useRef(0);

  const fetchData = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    try {
      const [statusRes, fullRes] = await Promise.all([
        taskApi.getStatus(projectId),
        taskApi.getFullStatus(projectId).catch(() => ({ data: null })),
      ]);
      if (seq !== fetchSeqRef.current) return; // 过期响应丢弃
      setProject(statusRes.data);
      if (fullRes.data) setFullProject(fullRes.data);
    } catch (err) {
      console.error('获取数据失败', err);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    const unsubs: (() => void)[] = [];
    const events = ['status:change', 'thinking:step', 'codegen:progress', 'validation:result', 'error'];
    events.forEach(event => {
      const unsub = on(event, () => fetchData());
      unsubs.push(unsub);
    });
    return () => unsubs.forEach(u => u());
  }, [on, fetchData]);

  // ── 派生值（必须在 early return 之前计算，确保 hooks 顺序一致）──
  const status = project?.status ?? '';
  const realStage = computeRealStage(fullProject || project);
  const currentStageIdx = status === 'FAILED' ? realStage : (STAGE_ORDER[status] ?? -1);

  // 当 status 变化时，自动切到当前阶段（除非用户手动导航到了其他阶段）
  useEffect(() => {
    if (!isManualNavigation.current) {
      const idx = currentStageIdx < 0 ? 0 : currentStageIdx;
      setSelectedStage(idx);
    }
  }, [status, currentStageIdx]);

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;
  if (!project) return <Empty description="项目不存在" />;

  const latestTask = project.tasks?.[0];
  const isGenerating = ['GENERATING', 'PENDING'].includes(status);
  const isPendingReview = status === 'PENDING_REVIEW';
  const isApproved = status === 'APPROVED';
  const isFailed = status === 'FAILED';
  const isDeveloping = status === 'DEVELOPING';
  const isPreview = status === 'PREVIEW';
  const isValidating = status === 'VALIDATING';
  const isReworking = status === 'REWORKING';
  const isHumanReview = status === 'HUMAN_REVIEW';

  const reviewDocTypes: DocType[] = ['MODULE_DESIGN', 'API_CONTRACT', 'DATA_MODEL'];
  const getDoc = (type: DocType) => project.documents?.find(d => d.docType === type);
  const techStackDoc = getDoc('TECH_STACK');
  const hasReviewDocs = reviewDocTypes.some(t => getDoc(t));

  const thinkingSteps = buildSteps(latestTask?.thinking);
  const activeThinkingStep = thinkingSteps.filter(s => s.status === 'done').length;

  const stageItemStatus = (idx: number): 'wait' | 'process' | 'finish' | 'error' => {
    if (isFailed && idx === currentStageIdx) return 'error';
    if (idx < currentStageIdx) return 'finish';
    if (idx === currentStageIdx) return 'process';
    return 'wait';
  };

  /** 用户点击 Pipeline 阶段图标 */
  const handleStageClick = (idx: number) => {
    const maxReached = currentStageIdx < 0 ? 0 : currentStageIdx;
    if (idx <= maxReached) {
      isManualNavigation.current = true;
      setSelectedStage(idx);
    }
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={onBack}>返回</Button>
          <Title level={4} style={{ margin: 0 }}>{project.name}</Title>
          <Tag color={STATUS_COLORS[status as ProjectStatus] as any}>{STATUS_LABELS[status as ProjectStatus]}</Tag>
          {fullProject && fullProject.iterationCount > 0 && <Tag>迭代 {fullProject.iterationCount}</Tag>}
          <Button size="small" icon={<ReloadOutlined />} onClick={fetchData}>刷新</Button>
        </Space>
      </div>

      {/* Pipeline */}
      <Card size="small" style={{ marginBottom: 16, borderRadius: 12 }}>
        <Steps
          current={selectedStage}
          status={isFailed ? 'error' : 'process'}
          size="small"
          style={{ padding: '12px 0' }}
          onChange={handleStageClick}
          items={PIPELINE_STAGES.map((s, idx) => {
            const reached = idx <= (currentStageIdx < 0 ? 0 : currentStageIdx);
            const isActive = idx === selectedStage;
            return {
              title: <Text style={{ fontSize: 12, cursor: reached ? 'pointer' : 'not-allowed', fontWeight: isActive ? 600 : 400, color: isActive ? s.color : undefined }}>{s.label}</Text>,
              status: stageItemStatus(idx),
              icon: <span style={{ color: stageItemStatus(idx) === 'finish' ? '#52c41a' : stageItemStatus(idx) === 'process' ? s.color : undefined, cursor: reached ? 'pointer' : 'not-allowed' }}>{s.icon}</span>,
              disabled: !reached,
            };
          })}
        />
        {selectedStage !== (currentStageIdx < 0 ? 0 : currentStageIdx) && (
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              📌 正在查看历史阶段「{PIPELINE_STAGES[selectedStage]?.label}」
              <Button type="link" size="small" onClick={() => { isManualNavigation.current = false; setSelectedStage(currentStageIdx < 0 ? 0 : currentStageIdx); }}>
                回到当前阶段
              </Button>
            </Text>
          </div>
        )}
      </Card>

      {/* Project Info */}
      <Card size="small" style={{ marginBottom: 16, borderRadius: 12 }}>
        <Row gutter={24}>
          <Col span={6}><Text type="secondary">项目ID</Text><div><Text code style={{ fontSize: 11 }}>{project.id}</Text></div></Col>
          <Col span={6}><Text type="secondary">版本</Text><div><Text strong>v{project.version}</Text></div></Col>
          <Col span={6}><Text type="secondary">创建时间</Text><div><Text>{new Date(project.createdAt).toLocaleString()}</Text></div></Col>
          <Col span={6}><Text type="secondary">更新时间</Text><div><Text>{new Date(project.updatedAt).toLocaleString()}</Text></div></Col>
        </Row>
      </Card>

      {/* Stage 1: 文档生成 */}
      {(selectedStage === 0 && (isGenerating || thinkingSteps.length > 0)) && (
        <Card style={{ marginBottom: 16, borderRadius: 12 }}>
          {isGenerating ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <Spin indicator={<LoadingOutlined style={{ fontSize: 48 }} spin />} />
              <p style={{ marginTop: 16, fontSize: 16, color: '#666' }}>AI 架构师正在思考并生成设计文档…</p>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <CheckCircleOutlined style={{ fontSize: 32, color: '#52c41a' }} />
              <p style={{ marginTop: 8, fontSize: 14, color: '#52c41a' }}>文档已生成完成</p>
            </div>
          )}
          <div style={{ maxWidth: 600, margin: '0 auto' }}>
            <Steps
              direction="vertical"
              current={activeThinkingStep}
              size="small"
              items={thinkingSteps.map(s => ({
                title: s.status === 'running' ? <Space><Text>{s.title}</Text><Tag color="processing">进行中</Tag></Space>
                  : <Text delete={s.status === 'done'}>{s.title}</Text>,
                description: <Text type="secondary" style={{ fontSize: 13 }}>{s.thought || '等待中…'}</Text>,
                icon: s.status === 'done' ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : undefined,
              }))}
            />
          </div>
        </Card>
      )}

      {isFailed && (
        <Alert type="error" message="操作失败"
          description={
            latestTask?.errorMsg
            || fullProject?.validations?.find(v => v.status === 'FAILED')?.comments
            || fullProject?.codeGens?.find(c => c.status === 'FAILED')?.errorMsg
            || '未知错误，请重试'
          }
          style={{ marginBottom: 16 }} showIcon />
      )}

      {/* Stage 2: 文档审批 */}
      {selectedStage === 1 && (hasReviewDocs || techStackDoc) && (
        <>
          {techStackDoc && (
            <Card title={<Space><RobotOutlined /> 技术栈选型</Space>}
              extra={<Text type="secondary" style={{ fontSize: 12 }}>仅供参考，不参与审批</Text>}
              size="small" style={{ marginBottom: 16, borderRadius: 12 }}>
              <DocumentPreview projectId={project.id} taskId={techStackDoc.taskId} docType="TECH_STACK" downloadUrl={techStackDoc.downloadUrl} />
            </Card>
          )}
          {hasReviewDocs && (
            <Card title={<Space><FileTextOutlined /> 架构设计文档审批</Space>}
              extra={isPendingReview ? <ApprovalPanel projectId={project.id} onApproved={fetchData} onRejected={fetchData} />
                : <Tag color="success" style={{ fontSize: 14, padding: '4px 12px' }}>✅ 已审批通过，代码生成已启动</Tag>}
              size="small" style={{ marginBottom: 16, borderRadius: 12 }}>
              <Tabs activeKey={reviewActiveTab} onChange={k => setReviewActiveTab(k as DocType)}
                items={reviewDocTypes.map(docType => ({
                  key: docType,
                  label: <span>{docType === 'MODULE_DESIGN' ? <ApiOutlined /> : docType === 'API_CONTRACT' ? <CodeOutlined /> : <DatabaseOutlined />} {docType === 'MODULE_DESIGN' ? '技术架构' : docType === 'API_CONTRACT' ? '接口文档' : '数据模型'}</span>,
                  children: getDoc(docType)
                    ? <DocumentPreview projectId={project.id} taskId={getDoc(docType)!.taskId} docType={docType} downloadUrl={getDoc(docType)!.downloadUrl} />
                    : <Empty description="文档尚未生成" />,
                }))}
              />
            </Card>
          )}
        </>
      )}

      {/* Stage 3: 代码开发 */}
      {selectedStage === 2 && (
        <Card title={<Space><CodeOutlined /> 并行代码开发</Space>}
          extra={<Space>{isDeveloping ? <Tag color="processing">生成中</Tag> : isReworking ? <Tag color="warning">返修中</Tag> : <Tag color="success">已完成</Tag>}</Space>}
          size="small" style={{ marginBottom: 16, borderRadius: 12 }}>
          <DevelopmentProgress projectId={projectId} codeGens={fullProject?.codeGens || []} loading={false} />
        </Card>
      )}

      {/* 代码目录（代码生成完成后展示，预览测试阶段由 PreviewReviewPanel 内部展示） */}
      {selectedStage >= 2 && selectedStage !== 3 && (fullProject?.codeGens?.some(c => c.status === 'COMPLETED') || isHumanReview) && (
        <div style={{ marginBottom: 16 }}>
          <CodeFileTree projectId={projectId} codeGens={fullProject?.codeGens} />
        </div>
      )}

      {/* Stage 3: 代码预览测试 */}
      {selectedStage === 3 && (
        <PreviewReviewPanel
          projectId={projectId}
          codeGens={fullProject?.codeGens}
          iterationCount={fullProject?.iterationCount || 0}
          projectStatus={status}
          onApproved={fetchData}
          onRejected={fetchData}
        />
      )}

      {/* Stage 4: 最终审核 + 完成 */}
      {selectedStage === 4 && isHumanReview && (
        <Card title={<Space><EyeOutlined /> 最终人工审核</Space>} size="small" style={{ marginBottom: 16, borderRadius: 12 }}>
          <FinalReviewPanel projectId={projectId} iterationCount={fullProject?.iterationCount || 0}
            onApproved={fetchData} onRejected={fetchData} />
        </Card>
      )}

      {selectedStage === 5 && isApproved && (
        <Alert type="success" message="🎉 项目全流程完成"
          description={<div><p>所有阶段已完成：PRD分析 → 架构设计 → 人工审批 → 代码生成 → 预览测试 → 最终审核</p>{fullProject?.iterationCount ? <p>共经历 {fullProject.iterationCount} 次迭代</p> : null}</div>}
          style={{ marginBottom: 16 }} showIcon />
      )}

      {/* 未来阶段提示 */}
      {selectedStage > (currentStageIdx < 0 ? 0 : currentStageIdx) && (
        <Card style={{ marginBottom: 16, borderRadius: 12 }}>
          <Empty description={`「${PIPELINE_STAGES[selectedStage]?.label}」阶段尚未到达，请等待流程自动推进`} />
        </Card>
      )}

      {/* 返修历史（所有阶段可见，只要有记录就展示） */}
      {fullProject?.reworkRecords && fullProject.reworkRecords.length > 0 && (
        <Card title={<Space><ReloadOutlined /> 返修历史（共 {fullProject.reworkRecords.length} 条，迭代 {fullProject?.iterationCount || 0}）</Space>} size="small" style={{ marginBottom: 16, borderRadius: 12 }}>
          <ReworkStatus projectId={projectId} reworkRecords={fullProject.reworkRecords}
            currentIteration={fullProject?.iterationCount || 0} onReworkTriggered={fetchData} />
        </Card>
      )}

      {/* 审批历史 */}
      {project.approvals && project.approvals.length > 0 && (
        <Card title="📝 审批历史" size="small" style={{ borderRadius: 12 }}>
          {project.approvals.map(a => (
            <div key={a.id} style={{ padding: '8px 12px', marginBottom: 8, background: a.action === 'APPROVED' ? '#f6ffed' : '#fff2f0', borderRadius: 8, border: `1px solid ${a.action === 'APPROVED' ? '#b7eb8f' : '#ffccc7'}` }}>
              <Space>
                {a.action === 'APPROVED' ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : <CloseCircleOutlined style={{ color: '#ff4d4f' }} />}
                <strong>{a.reviewer}</strong>
                <Tag color={a.action === 'APPROVED' ? 'success' : 'error'}>{a.action === 'APPROVED' ? '通过' : '驳回'}</Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>{new Date(a.createdAt).toLocaleString()}</Text>
              </Space>
              {a.comment && <div style={{ marginTop: 4, color: '#666', fontSize: 13 }}>{a.comment}</div>}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
};

export default ProjectDetail;
