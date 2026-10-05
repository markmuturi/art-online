-- ============================================================
-- Marketplace schema: artists, artworks, orders with escrow
-- Money is stored as integer cents. Never use float for currency.
-- Pairs with order-state-machine.md for the `orders.state` logic.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  phone text,
  password_hash text,               -- null if using an OAuth-only provider
  full_name text NOT NULL,
  role text NOT NULL DEFAULT 'buyer' CHECK (role IN ('buyer','artist','admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- ARTIST PROFILES (1:1 extension of users where role = 'artist')
-- ============================================================
CREATE TABLE artist_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  bio text,
  location_city text,
  location_country text NOT NULL DEFAULT 'KE',
  paystack_recipient_code text,     -- set once artist completes payout onboarding
  payout_channel text CHECK (payout_channel IN ('mpesa','bank')),
  kyc_status text NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending','verified','rejected')),
  kyc_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_artist_profiles_updated_at BEFORE UPDATE ON artist_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_artist_profiles_location ON artist_profiles(location_city);

-- ============================================================
-- BUYER SHIPPING ADDRESSES
-- ============================================================
CREATE TABLE addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_name text NOT NULL,
  line1 text NOT NULL,
  line2 text,
  city text NOT NULL,
  county text,
  postal_code text,
  country text NOT NULL DEFAULT 'KE',
  phone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_addresses_user ON addresses(user_id);

-- ============================================================
-- GENRES (taxonomy for browsing/filtering)
-- ============================================================
CREATE TABLE genres (
  id serial PRIMARY KEY,
  name text UNIQUE NOT NULL,
  slug text UNIQUE NOT NULL
);

-- ============================================================
-- ARTWORKS
-- ============================================================
CREATE TABLE artworks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id uuid NOT NULL REFERENCES artist_profiles(user_id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  genre_id int REFERENCES genres(id),
  price_cents integer NOT NULL CHECK (price_cents > 0),
  currency text NOT NULL DEFAULT 'KES',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','listed','sold','removed')),
  primary_image_url text,           -- object storage URL, not a binary
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_artworks_updated_at BEFORE UPDATE ON artworks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_artworks_status ON artworks(status);
CREATE INDEX idx_artworks_genre ON artworks(genre_id);
CREATE INDEX idx_artworks_artist ON artworks(artist_id);

-- Additional images beyond the primary one, also object storage URLs
CREATE TABLE artwork_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artwork_id uuid NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  url text NOT NULL,
  position smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_artwork_images_artwork ON artwork_images(artwork_id);

-- ============================================================
-- ORDERS — the escrow-relevant table. See order-state-machine.md
-- for the full transition table before touching `state` in code.
-- ============================================================
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES users(id),
  artwork_id uuid NOT NULL REFERENCES artworks(id),
  artist_id uuid NOT NULL REFERENCES artist_profiles(user_id),
  shipping_address_id uuid NOT NULL REFERENCES addresses(id),

  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  platform_fee_cents integer NOT NULL CHECK (platform_fee_cents >= 0),
  artist_payout_cents integer NOT NULL CHECK (artist_payout_cents >= 0),
  currency text NOT NULL DEFAULT 'KES',

  state text NOT NULL DEFAULT 'pending_payment' CHECK (state IN (
    'pending_payment','paid_held','shipped','delivered_confirmed',
    'disputed','released','refunded','cancelled'
  )),

  tracking_number text,
  shipped_at timestamptz,
  delivered_confirmed_at timestamptz,
  release_eligible_at timestamptz,   -- delivered_confirmed_at + dispute window, checked by the release job
  released_at timestamptz,
  refunded_at timestamptz,
  cancelled_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payout_math CHECK (artist_payout_cents = amount_cents - platform_fee_cents)
);
CREATE TRIGGER trg_orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_orders_state ON orders(state);
CREATE INDEX idx_orders_buyer ON orders(buyer_id);
CREATE INDEX idx_orders_artist ON orders(artist_id);
-- speeds up the release job's core query
CREATE INDEX idx_orders_release_eligible ON orders(release_eligible_at)
  WHERE state = 'delivered_confirmed';

-- ============================================================
-- ORDER EVENTS — audit trail, one row per state transition.
-- Write to this in the same transaction as every state change.
-- ============================================================
CREATE TABLE order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('buyer','artist','admin','system')),
  actor_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_events_order ON order_events(order_id);

-- ============================================================
-- PAYMENTS — inbound charge from the buyer via Paystack
-- ============================================================
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  paystack_reference text UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  amount_cents integer NOT NULL,
  raw_webhook_payload jsonb,        -- keep for audit/dispute evidence
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_payments_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- PAYOUTS — outbound transfer to the artist via Paystack Transfers
-- ============================================================
CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  artist_id uuid NOT NULL REFERENCES artist_profiles(user_id),
  paystack_transfer_code text UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','reversed')),
  amount_cents integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_payouts_updated_at BEFORE UPDATE ON payouts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- WEBHOOK EVENTS — idempotency dedup for Paystack webhooks.
-- Insert before processing; reject duplicates on (provider, event_id).
-- ============================================================
CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'paystack',
  event_id text NOT NULL,
  event_type text,
  payload jsonb,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
