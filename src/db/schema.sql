-- ParcelTongue schema, version 1 (PRD §7).
-- Applied by db.ts through the migrations runner; all timestamps are UTC ISO.

CREATE TABLE packages (
  awb              TEXT PRIMARY KEY,        -- 13–14 digits, normalized
  added_at         TEXT NOT NULL,
  source_link      TEXT,                    -- original link if provided
  dest_city        TEXT,
  reference_no     TEXT,
  product_type     TEXT,
  current_stage    TEXT,                    -- registered|accepted|in_transit|out_for_delivery|delivered|returned|exception|unknown
  status_text      TEXT,                    -- latest raw status description
  status_at        TEXT,                    -- latest status time (UTC ISO, source IST)
  delivery_eta     TEXT,                    -- raw prose, e.g. "26 Oct 2026, Evening"
  terminal         INTEGER NOT NULL DEFAULT 0,
  terminal_reason  TEXT,                    -- delivered|rto|lost|cancelled
  polls            INTEGER NOT NULL DEFAULT 0,
  last_polled_at   TEXT,
  last_error       TEXT,
  error_streak     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE events (
  id             INTEGER PRIMARY KEY,
  awb            TEXT NOT NULL REFERENCES packages(awb),
  occurred_at    TEXT,                      -- UTC ISO when the feed gave a time, else NULL
  description    TEXT NOT NULL,             -- scan label / status text
  location       TEXT,                      -- cityLocation or scannedLocation
  stage          TEXT,                      -- classified stage when known
  leg            TEXT NOT NULL DEFAULT 'forward',  -- forward|return
  is_summary     INTEGER NOT NULL DEFAULT 0,       -- 1 = status snapshot, not a scan
  first_seen_at  TEXT NOT NULL
  -- Dedupe across polls (PRD §7) is enforced by the unique expression
  -- index below, not a table-level UNIQUE: SQLite treats NULLs as
  -- distinct in UNIQUE constraints, so two undated (or location-less)
  -- scans of the same description would re-insert on every poll
  -- (see uq_events_dedupe).
);

CREATE INDEX idx_events_awb ON events(awb, first_seen_at);

-- Cross-poll dedupe key (PRD §7). COALESCE makes NULL occurred_at /
-- location compare equal, so undated scans are only ever inserted once
-- (M2 flagged this caveat; the anonymous feed is full of scans without
-- timestamps — PRD §4.3 pitfall 4).
CREATE UNIQUE INDEX uq_events_dedupe ON events(
  awb, description, COALESCE(occurred_at, ''), COALESCE(location, ''), leg
);
