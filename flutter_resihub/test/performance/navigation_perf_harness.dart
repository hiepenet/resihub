import 'package:flutter/widgets.dart';

/// Test-only counter used by navigation performance tests.
///
/// It exists so Tasks 3-5 can assert *how many times* a widget rebuilds or a
/// service is called across a navigation sequence, instead of timing a wall
/// clock (which is flaky in CI).
class PerfCounter {
  int _count = 0;

  int get value => _count;

  void increment() => _count++;

  void reset() => _count = 0;
}

/// Wraps a child and increments [counter] on every build.
///
/// Place it immediately below the widget whose rebuild count is under test,
/// or give it the child of a shell so a shell rebuild forces it to rebuild.
class BuildCountProbe extends StatelessWidget {
  const BuildCountProbe({
    super.key,
    required this.counter,
    required this.child,
  });

  final PerfCounter counter;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    counter.increment();
    return child;
  }
}
