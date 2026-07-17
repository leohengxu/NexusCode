import { BadRequestException } from '@nestjs/common';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import * as fs from 'fs';

// 允许的 PRD 文件类型
const ALLOWED_MIME_TYPES = [
  'text/plain',              // .txt
  'text/markdown',           // .md
  'text/x-markdown',         // .md (alternative)
  'application/octet-stream', // .md (Windows sometimes sends this)
];

// 当前服务按 UTF-8 纯文本读取，不能把二进制 doc/docx 当作 PRD 文本。
const ALLOWED_EXTENSIONS = ['.txt', '.md', '.markdown'];

export const multerConfig = {
  storage: diskStorage({
    destination: (_req, _file, callback) => {
      // multer 不会自动创建目标目录，需提前确保存在，否则首次上传报 ENOENT
      const dir = join(process.cwd(), 'uploads', 'prd');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      callback(null, dir);
    },
    filename: (_req, file, callback) => {
      const ext = extname(file.originalname);
      const filename = `prd_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
      callback(null, filename);
    },
  }),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  fileFilter: (_req: any, file: Express.Multer.File, callback: any) => {
    const ext = extname(file.originalname).toLowerCase();
    const isValidExt = ALLOWED_EXTENSIONS.includes(ext);
    const isValidMime = ALLOWED_MIME_TYPES.includes(file.mimetype);

    // 宽松模式：扩展名或 MIME 任一匹配即可（兼容 Windows .md 文件 MIME 不标准的问题）
    if (isValidExt && isValidMime) {
      callback(null, true);
    } else {
      callback(
        new BadRequestException(
          `不支持的文件类型: ${file.originalname}。支持格式: ${ALLOWED_EXTENSIONS.join(', ')}`,
        ),
        false,
      );
    }
  },
};
