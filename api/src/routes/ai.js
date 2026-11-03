import express from 'express';
import { adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import { aiRateLimiter } from '../middleware/rateLimiter.js';
import {
  getUserRoleCodes,
  getOwnerBuildingIds,
  getManagerBuildingIds,
  logAccessDenied,
} from '../services/ownerScope.js';
import {
  runExtractSuggestion,
  runMeterOcrSuggestion,
  runTicketTriageSuggestion,
  reviewAiSuggestion,
  getOrgAiUsageSummary,
} from '../services/aiGateway.js';

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendAiRouteError(res, err, fallbackMessage) {
  const status = err.status || err.httpStatus || 500;
  const code = err.code || (status === 500 ? 'AI_GATEWAY_ERROR' : 'VALIDATION_ERROR');
  if (status >= 500 && status !== 503 && status !== 504 && status !== 502) {
    console.error('[AI Route Error]:', err);
  }
  return res.status(status).json({
    code,
    message: err.message || fallbackMessage,
  });
}

/**
 * POST /api/v1/ai/extract (AI-01 — FR-059, PRD 12.1)
 * Trích xuất dữ liệu nháp từ ảnh CCCD (SYS_ADMIN, MANAGER) hoặc ảnh/PDF Hợp đồng giấy (MANAGER).
 * Không ghi vào bảng person/tenant/contract — chỉ tạo bản ghi ai_suggestion PENDING.
 */
router.post(
  '/extract',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  aiRateLimiter,
  idempotencyGuard(),
  async (req, res) => {
    const {
      document_type = 'CCCD',
      building_id = null,
      files = [],
      privacy_acknowledged = false,
    } = req.body || {};

    const orgId = req.user.org_id;
    const roleCodes = getUserRoleCodes(req);
    const isSysAdmin = roleCodes.includes('SYS_ADMIN');
    const isManager = roleCodes.includes('MANAGER');
    const docTypeNorm = String(document_type || 'CCCD').trim().toUpperCase();

    if (!['CCCD', 'CONTRACT'].includes(docTypeNorm)) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Loại tài liệu trích xuất phải là CCCD hoặc CONTRACT.',
      });
    }

    // PRD 6.2: SYS_ADMIN có CRUD trên Cư dân (CCCD) nhưng chỉ R trên Hợp đồng
    if (docTypeNorm === 'CONTRACT' && isSysAdmin && !isManager) {
      return res.status(403).json({
        code: 'FORBIDDEN_ROLE',
        message: 'Quản trị hệ thống chỉ có quyền trích xuất CCCD cho hồ sơ cư dân, không lập hợp đồng.',
      });
    }

    let validatedBuildingId = null;
    if (building_id !== null && building_id !== undefined && String(building_id).trim() !== '') {
      const rawBid = String(building_id).trim();
      if (!UUID_RE.test(rawBid)) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Mã tòa nhà không hợp lệ.' });
      }
      const bRes = await adminPool.query(
        `SELECT id, org_id FROM building WHERE id = $1 LIMIT 1`,
        [rawBid]
      );
      if (bRes.rows.length === 0 || bRes.rows[0].org_id !== orgId) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tòa nhà.' });
      }
      if (!isSysAdmin) {
        const mgrBuildingIds = await getManagerBuildingIds(req.user.sub, orgId);
        if (!mgrBuildingIds.includes(rawBid)) {
          await logAccessDenied(req, 'building', rawBid, 'MANAGER attempted AI extract outside assigned building');
          return res.status(403).json({
            code: 'ACCESS_DENIED',
            message: 'Bạn không được phân công quản lý tòa nhà này.',
          });
        }
      }
      validatedBuildingId = rawBid;
    }

    const { client, release } = await getUserClient(req);
    let inTx = false;
    try {
      await client.query('BEGIN');
      inTx = true;
      const suggestion = await runExtractSuggestion(client, {
        actorId: req.user.sub,
        orgId,
        buildingId: validatedBuildingId,
        documentType: docTypeNorm,
        filesBase64: Array.isArray(files) ? files : [files],
        privacyAcknowledged: privacy_acknowledged === true,
      });
      await client.query('COMMIT');
      inTx = false;

      return res.json({
        message:
          docTypeNorm === 'CONTRACT'
            ? 'AI đã trích xuất thông tin nháp từ tài liệu hợp đồng. Vui lòng kiểm tra và xác nhận.'
            : 'AI đã trích xuất thông tin nháp từ ảnh CCCD. Vui lòng kiểm tra và xác nhận.',
        data: suggestion,
      });
    } catch (err) {
      if (inTx) await client.query('ROLLBACK').catch(() => {});
      return sendAiRouteError(res, err, 'Không thể trích xuất dữ liệu tài liệu bằng AI.');
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/ai/meter-ocr (AI-02 — FR-030, FR-059, US-014, AC-014.1, AC-014.2)
 * Đọc chỉ số đồng hồ điện/nước từ ảnh chụp dành riêng cho MANAGER phụ trách tòa nhà.
 */
router.post(
  '/meter-ocr',
  authenticateToken,
  requireRole(['MANAGER']),
  aiRateLimiter,
  idempotencyGuard(),
  async (req, res) => {
    const { meter_id, period, image_base64 } = req.body || {};
    const orgId = req.user.org_id;

    if (!meter_id || !UUID_RE.test(String(meter_id))) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Mã đồng hồ (meter_id) là bắt buộc và phải đúng định dạng UUID.',
      });
    }

    const { client, release } = await getUserClient(req);
    let inTx = false;
    try {
      const scopeRes = await client.query(
        `SELECT * FROM fn_get_ops_resource_scope('meter', $1)`,
        [meter_id]
      );
      if (scopeRes.rows.length === 0 || scopeRes.rows[0].org_id !== orgId) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đồng hồ điện/nước.' });
      }
      const buildingId = scopeRes.rows[0].building_id;
      const mgrBuildingIds = await getManagerBuildingIds(req.user.sub, orgId);
      if (!mgrBuildingIds.includes(buildingId)) {
        await logAccessDenied(req, 'meter', meter_id, 'MANAGER attempted AI meter OCR outside assigned building');
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền đọc chỉ số đồng hồ thuộc tòa nhà khác.',
        });
      }

      await client.query('BEGIN');
      inTx = true;
      const suggestion = await runMeterOcrSuggestion(client, {
        actorId: req.user.sub,
        orgId,
        buildingId,
        meterId: meter_id,
        ...(period ? { period } : {}),
        imageBase64: image_base64,
      });
      await client.query('COMMIT');
      inTx = false;

      return res.json({
        message:
          suggestion.output.reading === null
            ? 'Ảnh đồng hồ chưa đủ rõ để AI tự điền chỉ số — vui lòng nhập tay.'
            : 'AI đã đọc chỉ số đồng hồ nháp — vui lòng kiểm tra trước khi lưu.',
        data: suggestion,
      });
    } catch (err) {
      if (inTx) await client.query('ROLLBACK').catch(() => {});
      return sendAiRouteError(res, err, 'Không thể đọc chỉ số đồng hồ bằng AI.');
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/ai/classify (AI-03 — FR-043, US-011, AC-011.1, AC-011.2)
 * Phân loại & gợi ý định tuyến lại yêu cầu báo hỏng theo yêu cầu của MANAGER.
 */
router.post(
  '/classify',
  authenticateToken,
  requireRole(['MANAGER']),
  aiRateLimiter,
  idempotencyGuard(),
  async (req, res) => {
    const { service_request_id } = req.body || {};
    const orgId = req.user.org_id;

    if (!service_request_id || !UUID_RE.test(String(service_request_id))) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Mã yêu cầu sửa chữa (service_request_id) là bắt buộc.',
      });
    }

    const { client, release } = await getUserClient(req);
    let inTx = false;
    try {
      const scopeRes = await client.query(
        `SELECT * FROM fn_get_ops_resource_scope('service_request', $1)`,
        [service_request_id]
      );
      if (scopeRes.rows.length === 0 || scopeRes.rows[0].org_id !== orgId) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu sửa chữa.' });
      }
      const buildingId = scopeRes.rows[0].building_id;
      const mgrBuildingIds = await getManagerBuildingIds(req.user.sub, orgId);
      if (!mgrBuildingIds.includes(buildingId)) {
        await logAccessDenied(
          req,
          'service_request',
          service_request_id,
          'MANAGER attempted AI classify outside assigned building'
        );
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền phân loại yêu cầu của tòa nhà khác.',
        });
      }

      await client.query('BEGIN');
      inTx = true;
      const suggestion = await runTicketTriageSuggestion(client, {
        actorId: req.user.sub,
        orgId,
        buildingId,
        serviceRequestId: service_request_id,
        useBackgroundRpc: false,
      });
      await client.query('COMMIT');
      inTx = false;

      return res.json({
        message: 'AI đã cập nhật gợi ý phân loại yêu cầu báo hỏng.',
        data: suggestion,
      });
    } catch (err) {
      if (inTx) await client.query('ROLLBACK').catch(() => {});
      return sendAiRouteError(res, err, 'Không thể phân loại yêu cầu bằng AI.');
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/ai/suggestions/:id/review
 * Xác nhận hoặc từ chối gợi ý AI thủ công (SYS_ADMIN cho CCCD, MANAGER cho tòa phụ trách).
 */
router.post(
  '/suggestions/:id/review',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { decision = 'ACCEPT', final_values = {}, target_entity_id = null } = req.body || {};

    if (!UUID_RE.test(String(id || ''))) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy gợi ý AI.' });
    }

    const { client, release } = await getUserClient(req);
    let inTx = false;
    try {
      await client.query('BEGIN');
      inTx = true;
      const reviewed = await reviewAiSuggestion(client, {
        suggestionId: id,
        actorId: req.user.sub,
        decision,
        finalValues: final_values && typeof final_values === 'object' ? final_values : {},
        targetEntityId: target_entity_id || null,
      });
      await client.query('COMMIT');
      inTx = false;

      return res.json({
        message: decision === 'REJECT' ? 'Đã bỏ qua gợi ý AI.' : 'Đã xác nhận gợi ý AI.',
        data: reviewed,
      });
    } catch (err) {
      if (inTx) await client.query('ROLLBACK').catch(() => {});
      if ((err.status || err.httpStatus) === 403 && err.code === 'ACCESS_DENIED') {
        await logAccessDenied(
          req,
          'ai_suggestion',
          id,
          err.message || 'Unauthorized AI suggestion review attempt'
        );
      }
      return sendAiRouteError(res, err, 'Lỗi khi cập nhật trạng thái gợi ý AI.');
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/ai/usage
 * Thống kê hạn mức token/chi phí tháng và KPI G6 (tỷ lệ chấp nhận gợi ý AI).
 */
router.get(
  '/usage',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const orgId = req.user.org_id;
    const rawBuildingId = req.query.building_id ? String(req.query.building_id).trim() : null;
    const roleCodes = getUserRoleCodes(req);
    const isSysAdmin = roleCodes.includes('SYS_ADMIN');
    const isOwner = roleCodes.includes('OWNER');

    if (rawBuildingId) {
      if (!UUID_RE.test(rawBuildingId)) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Mã tòa nhà không hợp lệ.' });
      }
      if (!isSysAdmin) {
        const allowedIds = isOwner
          ? await getOwnerBuildingIds(req.user.sub, orgId)
          : await getManagerBuildingIds(req.user.sub, orgId);
        if (!allowedIds.includes(rawBuildingId)) {
          await logAccessDenied(req, 'building', rawBuildingId, 'Actor requested AI usage outside building scope');
          return res.status(403).json({
            code: 'ACCESS_DENIED',
            message: 'Bạn không có quyền xem thống kê AI của tòa nhà này.',
          });
        }
      }
    }

    const { client, release } = await getUserClient(req);
    try {
      const summary = await getOrgAiUsageSummary(client, {
        orgId,
        buildingId: rawBuildingId,
      });
      return res.json({ data: summary });
    } catch (err) {
      console.error('[AI Usage Error]:', err);
      return res.status(500).json({
        code: 'DB_ERROR',
        message: 'Lỗi khi tải thống kê sử dụng AI Gateway.',
      });
    } finally {
      await release();
    }
  }
);

export default router;

