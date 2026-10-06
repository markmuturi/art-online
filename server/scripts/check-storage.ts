import { randomUUID } from "node:crypto";
import { uploadPublicObject, uploadPrivateObject, getPrivateDownloadUrl, deletePublicObject, deletePrivateObject } from "../lib/storage";

// Round-trips a real object through your actual R2 buckets using your real .env credentials.
// Unlike `npm test`, which runs against a local stand-in, this talks to the real thing: it
// confirms your buckets exist, your API token actually works, your public bucket is really
// public, and — just as important — that your private bucket is NOT.

function fail(msg: string): never {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}

// R2_ACCOUNT_ID is only required when R2_ENDPOINT isn't set, matching lib/storage.ts's own rule.
const required = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_PUBLIC_BUCKET", "R2_PRIVATE_BUCKET", "R2_PUBLIC_BASE_URL"];
if (!process.env.R2_ENDPOINT) required.push("R2_ACCOUNT_ID");
for (const name of required) {
  if (!process.env[name]) fail(`${name} is not set. Fill in every R2_* variable in .env before running this.`);
}

const marker = randomUUID();
const body = Buffer.from(`art-online storage check ${marker}`);

console.log("Uploading a test object to the PUBLIC bucket...");
const publicKey = `storage-check/${marker}.txt`;
const publicUrl = await uploadPublicObject(publicKey, body, "text/plain");
console.log(`  uploaded, constructed URL: ${publicUrl}`);

console.log("Fetching it back with a plain, unsigned request (the way a browser would)...");
const publicFetch = await fetch(publicUrl);
if (publicFetch.status !== 200) {
  fail(
    `the public bucket returned ${publicFetch.status} for an unsigned GET. ` +
      `Public access is probably not enabled yet: bucket -> Settings -> Public access.`,
  );
}
const publicBody = await publicFetch.text();
if (publicBody !== body.toString()) fail("public bucket returned 200 but the content didn't match what was uploaded.");
console.log("  PASS: public bucket is reachable and serving the right content.");

console.log("Uploading a test object to the PRIVATE bucket...");
// A distinct key from the public object above — otherwise the leak check below would pass
// by coincidence, because the public bucket genuinely has something at the shared path.
const privateKey = `storage-check/${marker}-private.txt`;
await uploadPrivateObject(privateKey, body, "text/plain");

console.log("Confirming the private object is NOT reachable through the public bucket URL...");
const leakCheck = await fetch(`${process.env.R2_PUBLIC_BASE_URL}/${privateKey}`);
if (leakCheck.status === 200) {
  fail(
    "a private-bucket object was fetchable through the PUBLIC bucket's URL. " +
      "Check that R2_PUBLIC_BUCKET and R2_PRIVATE_BUCKET are actually two different buckets.",
  );
}
console.log("  PASS: private object is not reachable via the public bucket.");

console.log("Generating a signed URL for the private object and fetching it...");
const signedUrl = await getPrivateDownloadUrl(privateKey, 60);
const signedFetch = await fetch(signedUrl);
if (signedFetch.status !== 200) fail(`signed URL returned ${signedFetch.status}. Check the API token's permissions on the private bucket.`);
if ((await signedFetch.text()) !== body.toString()) fail("signed URL returned 200 but the content didn't match.");
console.log("  PASS: signed URL works and returns the right content.");

console.log("Cleaning up both test objects...");
await deletePublicObject(publicKey);
await deletePrivateObject(privateKey);

console.log("\nALL CHECKS PASSED. Your R2 setup is correctly wired.");
