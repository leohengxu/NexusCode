import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { FileService } from './file.service';

test('resolveWithin rejects parent traversal and absolute paths', () => {
  const service = new FileService();
  const root = path.resolve('uploads', 'project', 'code');

  assert.throws(() => service.resolveWithin(root, '../outside.txt'), /非法文件路径/);
  assert.throws(() => service.resolveWithin(root, path.resolve(root, '..', 'outside.txt')), /非法文件路径/);
});

test('resolveWithin accepts a normalized child path', () => {
  const service = new FileService();
  const root = path.resolve('uploads', 'project', 'code');

  assert.equal(
    service.resolveWithin(root, 'src\\pages/../main.tsx'),
    path.join(root, 'src', 'main.tsx'),
  );
});
