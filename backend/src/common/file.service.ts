import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DocType, DOC_TYPE_EXTENSIONS, DOC_TYPE_LABELS } from './constants';

@Injectable()
export class FileService {
  private readonly uploadDir: string;

  constructor() {
    this.uploadDir = process.env.UPLOAD_DIR || './uploads';
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  /**
   * 获取项目根目录
   */
  getProjectDir(projectId: string): string {
    return path.join(this.uploadDir, projectId);
  }

  /**
   * 获取指定迭代、指定角色的代码目录: uploads/{projectId}/code/iter{n}/{role}/
   *
   * 按 iteration 隔离，避免返修时新一轮生成覆盖旧代码、
   * 或 validator 读到半写状态的目录。
   */
  getCodeDir(projectId: string, iteration: number, role: string): string {
    return path.join(
      this.getProjectDir(projectId),
      'code',
      `iter${iteration}`,
      role.toLowerCase(),
    );
  }

  /** Resolve a model-supplied path and reject anything outside baseDir. */
  resolveWithin(baseDir: string, candidate: string): string {
    if (!candidate || candidate.includes('\0')) {
      throw new Error('非法文件路径');
    }

    const root = path.resolve(baseDir);
    const resolved = path.resolve(root, candidate.replace(/[\\/]+/g, path.sep));
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('非法文件路径');
    }
    return resolved;
  }

  /**
   * 检查上传目录可用磁盘空间是否充足。
   * @param requiredBytes 需要的最小可用字节数
   * @returns { ok, available } ok=false 表示空间不足
   */
  checkDiskSpace(requiredBytes: number): { ok: boolean; available: number } {
    const available = this.getAvailableSpace();
    return { ok: available >= requiredBytes, available };
  }

  /**
   * 获取指定版本的文档目录: uploads/{projectId}/v{version}/
   */
  getVersionDir(projectId: string, version: number): string {
    const dir = path.join(this.uploadDir, projectId, `v${version}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * 归档旧版本: 将当前文档移到 archive/v{version}/
   */
  archiveVersion(projectId: string, oldVersion: number): string {
    const projectDir = this.getProjectDir(projectId);
    const oldDir = path.join(projectDir, `v${oldVersion}`);
    const archiveDir = path.join(projectDir, 'archive', `v${oldVersion}`);

    if (fs.existsSync(oldDir)) {
      if (!fs.existsSync(path.dirname(archiveDir))) {
        fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
      }
      fs.renameSync(oldDir, archiveDir);
      return archiveDir;
    }
    return '';
  }

  /**
   * 保存 PRD 文件
   */
  savePrdFile(projectId: string, buffer: Buffer, originalName: string): string {
    const dir = path.join(this.uploadDir, projectId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const filePath = path.join(dir, `prd_${Date.now()}_${originalName}`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  /**
   * 保存文档内容到文件
   */
  saveDocument(
    projectId: string,
    version: number,
    docType: DocType,
    content: string,
  ): { fileName: string; filePath: string; fileSize: number } {
    const versionDir = this.getVersionDir(projectId, version);
    const ext = DOC_TYPE_EXTENSIONS[docType];
    const label = DOC_TYPE_LABELS[docType];
    const fileName = `${docType.toLowerCase()}_${label}${ext}`;
    const filePath = path.join(versionDir, fileName);
    fs.writeFileSync(filePath, content, 'utf-8');
    const fileSize = Buffer.byteLength(content, 'utf-8');
    return { fileName, filePath, fileSize };
  }

  /**
   * 读取文档内容
   */
  readDocument(filePath: string): string {
    if (!fs.existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  /**
   * 获取文档相对路径（用于前端下载链接）
   */
  getRelativePath(filePath: string): string {
    return filePath.replace(this.uploadDir, '').replace(/\\/g, '/');
  }

  /**
   * 直接保存内容到指定路径
   */
  saveDocumentRaw(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  /**
   * 获取磁盘可用空间 (bytes)
   */
  getAvailableSpace(): number {
    try {
      const stat = fs.statfsSync ? fs.statfsSync(this.uploadDir) : null;
      if (stat) return stat.bsize * stat.bavail;
      return Infinity;
    } catch {
      return Infinity;
    }
  }
}
