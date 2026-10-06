import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import S3rver from "s3rver";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";

// A local S3-compatible server standing in for Cloudflare R2 in tests. R2 is S3-API-compatible,
// so code written against the real @aws-sdk/client-s3 here runs unmodified against real R2,
// only the endpoint and credentials change.
export async function startTestStorage(port: number): Promise<() => Promise<void>> {
  const dir = mkdtempSync(join(tmpdir(), "art-online-s3-"));
  const server = new S3rver({ port, address: "localhost", silent: true, directory: dir });
  await server.run();

  process.env.R2_ENDPOINT = `http://localhost:${port}`;
  process.env.R2_ACCESS_KEY_ID = "S3RVER";
  process.env.R2_SECRET_ACCESS_KEY = "S3RVER";
  process.env.R2_PUBLIC_BUCKET = "art-online-public-test";
  process.env.R2_PRIVATE_BUCKET = "art-online-private-test";
  process.env.R2_PUBLIC_BASE_URL = `http://localhost:${port}/${process.env.R2_PUBLIC_BUCKET}`;

  const s3 = new S3Client({
    endpoint: process.env.R2_ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "S3RVER", secretAccessKey: "S3RVER" },
    forcePathStyle: true,
  });
  await s3.send(new CreateBucketCommand({ Bucket: process.env.R2_PUBLIC_BUCKET }));
  await s3.send(new CreateBucketCommand({ Bucket: process.env.R2_PRIVATE_BUCKET }));

  return async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  };
}
