# FastCode - 代码全流程生成平台

从 PRD 文档自动生成四份架构设计文档 → 人工审批 → Worker Agents 并行代码生成 → Validator Agents 多维盲审 → 返修闭环 → 最终审核发布。

## 项目结构

```
demo/
├── backend/                # NestJS 后端
│   ├── prisma/
│   │   └── schema.prisma   # 数据库 Schema
│   ├── src/
│   │   ├── common/         # 公共模块 (Prisma, Files, Workflow, Constants)
│   │   ├── modules/
│   │   │   ├── opencode/   # LLM 集成封装（Planner Agent）
│   │   │   ├── task/       # 任务管理
│   │   │   ├── document/   # 文档管理
│   │   │   ├── approval/   # 架构文档审批
│   │   │   ├── codegen/    # Worker Agents（前端+后端代码生成）
│   │   │   ├── validator/  # Validator Agents（功能/安全/性能/UI）
│   │   │   └── human-review/ # 最终人工审核
│   │   ├── app.module.ts
│   │   └── main.ts
│   └── uploads/            # 文档和代码存储
├── frontend/               # React + Vite 前端
│   └── src/
│       ├── pages/          # 页面组件
│       ├── components/     # 可复用组件
│       ├── services/       # API 调用
│       └── types/          # TypeScript 类型
└── plan-a.txt              # 完整项目需求文档
```

## 完整工作流

```
PRD 上传
  → Planner Agent（架构师）生成4份文档（技术栈/架构/API/DDL）
  → 人工审批技术栈
    → 通过 → Worker Agents 并行开发（前端Agent + 后端Agent）
    → 驳回 → 全量重新生成文档
  → 代码预览测试（本地 Vite 沙箱预览 + Validator Agents 盲审）
    → 全部通过 → 人工最终审核
    → 任一驳回 → 返修闭环（反馈给 Worker Agent 重新生成，迭代计数+1，不设次数上限）
  → 最终审核通过 → 基线发布
  → 最终审核驳回 → 返修或失败
```

## 状态流转

```
PENDING → GENERATING → PENDING_REVIEW → DEVELOPING → PREVIEW → HUMAN_REVIEW → APPROVED (终态)
                                  ↓                    ↓             ↓
                              REJECTED              REWORKING ←──────┘ (返修闭环，不设上限)
                                  ↓                    ↓
                            GENERATING            DEVELOPING
所有状态均可进入 FAILED (异常终止，可恢复到 PENDING/REWORKING)
```

## 快速启动

### 1. 环境要求

- Node.js 20.19+（或 22.12+）
- PostgreSQL 数据库（当前使用 SQLite 开发）

### 2. 配置

```bash
# 复制环境变量模板
cp backend/.env.example backend/.env

# 编辑 backend/.env，设置 OPENCODE_API_KEY 和 OPENCODE_MODEL
# 生产环境必须设置 API_KEY；并在 frontend/.env.local 设置相同的 VITE_API_KEY
# 访问 https://opencode.ai/auth 获取 API Key
```

### 3. 启动后端

```bash
cd backend
npm install
npx prisma generate
npx prisma db push
npm run dev
```

后端运行在 http://localhost:3000
Swagger 文档: http://localhost:3000/api

PRD 文件上传目前只接受 UTF-8 的 `.txt`、`.md`、`.markdown` 纯文本格式。

### 4. 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端运行在 http://localhost:5173

## API 接口

### 任务管理
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tasks` | 提交 PRD 文本生成文档 |
| POST | `/api/tasks/upload` | 上传 PRD 文件生成文档 |
| GET | `/api/tasks` | 获取所有项目列表 |
| GET | `/api/tasks/:projectId` | 查询项目状态 |
| GET | `/api/tasks/:projectId/full-status` | 获取完整状态（含代码/验证/返修） |
| POST | `/api/tasks/:projectId/rework` | 手动触发返修 |

### 文档管理
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/documents/:projectId` | 获取文档列表 |
| GET | `/api/documents/:projectId/preview` | 预览单份文档 |

### 架构文档审批
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/approvals/:projectId/approve` | 审批通过（自动触发代码生成） |
| POST | `/api/approvals/:projectId/reject` | 驳回重生成 |
| GET | `/api/approvals/:projectId/history` | 审批历史 |

### 代码生成（Worker Agents）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/codegen/:projectId/start` | 启动并行代码生成 |
| GET | `/api/codegen/:projectId/status` | 获取代码生成状态 |
| GET | `/api/codegen/:projectId/preview` | 预览生成的代码 |

### 代码验证（Validator Agents）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/validations/:projectId/start` | 启动并行验证 |
| GET | `/api/validations/:projectId` | 获取验证结果 |

### 最终审核
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/human-review/:projectId` | 获取最终审核状态 |
| POST | `/api/human-review/:projectId/approve` | 最终通过，发布基线 |
| POST | `/api/human-review/:projectId/reject` | 最终驳回，触发返修 |

## Agent 角色说明

| Agent | 角色 | 输入 | 输出 |
|-------|------|------|------|
| Planner | 架构师 | PRD | 技术栈选型、架构文档、API契约、DDL |
| Worker (Frontend) | 前端开发者 | 架构文档 | React + TypeScript 代码 |
| Worker (Backend) | 后端开发者 | 架构文档 | NestJS 代码 |
| Validator (Functional) | 功能验证 | PRD + 代码 | 功能一致性报告 |
| Validator (Security) | 安全审计 | 代码 | 安全漏洞报告 |
| Validator (Performance) | 性能审查 | 代码 | 性能问题报告 |
| Validator (UI) | UI审查 | 前端代码 | UI规范报告 |
| Human Reviewer | 最终审批 | 完整产出物 | 通过/驳回 |

## 核心技术架构

- **后端**: NestJS + Prisma + LangChain + OpenCode Zen API
- **前端**: React 18 + Ant Design + Vite + Mermaid
- **LLM**: OpenCode Zen (OpenAI 兼容模式)
- **存储**: 文件系统为主，数据库存元数据
- **版本管理**: 目录级存档 `uploads/{id}/archive/v{n}/`
- **迭代保护**: 返修不设次数上限，iterationCount 持续递增
- **盲验证**: Validator 只看最终代码，不看开发过程
