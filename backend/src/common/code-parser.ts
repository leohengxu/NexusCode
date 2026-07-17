export interface ExtractedFile {
  path: string;
  language: string;
  content: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileTreeNode[];
  language?: string;
  size?: number;
}

/** Find the closing ``` line (must be exact ``` or ``` followed by nothing) */
function findClosingFence(lines: string[], startIdx: number): number {
  for (let i = startIdx; i < lines.length; i++) {
    if (/^```\s*$/.test(lines[i].trim())) return i;
  }
  // 没有找到闭合标记 — 返回 lines.length 表示取到末尾（处理 LLM 输出被截断的情况）
  return lines.length;
}

/** Collect content between startIdx and the closing ``` (or end of input if truncated) */
function collectUntilFence(lines: string[], startIdx: number): string {
  const end = findClosingFence(lines, startIdx);
  return lines.slice(startIdx, end).join('\n').trim();
}

/** Extract a file path from the opening fence line or nearby text */
function extractFilePath(openingLine: string, contextLines: string[], lineIdx: number): string | null {
  const trimmed = openingLine.trim();

  // Pattern 1: ```lang:path/to/file  or  ```lang:`path/to/file`
  const colonMatch = trimmed.match(/^```(\w*)\s*:\s*`?(.+?)`?\s*$/);
  if (colonMatch) {
    const raw = colonMatch[2].trim().replace(/^`|`$/g, '').trim();
    if (raw) return raw;
  }

  // Pattern 2: ```path/to/file (no language, just path)
  const simpleMatch = trimmed.match(/^```\s*`?(.+?\.\w+)`?\s*$/);
  if (simpleMatch) {
    const raw = simpleMatch[1].trim().replace(/^`|`$/g, '').trim();
    if (raw) return raw;
  }

  // Pattern 3: Look in lines before the code block for a heading or "File:" marker
  for (let lookback = 1; lookback <= 5; lookback++) {
    const idx = lineIdx - lookback;
    if (idx < 0) break;
    const prevLine = contextLines[idx].trim();

    // ## path/to/file.tsx  or  # path/to/file.tsx  (must look like a path, not a heading word)
    const headingMatch = prevLine.match(/^#+\s*(.+?\.\w+)\s*$/);
    if (headingMatch) return headingMatch[1].trim();

    // File: path/to/file.tsx  or  file: path/to/file.tsx
    const fileMarkerMatch = prevLine.match(/^(?:file|File|FILE|文件)\s*[:：]\s*(.+?\.\w+)\s*$/);
    if (fileMarkerMatch) return fileMarkerMatch[1].trim();

    // // filepath: src/pages/Example.tsx  (VS Code style comment)
    const commentMatch = prevLine.match(/^\/\/\s*(?:filepath|path|文件路径)\s*[:：]\s*(.+?)\s*$/i);
    if (commentMatch) {
      const p = commentMatch[1].trim();
      if (p) return p;
    }
  }

  // Pattern 4: Look INSIDE the code block's first 2 lines for a path comment
  for (let lookahead = 1; lookahead <= 2; lookahead++) {
    const idx = lineIdx + lookahead;
    if (idx >= contextLines.length) break;
    const nextLine = contextLines[idx].trim();

    // // filepath: src/pages/Example.tsx
    const commentMatch = nextLine.match(/^\/\/\s*(?:filepath|path|文件路径)\s*[:：]\s*(.+?)\s*$/i);
    if (commentMatch) {
      const p = commentMatch[1].trim();
      if (p) return p;
    }

    // // src/pages/Example.tsx (just a path comment)
    const pathComment = nextLine.match(/^\/\/\s*((?:src|prisma|public|components|pages|api|modules|common)\/[^\s]+?\.\w+)\s*$/);
    if (pathComment) return pathComment[1].trim();
  }

  return null;
}

/** Determine a language extension from the code fence language tag */
function langToExt(language: string): string {
  const map: Record<string, string> = {
    tsx: '.tsx', ts: '.ts', jsx: '.jsx', js: '.js',
    json: '.json', css: '.css', html: '.html',
    prisma: '.prisma', yaml: '.yaml', yml: '.yml',
    md: '.md', sql: '.sql', python: '.py', py: '.py',
    go: '.go', rust: '.rs', java: '.java',
  };
  return map[language] || `.${language}`;
}

export function parseGeneratedCode(markdown: string): ExtractedFile[] {
  const files: ExtractedFile[] = [];
  const lines = markdown.split('\n');
  const usedPaths = new Set<string>();
  let fbSeq = 0; // 兜底文件序号，保证唯一不覆盖

  // 提取扩展名（末尾 .xxx），无扩展名返回空串。不依赖 node path 模块。
  const splitExt = (p: string): { base: string; ext: string } => {
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    const dot = p.lastIndexOf('.');
    if (dot > slash && dot !== -1) {
      return { base: p.slice(0, dot), ext: p.slice(dot) };
    }
    return { base: p, ext: '' };
  };

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();

    // Look for any opening code fence
    const fenceMatch = trimmed.match(/^```(\w*)/);
    if (fenceMatch) {
      const language = fenceMatch[1] || '';
      const openingLine = trimmed;

      // Try to extract path from opening line or surrounding context
      let filePath = extractFilePath(openingLine, lines, i);

      // Collect content until closing ```
      const content = collectUntilFence(lines, i + 1);

      // 检测是否为截断块（未找到闭合 fence，取到了文件末尾）
      const closingIdx = findClosingFence(lines, i + 1);
      const truncated = closingIdx >= lines.length;
      i = closingIdx + 1;

      if (!filePath) {
        // 无路径：仅当有 language 时兜底命名，且加唯一序号避免多块互相覆盖
        if (language) {
          filePath = `generated/file_${fbSeq++}${langToExt(language)}`;
        } else {
          // 无 language 无路径的匿名代码块：跳过
          continue;
        }
      }

      // 路径去重：同名再次出现时加序号，避免后写覆盖先写
      if (usedPaths.has(filePath)) {
        const { base, ext } = splitExt(filePath);
        let n = 1;
        while (usedPaths.has(`${base}_${n}${ext}`)) n++;
        filePath = `${base}_${n}${ext}`;
      }

      if (content.trim()) {
        usedPaths.add(filePath);
        files.push({ path: filePath, language, content });
        if (truncated) {
          // 截断块：内容可能不完整，收下但告警，便于上层/调试察觉
          console.warn(`[code-parser] 检测到未闭合代码块（LLM 输出可能被截断）: ${filePath}`);
        }
      }
      continue;
    }

    i++;
  }

  return files;
}

export function buildFileTree(files: ExtractedFile[]): FileTreeNode {
  const root: FileTreeNode = { name: '', path: '', type: 'dir', children: [] };

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const partName = parts[i];
      const partPath = parts.slice(0, i + 1).join('/');

      if (isLast) {
        current.children!.push({
          name: partName,
          path: partPath,
          type: 'file',
          language: file.language,
          size: file.content.length,
        });
      } else {
        let dir = current.children!.find(c => c.type === 'dir' && c.name === partName);
        if (!dir) {
          dir = { name: partName, path: partPath, type: 'dir', children: [] };
          current.children!.push(dir);
        }
        current = dir;
      }
    }
  }

  return root;
}
