-- ============================================================
-- 005_artist_onboarding.sql
-- Fields needed once applications carry real payout details back
-- from Paystack. The raw phone number / bank account number is
-- never stored here, only what Paystack hands back: a reusable
-- recipient_code, the bank/telco name, and a masked last 4 digits
-- for display. Paystack is the system of record for the full number.
-- ============================================================

ALTER TABLE artist_profiles
  ADD COLUMN kyc_note text,
  ADD COLUMN payout_account_last4 text,
  ADD COLUMN payout_bank_name text;
