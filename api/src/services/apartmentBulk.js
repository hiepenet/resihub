export function floorLevelToken(level) {
  const n = Number(level);
  if (!Number.isInteger(n)) return String(level ?? '').trim().toUpperCase();
  if (n < 0) return `B${Math.abs(n)}`;
  if (n === 0) return 'G';
  return String(n);
}

export function buildApartmentDrafts({
  codePrefix = '',
  units = [],
  floors = [],
  zoneId = null,
  amenities = {},
  note = '',
} = {}) {
  const prefix = String(codePrefix || '').trim().toUpperCase();

  return floors.flatMap((floor) =>
    units.map((unit, index) => {
      const suffix = unit.suffix
        ? String(unit.suffix).trim().toUpperCase()
        : String(index + 1).padStart(2, '0');

      return {
        floor_id: floor.id,
        floor_name: floor.name || `Tầng ${floor.level}`,
        code: `${prefix}${floorLevelToken(floor.level)}${suffix}`,
        zone_id: zoneId || null,
        type: String(unit.type || '1PN').trim(),
        bedrooms: Number(unit.bedrooms ?? 1),
        area_m2: Number(unit.area_m2 ?? 0),
        base_rent: Number(unit.base_rent ?? 0),
        amenities: amenities || {},
        note: note || '',
      };
    })
  );
}

export function findDuplicateCodes(drafts = []) {
  const seen = new Set();
  const duplicates = new Set();
  for (const draft of drafts) {
    const code = String(draft?.code || '').trim().toUpperCase();
    if (!code) continue;
    if (seen.has(code)) duplicates.add(code);
    else seen.add(code);
  }
  return [...duplicates];
}
