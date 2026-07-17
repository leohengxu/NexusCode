import React from 'react';
import { Card, Space, Typography, Tag, Timeline, Empty, Input, Button, App } from 'antd';
import { RollbackOutlined } from '@ant-design/icons';
import { ReworkRecord, CODE_GEN_LABELS, VALIDATOR_LABELS } from '../types';
import { taskApi } from '../services/api';

const { Text, Title } = Typography;
const { TextArea } = Input;

interface Props {
  projectId: string;
  reworkRecords: ReworkRecord[];
  currentIteration: number;
  onReworkTriggered: () => void;
}

const ReworkStatus: React.FC<Props> = ({ projectId, reworkRecords, currentIteration, onReworkTriggered }) => {
  const { message } = App.useApp();
  const [feedback, setFeedback] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  const handleManualRework = async () => {
    if (!feedback.trim()) {
      message.warning('请输入返修反馈');
      return;
    }
    setLoading(true);
    try {
      await taskApi.triggerRework(projectId, feedback);
      message.success('返修已触发');
      setFeedback('');
      onReworkTriggered();
    } catch (err: any) {
      message.error(err.response?.data?.message || '触发失败');
    } finally {
      setLoading(false);
    }
  };

  if (!reworkRecords || reworkRecords.length === 0) {
    return <Empty description="暂无返修记录" />;
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Text strong>当前迭代: {currentIteration}</Text>
      </Space>

      <Timeline
        items={reworkRecords.map((record, idx) => ({
          color: record.trigger === 'VALIDATOR' ? 'orange' : 'red',
          children: (
            <div key={record.id}>
              <Space>
                <Text strong>迭代 {record.iteration}</Text>
                <Tag color={record.trigger === 'VALIDATOR' ? 'orange' : 'red'}>
                  {record.trigger === 'VALIDATOR' ? 'AI验证驳回' : '人工审核驳回'}
                </Tag>
                <Text type="secondary">
                  {new Date(record.createdAt).toLocaleString()}
                </Text>
              </Space>
              <div
                style={{
                  marginTop: 8,
                  padding: 12,
                  background: '#fffbe6',
                  borderRadius: 8,
                  border: '1px solid #ffe58f',
                }}
              >
                <Text type="secondary" style={{ fontWeight: 'bold' }}>反馈内容:</Text>
                <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{record.feedback}</div>
              </div>
            </div>
          ),
        }))}
      />

      <Card size="small" title={<Space><RollbackOutlined /> 手动触发返修</Space>} style={{ marginTop: 16 }}>
          <TextArea
            rows={3}
            placeholder="输入返修反馈，说明需要修改的内容..."
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div style={{ marginTop: 12, textAlign: 'right' }}>
            <Button
              type="primary"
              icon={<RollbackOutlined />}
              loading={loading}
              onClick={handleManualRework}
              disabled={!feedback.trim()}
            >
              触发返修
            </Button>
          </div>
        </Card>
    </div>
  );
};

export default ReworkStatus;
