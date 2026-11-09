import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

test('OP01: deploy/restore.sh xóa đúng bảng _migrations(name) khớp migrate.js, dùng run -T cho tar stdin và up -d api worker', () => {
  const migrateSrc = fs.readFileSync(path.join(rootDir, 'api/src/db/migrate.js'), 'utf8');
  assert.match(migrateSrc, /CREATE TABLE IF NOT EXISTS _migrations\s*\(/);

  const restoreSrc = fs.readFileSync(path.join(rootDir, 'deploy/restore.sh'), 'utf8');
  assert.equal(
    restoreSrc.includes('schema_migrations'),
    false,
    'restore.sh không được dùng tên bảng sai schema_migrations'
  );
  assert.match(
    restoreSrc,
    /DELETE FROM _migrations WHERE name IN \('005_rls_enable_and_policies\.sql',\s*'007_grants\.sql'\)/,
    'restore.sh phải xóa 005 & 007 trong bảng _migrations(name) để api tự cấp lại quyền RLS sau --no-acl restore'
  );
  assert.match(
    restoreSrc,
    /compose_cmd run -T --rm --no-deps/,
    'restore.sh phải truyền cờ -T khi stream binary uploads_tar qua stdin'
  );
  assert.equal(
    restoreSrc.includes('compose_cmd start api worker'),
    false,
    'restore.sh không được dùng start api worker làm bỏ qua depends_on healthcheck'
  );
  assert.match(
    restoreSrc,
    /compose_cmd up -d api worker/,
    'restore.sh phải dùng up -d api worker để đảm bảo thứ tự khởi động theo healthcheck'
  );
});

test('OP02: deploy/demo-mode.sh bảo toàn quyền 600 của .env.production khi ghi cập nhật biến', () => {
  const demoSrc = fs.readFileSync(path.join(rootDir, 'deploy/demo-mode.sh'), 'utf8');
  assert.match(
    demoSrc,
    /chmod --reference="\$\{file\}" "\$\{tmp\}"[\s\S]*chmod 600 "\$\{tmp\}"/,
    'set_env_var trong demo-mode.sh phải giữ nguyên quyền hạn (600) trước khi mv đè lên .env.production'
  );
});

test('OP03: .dockerignore ở thư mục gốc chặn rò rỉ .env* (kể cả .env.production), backups và uploads vào build context của web', () => {
  const rootDockerIgnore = fs.readFileSync(path.join(rootDir, '.dockerignore'), 'utf8');
  const lines = rootDockerIgnore
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  assert.equal(lines.includes('.env*'), true, 'Root .dockerignore phải chặn .env*');
  assert.equal(lines.includes('backups'), true, 'Root .dockerignore phải chặn thư mục backups');
  assert.equal(lines.includes('uploads'), true, 'Root .dockerignore phải chặn thư mục uploads');
  assert.equal(lines.includes('api/uploads'), true, 'Root .dockerignore phải chặn api/uploads');
  assert.equal(lines.includes('.superpowers'), true, 'Root .dockerignore phải chặn .superpowers');
});

test('OP04: Tài liệu HUONG_DAN_DEPLOY_UBUNTU.md hướng dẫn dùng up -d api worker (không dùng restart) sau khi đổi APP_DB_PASSWORD', () => {
  const doc = fs.readFileSync(path.join(rootDir, 'deploy/HUONG_DAN_DEPLOY_UBUNTU.md'), 'utf8');
  const passwordTroubleshootingLine = doc
    .split(/\r?\n/)
    .find((line) => line.includes('sau khi đổi') && line.includes('APP_DB_PASSWORD'));
  assert.ok(passwordTroubleshootingLine, 'Phải có mục xử lý sự cố sau khi đổi APP_DB_PASSWORD');
  assert.equal(
    passwordTroubleshootingLine.includes('restart api'),
    false,
    'Không được hướng dẫn restart api vì docker compose restart không nạp lại biến từ .env.production'
  );
  assert.match(passwordTroubleshootingLine, /up -d api worker/);
});

test('OP05: Healthcheck của worker trong docker-compose.prod.yml dùng mẫu regex [s]rc/jobs/worker.js để tránh CMD-SHELL tự khớp chính nó', () => {
  const compose = fs.readFileSync(path.join(rootDir, 'docker-compose.prod.yml'), 'utf8');
  assert.match(
    compose,
    /\[s\]rc\/jobs\/worker\.js/,
    'CMD-SHELL phải dùng [s]rc/jobs/worker.js để không khớp nhầm chuỗi tham số của tiến trình /bin/sh -c'
  );
});
