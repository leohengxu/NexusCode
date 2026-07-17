import React, { useState, useRef } from 'react';
import { Button, Modal, Input, App, Space, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons';
import { humanReviewApi } from '../services/api';

const { Text } = Typography;
const { TextArea } = Input;

interface Props {
  projectId: string;
  iterationCount: number;
  onApproved: () => void;
  onRejected: () => void;
}

const FinalReviewPanel: React.FC<Props> = ({ projectId, iterationCount, onApproved, onRejected }) => {
  const { message } = App.useApp();
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState('');
  const rejectRef = useRef('');
  const [loading, setLoading] = useState(false);

  const handleApprove = async () => {
    Modal.confirm({
      title: '确认最终审核通过？',
      icon: <ExclamationCircleOutlined />,
      content: '通过后本次生成将作为最终基线发布。',
      okText: '确认发布基线',
      cancelText: '取消',
      onOk: async () => {
        setLoading(true);
        try {
          await humanReviewApi.approve(projectId);
          message.success('最终审核通过，基线已发布！');
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
      message.warning('请填写驳回意见');
      return;
    }
    setLoading(true);
    try {
      const res = await humanReviewApi.reject(projectId, comment);
      setRejectModalOpen(false);
      setRejectComment('');
      rejectRef.current = '';
      message.info(res.data?.message || '已驳回');
      onRejected();
    } catch (err: any) {
      const errMsg = err.response?.data?.message || err.message || '操作失败';
      message.error(errMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div style={{ padding: 16, background: '#fff7e6', borderRadius: 8, border: '1px solid #ffd591' }}>
          <Space>
            <ExclamationCircleOutlined style={{ color: '#fa8c16', fontSize: 18 }} />
            <Text strong>代码验证已全部通过，请进行最终人工审核</Text>
          </Space>
          <div style={{ marginTop: 8 }}>
            <Text type="secondary">当前迭代: {iterationCount}</Text>
          </div>
        </div>

        <Space>
          <Button
            type="primary"
            size="large"
            icon={<CheckCircleOutlined />}
            onClick={handleApprove}
            loading={loading}
            style={{ background: '#52c41a', borderColor: '#52c41a' }}
          >
            通过，发布基线
          </Button>
          <Button
            danger
            size="large"
            icon={<CloseCircleOutlined />}
            onClick={() => setRejectModalOpen(true)}
            loading={loading}
          >
            驳回，返修
          </Button>
        </Space>
      </Space>

      <Modal
        title="最终审核驳回"
        open={rejectModalOpen}
        onOk={handleReject}
        onCancel={() => setRejectModalOpen(false)}
        okText="确认驳回"
        cancelText="取消"
        okButtonProps={{ danger: true, loading }}
      >
        <p style={{ color: '#666' }}>
          驳回后将触发返修流程，Worker Agents 将根据反馈修改代码后重新验证。
        </p>
        <TextArea
          rows={4}
          placeholder="请输入驳回意见，说明需要修改的内容..."
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

export default FinalReviewPanel;
