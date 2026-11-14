import 'package:flutter/foundation.dart';

import '../../../core/constants/roles.dart';
import '../../../core/utils/permissions.dart';

/// Single role assignment model for a user, optionally scoped to a building.
@immutable
class UserRoleModel {
  final String code;
  final String? name;
  final String? buildingId;

  const UserRoleModel({
    required this.code,
    this.name,
    this.buildingId,
  });

  AppRole get appRole => AppRole.fromCode(code);

  factory UserRoleModel.fromJson(dynamic json) {
    if (json is String) {
      return UserRoleModel(code: json.trim());
    }
    if (json is Map) {
      return UserRoleModel(
        code: json['code']?.toString().trim() ?? '',
        name: json['name']?.toString().trim(),
        buildingId: json['building_id']?.toString().trim() ??
            json['buildingId']?.toString().trim(),
      );
    }
    return const UserRoleModel(code: '');
  }

  Map<String, dynamic> toJson() {
    return {
      'code': code,
      if (name != null) 'name': name,
      if (buildingId != null) 'building_id': buildingId,
    };
  }

  UserRoleModel copyWith({
    String? code,
    String? name,
    String? buildingId,
  }) {
    return UserRoleModel(
      code: code ?? this.code,
      name: name ?? this.name,
      buildingId: buildingId ?? this.buildingId,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UserRoleModel &&
          runtimeType == other.runtimeType &&
          code == other.code &&
          name == other.name &&
          buildingId == other.buildingId;

  @override
  int get hashCode => Object.hash(code, name, buildingId);

  @override
  String toString() => 'UserRoleModel(code: $code, buildingId: $buildingId)';
}

/// Canonical authenticated user model in ResiHub.
@immutable
class UserModel {
  final String id;
  final String fullName;
  final String? email;
  final String? phone;
  final String? orgId;
  final String? personId;
  final String? avatarUrl;
  final int? tokenVersion;
  final List<UserRoleModel> roles;

  const UserModel({
    required this.id,
    required this.fullName,
    this.email,
    this.phone,
    this.orgId,
    this.personId,
    this.avatarUrl,
    this.tokenVersion,
    this.roles = const [],
  });

  /// Primary role based on hierarchy: SYS_ADMIN > OWNER > MANAGER > RESIDENT.
  AppRole get primaryRole => getPrimaryRole(this);

  /// List of unique role codes for this user.
  List<String> get roleCodes {
    final list = <String>[];
    for (final r in roles) {
      final c = r.code.trim();
      if (c.isNotEmpty && !list.contains(c)) {
        list.add(c);
      }
    }
    return list;
  }

  /// List of unique building IDs assigned to this user across their roles.
  List<String> get assignedBuildingIds {
    final list = <String>[];
    for (final r in roles) {
      final bId = r.buildingId?.trim();
      if (bId != null && bId.isNotEmpty && !list.contains(bId)) {
        list.add(bId);
      }
    }
    return list;
  }

  /// True if user has any administrative portal role (SYS_ADMIN, OWNER, MANAGER).
  bool get isAdminPortal => isAdminPortalUser(this);

  factory UserModel.fromJson(Map<String, dynamic> json) {
    final rawRoles = json['roles'];
    final parsedRoles = <UserRoleModel>[];
    if (rawRoles is List) {
      for (final r in rawRoles) {
        if (r != null) {
          parsedRoles.add(UserRoleModel.fromJson(r));
        }
      }
    }

    final id = json['id']?.toString() ??
        json['sub']?.toString() ??
        json['user_id']?.toString() ??
        '';

    final fullName = json['full_name']?.toString() ??
        json['fullName']?.toString() ??
        json['name']?.toString() ??
        '';

    final tokenVer = json['token_version'] ?? json['tokenVersion'];

    return UserModel(
      id: id,
      fullName: fullName,
      email: json['email']?.toString(),
      phone: json['phone']?.toString(),
      orgId: json['org_id']?.toString() ?? json['orgId']?.toString(),
      personId: json['person_id']?.toString() ?? json['personId']?.toString(),
      avatarUrl: json['avatar_url']?.toString() ?? json['avatarUrl']?.toString(),
      tokenVersion: tokenVer is int ? tokenVer : int.tryParse(tokenVer?.toString() ?? ''),
      roles: List.unmodifiable(parsedRoles),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'sub': id,
      'full_name': fullName,
      if (email != null) 'email': email,
      if (phone != null) 'phone': phone,
      if (orgId != null) 'org_id': orgId,
      if (personId != null) 'person_id': personId,
      if (avatarUrl != null) 'avatar_url': avatarUrl,
      if (tokenVersion != null) 'token_version': tokenVersion,
      'roles': roles.map((r) => r.toJson()).toList(),
    };
  }

  UserModel copyWith({
    String? id,
    String? fullName,
    String? email,
    String? phone,
    String? orgId,
    String? personId,
    String? avatarUrl,
    int? tokenVersion,
    List<UserRoleModel>? roles,
  }) {
    return UserModel(
      id: id ?? this.id,
      fullName: fullName ?? this.fullName,
      email: email ?? this.email,
      phone: phone ?? this.phone,
      orgId: orgId ?? this.orgId,
      personId: personId ?? this.personId,
      avatarUrl: avatarUrl ?? this.avatarUrl,
      tokenVersion: tokenVersion ?? this.tokenVersion,
      roles: roles != null ? List.unmodifiable(roles) : this.roles,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is UserModel &&
          runtimeType == other.runtimeType &&
          id == other.id &&
          fullName == other.fullName &&
          email == other.email &&
          phone == other.phone &&
          orgId == other.orgId &&
          personId == other.personId &&
          avatarUrl == other.avatarUrl &&
          tokenVersion == other.tokenVersion &&
          listEquals(roles, other.roles);

  @override
  int get hashCode => Object.hash(
        id,
        fullName,
        email,
        phone,
        orgId,
        personId,
        avatarUrl,
        tokenVersion,
        Object.hashAll(roles),
      );

  @override
  String toString() => 'UserModel(id: $id, fullName: $fullName, roles: $roles)';
}
