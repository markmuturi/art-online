import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// R2_ENDPOINT is a test-only override (point it at a local S3-compatible server). In production,
// leave it unset and the endpoint is derived from R2_ACCOUNT_ID the way Cloudflare R2 expects.
function endpoint(): string {
  if (process.env.R2_ENDPOINT) return process.env.R2_ENDPOINT;
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) throw new Error("R2_ACCOUNT_ID is not set");
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function client(): S3Client {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY is not set");
  // forcePathStyle is required for R2 and happens to also work for the local test server.
  return new S3Client({ endpoint: endpoint(), region: "auto", credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true });
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// Public bucket: artwork photos. Must be configured for public read access in the R2 dashboard
// (a custom domain, or the r2.dev development URL) — this code only uploads, it does not grant access.
export async function uploadPublicObject(key: string, body: Buffer, contentType: string): Promise<string> {
  await client().send(new PutObjectCommand({ Bucket: requiredEnv("R2_PUBLIC_BUCKET"), Key: key, Body: body, ContentType: contentType }));
  return `${requiredEnv("R2_PUBLIC_BASE_URL").replace(/\/$/, "")}/${key}`;
}

export async function deletePublicObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: requiredEnv("R2_PUBLIC_BUCKET"), Key: key }));
}

// Private bucket: KYC documents. Must NOT have public access enabled. The only way out is a
// short-lived signed URL generated on demand for an admin, via getPrivateDownloadUrl below.
export async function uploadPrivateObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await client().send(new PutObjectCommand({ Bucket: requiredEnv("R2_PRIVATE_BUCKET"), Key: key, Body: body, ContentType: contentType }));
}

export async function getPrivateDownloadUrl(key: string, expiresInSeconds = 900): Promise<string> {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: requiredEnv("R2_PRIVATE_BUCKET"), Key: key }), { expiresIn: expiresInSeconds });
}

export async function deletePrivateObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: requiredEnv("R2_PRIVATE_BUCKET"), Key: key }));
}
