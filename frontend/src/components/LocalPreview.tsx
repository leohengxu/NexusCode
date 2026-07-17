import React, { useEffect, useRef, useState } from 'react';
import { Spin, Empty, Alert, Typography, Button, Space } from 'antd';
import { LoadingOutlined, ReloadOutlined } from '@ant-design/icons';
import { previewReviewApi } from '../services/api';

interface Props {
  projectId: string;
}

const { Text } = Typography;

const LocalPreview: React.FC<Props> = ({ projectId }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  // 复用进行中的请求，避免 StrictMode 双重挂载时并发启动两个 Vite 实例
  const startPromiseRef = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // 如果没有进行中的请求，发起新请求；否则复用同一个 promise
    if (!startPromiseRef.current) {
      startPromiseRef.current = previewReviewApi
        .startPreview(projectId)
        .then((res) => res.data?.url || null)
        .catch((err) => {
          startPromiseRef.current = null; // 失败后清空，允许重试
          throw err;
        })
        .then((u) => {
          startPromiseRef.current = null; // 完成后清空
          return u;
        });
    }

    startPromiseRef.current
      .then((u) => {
        if (!cancelled) { setUrl(u); setLoading(false); }
      })
      .catch((err: any) => {
        if (!cancelled) {
          setError(err?.response?.data?.message || err?.message || '启动预览服务失败');
          setLoading(false);
        }
      });

    // 不在卸载时调用 stopPreview：StrictMode 双重挂载和 Tab 切换会导致
    // stop/start 循环，Vite 关闭耗时数秒，期间 iframe 白屏且端口状态混乱。
    // 后端 instance 长期复用，每个项目只占一个端口。
    return () => { cancelled = true; };
  }, [projectId, retryKey]);

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <Spin indicator={<LoadingOutlined style={{ fontSize: 36 }} spin />} />
        <p style={{ marginTop: 12, color: '#666' }}>正在启动本地 Vite 预览服务…</p>
      </div>
    );
  }

  if (error) {
    return (
      <Empty description={error} style={{ padding: 40 }}>
        <Space direction="vertical">
          <Text type="secondary" style={{ fontSize: 12 }}>
            请根据上方错误检查当前迭代的前端产物或预览服务配置。
          </Text>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              startPromiseRef.current = null;
              setRetryKey(key => key + 1);
            }}
          >
            重试
          </Button>
        </Space>
      </Empty>
    );
  }

  if (!url) {
    return <Empty description="未能获取预览地址" style={{ padding: 40 }} />;
  }

  return (
    <div style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12, fontSize: 12 }}
        message={
          <Text style={{ fontSize: 12 }}>
            此预览在本地 Vite 沙箱中运行，API 调用已替换为 mock 数据。部分需要后端的功能无法完全展示。
          </Text>
        }
      />
      <div
        style={{
          border: '1px solid #e8e8e8',
          borderRadius: 8,
          overflow: 'hidden',
          height: 560,
          width: '100%',
        }}
      >
        <iframe
          src={url || undefined}
          title="本地预览"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
          style={{ width: '100%', height: '100%', border: 'none' }}
        />
      </div>
    </div>
  );
};

export default LocalPreview;
