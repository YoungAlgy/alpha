import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const CIPHERTEXT_VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function configuredSecret(): string {
  const value = process.env.CHECKOUT_BINDING_SECRET?.trim();
  if (!value) throw new Error("CHECKOUT_BINDING_SECRET is not configured");
  return value;
}

function encryptionKey(secret: string): Buffer {
  if (!secret) throw new Error("checkout Session email key is unavailable");
  // Domain separation keeps the encryption key independent from the HMAC key
  // used by checkoutEmailBinding even though both derive from one managed
  // checkout secret.
  return createHmac("sha256", secret)
    .update("alpha-checkout-session-email-key-v1\0", "utf8")
    .digest();
}

function associatedData(profileId: string): Buffer {
  if (!profileId) throw new Error("checkout profile id is required");
  return Buffer.from(
    `alpha-checkout-session-email-v1\0${profileId}`,
    "utf8"
  );
}

/**
 * Encrypt the exact normalized customer_email used in Stripe Session params.
 * The random nonce is stored with the versioned ciphertext. AES-GCM binds the
 * value to one profile id and authenticates it before any plaintext is used.
 */
export function encryptCheckoutSessionEmail(
  normalizedEmail: string,
  profileId: string,
  secret: string = configuredSecret()
): string {
  if (
    !normalizedEmail ||
    normalizedEmail !== normalizedEmail.toLowerCase().trim()
  ) {
    throw new Error("checkout Session email must already be normalized");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), nonce);
  cipher.setAAD(associatedData(profileId));
  const encrypted = Buffer.concat([
    cipher.update(normalizedEmail, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    CIPHERTEXT_VERSION,
    nonce.toString("base64url"),
    encrypted.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function decryptCheckoutSessionEmail(
  ciphertext: string,
  profileId: string,
  secret: string = configuredSecret()
): string {
  const parts = ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== CIPHERTEXT_VERSION) {
    throw new Error("checkout Session email ciphertext version is invalid");
  }
  const nonce = Buffer.from(parts[1], "base64url");
  const encrypted = Buffer.from(parts[2], "base64url");
  const tag = Buffer.from(parts[3], "base64url");
  if (
    nonce.length !== NONCE_BYTES ||
    tag.length !== TAG_BYTES ||
    encrypted.length < 3 ||
    encrypted.length > 254
  ) {
    throw new Error("checkout Session email ciphertext is malformed");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(secret),
    nonce
  );
  decipher.setAAD(associatedData(profileId));
  decipher.setAuthTag(tag);
  const normalizedEmail = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
  if (
    !normalizedEmail ||
    normalizedEmail !== normalizedEmail.toLowerCase().trim()
  ) {
    throw new Error("decrypted checkout Session email is invalid");
  }
  return normalizedEmail;
}
