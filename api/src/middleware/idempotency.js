import crypto from 'node:crypto';
import { adminPool } from '../db/client.js';

function canonicalizeValue(val) {
  if (val === null || val === undefined || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => (item === undefined ? null : canonicalizeValue(item)));
  }
  const sorted = {};
  for (const key of Object.keys(val).sort()) {
    if (val[key] !== undefined) {
      sorted[key] = canonicalizeValue(val[key]);
    }
  }
  return sorted;
}

export function canonicalHashBody(body) {
  const normalized = canonicalizeValue(body ?? {});
  const serialized = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

export function idempotencyGuard(options = {}) {
  return async function idempotencyMiddleware(req, res, next) {
    const rawHeader = req.get('Idempotency-Key');
    if (rawHeader === undefined || rawHeader === null) {
      const mustRequire =
        options.requireHeader ??
        (process.env.REQUIRE_IDEMPOTENCY_KEY !== undefined
          ? process.env.REQUIRE_IDEMPOTENCY_KEY === 'true'
          : process.env.NODE_ENV === 'production');
      if (mustRequire) {
        return res.status(400).json({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Thiếu header Idempotency-Key bắt buộc cho thao tác ghi dữ liệu.',
        });
      }
      return next();
    }

    const idemKey = String(rawHeader).trim();
    if (idemKey.length < 1 || idemKey.length > 255) {
      return res.status(400).json({
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Header Idempotency-Key phải có độ dài từ 1 đến 255 ký tự.',
      });
    }

    const orgId = req.user?.org_id;
    const actorId = req.user?.sub || req.user?.id;
    if (!orgId || !actorId) {
      return next();
    }

    const method = String(req.method || 'POST').toUpperCase();
    const routePath = `${req.baseUrl || ''}${req.path || ''}` || req.originalUrl.split('?')[0];
    const requestHash = canonicalHashBody(req.body);

    try {
      await adminPool.query(
        `DELETE FROM idempotency_key
         WHERE org_id = $1
           AND actor_id = $2
           AND method = $3
           AND route_path = $4
           AND idem_key = $5
           AND expires_at <= NOW()`,
        [orgId, actorId, method, routePath, idemKey]
      );

      const claimRes = await adminPool.query(
        `INSERT INTO idempotency_key (org_id, actor_id, idem_key, method, route_path, request_hash, state)
         VALUES ($1, $2, $3, $4, $5, $6, 'IN_PROGRESS')
         ON CONFLICT (org_id, actor_id, method, route_path, idem_key) DO NOTHING
         RETURNING id`,
        [orgId, actorId, idemKey, method, routePath, requestHash]
      );

      if (claimRes.rows.length === 0) {
        const existingRes = await adminPool.query(
          `SELECT id, request_hash, state, status_code, response_body
           FROM idempotency_key
           WHERE org_id = $1
             AND actor_id = $2
             AND method = $3
             AND route_path = $4
             AND idem_key = $5
           LIMIT 1`,
          [orgId, actorId, method, routePath, idemKey]
        );

        if (existingRes.rows.length > 0) {
          const row = existingRes.rows[0];
          if (row.request_hash !== requestHash) {
            return res.status(409).json({
              code: 'IDEMPOTENCY_KEY_CONFLICT',
              message: 'Khóa Idempotency-Key đã được sử dụng với dữ liệu đầu vào khác.',
            });
          }
          if (row.state === 'IN_PROGRESS') {
            return res.status(409).json({
              code: 'IDEMPOTENCY_IN_PROGRESS',
              message: 'Yêu cầu cùng Idempotency-Key đang được xử lý, vui lòng đợi.',
            });
          }
          res.set('Idempotent-Replayed', 'true');
          return res.status(row.status_code || 200).json(row.response_body);
        }
      }

      const recordId = claimRes.rows[0]?.id;
      if (!recordId) {
        return next();
      }

      let settled = false;
      const origJson = res.json.bind(res);

      res.json = function patchedIdempotentJson(payload) {
        if (settled) {
          return origJson(payload);
        }
        settled = true;
        const statusCode = res.statusCode || 200;
        const shouldPersist =
          (statusCode >= 200 && statusCode < 300) ||
          payload?.code === 'PRICE_NEEDS_APPROVAL';

        const persistOp = shouldPersist
          ? adminPool.query(
              `UPDATE idempotency_key
               SET state = 'COMPLETED',
                   status_code = $1,
                   response_body = $2::jsonb
               WHERE id = $3`,
              [statusCode, JSON.stringify(payload ?? null), recordId]
            )
          : adminPool.query(`DELETE FROM idempotency_key WHERE id = $1`, [recordId]);

        persistOp
          .catch((err) => {
            console.error('[Idempotency Finalize Error]:', err);
          })
          .finally(() => {
            origJson(payload);
          });

        return res;
      };

      res.on('close', () => {
        if (!settled) {
          settled = true;
          adminPool
            .query(`DELETE FROM idempotency_key WHERE id = $1 AND state = 'IN_PROGRESS'`, [recordId])
            .catch(() => {});
        }
      });

      return next();
    } catch (err) {
      console.error('[Idempotency Middleware Error]:', err);
      return next(err);
    }
  };
}
