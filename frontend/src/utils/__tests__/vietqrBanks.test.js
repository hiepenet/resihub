import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVietQrBankOptions, matchVietQrBank } from '../vietqrBanks.js';

const SAMPLE_BANKS = [
  {
    id: 43,
    code: 'VCB',
    bin: '970436',
    shortName: 'Vietcombank',
    name: 'Ngân hàng TMCP Ngoại Thương Việt Nam',
    logo: 'https://cdn.vietqr.io/img/VCB.png',
  },
  {
    id: 38,
    code: 'TCB',
    bin: '970407',
    shortName: 'Techcombank',
    name: 'Ngân hàng TMCP Kỹ thương Việt Nam',
    logo: 'https://cdn.vietqr.io/img/TCB.png',
  },
];

test('buildVietQrBankOptions maps VietQR bank items to rich Select options', () => {
  const opts = buildVietQrBankOptions(SAMPLE_BANKS);
  assert.equal(opts.length, 2);
  assert.equal(opts[0].value, 'Vietcombank');
  assert.equal(opts[0].label, 'Vietcombank (VCB)');
  assert.equal(opts[0].sublabel, 'Ngân hàng TMCP Ngoại Thương Việt Nam');
  assert.equal(opts[0].badge, 'BIN 970436');
  assert.equal(opts[0].logo, 'https://cdn.vietqr.io/img/VCB.png');
  assert.ok(opts[0].searchText.includes('970436'));
  assert.deepEqual(opts[0].bank, SAMPLE_BANKS[0]);
});

test('buildVietQrBankOptions preserves legacy custom bank_name at top when not in VietQR list', () => {
  const opts = buildVietQrBankOptions(SAMPLE_BANKS, {
    bank_name: 'Ngân hàng Liên doanh Cũ',
    bank_bin: '999999',
  });
  assert.equal(opts.length, 3);
  assert.equal(opts[0].value, 'Ngân hàng Liên doanh Cũ');
  assert.equal(opts[0].label, 'Ngân hàng Liên doanh Cũ');
  assert.equal(opts[0].badge, 'BIN 999999');
  assert.equal(opts[0].bank, null);
});

test('buildVietQrBankOptions does not prepend duplicate legacy entry when currentBankInfo matches a VietQR bank by code/fullName', () => {
  const opts = buildVietQrBankOptions(SAMPLE_BANKS, {
    bank_name: 'VCB',
    bank_code: 'VCB',
  });
  assert.equal(opts.length, 2);
  assert.equal(opts[0].value, 'Vietcombank');
});

test('matchVietQrBank matches by bank_code, bank_bin, shortName, or code in bank_name', () => {
  assert.equal(matchVietQrBank(SAMPLE_BANKS, { bank_code: 'TCB' })?.shortName, 'Techcombank');
  assert.equal(matchVietQrBank(SAMPLE_BANKS, { bank_bin: '970436' })?.shortName, 'Vietcombank');
  assert.equal(matchVietQrBank(SAMPLE_BANKS, { bank_name: 'vietcombank' })?.code, 'VCB');
  assert.equal(matchVietQrBank(SAMPLE_BANKS, { bank_name: 'TCB' })?.shortName, 'Techcombank');
  assert.equal(matchVietQrBank(SAMPLE_BANKS, { bank_name: 'Ngân hàng ngoài danh mục' }), null);
});

