import type { PoolClient } from "pg";

export class ApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplicationError";
  }
}

export interface ApplicationRow {
  userId: string;
  displayName: string;
  bio: string | null;
  locationCity: string | null;
  payoutChannel: "mpesa" | "bank" | null;
  payoutBankName: string | null;
  payoutAccountLast4: string | null;
  kycStatus: "pending" | "verified" | "rejected";
  kycNote: string | null;
  createdAt: string;
}

function mapRow(r: any): ApplicationRow {
  return {
    userId: r.user_id,
    displayName: r.display_name,
    bio: r.bio,
    locationCity: r.location_city,
    payoutChannel: r.payout_channel,
    payoutBankName: r.payout_bank_name,
    payoutAccountLast4: r.payout_account_last4,
    kycStatus: r.kyc_status,
    kycNote: r.kyc_note,
    createdAt: r.created_at,
  };
}

// Read-only, called before the Paystack network call so we fail fast without creating a
// recipient we'd have to clean up. A second, real race (two concurrent applications from
// the same user) is possible but low-stakes: worst case is two Paystack recipients created,
// never two role changes, since approve/reject only ever acts on a single row.
export async function checkCanApply(client: PoolClient, userId: string): Promise<void> {
  const { rows } = await client.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [userId]);
  if (rows[0]?.role === "artist") throw new ApplicationError("You're already an artist.");
  if (rows[0]?.role === "admin") throw new ApplicationError("Admin accounts cannot apply as artists.");

  const existing = await client.query<{ kyc_status: string }>(
    `SELECT kyc_status FROM artist_profiles WHERE user_id = $1`,
    [userId],
  );
  const status = existing.rows[0]?.kyc_status;
  if (status === "pending") throw new ApplicationError("Your application is already pending review.");
  if (status === "verified") throw new ApplicationError("You're already an approved artist.");
  // status undefined (first application) or 'rejected' (reapplying) are both fine.
}

export interface SaveApplicationArgs {
  userId: string;
  displayName: string;
  bio: string | null;
  locationCity: string | null;
  payoutChannel: "mpesa" | "bank";
  recipientCode: string;
  bankName: string;
  accountLast4: string;
}

// Called after the Paystack recipient already exists. INSERT for a first-time applicant,
// UPDATE (clearing any old rejection note) for someone reapplying.
export async function saveApplication(client: PoolClient, args: SaveApplicationArgs): Promise<void> {
  await client.query(
    `INSERT INTO artist_profiles
       (user_id, display_name, bio, location_city, payout_channel,
        paystack_recipient_code, payout_bank_name, payout_account_last4, kyc_status, kyc_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       bio = EXCLUDED.bio,
       location_city = EXCLUDED.location_city,
       payout_channel = EXCLUDED.payout_channel,
       paystack_recipient_code = EXCLUDED.paystack_recipient_code,
       payout_bank_name = EXCLUDED.payout_bank_name,
       payout_account_last4 = EXCLUDED.payout_account_last4,
       kyc_status = 'pending',
       kyc_note = NULL,
       updated_at = now()`,
    [
      args.userId,
      args.displayName,
      args.bio,
      args.locationCity,
      args.payoutChannel,
      args.recipientCode,
      args.bankName,
      args.accountLast4,
    ],
  );
}

export async function getOwnApplication(client: PoolClient, userId: string): Promise<ApplicationRow | null> {
  const { rows } = await client.query(`SELECT * FROM artist_profiles WHERE user_id = $1`, [userId]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function listPendingApplications(client: PoolClient): Promise<ApplicationRow[]> {
  const { rows } = await client.query(
    `SELECT * FROM artist_profiles WHERE kyc_status = 'pending' ORDER BY created_at`,
  );
  return rows.map(mapRow);
}

export async function approveApplication(client: PoolClient, userId: string): Promise<void> {
  const app = await client.query(
    `SELECT 1 FROM artist_profiles WHERE user_id = $1 AND kyc_status = 'pending' FOR UPDATE`,
    [userId],
  );
  if (app.rowCount === 0) throw new ApplicationError("No pending application for this user.");

  await client.query(`UPDATE artist_profiles SET kyc_status = 'verified', kyc_verified_at = now() WHERE user_id = $1`, [
    userId,
  ]);
  await client.query(`UPDATE users SET role = 'artist' WHERE id = $1`, [userId]);
}

// Returns the recipient code (or null) so the route can attempt Paystack cleanup
// outside this transaction, same reasoning as every other network-call-after-commit pattern here.
export async function rejectApplication(client: PoolClient, userId: string, note: string | null): Promise<string | null> {
  const found = await client.query<{ paystack_recipient_code: string | null }>(
    `SELECT paystack_recipient_code FROM artist_profiles WHERE user_id = $1 AND kyc_status = 'pending' FOR UPDATE`,
    [userId],
  );
  if (found.rowCount === 0) throw new ApplicationError("No pending application for this user.");

  await client.query(`UPDATE artist_profiles SET kyc_status = 'rejected', kyc_note = $2 WHERE user_id = $1`, [
    userId,
    note,
  ]);
  return found.rows[0].paystack_recipient_code;
}
