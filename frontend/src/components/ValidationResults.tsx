import React from 'react';
import { Card, Space, Typography, Tag, Progress, Empty, Spin, Divider } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { VALIDATOR_LABELS, VALIDATOR_ICONS, ValidationRecord } from '../types';

const { Text } = Typography;

interface Props {
  validations: ValidationRecord[];
  loading?: boolean;
}

const ValidationResults: React.FC<Props> = ({ validations, loading }) => {
  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <Spin />
        <p>加载验证结果...</p>
      </div>
    );
  }

  if (!validations || validations.length === 0) {
    return <Empty description="暂无验证结果" />;
  }

  const iterations = [...new Set(validations.map(v => v.iteration))].sort((a, b) => b - a);
  const latestIteration = iterations[0];
  const latestRecords = validations.filter(v => v.iteration === latestIteration);

  const allPassed = latestRecords.every(v => v.status === 'PASSED');
  const anyFailed = latestRecords.some(v => v.status === 'FAILED');
  const anyRunning = latestRecords.some(v => v.status === 'RUNNING');

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Text strong>验证迭代: v{latestIteration}</Text>
        {allPassed && <Tag color="success">全部通过</Tag>}
        {anyFailed && <Tag color="error">有未通过</Tag>}
        {anyRunning && <Tag color="processing">验证中</Tag>}
      </Space>

      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {latestRecords.map(record => {
          const isPassed = record.status === 'PASSED';
          const isFailed = record.status === 'FAILED';
          const isRunning = record.status === 'RUNNING';
          const isPending = record.status === 'PENDING';

          let resultObj: any = {};
          if (record.result) {
            try { resultObj = JSON.parse(record.result); } catch {}
          }

          return (
            <Card
              key={record.id}
              size="small"
              title={
                <Space>
                  <Text>{VALIDATOR_ICONS[record.role]} {VALIDATOR_LABELS[record.role]}</Text>
                  {isPassed && <Tag color="success" icon={<CheckCircleOutlined />}>通过</Tag>}
                  {isFailed && <Tag color="error" icon={<CloseCircleOutlined />}>未通过</Tag>}
                  {isRunning && <Tag color="processing">进行中</Tag>}
                  {isPending && <Tag>待验证</Tag>}
                </Space>
              }
            >
              {(isPassed || isFailed) && (
                <>
                  <Progress
                    percent={record.score ?? (isPassed ? 90 : 30)}
                    status={isPassed ? 'success' : 'exception'}
                    format={(p) => `${p}分`}
                  />
                  {record.comments && (
                    <div style={{ marginTop: 8 }}>
                      <Text>{record.comments}</Text>
                    </div>
                  )}
                  {resultObj.issues && resultObj.issues.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <Text type="secondary" style={{ fontWeight: 'bold' }}>发现的问题:</Text>
                      {resultObj.issues.map((issue: any, idx: number) => (
                        <div
                          key={idx}
                          style={{
                            marginTop: 4,
                            padding: '4px 8px',
                            background: issue.severity === 'critical' ? '#fff2f0' : '#fffbe6',
                            borderRadius: 4,
                            fontSize: 13,
                          }}
                        >
                          <Tag color={issue.severity === 'critical' ? 'red' : issue.severity === 'major' ? 'orange' : 'blue'}>
                            {issue.severity}
                          </Tag>
                          {issue.description}
                          {issue.location && (
                            <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                              位置: {issue.location}
                            </Text>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </Card>
          );
        })}
      </Space>
    </div>
  );
};

export default ValidationResults;
