import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/query_cache.dart';
import '../services/buildings_service.dart';

/// Provider for building list used across selectors, dropdowns, and filters.
/// Emits `List<Map<String, dynamic>>`.
final buildingsListProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final service = ref.watch(buildingsServiceProvider);
  final res = await service.list();
  if (res is Map && res['data'] is List) {
    return (res['data'] as List)
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
  } else if (res is List) {
    return res
        .whereType<Map>()
        .map((e) => Map<String, dynamic>.from(e))
        .toList();
  }
  return const [];
});

/// Refreshes the buildings selector by invalidating the queryCache 'buildings' namespace
/// and invalidating `buildingsListProvider`. Replaces React's `resihub:buildings-updated` event.
void refreshBuildingsSelector(WidgetRef ref) {
  ref.read(queryCacheProvider).invalidate('buildings');
  ref.invalidate(buildingsListProvider);
}

/// Helper for refreshing buildings from a Riverpod [Ref] (e.g. inside another provider).
void refreshBuildingsSelectorFromRef(Ref ref) {
  ref.read(queryCacheProvider).invalidate('buildings');
  ref.invalidate(buildingsListProvider);
}
