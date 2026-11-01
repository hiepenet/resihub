import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMoneyPropValue,
  formatMoneyInputDisplay,
  parseMoneyUserEdit,
  handleMoneySeparatorKey,
} from '../moneyInput.js';

test('normalizeMoneyPropValue handles integers, strings, empty values, and Postgres NUMERIC decimals', () => {
  assert.equal(normalizeMoneyPropValue(100000), '100000');
  assert.equal(normalizeMoneyPropValue(1000000), '1000000');
  assert.equal(normalizeMoneyPropValue('8500000.00'), '8500000');
  assert.equal(normalizeMoneyPropValue('220000.5'), '220001');
  assert.equal(normalizeMoneyPropValue('100.000'), '100000');
  assert.equal(normalizeMoneyPropValue('1.000.000'), '1000000');
  assert.equal(normalizeMoneyPropValue(0), '0');
  assert.equal(normalizeMoneyPropValue('0.00'), '0');
  assert.equal(normalizeMoneyPropValue('000'), '0');
  assert.equal(normalizeMoneyPropValue('00150000'), '150000');
  assert.equal(normalizeMoneyPropValue(''), '');
  assert.equal(normalizeMoneyPropValue(null), '');
  assert.equal(normalizeMoneyPropValue(undefined), '');
});

test('normalizeMoneyPropValue respects allowNegative flag', () => {
  assert.equal(normalizeMoneyPropValue('-200000', { allowNegative: true }), '-200000');
  assert.equal(normalizeMoneyPropValue('-200000.00', { allowNegative: true }), '-200000');
  assert.equal(normalizeMoneyPropValue(-1500000, { allowNegative: true }), '-1500000');
  assert.equal(normalizeMoneyPropValue('-200000', { allowNegative: false }), '200000');
  assert.equal(normalizeMoneyPropValue('-0', { allowNegative: true }), '0');
});

test('formatMoneyInputDisplay formats with dot thousand separators', () => {
  assert.equal(formatMoneyInputDisplay(100000), '100.000');
  assert.equal(formatMoneyInputDisplay(1000000), '1.000.000');
  assert.equal(formatMoneyInputDisplay('8500000.00'), '8.500.000');
  assert.equal(formatMoneyInputDisplay('-200000', { allowNegative: true }), '-200.000');
  assert.equal(formatMoneyInputDisplay('-1250000', { allowNegative: true }), '-1.250.000');
  assert.equal(formatMoneyInputDisplay(0), '0');
  assert.equal(formatMoneyInputDisplay(''), '');
});

test('parseMoneyUserEdit formats while preserving caret position on middle edits', () => {
  const endEdit = parseMoneyUserEdit('100000', 6);
  assert.deepEqual(endEdit, {
    rawValue: '100000',
    displayValue: '100.000',
    nextCaretIndex: 7,
    isTransientMinus: false,
  });

  // User inserts "5" right after "1" in "100.000" -> raw input DOM text is "1500.000" with caret at 2
  const midEdit = parseMoneyUserEdit('1500.000', 2);
  assert.deepEqual(midEdit, {
    rawValue: '1500000',
    displayValue: '1.500.000',
    nextCaretIndex: 3, // right after "1.5"
    isTransientMinus: false,
  });
});

test('parseMoneyUserEdit handles transient minus without leaking NaN to rawValue', () => {
  const transient = parseMoneyUserEdit('-', 1, { allowNegative: true });
  assert.deepEqual(transient, {
    rawValue: '',
    displayValue: '-',
    nextCaretIndex: 1,
    isTransientMinus: true,
  });

  const disallowed = parseMoneyUserEdit('-', 1, { allowNegative: false });
  assert.deepEqual(disallowed, {
    rawValue: '',
    displayValue: '',
    nextCaretIndex: 0,
    isTransientMinus: false,
  });

  const fullNegative = parseMoneyUserEdit('-200000', 7, { allowNegative: true });
  assert.deepEqual(fullNegative, {
    rawValue: '-200000',
    displayValue: '-200.000',
    nextCaretIndex: 8,
    isTransientMinus: false,
  });
});

test('handleMoneySeparatorKey deletes the adjacent digit when pressing Backspace or Delete on a dot', () => {
  // Caret right after first dot in "1.000.000" (index 2), pressing Backspace removes "1" -> "0"
  const bs = handleMoneySeparatorKey('1.000.000', 2, 2, 'Backspace');
  assert.deepEqual(bs, {
    handled: true,
    rawValue: '0',
    displayValue: '0',
    nextCaretIndex: 1,
    isTransientMinus: false,
  });

  // Caret right after first dot in "12.345.678" (index 3), pressing Backspace removes "2" -> "1.345.678"
  const bs2 = handleMoneySeparatorKey('12.345.678', 3, 3, 'Backspace');
  assert.deepEqual(bs2, {
    handled: true,
    rawValue: '1345678',
    displayValue: '1.345.678',
    nextCaretIndex: 1,
    isTransientMinus: false,
  });

  // Caret right before first dot in "12.345" (index 2), pressing Delete removes "3" -> "1.245"
  const del = handleMoneySeparatorKey('12.345', 2, 2, 'Delete');
  assert.deepEqual(del, {
    handled: true,
    rawValue: '1245',
    displayValue: '1.245',
    nextCaretIndex: 3,
    isTransientMinus: false,
  });

  // Non-separator position is not intercepted
  const normal = handleMoneySeparatorKey('12.345', 1, 1, 'Backspace');
  assert.equal(normal.handled, false);
});

