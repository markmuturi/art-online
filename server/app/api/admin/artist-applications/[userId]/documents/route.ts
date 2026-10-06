import { pool } from "@/lib/db";
import { requireRole, errorResponse } from "@/lib/auth/session";
import { getPrivateDownloadUrl } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
  try {
    await requireRole(req.headers, "admin");
  } catch (err) {
    return errorResponse(err);
  }
  const { userId } = await params;

  const docs = await pool.query<{ id: string; storage_key: string; file_type: string; created_at: string }>(
    `SELECT id, storage_key, file_type, created_at FROM kyc_documents WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  // Signed URLs are generated fresh on every request and expire in 15 minutes. Nothing about a
  // KYC document is ever reachable through a link that outlives the admin's current review session.
  const withUrls = await Promise.all(
    docs.rows.map(async (d) => ({
      id: d.id,
      fileType: d.file_type,
      uploadedAt: d.created_at,
      downloadUrl: await getPrivateDownloadUrl(d.storage_key, 900),
    })),
  );
  return Response.json(withUrls);
}
