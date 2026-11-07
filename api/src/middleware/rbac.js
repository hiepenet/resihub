import { logAccessDenied } from '../services/ownerScope.js';

export function requireRole(allowedRoles) {
  return async (req, res, next) => {
    if (!req.user || !req.user.roles) {
      return res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Chưa xác thực người dùng.',
      });
    }

    const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    // FIX BP-006: filter null/undefined trước khi lấy .code để tránh TypeError crash
    const userRoleCodes = req.user.roles
      .filter((r) => r != null)
      .map((r) => (typeof r === 'string' ? r : r.code))
      .filter((code) => typeof code === 'string');
    const hasRole = userRoleCodes.some((code) => roles.includes(code));
    if (!hasRole) {
      const targetId = req.params?.id || req.body?.building_id || req.query?.building_id || null;
      await logAccessDenied(
        req,
        'rbac',
        targetId,
        `Role [${userRoleCodes.join(',')}] not in allowed roles [${roles.join(',')}]`
      );
      return res.status(403).json({
        code: 'FORBIDDEN',
        message: 'Bạn không có quyền thực hiện thao tác này.',
      });
    }

    next();
  };
}
