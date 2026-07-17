import React, { useState } from 'react';
import {
  Card, Input, Button, Upload, App, Space, Typography, Divider, Tabs,
} from 'antd';
import { InboxOutlined, FileTextOutlined, SendOutlined } from '@ant-design/icons';
import type { UploadFile } from 'antd';
import { taskApi } from '../services/api';

const { TextArea } = Input;
const { Title, Text } = Typography;
const { Dragger } = Upload;

interface Props {
  onCreated: (projectId: string) => void;
}

const PrdUpload: React.FC<Props> = ({ onCreated }) => {
  const { message } = App.useApp();
  const [prdText, setPrdText] = useState('');
  const [projectName, setProjectName] = useState('');
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [loading, setLoading] = useState(false);

  const handleTextSubmit = async () => {
    if (!prdText.trim()) {
      message.warning('请输入 PRD 内容');
      return;
    }
    setLoading(true);
    try {
      const res = await taskApi.create({
        name: projectName || undefined,
        prdContent: prdText,
      });
      message.success('任务已创建，正在生成文档...');
      onCreated(res.data.projectId);
    } catch (err: any) {
      message.error(err.response?.data?.message || '创建失败');
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async () => {
    if (fileList.length === 0) {
      message.warning('请选择 PRD 文件');
      return;
    }
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('file', fileList[0].originFileObj as File);
      if (projectName) formData.append('name', projectName);
      const res = await taskApi.upload(formData);
      message.success('文件已上传，正在生成文档...');
      onCreated(res.data.projectId);
    } catch (err: any) {
      message.error(err.response?.data?.message || '上传失败');
    } finally {
      setLoading(false);
    }
  };

  const tabItems = [
    {
      key: 'text',
      label: (
        <span><FileTextOutlined /> 文本输入</span>
      ),
      children: (
        <div>
          <TextArea
            rows={12}
            placeholder="请输入 PRD 文档内容..."
            value={prdText}
            onChange={(e) => setPrdText(e.target.value)}
            style={{ fontFamily: 'monospace', fontSize: 14 }}
          />
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={loading}
              onClick={handleTextSubmit}
              size="large"
            >
              提交生成
            </Button>
          </div>
        </div>
      ),
    },
    {
      key: 'file',
      label: (
        <span><InboxOutlined /> 文件上传</span>
      ),
      children: (
        <div>
          <Dragger
            fileList={fileList}
            beforeUpload={(file) => {
              setFileList([{ uid: '-1', name: file.name, status: 'done', originFileObj: file as any }]);
              return false;
            }}
            onRemove={() => setFileList([])}
            maxCount={1}
            accept=".txt,.md,.markdown"
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">点击或拖拽 PRD 文件到此区域</p>
            <p className="ant-upload-hint">支持 UTF-8 的 .txt / .md / .markdown 格式</p>
          </Dragger>
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={loading}
              onClick={handleFileUpload}
              size="large"
              disabled={fileList.length === 0}
            >
              上传并生成
            </Button>
          </div>
        </div>
      ),
    },
  ];

  return (
    <Card
      title={<Title level={4}>📝 PRD 上传</Title>}
      style={{ maxWidth: 800, margin: '0 auto' }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <Text strong>项目名称（可选）</Text>
          <Input
            placeholder="输入项目名称，不填则自动生成"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            style={{ marginTop: 8 }}
          />
        </div>

        <Divider />

        <Tabs items={tabItems} />

        <Divider />

        <div
          style={{
            background: '#f0f5ff',
            padding: '12px 16px',
            borderRadius: 8,
            border: '1px solid #d6e4ff',
          }}
        >
          <Text type="secondary">
            💡 提示：提交后系统将自动调用 AI 生成三份架构设计文档（技术栈选型、
            模块划分、API 契约、数据模型），生成完毕后进入待审批状态。
          </Text>
        </div>
      </Space>
    </Card>
  );
};

export default PrdUpload;
