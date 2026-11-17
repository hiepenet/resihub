import 'package:flutter/material.dart';
import 'package:shimmer/shimmer.dart';

import '../../../core/theme/app_colors.dart';

class AppSkeleton extends StatelessWidget {
  final double? width;
  final double? height;
  final BorderRadiusGeometry? borderRadius;

  const AppSkeleton({
    super.key,
    this.width,
    this.height,
    this.borderRadius,
  });

  @override
  Widget build(BuildContext context) {
    final isTesting = WidgetsBinding.instance.runtimeType.toString().contains('Test');

    final placeholder = Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: AppColors.slate200,
        borderRadius: borderRadius ?? BorderRadius.circular(8),
      ),
    );

    if (isTesting) {
      return placeholder;
    }

    return Shimmer.fromColors(
      baseColor: AppColors.slate200,
      highlightColor: AppColors.slate100,
      child: placeholder,
    );
  }
}

class PageSkeleton extends StatelessWidget {
  const PageSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        // Top header row
        const Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                AppSkeleton(width: 200, height: 24),
                SizedBox(height: 8),
                AppSkeleton(width: 320, height: 16),
              ],
            ),
            AppSkeleton(width: 120, height: 38),
          ],
        ),
        const SizedBox(height: 24),

        // Stat cards grid
        LayoutBuilder(
          builder: (context, constraints) {
            final count = constraints.maxWidth >= 900 ? 4 : (constraints.maxWidth >= 600 ? 2 : 1);
            return Wrap(
              spacing: 16,
              runSpacing: 16,
              children: List.generate(
                4,
                (i) => SizedBox(
                  width: (constraints.maxWidth - (count - 1) * 16) / count,
                  child: const AppSkeleton(height: 110),
                ),
              ),
            );
          },
        ),
        const SizedBox(height: 24),

        // Main table / card skeleton
        const AppSkeleton(height: 320),
      ],
    );
  }
}
