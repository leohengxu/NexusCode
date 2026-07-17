import React, { useState, useRef } from 'react';
import {
  Button, Modal, Input, App, Space, Tag, Typography, Card, Divider, Tabs,
} from 'antd';
import {
  CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined,
  EyeOutlined, ExperimentOutlined, CodeOutlined,
} from '@ant-design/icons';
import { previewReviewApi } from '../services/api';
import type { CodeGenRecord } from '../types';
import CodeFileTree from './CodeFileTree';
import LocalPreview from './LocalPreview';

const { Text } = Typography;
const { TextArea } = Input;

interface Props {
  projectId: string;
  codeGens?: CodeGenRecord[];
  iterationCount: number;
  projectStatus: string;
  onApproved: () => void;
  onRejected: () => void;
}

const PreviewReviewPanel: React.FC<Props> = ({ projectId, codeGens, iterationCount, projectStatus, onApproved, onRejected }) => {
  const { message } = App.useApp();
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState('');
  const rejectRef = useRef('');
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'preview' | 'code'>('preview');

  const completedCount = codeGens?.filter(c => c.status === 'COMPLETED').length || 0;
  const failedCount = codeGens?.filter(c => c.status === 'FAILED').length || 0;
  const runningCount = codeGens?.filter(c => c.status === 'RUNNING').length || 0;
  const recoveringFromFailure = projectStatus === 'FAILED';
  const latestFrontendIteration = codeGens
    ?.filter(c => c.role === 'FRONTEND' && c.status === 'COMPLETED')
    .reduce((latest, record) => Math.max(latest, record.iteration), 0) || 0;

  const handleApprove = () => {
    Modal.confirm({
      title: '确认代码预览通过？',
      icon: <ExclamationCircleOutlined />,
      content: '通过后将进入最终审核阶段，由最终审核人确认后发布基线。',
      okText: '确认通过',
      cancelText: '取消',
      onOk: async () => {
        setLoading(true);
        try {
          await previewReviewApi.approve(projectId);
          message.success('预览通过，已进入最终审核！');
          onApproved();
        } catch (err: any) {
          const errMsg = err.response?.data?.message || err.message || '操作失败';
          message.error(errMsg);
        } finally {
          setLoading(false);
        }
      },
    });
  };

  const handleReject = async () => {
    const comment = (rejectComment || rejectRef.current || '').trim();
    if (!comment) {
      message.warning('请填写修改意见');
      return;
    }
    setLoading(true);
    try {
      await previewReviewApi.reject(projectId, comment);
      setRejectModalOpen(false);
      setRejectComment('');
      rejectRef.current = '';
      message.info('已提交修改意见，将重新生成代码');
      onRejected();
    } catch (err: any) {
      const errMsg = err.response?.data?.message || err.message || '操作失败';
      message.error(errMsg);
    } finally {
      setLoading(false);
    }
  };

  const tabItems = [
    {
      key: 'preview',
      label: (
        <span>
          <EyeOutlined /> 页面预览
        </span>
      ),
      children: (
        <div style={{ minHeight: 400 }}>
          <LocalPreview
            key={`${projectId}:frontend-iter${latestFrontendIteration}`}
            projectId={projectId}
          />
        </div>
      ),
    },
    {
      key: 'code',
      label: (
        <span>
          <CodeOutlined /> 代码浏览
        </span>
      ),
      children: (
        <div style={{ marginBottom: 16 }}>
          <CodeFileTree projectId={projectId} codeGens={codeGens} />
        </div>
      ),
    },
  ];

  return (
    <>
      <Card
        title={
          <Space>
            <ExperimentOutlined />
            <span>代码预览测试</span>
          </Space>
        }
        size="small"
        style={{ marginBottom: 16, borderRadius: 12 }}
      >
        {/* Info banner */}
        <div style={{ padding: 16, background: '#e6f7ff', borderRadius: 8, border: '1px solid #91d5ff', marginBottom: 16 }}>
          <Space>
            <EyeOutlined style={{ color: '#1890ff', fontSize: 18 }} />
            <div>
              <Text strong>{recoveringFromFailure ? '历史超时失败，可通过反馈恢复返修' : '代码已生成完成，请预览测试'}</Text>
              <div style={{ marginTop: 4 }}>
                <Text type="secondary">
                  {recoveringFromFailure
                    ? '当前项目保留了已生成代码。提交修改意见后将进入新的返修迭代。'
                    : '在"页面预览"中查看前端实际效果，在"代码浏览"中查看前后端源代码。确认无误后通过，或提交修改意见触发返修。'}
                </Text>
              </div>
              <div style={{ marginTop: 8 }}>
                <Space>
                  {iterationCount > 0 && <Tag>迭代 {iterationCount}</Tag>}
                  {completedCount > 0 && <Tag color="success">{completedCount} 个模块已完成</Tag>}
                  {failedCount > 0 && <Tag color="error">{failedCount} 个模块失败</Tag>}
                  {runningCount > 0 && <Tag color="processing">{runningCount} 个模块生成中</Tag>}
                </Space>
              </div>
            </div>
          </Space>
        </div>

        {/* Tabs: 页面预览 | 代码浏览 */}
        <Tabs
          activeKey={activeTab}
          onChange={k => setActiveTab(k as 'preview' | 'code')}
          items={tabItems}
          style={{ marginBottom: 8 }}
        />

        <Divider />

        {/* Action buttons */}
        <div style={{ textAlign: 'center' }}>
          <Space size="large">
            <Button
              type="primary"
              size="large"
              icon={<CheckCircleOutlined />}
              onClick={handleApprove}
              loading={loading}
              disabled={recoveringFromFailure}
              style={{ background: '#52c41a', borderColor: '#52c41a' }}
            >
              确认通过，进入最终审核
            </Button>
            <Button
              danger
              size="large"
              icon={<CloseCircleOutlined />}
              onClick={() => setRejectModalOpen(true)}
              loading={loading}
            >
              需要修改，提交反馈
            </Button>
          </Space>
        </div>
      </Card>

      <Modal
        title="代码修改反馈"
        open={rejectModalOpen}
        onOk={handleReject}
        onCancel={() => setRejectModalOpen(false)}
        okText="提交反馈并重新生成"
        cancelText="取消"
        okButtonProps={{ danger: true, loading }}
      >
        <p style={{ color: '#666' }}>
          提交后系统将根据您的反馈意见，重新生成前端和后端代码。生成完成后会再次进入预览测试阶段。
        </p>
        <TextArea
          rows={6}
          placeholder="请描述需要修改的内容，例如：&#10;1. 前端列表页面需要增加搜索功能&#10;2. 后端 API 缺少分页参数&#10;3. 数据库字段类型需要调整..."
          value={rejectComment}
          onChange={(e) => {
            setRejectComment(e.target.value);
            rejectRef.current = e.target.value;
          }}
        />
      </Modal>
    </>
  );
};

export default PreviewReviewPanel;
