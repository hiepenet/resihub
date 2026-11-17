import 'package:flutter/material.dart';

/// Bảng màu chuẩn của ResiHub khớp 100% với Tailwind CSS cấu hình trong `frontend/tailwind.config.js`.
class AppColors {
  AppColors._();

  // Primary (Sky palette)
  static const Color primary50 = Color(0xFFF0F9FF);
  static const Color primary100 = Color(0xFFE0F2FE);
  static const Color primary200 = Color(0xFFBAE6FD);
  static const Color primary300 = Color(0xFF7DD3FC);
  static const Color primary400 = Color(0xFF38BDF8);
  static const Color primary500 = Color(0xFF0EA5E9);
  static const Color primary600 = Color(0xFF0284C7);
  static const Color primary700 = Color(0xFF0369A1);
  static const Color primary800 = Color(0xFF075985);
  static const Color primary900 = Color(0xFF0C4A6E);
  static const Color primary = primary500;

  // Secondary (Indigo palette)
  static const Color secondary50 = Color(0xFFEEF2FF);
  static const Color secondary100 = Color(0xFFE0E7FF);
  static const Color secondary500 = Color(0xFF6366F1);
  static const Color secondary600 = Color(0xFF4F46E5);
  static const Color secondary700 = Color(0xFF4338CA);
  static const Color secondary = secondary500;

  // Slate / Neutral palette
  static const Color slate50 = Color(0xFFF8FAFC);
  static const Color slate100 = Color(0xFFF1F5F9);
  static const Color slate200 = Color(0xFFE2E8F0);
  static const Color slate300 = Color(0xFFCBD5E1);
  static const Color slate400 = Color(0xFF94A3B8);
  static const Color slate500 = Color(0xFF64748B);
  static const Color slate600 = Color(0xFF475569);
  static const Color slate700 = Color(0xFF334155);
  static const Color slate800 = Color(0xFF1E293B);
  static const Color slate900 = Color(0xFF0F172A);

  // Emerald (Success)
  static const Color emerald50 = Color(0xFFECFDF5);
  static const Color emerald100 = Color(0xFFD1FAE5);
  static const Color emerald200 = Color(0xFFA7F3D0);
  static const Color emerald500 = Color(0xFF10B981);
  static const Color emerald600 = Color(0xFF059669);
  static const Color emerald700 = Color(0xFF047857);

  // Amber (Warning)
  static const Color amber50 = Color(0xFFFFFBEB);
  static const Color amber100 = Color(0xFFFEF3C7);
  static const Color amber200 = Color(0xFFFDE68A);
  static const Color amber300 = Color(0xFFFCD34D);
  static const Color amber400 = Color(0xFFFBBF24);
  static const Color amber500 = Color(0xFFF59E0B);
  static const Color amber600 = Color(0xFFD97706);
  static const Color amber700 = Color(0xFFB45309);
  static const Color amber900 = Color(0xFF78350F);

  // Rose / Red (Danger & Error)
  static const Color rose50 = Color(0xFFFFF1F2);
  static const Color rose100 = Color(0xFFFFE4E6);
  static const Color rose200 = Color(0xFFFECDD3);
  static const Color rose300 = Color(0xFFFDA4AF);
  static const Color rose400 = Color(0xFFFB7185);
  static const Color rose500 = Color(0xFFF43F5E);
  static const Color rose600 = Color(0xFFE11D48);
  static const Color rose700 = Color(0xFFBE123C);
  static const Color rose800 = Color(0xFF9F1239);

  // Sky
  static const Color sky50 = Color(0xFFF0F9FF);
  static const Color sky200 = Color(0xFFBAE6FD);
  static const Color sky500 = Color(0xFF0EA5E9);
  static const Color sky700 = Color(0xFF0369A1);

  // Purple / Violet
  static const Color purple50 = Color(0xFFFAF5FF);
  static const Color purple200 = Color(0xFFE9D5FF);
  static const Color purple500 = Color(0xFFA855F7);
  static const Color purple700 = Color(0xFF7E22CE);

  // Surfaces & Base
  static const Color surface = Color(0xFFFFFFFF);
  static const Color surfaceMuted = Color(0xFFF8FAFC);
  static const Color border = Color(0xFFE2E8F0);
  static const Color background = Color(0xFFF8FAFC);

  // Text
  static const Color textPrimary = Color(0xFF0F172A);
  static const Color textSecondary = Color(0xFF475569);
  static const Color textMuted = Color(0xFF94A3B8);

  // Card shadow
  static const BoxShadow cardShadow = BoxShadow(
    color: Color.fromRGBO(15, 23, 42, 0.06),
    blurRadius: 3,
    offset: Offset(0, 1),
  );

  static const BoxShadow elevatedShadow = BoxShadow(
    color: Color.fromRGBO(15, 23, 42, 0.08),
    blurRadius: 25,
    offset: Offset(0, 10),
  );
}
