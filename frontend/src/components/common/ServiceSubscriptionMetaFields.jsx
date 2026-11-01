import React from 'react';
import { Car } from 'lucide-react';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { syncVehiclePlatesArray } from '../../utils/serviceSubscriptionMeta';

export function ServiceSubscriptionMetaFields({
  isParking = false,
  quantity = 1,
  vehiclePlates = [],
  note = '',
  plateErrors = [],
  noteError = '',
  onPlateChange,
  onNoteChange,
  noteMultiline = false,
  noteRows = 2,
}) {
  const slots = isParking ? syncVehiclePlatesArray(vehiclePlates, quantity) : [];

  return (
    <div className="space-y-3">
      {isParking ? (
        <div className={slots.length > 1 ? 'grid grid-cols-1 sm:grid-cols-2 gap-3' : ''}>
          {slots.map((plateVal, idx) => (
            <Input
              key={idx}
              required
              icon={Car}
              label={slots.length === 1 ? 'Biển số xe' : `Biển số xe #${idx + 1}`}
              placeholder="VD: 59A1-123.45, Xe đạp #1 hoặc Chờ bấm biển"
              maxLength={30}
              value={plateVal}
              error={plateErrors?.[idx] || ''}
              onChange={(e) => onPlateChange?.(idx, e.target.value)}
            />
          ))}
        </div>
      ) : null}

      <Input
        label="Ghi chú dịch vụ (tùy chọn)"
        multiline={noteMultiline}
        rows={noteRows}
        maxLength={500}
        placeholder={
          isParking
            ? 'VD: Loại xe tay ga, ô đỗ hầm B1, mã thẻ từ...'
            : 'VD: Khung giờ phục vụ, gói cước hoặc thỏa thuận riêng...'
        }
        value={note || ''}
        error={noteError || ''}
        onChange={(e) => onNoteChange?.(e.target.value)}
      />
    </div>
  );
}

export function VehiclePlatesBadges({ plates, className = '' }) {
  const cleanPlates = Array.isArray(plates)
    ? plates.map((p) => String(p || '').trim()).filter(Boolean)
    : [];

  if (cleanPlates.length === 0) return null;

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`.trim()}>
      {cleanPlates.map((plate, idx) => (
        <Badge key={`${plate}-${idx}`} variant="sky" icon={Car} className="font-mono text-[11px]">
          {plate}
        </Badge>
      ))}
    </div>
  );
}

export default ServiceSubscriptionMetaFields;
