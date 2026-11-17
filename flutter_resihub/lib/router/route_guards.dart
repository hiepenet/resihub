import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/auth/providers/auth_provider.dart';
import '../../shared/widgets/common/access_denied.dart';

/// Notifier that bridges Riverpod [authProvider] to GoRouter's [refreshListenable].
///
/// Only triggers [notifyListeners] when:
/// 1. `isAuthenticated` changes (e.g. login, logout, session expiration)
/// 2. User `roleCodes` change (e.g. role escalation or alteration)
///
/// Operational changes like `selectedBuildingId` switching or editing user
/// profile fields (name, phone) do NOT notify and therefore preserve the current
/// navigation stack.
class RouterRefreshNotifier extends ChangeNotifier {
  bool _isAuthenticated;
  List<String> _sortedRoles;

  RouterRefreshNotifier({
    bool isAuthenticated = false,
    List<String> roleCodes = const [],
  })  : _isAuthenticated = isAuthenticated,
        _sortedRoles = _sortRoles(roleCodes);

  static List<String> _sortRoles(List<String> roles) {
    final copy = List<String>.from(roles)..sort();
    return copy;
  }

  bool get isAuthenticated => _isAuthenticated;
  List<String> get sortedRoles => List.unmodifiable(_sortedRoles);

  /// Synchronizes state from an incoming [AuthState], notifying only on relevant changes.
  void updateFromAuthState(AuthState state) {
    final nextAuth = state.isAuthenticated;
    final nextSortedRoles = _sortRoles(state.roleCodes);

    final authChanged = _isAuthenticated != nextAuth;
    final rolesChanged = !listEquals(_sortedRoles, nextSortedRoles);

    if (authChanged || rolesChanged) {
      _isAuthenticated = nextAuth;
      _sortedRoles = nextSortedRoles;
      notifyListeners();
    }
  }
}

/// Riverpod provider for [RouterRefreshNotifier].
/// Uses `ref.listen` on [authProvider] so the notifier remains a long-lived singleton.
final routerRefreshNotifierProvider = Provider<RouterRefreshNotifier>((ref) {
  final initialAuth = ref.read(authProvider);
  final notifier = RouterRefreshNotifier(
    isAuthenticated: initialAuth.isAuthenticated,
    roleCodes: initialAuth.roleCodes,
  );

  ref.listen<AuthState>(authProvider, (_, next) {
    notifier.updateFromAuthState(next);
  });

  return notifier;
});

/// Route guard widget matching React Router's `RoleGuard`.
/// Renders [AccessDenied] if current authenticated user lacks required roles.
class RoleGuard extends ConsumerWidget {
  final List<String> allowedRoles;
  final Widget child;

  const RoleGuard({
    super.key,
    required this.allowedRoles,
    required this.child,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authProvider);
    final userRoles = authState.roleCodes;

    final hasRole = allowedRoles.any((allowed) {
      final normAllowed = allowed.trim().toUpperCase();
      return userRoles.any((ur) => ur.trim().toUpperCase() == normAllowed);
    });

    if (!hasRole) {
      return const AccessDenied();
    }

    return child;
  }
}
