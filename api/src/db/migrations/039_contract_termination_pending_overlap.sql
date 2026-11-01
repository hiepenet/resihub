-- 039_contract_termination_pending_overlap.sql
-- 1. Mở rộng ràng buộc chồng lấn hợp đồng (contract_no_overlap) bao gồm cả TERMINATION_PENDING
--    và tính theo ngày kết thúc thực tế COALESCE(terminated_at, end_date) để bảo vệ giai đoạn chờ bàn giao
--    nhưng vẫn cho phép ký hợp đồng mới nối tiếp từ sau ngày trả phòng đã duyệt.
-- 2. Đồng bộ lại các hợp đồng đang ACTIVE nhưng đã có đề nghị chấm dứt (contract_request TERMINATION = APPROVED).

BEGIN;

-- Cập nhật các hợp đồng đang ACTIVE mà đề nghị TERMINATION đã được duyệt trước đó
UPDATE contract c
SET status = CASE
      WHEN COALESCE(cr.desired_date, CURRENT_DATE) <= CURRENT_DATE THEN 'TERMINATED'
      ELSE 'TERMINATION_PENDING'
    END,
    terminated_at = LEAST(
      c.end_date,
      GREATEST(
        CASE WHEN CURRENT_DATE < c.start_date THEN CURRENT_DATE ELSE c.start_date END,
        COALESCE(cr.desired_date, CURRENT_DATE)
      )
    ),
    updated_at = NOW()
FROM (
  SELECT DISTINCT ON (contract_id) contract_id, desired_date
  FROM contract_request
  WHERE type = 'TERMINATION' AND status = 'APPROVED'
  ORDER BY contract_id, updated_at DESC
) cr
WHERE c.id = cr.contract_id
  AND c.status = 'ACTIVE';

ALTER TABLE contract DROP CONSTRAINT IF EXISTS contract_no_overlap;

ALTER TABLE contract ADD CONSTRAINT contract_no_overlap
  EXCLUDE USING gist (
    apartment_id WITH =,
    daterange(start_date, COALESCE(terminated_at, end_date), '[)') WITH &&
  )
  WHERE (
    status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
    AND COALESCE(terminated_at, end_date) > start_date
  );

COMMIT;

