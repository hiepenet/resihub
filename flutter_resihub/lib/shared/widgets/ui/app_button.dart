import 'package:flutter/material.dart';
import '../../../core/theme/app_colors.dart';

enum AppButtonVariant {
  primary,
  secondary,
  outline,
  ghost,
  success,
  warning,
  danger,
  soft,
}

enum AppButtonSize {
  xs,
  sm,
  md,
  lg,
}

class AppButton extends StatelessWidget {
  final String? text;
  final Widget? child;
  final AppButtonVariant variant;
  final AppButtonSize size;
  final bool loading;
  final bool disabled;
  final Widget? icon;
  final Widget? rightIcon;
  final VoidCallback? onPressed;
  final bool fullWidth;

  const AppButton({
    super.key,
    this.text,
    this.child,
    this.variant = AppButtonVariant.primary,
    this.size = AppButtonSize.md,
    this.loading = false,
    this.disabled = false,
    this.icon,
    this.rightIcon,
    this.onPressed,
    this.fullWidth = false,
  });

  @override
  Widget build(BuildContext context) {
    final isInteractive = !disabled && !loading && onPressed != null;

    final (bgColor, fgColor, borderColor) = switch (variant) {
      AppButtonVariant.primary => (
          AppColors.primary500,
          Colors.white,
          Colors.transparent,
        ),
      AppButtonVariant.secondary => (
          AppColors.secondary600,
          Colors.white,
          Colors.transparent,
        ),
      AppButtonVariant.outline => (
          Colors.white,
          AppColors.slate700,
          AppColors.border,
        ),
      AppButtonVariant.ghost => (
          Colors.transparent,
          AppColors.slate600,
          Colors.transparent,
        ),
      AppButtonVariant.success => (
          AppColors.emerald600,
          Colors.white,
          Colors.transparent,
        ),
      AppButtonVariant.warning => (
          AppColors.amber500,
          Colors.white,
          Colors.transparent,
        ),
      AppButtonVariant.danger => (
          AppColors.rose600,
          Colors.white,
          Colors.transparent,
        ),
      AppButtonVariant.soft => (
          AppColors.primary50,
          AppColors.primary700,
          AppColors.primary100,
        ),
    };

    final (height, fontSize, horizontalPadding, iconSize) = switch (size) {
      AppButtonSize.xs => (28.0, 12.0, 10.0, 14.0),
      AppButtonSize.sm => (32.0, 12.0, 12.0, 16.0),
      AppButtonSize.md => (38.0, 14.0, 16.0, 16.0),
      AppButtonSize.lg => (44.0, 14.0, 20.0, 18.0),
    };

    Widget content;
    if (loading) {
      content = Row(
        mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          SizedBox(
            width: iconSize,
            height: iconSize,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              valueColor: AlwaysStoppedAnimation<Color>(fgColor),
            ),
          ),
        ],
      );
    } else {
      final children = <Widget>[];
      if (icon != null) {
        children.add(icon!);
        if (text != null || child != null) {
          children.add(const SizedBox(width: 6));
        }
      }
      if (child != null) {
        children.add(child!);
      } else if (text != null) {
        children.add(
          Flexible(
            child: Text(
              text!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: fontSize,
                fontWeight: FontWeight.w500,
                color: fgColor,
              ),
            ),
          ),
        );
      }
      if (rightIcon != null) {
        if (text != null || child != null || icon != null) {
          children.add(const SizedBox(width: 6));
        }
        children.add(rightIcon!);
      }

      content = Row(
        mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: children,
      );
    }

    final radius = BorderRadius.circular(size == AppButtonSize.xs ? 6 : 8);

    Widget button = Opacity(
      opacity: isInteractive ? 1.0 : 0.5,
      child: Material(
        color: bgColor,
        borderRadius: radius,
        child: InkWell(
          onTap: isInteractive ? onPressed : null,
          borderRadius: radius,
          hoverColor: fgColor.withValues(alpha: 0.08),
          splashColor: fgColor.withValues(alpha: 0.12),
          child: Container(
            height: height,
            width: fullWidth ? double.infinity : null,
            padding: EdgeInsets.symmetric(horizontal: horizontalPadding),
            decoration: BoxDecoration(
              borderRadius: radius,
              border: Border.all(color: borderColor),
            ),
            child: content,
          ),
        ),
      ),
    );

    return button;
  }
}
