import React from 'react';
import { Badge } from '../ui/Badge';
import { ALL_STATUS_MAPS } from '../../constants/statuses';

export function StatusBadge({ status, domain = 'contract', dot = true, className = '' }) {
  if (!status) return <Badge variant="slate">—</Badge>;

  const map = ALL_STATUS_MAPS[domain] || {};
  let found = map[status];

  if (!found) {
    for (const m of Object.values(ALL_STATUS_MAPS)) {
      if (m[status]) {
        found = m[status];
        break;
      }
    }
  }

  if (!found) {
    return (
      <Badge variant="slate" dot={dot} className={className}>
        {status}
      </Badge>
    );
  }

  return (
    <Badge variant={found.variant || 'slate'} dot={dot} className={className}>
      {found.label}
    </Badge>
  );
}

export default StatusBadge;

