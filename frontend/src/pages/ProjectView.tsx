import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Tag, Tabs, Spin, Alert, Descriptions, Space, Typography, Empty, Divider, Steps, Button,
} from 'antd';
import {
  CheckCircleOutlined, CloseCircleOutlined,
  LoadingOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { Project, DocType, STATUS_LABELS, STATUS_COLORS } from '../types';
import { taskApi } from '../services/api';
import DocumentPreview from '../components/DocumentPreview';
import ApprovalPanel from '../components/ApprovalPanel';
import DevelopmentProgress from '../components/DevelopmentProgress';
import ValidationResults from '../components/ValidationResults';
import ReworkStatus from '../components/ReworkStatus';
import FinalReviewPanel from '../components/FinalReviewPanel';

const { Title, Text } = Typography;

interface Props {
  projectId: string;
}

interface ThinkingStep {
  step: number;
  total: number;
  title: string;
  thought: string;
  status: 'pending' | 'running' | 'done';
  timestamp: string;
}

const STEP_TITLES = [
  '解析 PRD 核心需求',
  '技术栈选型',
  '技术架构设计',
  '接口设计',
  '数据库设计',
];

function parseThinking(thinking?: string): ThinkingStep[] {
  if (!thinking) return [];
  try {
    const parsed = JSON.parse(thinking) as ThinkingStep[];
    return parsed.sort((a, b) => a.step - b.step);
  } catch {
    return [];
  }
}

function buildSteps(thinking?: string): ThinkingStep[] {
  const saved = parseThinking(thinking);
  return STEP_TITLES.map((title, idx) => {
    const stepNum = idx + 1;
    const savedStep = saved.find((s) => s.step === stepNum);
    if (savedStep) return savedStep;
    return {
      step: stepNum,
      total: STEP_TITLES.length,
      title,
      thought: '',
      status: 'pending',
      timestamp: '',
    };
  });
}

const ProjectView: React.FC<Props> = ({ projectId }) => {
  const [project, setProject] = useState<Project | null>(null);
  const [fullProject, setFullProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [fullLoading, setFullLoading] = useState(false);
  const [reviewActiveTab, setReviewActiveTab] = useState<DocType>('MODULE_DESIGN');

  const fetchStatus = useCallback(async () => {
    try {
      const res = await taskApi.getStatus(projectId);
      setProject(res.data);
    } catch (err) {
      console.error('获取状态失败', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const fetchFullStatus = useCallback(async () => {
    setFullLoading(true);
    try {
      const res = await taskApi.getFullStatus(projectId);
      setFullProject(res.data);
    } catch (err) {
      console.error('获取完整状态失败', err);
    } finally {
      setFullLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchStatus();
    fetchFullStatus();
    const interval = setInterval(() => {
      if (
        project?.status === 'GENERATING' ||
        project?.status === 'PENDING' ||
        project?.status === 'REJECTED' ||
        project?.status === 'DEVELOPING' ||
        project?.status === 'VALIDATING' ||
        project?.status === 'REWORKING'
      ) {
        fetchStatus();
        fetchFullStatus();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [projectId, project?.status, fetchStatus, fetchFullStatus]);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!project) {
    return <Empty description="项目不存在" />;
  }

  const latestTask = project.tasks?.[0];

  const status = project.status;
  const isGenerating = status === 'GENERATING' || status === 'PENDING' || status === 'REJECTED';
  const isPendingReview = status === 'PENDING_REVIEW';
  const isDeveloping = status === 'DEVELOPING';
  const isValidating = status === 'VALIDATING';
  const isReworking = status === 'REWORKING';
  const isHumanReview = status === 'HUMAN_REVIEW';
  const isApproved = status === 'APPROVED';
  const isFailed = status === 'FAILED';

  const reviewDocTypes: DocType[] = ['MODULE_DESIGN', 'API_CONTRACT', 'DATA_MODEL'];

  const getDoc = (type: DocType) => project.documents?.find((d) => d.docType === type);
  const techStackDoc = getDoc('TECH_STACK');
  const hasReviewDocs = reviewDocTypes.some((t) => getDoc(t));

  const thinkingSteps = buildSteps(latestTask?.thinking);
  const activeStep = thinkingSteps.filter((s) => s.status === 'done').length;

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      {/* 项目信息卡片 */}
      <Card style={{ marginBottom: 16 }}>
        <Descriptions
          title={
            <Space>
              <Title level={4} style={{ margin: 0 }}>📋 {project.name}</Title>
              <Tag color={STATUS_COLORS[status] as any}>
                {STATUS_LABELS[status]}
              </Tag>
              {fullProject && fullProject.iterationCount > 0 && (
                <Tag>迭代 {fullProject.iterationCount}</Tag>
              )}
            </Space>
          }
          column={4}
          size="small"
        >
          <Descriptions.Item label="项目 ID">{project.id}</Descriptions.Item>
          <Descriptions.Item label="版本">v{project.version}</Descriptions.Item>
          <Descriptions.Item label="创建时间">
            {new Date(project.createdAt).toLocaleString()}
          </Descriptions.Item>
          <Descriptions.Item label="更新时间">
            {new Date(project.updatedAt).toLocaleString()}
          </Descriptions.Item>
        </Descriptions>
        <Space style={{ marginTop: 8 }}>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => { fetchStatus(); fetchFullStatus(); }}>
            刷新
          </Button>
        </Space>
      </Card>

      {/* ===== 阶段1: 文档生成中 ===== */}
      {isGenerating && (
        <Card>
          <div style={{ textAlign: 'center', padding: '24px 0 40px' }}>
            <Spin indicator={<LoadingOutlined style={{ fontSize: 48 }} spin />} />
            <p style={{ marginTop: 16, fontSize: 16, color: '#666' }}>
              AI 架构师正在思考并生成设计文档…
            </p>
          </div>
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <Steps
              direction="vertical"
              current={activeStep}
              size="small"
              items={thinkingSteps.map((s) => ({
                title: s.status === 'running' ? (
                  <Space>
                    <Text>{s.title}</Text>
                    <Tag color="processing">进行中</Tag>
                  </Space>
                ) : (
                  <Text delete={s.status === 'done'}>{s.title}</Text>
                ),
                description: (
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    {s.thought || '等待中…'}
                  </Text>
                ),
                icon: s.status === 'done' ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : undefined,
              }))}
            />
          </div>
        </Card>
      )}

      {/* ===== 失败状态 ===== */}
      {isFailed && (
        <Alert
          type="error"
          message="操作失败"
          description={
            <div>
              <p>{latestTask?.errorMsg || '未知错误'}</p>
              <p>请检查错误信息后重试</p>
            </div>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {/* ===== 阶段2: 文档已生成，待审批 ===== */}
      {(isPendingReview || isApproved || status === 'REJECTED') && (
        <>
          {techStackDoc && (
            <Card
              title={<Title level={5} style={{ margin: 0 }}>🛠 技术栈选型</Title>}
              extra={
                <Text type="secondary" style={{ fontSize: 12 }}>📌 仅供参考，不参与审批</Text>
              }
              style={{ marginBottom: 16 }}
            >
              <DocumentPreview
                projectId={project.id}
                taskId={techStackDoc.taskId}
                docType="TECH_STACK"
                downloadUrl={techStackDoc.downloadUrl}
              />
            </Card>
          )}

          {hasReviewDocs && (
            <Card
              title={<Title level={5} style={{ margin: 0 }}>📄 审批文档</Title>}
              extra={
                isPendingReview ? (
                  <ApprovalPanel
                    projectId={project.id}
                    onApproved={fetchStatus}
                    onRejected={fetchStatus}
                  />
                ) : isApproved ? (
                  <Tag color="success" style={{ fontSize: 14, padding: '4px 12px' }}>
                    ✅ 已审批通过
                  </Tag>
                ) : null
              }
            >
              <Tabs
                activeKey={reviewActiveTab}
                onChange={(key) => setReviewActiveTab(key as DocType)}
                items={reviewDocTypes.map((docType) => {
                  const doc = getDoc(docType);
                  return {
                    key: docType,
                    label: docType === 'MODULE_DESIGN' ? '技术架构文档'
                      : docType === 'API_CONTRACT' ? '接口文档'
                      : '数据库文档',
                    children: doc ? (
                      <DocumentPreview
                        projectId={project.id}
                        taskId={doc.taskId}
                        docType={docType}
                        downloadUrl={doc.downloadUrl}
                      />
                    ) : (
                      <Empty description="文档尚未生成" />
                    ),
                  };
                })}
              />

              {isApproved && (
                <Alert
                  type="success"
                  message="✅ 三份架构文档已审批通过"
                  description="技术架构、接口文档、数据库文档已锁定为基线。Worker Agents 将基于此基线进行并行代码开发。"
                  style={{ marginTop: 16 }}
                  showIcon
                />
              )}
            </Card>
          )}
        </>
      )}

      {/* ===== 阶段3: 并行代码开发中 ===== */}
      {(isDeveloping || isReworking) && (
        <Card
          title={
            <Title level={5} style={{ margin: 0 }}>
              🏗️ 并行代码开发
            </Title>
          }
          extra={
            isDeveloping ? (
              <Tag color="processing">前端 + 后端并行生成中</Tag>
            ) : (
              <Tag color="warning">返修重新生成中</Tag>
            )
          }
          style={{ marginBottom: 16 }}
        >
          <DevelopmentProgress
            projectId={projectId}
            codeGens={fullProject?.codeGens || project.codeGens || []}
            loading={fullLoading}
          />
        </Card>
      )}

      {/* ===== 阶段4: 代码验证中 ===== */}
      {(isValidating || isHumanReview) && (
        <Card
          title={
            <Title level={5} style={{ margin: 0 }}>
              🔍 代码验证
            </Title>
          }
          extra={
            isValidating ? (
              <Tag color="processing">功能/安全/性能/UI 多维并行验证</Tag>
            ) : (
              <Tag color="success">验证完成</Tag>
            )
          }
          style={{ marginBottom: 16 }}
        >
          <ValidationResults
            validations={fullProject?.validations || []}
            loading={fullLoading}
          />
        </Card>
      )}

      {/* ===== 阶段5: 返修记录 ===== */}
      {(isReworking || isHumanReview || isValidating) && fullProject?.reworkRecords && fullProject.reworkRecords.length > 0 && (
        <Card
          title={
            <Title level={5} style={{ margin: 0 }}>
              🔄 返修历史
            </Title>
          }
          style={{ marginBottom: 16 }}
        >
          <ReworkStatus
            projectId={projectId}
            reworkRecords={fullProject.reworkRecords}
            currentIteration={fullProject?.iterationCount || 0}
            onReworkTriggered={() => { fetchStatus(); fetchFullStatus(); }}
          />
        </Card>
      )}

      {/* ===== 阶段6: 人工最终审核 ===== */}
      {isHumanReview && (
        <Card
          title={
            <Title level={5} style={{ margin: 0 }}>
              🏁 最终人工审核
            </Title>
          }
          style={{ marginBottom: 16 }}
        >
          <FinalReviewPanel
            projectId={projectId}
            iterationCount={fullProject?.iterationCount || 0}
            onApproved={() => { fetchStatus(); fetchFullStatus(); }}
            onRejected={() => { fetchStatus(); fetchFullStatus(); }}
          />
        </Card>
      )}

      {/* ===== 最终通过状态 ===== */}
      {isApproved && (
        <Alert
          type="success"
          message="🎉 项目全流程完成"
          description={
            <div>
              <p>所有阶段已完成：PRD分析 → 架构设计 → 人工审批 → 代码生成 → 多维验证 → 最终审核</p>
              {fullProject?.iterationCount && fullProject.iterationCount > 0 && (
                <p>共经历 {fullProject.iterationCount} 次迭代</p>
              )}
            </div>
          }
          style={{ marginBottom: 16 }}
          showIcon
        />
      )}

      {/* 审批历史 */}
      {project.approvals && project.approvals.length > 0 && (
        <Card title="📝 审批历史" style={{ marginTop: 16 }}>
          {project.approvals.map((approval) => (
            <div
              key={approval.id}
              style={{
                padding: '12px 16px',
                marginBottom: 8,
                background: approval.action === 'APPROVED' ? '#f6ffed' : '#fff2f0',
                borderRadius: 8,
                border: `1px solid ${approval.action === 'APPROVED' ? '#b7eb8f' : '#ffccc7'}`,
              }}
            >
              <Space>
                {approval.action === 'APPROVED' ? (
                  <CheckCircleOutlined style={{ color: '#52c41a' }} />
                ) : (
                  <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
                )}
                <strong>{approval.reviewer}</strong>
                <Tag color={approval.action === 'APPROVED' ? 'success' : 'error'}>
                  {approval.action === 'APPROVED' ? '通过' : '驳回'}
                </Tag>
                <span style={{ color: '#999' }}>
                  {new Date(approval.createdAt).toLocaleString()}
                </span>
              </Space>
              {approval.comment && (
                <p style={{ marginTop: 8, color: '#666' }}>{approval.comment}</p>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
};

export default ProjectView;
