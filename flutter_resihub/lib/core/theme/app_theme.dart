import 'package:flutter/material.dart';
import 'app_colors.dart';

/// Khởi tạo Material 3 Theme cho ResiHub khớp thiết kế giao diện ReactJS.
ThemeData buildAppTheme({Brightness brightness = Brightness.light}) {
  final isLight = brightness == Brightness.light;

  final colorScheme = ColorScheme(
    brightness: brightness,
    primary: AppColors.primary500,
    onPrimary: Colors.white,
    secondary: AppColors.secondary500,
    onSecondary: Colors.white,
    error: AppColors.rose600,
    onError: Colors.white,
    surface: isLight ? AppColors.surface : AppColors.slate800,
    onSurface: isLight ? AppColors.textPrimary : Colors.white,
    outline: AppColors.border,
  );

  return ThemeData(
    useMaterial3: true,
    fontFamily: 'Inter',
    colorScheme: colorScheme,
    scaffoldBackgroundColor: isLight ? AppColors.background : AppColors.slate900,
    cardTheme: CardThemeData(
      color: isLight ? AppColors.surface : AppColors.slate800,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: const BorderSide(color: AppColors.border),
      ),
    ),
    dividerTheme: const DividerThemeData(
      color: AppColors.border,
      thickness: 1,
      space: 1,
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: isLight ? Colors.white : AppColors.slate900,
      foregroundColor: isLight ? AppColors.textPrimary : Colors.white,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: TextStyle(
        fontFamily: 'Inter',
        color: isLight ? AppColors.textPrimary : Colors.white,
        fontSize: 16,
        fontWeight: FontWeight.w600,
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: isLight ? Colors.white : AppColors.slate800,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      hintStyle: const TextStyle(
        fontFamily: 'Inter',
        color: AppColors.textMuted,
        fontSize: 14,
      ),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: AppColors.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(8),
        borderSide: const BorderSide(color: AppColors.border),
      ),
      focusedBorder: const OutlineInputBorder(
        borderRadius: BorderRadius.all(Radius.circular(8)),
        borderSide: BorderSide(color: AppColors.primary500, width: 2),
      ),
      errorBorder: const OutlineInputBorder(
        borderRadius: BorderRadius.all(Radius.circular(8)),
        borderSide: BorderSide(color: AppColors.rose400),
      ),
      focusedErrorBorder: const OutlineInputBorder(
        borderRadius: BorderRadius.all(Radius.circular(8)),
        borderSide: BorderSide(color: AppColors.rose500, width: 2),
      ),
    ),
  );
}
