import '../constants/roles.dart';
import '../../features/auth/models/user_model.dart';

/// Extracts unique, non-empty role codes from a user instance ([UserModel] or [Map]).
/// Matching `frontend/src/utils/permissions.js:extractRoleCodes`.
List<String> extractRoleCodes(dynamic user) {
  if (user == null) return [];

  if (user is UserModel) {
    final codes = <String>[];
    for (final role in user.roles) {
      final code = role.code.trim();
      if (code.isNotEmpty && !codes.contains(code)) {
        codes.add(code);
      }
    }
    return codes;
  }

  if (user is Map) {
    final rawRoles = user['roles'];
    if (rawRoles is! List) return [];
    final codes = <String>[];
    for (final r in rawRoles) {
      String? code;
      if (r is String) {
        code = r.trim();
      } else if (r is Map) {
        code = r['code']?.toString().trim();
      }
      if (code != null && code.isNotEmpty && !codes.contains(code)) {
        codes.add(code);
      }
    }
    return codes;
  }

  return [];
}

/// Resolves the primary role of a user following authority priority:
/// SYS_ADMIN > OWNER > MANAGER > RESIDENT.
/// Matching `frontend/src/utils/permissions.js:getPrimaryRole`.
AppRole getPrimaryRole(dynamic user) {
  final codes = extractRoleCodes(user);
  for (final prio in kRolePriority) {
    if (codes.contains(prio.code)) {
      return prio;
    }
  }
  return AppRole.resident;
}

/// Checks if the user holds at least one of the [allowedRoles].
/// [allowedRoles] can be an [AppRole], a [String], a `List<AppRole>`, `List<String>`, or null/empty.
/// Matching `frontend/src/utils/permissions.js:hasAnyRole`.
bool hasAnyRole(dynamic user, dynamic allowedRoles) {
  if (allowedRoles == null) return true;

  final allowedCodes = <String>{};
  if (allowedRoles is Iterable) {
    if (allowedRoles.isEmpty) return true;
    for (final item in allowedRoles) {
      if (item is AppRole) {
        allowedCodes.add(item.code);
      } else if (item != null) {
        final str = item.toString().trim();
        if (str.isNotEmpty) allowedCodes.add(str);
      }
    }
    if (allowedCodes.isEmpty) return true;
  } else if (allowedRoles is AppRole) {
    allowedCodes.add(allowedRoles.code);
  } else {
    final str = allowedRoles.toString().trim();
    if (str.isEmpty) return true;
    allowedCodes.add(str);
  }

  final codes = extractRoleCodes(user);
  return codes.any(allowedCodes.contains);
}

/// Determines if the user is authorized to access the admin portal
/// (SYS_ADMIN, OWNER, or MANAGER).
/// Matching `frontend/src/utils/permissions.js:isAdminPortalUser`.
bool isAdminPortalUser(dynamic user) {
  return hasAnyRole(user, kAdminPortalRoles);
}

/// Extracts deduplicated building IDs assigned to the user from their roles.
/// Matching `frontend/src/utils/permissions.js:getAssignedBuildingIds`.
List<String> getAssignedBuildingIds(dynamic user) {
  if (user == null) return [];

  if (user is UserModel) {
    return user.assignedBuildingIds;
  }

  if (user is Map) {
    final rawRoles = user['roles'];
    if (rawRoles is! List) return [];
    final set = <String>{};
    for (final r in rawRoles) {
      if (r is Map && r['building_id'] != null) {
        final id = r['building_id'].toString().trim();
        if (id.isNotEmpty) set.add(id);
      }
    }
    return set.toList();
  }

  return [];
}
