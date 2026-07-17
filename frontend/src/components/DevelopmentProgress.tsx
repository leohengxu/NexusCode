import React, { useState } from 'react';
import { Card, Progress, Space, Typography, Tag, Empty, Spin, Button, Modal } from 'antd';
import { EyeOutlined, CodeOutlined } from '@ant-design/icons';
import { CODE_GEN_ICONS, CODE_GEN_LABELS, CodeGenRecord } from '../types';
import { codegenApi } from '../services/api';

const { Text } = Typography;

interface Props {
  projectId: string;
  codeGens: CodeGenRecord[];
  loading?: boolean;
}

const DevelopmentProgress: React.FC<Props> = ({ projectId, codeGens, loading }) => {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewContent, setPreviewContent] = useState('');
  const [previewTitle, setPreviewTitle] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <Spin />
        <p>加载开发进度...</p>
      </div>
    );
  }

  if (!codeGens || codeGens.length === 0) {
    return <Empty description="暂无开发记录" />;
  }

  const iterations = [...new Set(codeGens.map(c => c.iteration))].sort((a, b) => b - a);
  const latestIteration = iterations[0];
  const latestRecords = codeGens.filter(c => c.iteration === latestIteration);

  const handlePreview = async (role: string) => {
    setPreviewLoading(true);
    setPreviewTitle(CODE_GEN_LABELS[role as 'FRONTEND' | 'BACKEND'] || role);
    try {
      const res = await codegenApi.preview(projectId, role);
      setPreviewContent(res.data.content || '暂无代码内容');
    } catch (err: any) {
      setPreviewContent(`加载失败: ${err.response?.data?.message || err.message}`);
    } finally {
      setPreviewLoading(false);
      setPreviewOpen(true);
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Text strong>最新迭代: v{latestIteration}</Text>
        {latestRecords.every(r => r.status === 'COMPLETED') && (
          <Tag color="success">全部完成</Tag>
        )}
        {latestRecords.some(r => r.status === 'RUNNING') && (
          <Tag color="processing">生成中</Tag>
        )}
        {latestRecords.some(r => r.status === 'FAILED') && (
          <Tag color="error">有失败</Tag>
        )}
      </Space>

      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {latestRecords.map(record => {
          const isRunning = record.status === 'RUNNING';
          const isCompleted = record.status === 'COMPLETED';
          const isFailed = record.status === 'FAILED';

          return (
            <Card
              key={record.id}
              size="small"
              title={
                <Space>
                  <Text>{CODE_GEN_ICONS[record.role]} {CODE_GEN_LABELS[record.role]}</Text>
                  <Tag color={isCompleted ? 'success' : isRunning ? 'processing' : 'error'}>
                    {isCompleted ? '已完成' : isRunning ? '进行中' : '失败'}
                  </Tag>
                </Space>
              }
              extra={
                isCompleted && (
                  <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handlePreview(record.role)}>
                    查看代码
                  </Button>
                )
              }
            >
              <Progress
                percent={isCompleted ? 100 : isRunning ? 0 : 0}
                status={isFailed ? 'exception' : isRunning ? 'active' : isCompleted ? 'success' : 'normal'}
                strokeColor={isCompleted ? '#52c41a' : undefined}
              />
              {record.startTime && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  开始: {new Date(record.startTime).toLocaleString()}
                </Text>
              )}
              {record.endTime && (
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 16 }}>
                  完成: {new Date(record.endTime).toLocaleString()}
                </Text>
              )}
              {record.errorMsg && (
                <div style={{ marginTop: 8, color: '#ff4d4f', fontSize: 13 }}>
                  错误: {record.errorMsg}
                </div>
              )}
            </Card>
          );
        })}
      </Space>

      {iterations.length > 1 && (
        <div style={{ marginTop: 16 }}>
          <Text type="secondary">历史迭代: </Text>
          <Space>
            {iterations.filter(i => i !== latestIteration).map(i => {
              const iterRecords = codeGens.filter(c => c.iteration === i);
              const allDone = iterRecords.every(r => r.status === 'COMPLETED');
              return (
                <Tag key={i} color={allDone ? 'default' : 'error'}>
                  迭代 {i} {allDone ? '(完成)' : '(失败)'}
                </Tag>
              );
            })}
          </Space>
        </div>
      )}

      <Modal
        title={<Space><CodeOutlined /> {previewTitle} - 代码预览</Space>}
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        footer={null}
        width="80%"
        style={{ top: 20 }}
      >
        {previewLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : (
          <pre style={{
            background: '#1e1e1e', color: '#d4d4d4', padding: 16, borderRadius: 8,
            fontSize: 13, maxHeight: '70vh', overflow: 'auto', whiteSpace: 'pre-wrap',
            fontFamily: "'Cascadia Code', 'Fira Code', monospace", lineHeight: 1.6,
          }}>
            {previewContent}
          </pre>
        )}
      </Modal>
    </div>
  );
};

export default DevelopmentProgress;
