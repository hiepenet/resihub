// Lưu ảnh base64 (bản ký HĐ, CCCD) vào disk + ghi attachment. ponytail: disk cục bộ,
// không serve static — chỉ đọc qua GET /attachments/:id/view có auth; chuyển storage bucket khi deploy thật.
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const UPLOADS_ROOT = path.join(process.cwd(), 'uploads');
export const IMAGE_MIME_RE = /^data:image\/(jpeg|png);base64,\s*([A-Za-z0-9+/=\r\n]+)$/;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function saveBase64Image({ imageBase64, folder, entityId, entity, ownerId, req, query }) {
  const match = IMAGE_MIME_RE.exec(imageBase64 || '');
  if (!match) {
    return { error: { code: 'VALIDATION_ERROR', message: 'Ảnh phải là base64 JPEG/PNG (data:image/jpeg|png;base64,...).' } };
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { error: { code: 'VALIDATION_ERROR', message: 'Ảnh vượt quá 5MB.' } };
  }
  const ext = match[1] === 'png' ? 'png' : 'jpg';
  const fileName = `${randomUUID()}.${ext}`;
  await mkdir(path.join(UPLOADS_ROOT, folder, entityId), { recursive: true });
  await writeFile(path.join(UPLOADS_ROOT, folder, entityId, fileName), bytes);
  const storagePath = `uploads/${folder}/${entityId}/${fileName}`;
  const attRes = await query(
    `INSERT INTO attachment (owner_entity, owner_id, storage_path, mime, size_bytes, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, storage_path, mime`,
    [entity, ownerId, storagePath, `image/${ext}`, bytes.length, req.user.sub]
  );
  return { attachment: attRes.rows[0], bytes, storagePath };
}
