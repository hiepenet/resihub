import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

typedef TokenRefreshedCallback = void Function(Map<String, dynamic>? user, String accessToken);

/// Decoupled one-way listener/callback bridge between [core/network] and [features/auth].
///
/// This avoids circular dependencies between network interceptors and authentication notifiers.
class SessionLifecycleBridge {
  final List<TokenRefreshedCallback> _tokenRefreshedListeners = [];
  final List<VoidCallback> _sessionExpiredListeners = [];

  void addTokenRefreshedListener(TokenRefreshedCallback listener) {
    _tokenRefreshedListeners.add(listener);
  }

  void removeTokenRefreshedListener(TokenRefreshedCallback listener) {
    _tokenRefreshedListeners.remove(listener);
  }

  void addSessionExpiredListener(VoidCallback listener) {
    _sessionExpiredListeners.add(listener);
  }

  void removeSessionExpiredListener(VoidCallback listener) {
    _sessionExpiredListeners.remove(listener);
  }

  /// Notifies listeners that a refresh request succeeded with a new access token
  /// and potentially updated user profile.
  void notifyTokenRefreshed(Map<String, dynamic>? user, String accessToken) {
    for (final listener in List<TokenRefreshedCallback>.of(_tokenRefreshedListeners)) {
      try {
        listener(user, accessToken);
      } catch (e, st) {
        debugPrint('Error in TokenRefreshedListener: $e\n$st');
      }
    }
  }

  /// Notifies listeners that refresh failed and the session has expired.
  void notifySessionExpired() {
    for (final listener in List<VoidCallback>.of(_sessionExpiredListeners)) {
      try {
        listener();
      } catch (e, st) {
        debugPrint('Error in SessionExpiredListener: $e\n$st');
      }
    }
  }

  void dispose() {
    _tokenRefreshedListeners.clear();
    _sessionExpiredListeners.clear();
  }
}

/// Provider for the application's session lifecycle bridge.
final sessionLifecycleBridgeProvider = Provider<SessionLifecycleBridge>((ref) {
  final bridge = SessionLifecycleBridge();
  ref.onDispose(() => bridge.dispose());
  return bridge;
});
