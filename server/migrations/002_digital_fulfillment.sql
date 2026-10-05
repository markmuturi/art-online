-- ============================================================
-- 002_digital_fulfillment.sql
-- Adds digital artworks alongside physical. One artwork row is
-- either physical or digital, never both — an artist selling the
-- same piece both ways lists it twice.
-- ============================================================

ALTER TABLE artworks
  ADD COLUMN fulfillment_type text NOT NULL DEFAULT 'physical'
    CHECK (fulfillment_type IN ('physical','digital')),
  ADD COLUMN edition_type text
    CHECK (edition_type IN ('original','limited')),
  ADD COLUMN edition_size integer
    CHECK (edition_size IS NULL OR edition_size > 0),
  ADD COLUMN editions_sold integer NOT NULL DEFAULT 0
    CHECK (editions_sold >= 0);

ALTER TABLE artworks
  ADD CONSTRAINT digital_requires_edition CHECK (
    fulfillment_type = 'physical' OR edition_type IS NOT NULL
  ),
  ADD CONSTRAINT limited_requires_size CHECK (
    edition_type IS DISTINCT FROM 'limited' OR edition_size IS NOT NULL
  ),
  ADD CONSTRAINT editions_sold_within_size CHECK (
    edition_size IS NULL OR editions_sold <= edition_size
  );

-- Physical orders need an address, digital orders must not have one.
-- A plain CHECK constraint can't see across tables to artworks.fulfillment_type,
-- so this has to be a trigger, not a constraint. Don't skip this and rely on
-- app code alone, that's exactly the kind of rule that gets forgotten later.
ALTER TABLE orders
  ALTER COLUMN shipping_address_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION validate_order_fulfillment()
RETURNS TRIGGER AS $$
DECLARE
  v_fulfillment_type text;
BEGIN
  SELECT fulfillment_type INTO v_fulfillment_type
  FROM artworks WHERE id = NEW.artwork_id;

  IF v_fulfillment_type = 'physical' AND NEW.shipping_address_id IS NULL THEN
    RAISE EXCEPTION 'physical orders require a shipping_address_id';
  END IF;

  IF v_fulfillment_type = 'digital' AND NEW.shipping_address_id IS NOT NULL THEN
    RAISE EXCEPTION 'digital orders must not have a shipping_address_id';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_order_fulfillment
  BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION validate_order_fulfillment();

-- ============================================================
-- The actual sellable file. Private storage key, never a public URL.
-- artwork_images / primary_image_url stay as watermarked or
-- resolution-capped previews — the real deliverable never sits
-- behind a guessable public path.
-- ============================================================
CREATE TABLE digital_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artwork_id uuid NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  file_type text NOT NULL,
  file_size_bytes bigint NOT NULL,
  checksum text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_digital_assets_artwork ON digital_assets(artwork_id);

-- One grant per purchase. Generate a fresh signed URL from storage_key
-- on each request, don't store the signed URL itself, it expires anyway.
CREATE TABLE download_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  digital_asset_id uuid NOT NULL REFERENCES digital_assets(id),
  max_downloads smallint NOT NULL DEFAULT 5,
  download_count smallint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT download_count_within_max CHECK (download_count <= max_downloads)
);
CREATE INDEX idx_download_grants_order ON download_grants(order_id);

-- Evidence trail. When a buyer disputes a card charge claiming they
-- never got the file, this is what you hand Paystack to contest it.
CREATE TABLE download_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  download_grant_id uuid NOT NULL REFERENCES download_grants(id) ON DELETE CASCADE,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_download_events_grant ON download_events(download_grant_id);
