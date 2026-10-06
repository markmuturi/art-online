-- ============================================================
-- 006_kyc_documents.sql
-- Documents an applicant uploads in support of their artist
-- application. storage_key points into the PRIVATE R2 bucket,
-- never the public one. Multiple rows per user are expected
-- (front and back of an ID, for instance).
-- ============================================================

CREATE TABLE kyc_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  file_type text NOT NULL,
  file_size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_kyc_documents_user ON kyc_documents(user_id);
