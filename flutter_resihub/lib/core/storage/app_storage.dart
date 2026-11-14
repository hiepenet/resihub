import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Interface for secure key-value storage to enable deterministic unit testing
/// and cross-platform decoupling without triggering platform channel calls.
abstract class SecureStorageInterface {
  Future<String?> read({required String key});
  Future<void> write({required String key, required String? value});
  Future<void> delete({required String key});
  Future<void> deleteAll();
}

/// Default implementation wrapping [FlutterSecureStorage].
class DefaultSecureStorage implements SecureStorageInterface {
  final FlutterSecureStorage _storage;

  DefaultSecureStorage([FlutterSecureStorage? storage])
      : _storage = storage ?? const FlutterSecureStorage();

  @override
  Future<String?> read({required String key}) => _storage.read(key: key);

  @override
  Future<void> write({required String key, required String? value}) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete({required String key}) => _storage.delete(key: key);

  @override
  Future<void> deleteAll() => _storage.deleteAll();
}

/// Platform-Aware Storage for ResiHub application state and tokens.
///
/// On Web:
/// - EVERYTHING is stored in [SharedPreferences] (window.localStorage).
/// - [FlutterSecureStorage] is NEVER accessed, preventing HTTP LAN / Web SubtleCrypto crashes.
///
/// On Mobile / Desktop:
/// - Auth tokens (accessToken, refreshToken) are stored securely via [FlutterSecureStorage].
/// - User data, UI preferences, and selected building ID are stored via [SharedPreferences].
///
/// RAM Cache:
/// - [init] hydrates values into synchronous RAM getters so Interceptors and UI can read instantly.
class AppStorage {
  static const String _kAccessToken = 'accessToken';
  static const String _kRefreshToken = 'refreshToken';
  static const String _kUser = 'user';
  static const String _kSelectedBuildingId = 'selectedBuildingId';
  static const String _kSidebarCollapsed = 'sidebarCollapsed';
  static const String _kThemeMode = 'themeMode';
  static const String _kAiPrivacyConsent = 'aiPrivacyConsent';

  final bool isWeb;
  final SharedPreferences? _injectedPrefs;
  final SecureStorageInterface? _injectedSecureStorage;

  SharedPreferences? _prefs;
  SecureStorageInterface? _secureStorage;

  // Synchronous RAM cache
  String? _accessToken;
  String? _refreshToken;
  Map<String, dynamic>? _user;
  String? _selectedBuildingId;
  bool _sidebarCollapsed = false;
  String? _themeMode;
  bool? _aiPrivacyConsent;
  bool _isInitialized = false;

  AppStorage({
    this.isWeb = kIsWeb,
    SharedPreferences? prefs,
    SecureStorageInterface? secureStorage,
  })  : _injectedPrefs = prefs,
        _injectedSecureStorage = secureStorage;

  /// Initializes storage and loads cached state synchronously into RAM.
  Future<void> init() async {
    _prefs = _injectedPrefs ?? await SharedPreferences.getInstance();

    if (!isWeb) {
      _secureStorage = _injectedSecureStorage ?? DefaultSecureStorage();
    }

    if (isWeb) {
      _accessToken = _prefs?.getString(_kAccessToken);
      _refreshToken = _prefs?.getString(_kRefreshToken);
    } else {
      _accessToken = await _secureStorage?.read(key: _kAccessToken);
      _refreshToken = await _secureStorage?.read(key: _kRefreshToken);
    }

    final rawUser = _prefs?.getString(_kUser);
    if (rawUser != null && rawUser.isNotEmpty) {
      try {
        final decoded = jsonDecode(rawUser);
        if (decoded is Map<String, dynamic>) {
          _user = decoded;
        } else if (decoded is Map) {
          _user = Map<String, dynamic>.from(decoded);
        } else {
          _user = null;
        }
      } catch (_) {
        _user = null;
      }
    } else {
      _user = null;
    }

    _selectedBuildingId = _prefs?.getString(_kSelectedBuildingId);
    _sidebarCollapsed = _prefs?.getBool(_kSidebarCollapsed) ?? false;
    _themeMode = _prefs?.getString(_kThemeMode);
    _aiPrivacyConsent = _prefs?.getBool(_kAiPrivacyConsent);

    _isInitialized = true;
  }

  bool get isInitialized => _isInitialized;

  // Synchronous RAM getters
  String? get accessToken => _accessToken;
  String? get refreshToken => _refreshToken;
  Map<String, dynamic>? get user => _user;
  String? get selectedBuildingId => _selectedBuildingId;
  bool get sidebarCollapsed => _sidebarCollapsed;
  String? get themeMode => _themeMode;
  bool? get aiPrivacyConsent => _aiPrivacyConsent;

  String? get userId => _user?['id']?.toString() ?? _user?['sub']?.toString();
  String? get userRole => _user?['role']?.toString();
  bool get isAuthenticated => _accessToken != null && _accessToken!.isNotEmpty;

  /// Updates access and refresh tokens in both RAM and persistent storage.
  Future<void> setTokens({required String accessToken, String? refreshToken}) async {
    _accessToken = accessToken;
    if (refreshToken != null) {
      _refreshToken = refreshToken;
    }

    if (isWeb) {
      await _prefs?.setString(_kAccessToken, accessToken);
      if (refreshToken != null) {
        await _prefs?.setString(_kRefreshToken, refreshToken);
      }
    } else {
      await _secureStorage?.write(key: _kAccessToken, value: accessToken);
      if (refreshToken != null) {
        await _secureStorage?.write(key: _kRefreshToken, value: refreshToken);
      }
    }
  }

  /// Updates cached user in both RAM and persistent storage.
  Future<void> setUser(Map<String, dynamic>? user) async {
    _user = user;
    if (user != null) {
      await _prefs?.setString(_kUser, jsonEncode(user));
    } else {
      await _prefs?.remove(_kUser);
    }
  }

  /// Updates selected building ID.
  Future<void> setSelectedBuildingId(String? buildingId) async {
    _selectedBuildingId = buildingId;
    if (buildingId != null && buildingId.isNotEmpty) {
      await _prefs?.setString(_kSelectedBuildingId, buildingId);
    } else {
      await _prefs?.remove(_kSelectedBuildingId);
    }
  }

  /// Updates sidebar collapsed UI preference.
  Future<void> setSidebarCollapsed(bool collapsed) async {
    _sidebarCollapsed = collapsed;
    await _prefs?.setBool(_kSidebarCollapsed, collapsed);
  }

  /// Updates theme mode UI preference (light, dark, system).
  Future<void> setThemeMode(String theme) async {
    _themeMode = theme;
    await _prefs?.setString(_kThemeMode, theme);
  }

  /// Updates AI privacy consent flag.
  Future<void> setAiPrivacyConsent(bool consent) async {
    _aiPrivacyConsent = consent;
    await _prefs?.setBool(_kAiPrivacyConsent, consent);
  }

  /// Clears session tokens and cached user, preserving UI preferences.
  Future<void> clearSession() async {
    _accessToken = null;
    _refreshToken = null;
    _user = null;

    if (isWeb) {
      await _prefs?.remove(_kAccessToken);
      await _prefs?.remove(_kRefreshToken);
    } else {
      await _secureStorage?.delete(key: _kAccessToken);
      await _secureStorage?.delete(key: _kRefreshToken);
    }
    await _prefs?.remove(_kUser);
  }

  /// Clears all storage keys including UI preferences.
  Future<void> clearAll() async {
    _accessToken = null;
    _refreshToken = null;
    _user = null;
    _selectedBuildingId = null;
    _sidebarCollapsed = false;
    _themeMode = null;
    _aiPrivacyConsent = null;

    if (isWeb) {
      await _prefs?.clear();
    } else {
      await _secureStorage?.deleteAll();
      await _prefs?.clear();
    }
  }
}

/// Riverpod provider for AppStorage. Must be initialized and overridden in ProviderScope.
final appStorageProvider = Provider<AppStorage>((ref) {
  throw UnimplementedError(
    'appStorageProvider must be initialized and overridden with AppStorage instance in ProviderScope',
  );
});
