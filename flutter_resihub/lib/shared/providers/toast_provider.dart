import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';

enum ToastVariant {
  success,
  error,
  warning,
  info,
}

class ToastItem {
  final String id;
  final String? title;
  final String message;
  final ToastVariant variant;
  final Duration duration;

  const ToastItem({
    required this.id,
    this.title,
    required this.message,
    this.variant = ToastVariant.info,
    this.duration = const Duration(seconds: 4),
  });
}

class ToastNotifier extends Notifier<List<ToastItem>> {
  final Map<String, Timer> _timers = {};
  int _counter = 0;

  @override
  List<ToastItem> build() {
    ref.onDispose(() {
      for (final timer in _timers.values) {
        timer.cancel();
      }
      _timers.clear();
    });
    return const [];
  }

  String show({
    String? title,
    required String message,
    ToastVariant variant = ToastVariant.info,
    Duration duration = const Duration(seconds: 4),
  }) {
    final id = 'toast_${++_counter}_${DateTime.now().microsecondsSinceEpoch}';
    final item = ToastItem(
      id: id,
      title: title,
      message: message,
      variant: variant,
      duration: duration,
    );
    state = [...state, item];

    if (duration > Duration.zero) {
      _timers[id] = Timer(duration, () {
        dismiss(id);
      });
    }

    return id;
  }

  String success(
    String message, {
    String? title,
    Duration duration = const Duration(seconds: 4),
  }) {
    return show(
      title: title,
      message: message,
      variant: ToastVariant.success,
      duration: duration,
    );
  }

  String error(
    String message, {
    String? title,
    Duration duration = const Duration(seconds: 5),
  }) {
    return show(
      title: title,
      message: message,
      variant: ToastVariant.error,
      duration: duration,
    );
  }

  String warning(
    String message, {
    String? title,
    Duration duration = const Duration(seconds: 4),
  }) {
    return show(
      title: title,
      message: message,
      variant: ToastVariant.warning,
      duration: duration,
    );
  }

  String info(
    String message, {
    String? title,
    Duration duration = const Duration(seconds: 4),
  }) {
    return show(
      title: title,
      message: message,
      variant: ToastVariant.info,
      duration: duration,
    );
  }

  void dismiss(String id) {
    _timers[id]?.cancel();
    _timers.remove(id);
    state = state.where((item) => item.id != id).toList();
  }
}

final toastProvider = NotifierProvider<ToastNotifier, List<ToastItem>>(ToastNotifier.new);
