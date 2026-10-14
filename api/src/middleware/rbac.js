export function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !req.user.roles) {
      return res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Chưa xác thực người dùng.',
      });
    }

    const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    const userRoleCodes = req.user.roles.map((r) => (typeof r === 'string' ? r : r.code));
    
    // SYS_ADMIN bypass
    if (userRoleCodes.includes('SYS_ADMIN')) {
      return next();
    }

    const hasRole = userRoleCodes.some((code) => roles.includes(code));
    if (!hasRole) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        message: 'Bạn không có quyền thực hiện thao tác này.',
      });
    }

    next();
  };
}
