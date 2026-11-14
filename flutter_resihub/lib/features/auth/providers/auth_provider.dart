import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/roles.dart';
import '../../../core/network/query_cache.dart';
import '../../../core/network/session_lifecycle_bridge.dart';
import '../../../core/storage/app_storage.dart';
import '../../../core/utils/permissions.dart';
import '../models/user_model.dart';
import '../services/auth_service.dart';

/// Immutable authentication state representing the current session.
@immutable
class AuthState {
  final UserModel? user;
  final String? accessToken;
  final String? refreshToken;
  final bool isAuthenticated;
  final String selectedBuildingId;
  final bool isLoading;
  final String? errorMessage;

  const AuthState({
    this.user,
    this.accessToken,
    this.refreshToken,
    this.isAuthenticated = false,
    this.selectedBuildingId = '',
    this.isLoading = false,
    this.errorMessage,
  });

  /// Primary role based on hierarchy: SYS_ADMIN > OWNER > MANAGER > RESIDENT.
  AppRole get primaryRole => user?.primaryRole ?? AppRole.resident;

  /// Role codes of the current user.
  List<String> get roleCodes => user?.roleCodes ?? const [];

  /// Assigned building IDs for the current user.
  List<String> get assignedBuildingIds => user?.assignedBuildingIds ?? const [];

  /// True if user is authorized for Admin Portal.
  bool get isAdminPortal => user?.isAdminPortal ?? false;

  /// Checks if user has any of the specified roles.
  bool hasRole(dynamic allowedRoles) =>
      user != null && hasAnyRole(user, allowedRoles);

  AuthState copyWith({
    UserModel? user,
    String? accessToken,
    String? refreshToken,
    bool? isAuthenticated,
    String? selectedBuildingId,
    bool? isLoading,
    String? errorMessage,
  }) {
    return AuthState(
      user: user ?? this.user,
      accessToken: accessToken ?? this.accessToken,
      refreshToken: refreshToken ?? this.refreshToken,
      isAuthenticated: isAuthenticated ?? this.isAuthenticated,
      selectedBuildingId: selectedBuildingId ?? this.selectedBuildingId,
      isLoading: isLoading ?? this.isLoading,
      errorMessage: errorMessage,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AuthState &&
          runtimeType == other.runtimeType &&
          user == other.user &&
          accessToken == other.accessToken &&
          refreshToken == other.refreshToken &&
          isAuthenticated == other.isAuthenticated &&
          selectedBuildingId == other.selectedBuildingId &&
          isLoading == other.isLoading &&
          errorMessage == other.errorMessage;

  @override
  int get hashCode => Object.hash(
        user,
        accessToken,
        refreshToken,
        isAuthenticated,
        selectedBuildingId,
        isLoading,
        errorMessage,
      );

  @override
  String toString() =>
      'AuthState(user: ${user?.id}, isAuth: $isAuthenticated, buildingId: $selectedBuildingId)';
}

/// State notifier managing authentication, session hydration, and building selection.
/// Matches `frontend/src/stores/authStore.js`.
class AuthNotifier extends Notifier<AuthState> {
  @override
  AuthState build() {
    final storage = ref.watch(appStorageProvider);
    final sessionBridge = ref.watch(sessionLifecycleBridgeProvider);

    // Register SessionLifecycleBridge listeners
    void onTokenRefreshed(Map<String, dynamic>? updatedUser, String newAccessToken) {
      if (updatedUser != null) {
        final currentMap = state.user?.toJson() ?? <String, dynamic>{};
        final merged = {...currentMap, ...updatedUser};
        final newUser = UserModel.fromJson(merged);
        storage.setUser(newUser.toJson());
        state = state.copyWith(
          user: newUser,
          accessToken: newAccessToken,
          isAuthenticated: true,
        );
      } else {
        state = state.copyWith(
          accessToken: newAccessToken,
          isAuthenticated: true,
        );
      }
    }

    void onSessionExpired() {
      clearSession();
    }

    sessionBridge.addTokenRefreshedListener(onTokenRefreshed);
    sessionBridge.addSessionExpiredListener(onSessionExpired);

    ref.onDispose(() {
      sessionBridge.removeTokenRefreshedListener(onTokenRefreshed);
      sessionBridge.removeSessionExpiredListener(onSessionExpired);
    });

    // Hydrate initial state from AppStorage
    final cachedUserMap = storage.user;
    final user = cachedUserMap != null ? UserModel.fromJson(cachedUserMap) : null;
    final accessToken = storage.accessToken;
    final refreshToken = storage.refreshToken;
    final isAuthenticated = storage.isAuthenticated;
    final selectedBuildingId = storage.selectedBuildingId ?? '';

    return AuthState(
      user: user,
      accessToken: accessToken,
      refreshToken: refreshToken,
      isAuthenticated: isAuthenticated,
      selectedBuildingId: selectedBuildingId,
    );
  }

  /// Sets tokens and user data on successful login/verify.
  /// Matching `frontend/src/stores/authStore.js:setAuthData`.
  Future<void> setAuthData({
    required String accessToken,
    String? refreshToken,
    required UserModel user,
  }) async {
    final storage = ref.read(appStorageProvider);
    final queryCache = ref.read(queryCacheProvider);

    queryCache.clear();
    await storage.setTokens(
      accessToken: accessToken,
      refreshToken: refreshToken,
    );
    await storage.setUser(user.toJson());

    // Auto-select building if exactly 1 assigned
    final assigned = user.assignedBuildingIds;
    final initialBuildingId = assigned.length == 1 ? assigned.first : '';
    await storage.setSelectedBuildingId(initialBuildingId.isNotEmpty ? initialBuildingId : null);

    state = state.copyWith(
      accessToken: accessToken,
      refreshToken: refreshToken ?? state.refreshToken,
      user: user,
      isAuthenticated: true,
      selectedBuildingId: initialBuildingId,
    );
  }

  /// Updates or merges partial user data into the current session and storage.
  /// Matching `frontend/src/stores/authStore.js:updateUser`.
  Future<void> updateUser(dynamic partialUser) async {
    final storage = ref.read(appStorageProvider);
    final currentMap = state.user?.toJson() ?? <String, dynamic>{};

    final Map<String, dynamic> patchMap;
    if (partialUser is UserModel) {
      patchMap = partialUser.toJson();
    } else if (partialUser is Map<String, dynamic>) {
      patchMap = partialUser;
    } else if (partialUser is Map) {
      patchMap = Map<String, dynamic>.from(partialUser);
    } else {
      return;
    }

    final merged = {...currentMap, ...patchMap};
    final newUser = UserModel.fromJson(merged);

    state = state.copyWith(user: newUser);
    await storage.setUser(newUser.toJson());
  }

  /// Changes the globally active building context.
  /// Matching `frontend/src/stores/authStore.js:setSelectedBuildingId`.
  Future<void> setSelectedBuildingId(String? buildingId) async {
    final storage = ref.read(appStorageProvider);
    final val = buildingId?.trim() ?? '';
    await storage.setSelectedBuildingId(val.isNotEmpty ? val : null);
    state = state.copyWith(selectedBuildingId: val);
  }

  /// Clears user session, auth tokens, selectedBuildingId, and queryCache.
  /// Matching `frontend/src/stores/authStore.js:clearSession`.
  Future<void> clearSession() async {
    final storage = ref.read(appStorageProvider);
    final queryCache = ref.read(queryCacheProvider);

    // Update memory state and queryCache immediately
    queryCache.clear();
    state = const AuthState(
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      selectedBuildingId: '',
      isLoading: false,
      errorMessage: null,
    );

    // Persist session clearing to storage
    await storage.clearSession();
    await storage.setSelectedBuildingId(null);
  }

  /// Performs server logout and clears local session state.
  Future<void> logout() async {
    try {
      final authService = ref.read(authServiceProvider);
      await authService.logout();
    } catch (_) {
      // Ignore network errors during logout; ensure local cleanup happens
    } finally {
      await clearSession();
    }
  }
}

/// Riverpod provider for application authentication state and actions.
final authProvider = NotifierProvider<AuthNotifier, AuthState>(AuthNotifier.new);
