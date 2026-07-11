-- Extensions the HotelOS schema depends on. Run once at container init.

-- btree_gist: required for the no_double_booking EXCLUDE constraint (TDD §4.3),
-- which mixes an equality operator (room_id WITH =) with a range overlap
-- operator (stay WITH &&) in a single GiST index.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- pgcrypto: gen_random_bytes for column-level PII encryption (TDD §9).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Citext: case-insensitive email uniqueness on identity.users.
CREATE EXTENSION IF NOT EXISTS citext;
