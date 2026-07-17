import React, { useState, useRef } from 'react';
import { Button, Modal, Input, App, Space, Tag } from 'antd';
import {
  CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons';
import { approvalApi } from '../services/api';

const { TextArea } = Input;

interface Props {
  projectId: string;
  onApproved: () => void;
  onRejected: () => void;
}

const ApprovalPanel: React.FC<Props> = ({ projectId, onApproved, onRejected }) => {
  const { message } = App.useApp();
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectComment, setRejectComment] = useState('');
  const rejectRef = useRef('');
  const [loading, setLoading] = useState(false);

  const handleApprove = async () => {
    Modal.confirm({
      title: '确认审批通过？',
      icon: <ExclamationCircleOutlined />,
      content: '通过后技术栈选型将作为基线发布，下游 Agent 将基于此基线进行开发。',
      okText: '确认通过',
      cancelText: '取消',
      onOk: async () => {
        setLoading(true);
        try {
          await approvalApi.approve(projectId);
          message.success('审批通过，技术栈基线已发布！');
          onApproved();
        } catch (err: any) {
          message.error(err.response?.data?.message || '操作失败');
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
      const res = await approvalApi.reject(projectId, { comment, reviewer: '架构师' });
      message.info(res.data?.message || '已驳回，系统将全量重新生成文档');
      setRejectModalOpen(false);
      setRejectComment('');
      rejectRef.current = '';
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
      <Space>
        <Tag color="warning" style={{ fontSize: 14, padding: '4px 12px' }}>
          ⚠ 待审批
        </Tag>
        <Button
          type="primary"
          icon={<CheckCircleOutlined />}
          onClick={handleApprove}
          loading={loading}
        >
          审批通过
        </Button>
        <Button
          danger
          icon={<CloseCircleOutlined />}
          onClick={() => setRejectModalOpen(true)}
          loading={loading}
        >
          驳回重生成
        </Button>
      </Space>

      <Modal
        title="驳回并全量重新生成"
        open={rejectModalOpen}
        onOk={handleReject}
        onCancel={() => setRejectModalOpen(false)}
        okText="确认驳回"
        cancelText="取消"
        okButtonProps={{ danger: true, loading }}
      >
        <p style={{ color: '#666' }}>
          驳回后系统将<b>全量重新生成</b>三份文档（非增量修改），
          保证文档间的逻辑一致性。
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

export default ApprovalPanel;
