import zlib from 'node:zlib';

const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
const LEADING_ZERO_DIGITS_RE = /^0\d+$/;

/**
 * Prefix spreadsheet formula trigger characters (=, +, -, @, \t, \r) with a single quote '
 * to prevent CSV / Excel Formula Injection (OWASP CSV Injection).
 */
export function sanitizeSpreadsheetFormula(str) {
  const s = String(str ?? '');
  if (!s) return '';
  if (FORMULA_TRIGGER_RE.test(s)) {
    return `'${s}`;
  }
  return s;
}

/**
 * Format a single cell for CSV output:
 * - Null/undefined -> ''
 * - Numbers / booleans -> unquoted primitive string (unless NaN/Infinity)
 * - Strings with leading zero digits (e.g. phone/account '0909123456') -> prefixed with ' and double-quoted "'0909123456"
 * - Formula strings -> prefixed with ' via sanitizeSpreadsheetFormula and double-quoted
 * - Double quotes escaped as ""
 */
export function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (!raw) return '';

  let safe = sanitizeSpreadsheetFormula(raw);
  let forceQuote = safe !== raw;
  if (!forceQuote && LEADING_ZERO_DIGITS_RE.test(safe)) {
    safe = `'${safe}`;
    forceQuote = true;
  }

  if (forceQuote || /[",\r\n;]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * Generate UTF-8 BOM CSV string compatible with Microsoft Excel (Vietnamese diacritics intact).
 */
export function toUtf8BomCsv(headers, rows) {
  const headerLine = (headers || []).map((h) => escapeCsvCell(h)).join(',');
  const bodyLines = (rows || []).map((row) =>
    (row || []).map((cell) => escapeCsvCell(cell)).join(',')
  );
  return `\uFEFF${[headerLine, ...bodyLines].join('\r\n')}\r\n`;
}

// ============================================================================
// Minimal zero-dependency OpenXML (.xlsx) generator using node:zlib + CRC32
// ============================================================================

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colIndexToLetters(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function buildWorksheetXml(headers = [], rows = []) {
  const allRows = [headers, ...rows];
  const xmlRows = [];

  for (let rIdx = 0; rIdx < allRows.length; rIdx++) {
    const row = allRows[rIdx] || [];
    const rowNum = rIdx + 1;
    const cells = [];

    for (let cIdx = 0; cIdx < row.length; cIdx++) {
      const val = row[cIdx];
      if (val === null || val === undefined || val === '') continue;
      const cellRef = `${colIndexToLetters(cIdx)}${rowNum}`;

      if (rIdx > 0 && typeof val === 'number' && Number.isFinite(val)) {
        cells.push(`<c r="${cellRef}" t="n"><v>${val}</v></c>`);
      } else {
        const rawStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
        const safeStr = sanitizeSpreadsheetFormula(rawStr);
        const preserveAttr = /^\s|\s$|[\r\n\t]/.test(safeStr) ? ' xml:space="preserve"' : '';
        cells.push(
          `<c r="${cellRef}" t="inlineStr"><is><t${preserveAttr}>${escapeXml(safeStr)}</t></is></c>`
        );
      }
    }

    xmlRows.push(`<row r="${rowNum}">${cells.join('')}</row>`);
  }

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${xmlRows.join('')}</sheetData>` +
    `</worksheet>`
  );
}

function sanitizeSheetName(name, fallbackIdx) {
  const cleaned = String(name || `Sheet${fallbackIdx}`)
    .replace(/[\\/?*[\]:]/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned || `Sheet${fallbackIdx}`;
}

function buildZipArchive(files) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const uncompressedBuf = Buffer.isBuffer(file.data)
      ? file.data
      : Buffer.from(String(file.data), 'utf8');
    const compressedBuf = zlib.deflateRawSync(uncompressedBuf);
    const fileCrc = crc32(uncompressedBuf);

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature PK\x03\x04
    localHeader.writeUInt16LE(20, 4); // version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(8, 8); // compression method: deflate
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x0021, 12); // mod date (1980-01-01)
    localHeader.writeUInt32LE(fileCrc, 14);
    localHeader.writeUInt32LE(compressedBuf.length, 18);
    localHeader.writeUInt32LE(uncompressedBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    localParts.push(localHeader, nameBuf, compressedBuf);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature PK\x01\x02
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(8, 10); // compression method: deflate
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(fileCrc, 16);
    centralHeader.writeUInt32LE(compressedBuf.length, 20);
    centralHeader.writeUInt32LE(uncompressedBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(localOffset, 42); // relative offset

    centralParts.push(centralHeader, nameBuf);
    localOffset += localHeader.length + nameBuf.length + compressedBuf.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central directory PK\x05\x06
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

/**
 * Build a valid OpenXML .xlsx Buffer from an array of sheets:
 * sheets: Array<{ name: string, headers: string[], rows: Array<Array<unknown>> }>
 */
export function toXlsxBuffer(sheets = []) {
  const normalizedSheets =
    Array.isArray(sheets) && sheets.length > 0
      ? sheets
      : [{ name: 'Sheet1', headers: [], rows: [] }];

  const contentTypesOverrides = normalizedSheets
    .map(
      (_, idx) =>
        `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('');

  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    contentTypesOverrides +
    `</Types>`;

  const rootRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbookSheetsXml = normalizedSheets
    .map(
      (s, idx) =>
        `<sheet name="${escapeXml(sanitizeSheetName(s.name, idx + 1))}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`
    )
    .join('');

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${workbookSheetsXml}</sheets>` +
    `</workbook>`;

  const workbookRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    normalizedSheets
      .map(
        (_, idx) =>
          `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`
      )
      .join('') +
    `</Relationships>`;

  const zipFiles = [
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: rootRelsXml },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
    ...normalizedSheets.map((s, idx) => ({
      name: `xl/worksheets/sheet${idx + 1}.xml`,
      data: buildWorksheetXml(s.headers || [], s.rows || []),
    })),
  ];

  return buildZipArchive(zipFiles);
}
