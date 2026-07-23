import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const AWS_REGION = process.env.AWS_REGION || "eu-west-1";

const s3 = new S3Client({ region: AWS_REGION });

/**
 * Uploads a buffer to S3 under a namespaced key and returns its public URL.
 */
export async function uploadToS3(
  buffer: Buffer,
  mimeType: string,
  folder: "receipts" | "voice-notes"
): Promise<string> {
  if (!S3_BUCKET_NAME) {
    throw new Error("S3_BUCKET_NAME not configured");
  }

  const extension = mimeType.split("/")[1]?.split(";")[0] || "bin";
  const key = `${folder}/${crypto.randomUUID()}.${extension}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    })
  );

  return `https://${S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}
