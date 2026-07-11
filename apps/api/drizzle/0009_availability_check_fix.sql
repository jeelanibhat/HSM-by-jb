-- Relax the availability guard from `sold + blocked <= total` to `sold <= total`.
--
-- The original was wrong in a way that only shows up operationally.
--
-- Blocking a room is a business decision, and it can legitimately happen on a
-- sold-out night: a pipe bursts in 204 and the room must go OOO while a guest
-- holds a confirmed booking for it. That is an OVERBOOKING — a real situation the
-- front office resolves by moving or walking a guest. It is not a data-integrity
-- violation.
--
-- Under the old CHECK, Postgres would have refused the write that recorded the
-- burst pipe. The system would have made it impossible to tell the truth about the
-- state of the hotel — the counters would stay tidy and the broken room would keep
-- being sold.
--
-- What must never happen is selling the 31st room of a 30-room type, or releasing
-- a room twice on cancellation. `sold >= 0 AND sold <= total` guards exactly that,
-- and it stays.

ALTER TABLE "reservations"."room_type_availability"
  DROP CONSTRAINT IF EXISTS availability_never_oversold;

ALTER TABLE "reservations"."room_type_availability"
  ADD CONSTRAINT availability_never_oversold
  CHECK (sold >= 0 AND sold <= total);
