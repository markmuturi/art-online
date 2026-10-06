import sharp from "sharp";

export class InvalidImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImageError";
  }
}

const MAX_INPUT_PIXELS = 40_000_000; // ~40MP. Guards against a tiny file that decompresses huge.
const MAX_PUBLIC_DIMENSION = 2000; // long edge, in pixels
const PUBLIC_WEBP_QUALITY = 82;

export interface ProcessedImage {
  buffer: Buffer;
  contentType: string;
  extension: string;
}

// For public artwork photos. Fully decoding the file IS the format check: a corrupt file or one
// with a fake extension simply fails here, which is a stronger guarantee than sniffing a magic
// byte header. .rotate() with no args bakes the EXIF orientation into the actual pixels before
// that tag is gone; re-encoding without calling withMetadata() drops EXIF/GPS/IPTC by default,
// which is what actually stops a phone photo from leaking an artist's home studio location.
export async function processPublicImage(input: Buffer): Promise<ProcessedImage> {
  try {
    await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw new InvalidImageError("That file isn't a readable image.");
  }
  const buffer = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: MAX_PUBLIC_DIMENSION, height: MAX_PUBLIC_DIMENSION, fit: "inside", withoutEnlargement: true })
    .webp({ quality: PUBLIC_WEBP_QUALITY })
    .toBuffer();
  return { buffer, contentType: "image/webp", extension: "webp" };
}

const FORMAT_MAP: Record<string, { contentType: string; extension: string }> = {
  jpeg: { contentType: "image/jpeg", extension: "jpg" },
  png: { contentType: "image/png", extension: "png" },
  webp: { contentType: "image/webp", extension: "webp" },
};

// For private KYC documents. Validated the same way (must actually decode), but NOT resized or
// re-encoded: an ID photo needs to stay legible for whoever reviews it, and since this bucket is
// never public, stripping EXIF here isn't buying any real privacy.
export async function validateKycImage(input: Buffer): Promise<ProcessedImage> {
  let format: string | undefined;
  try {
    format = (await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
  } catch {
    throw new InvalidImageError("That file isn't a readable image.");
  }
  const detected = format ? FORMAT_MAP[format] : undefined;
  if (!detected) throw new InvalidImageError(`Unsupported image format: ${format ?? "unknown"}. Use JPEG, PNG or WebP.`);
  return { buffer: input, contentType: detected.contentType, extension: detected.extension };
}
