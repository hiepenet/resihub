// Lưu tệp base64 (bản ký HĐ JPEG/PNG/PDF, ảnh CCCD JPEG/PNG) vào disk + ghi attachment.
// Không serve static — chỉ đọc qua GET /attachments/:id/view có auth; chuyển storage bucket khi deploy thật.
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const UPLOADS_ROOT = path.join(process.cwd(), 'uploads');
export const IMAGE_MIME_RE = /^data:image\/(jpeg|png);base64,\s*([A-Za-z0-9+/=\r\n]+)$/;
export const SCAN_MIME_RE = /^data:(image\/jpeg|image\/png|application\/pdf);base64,\s*([A-Za-z0-9+/=\r\n]+)$/;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CONTRACT_SCAN_BYTES = 10 * 1024 * 1024;

export async function saveBase64Image({
  imageBase64,
  folder,
  entityId,
  entity,
  ownerId,
  req,
  query,
  allowPdf = false,
  maxBytes = MAX_IMAGE_BYTES,
}) {
  let mime;
  let ext;
  let base64Payload;

  if (allowPdf) {
    const match = SCAN_MIME_RE.exec(imageBase64 || '');
    if (!match) {
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Tệp đính kèm phải là base64 JPEG/PNG hoặc PDF (data:image/jpeg|png;base64,... hoặc data:application/pdf;base64,...).',
        },
      };
    }
    mime = match[1];
    base64Payload = match[2];
    ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
  } else {
    const match = IMAGE_MIME_RE.exec(imageBase64 || '');
    if (!match) {
      return { error: { code: 'VALIDATION_ERROR', message: 'Ảnh phải là base64 JPEG/PNG (data:image/jpeg|png;base64,...).' } };
    }
    ext = match[1] === 'png' ? 'png' : 'jpg';
    mime = `image/${ext}`;
    base64Payload = match[2];
  }

  const bytes = Buffer.from(base64Payload, 'base64');
  if (bytes.length > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: allowPdf ? `Tệp đính kèm vượt quá ${maxMb}MB.` : `Ảnh vượt quá ${maxMb}MB.`,
      },
    };
  }

  if (mime === 'application/pdf') {
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      return {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Tệp PDF không hợp lệ hoặc bị hỏng.',
        },
      };
    }
  }

  const fileName = `${randomUUID()}.${ext}`;
  await mkdir(path.join(UPLOADS_ROOT, folder, entityId), { recursive: true });
  await writeFile(path.join(UPLOADS_ROOT, folder, entityId, fileName), bytes);
  const storagePath = `uploads/${folder}/${entityId}/${fileName}`;
  const attRes = await query(
    `INSERT INTO attachment (owner_entity, owner_id, storage_path, mime, size_bytes, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, storage_path, mime`,
    [entity, ownerId, storagePath, mime, bytes.length, req?.user?.sub || null]
  );
  return { attachment: attRes.rows[0], bytes, storagePath };
}
