import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const AWS_REGION = process.env.AWS_REGION || "eu-west-1"; // adjust to your bucket's region

const s3 = new S3Client({ region: AWS_REGION });

/**
 * Uploads a buffer to S3 under a namespaced key and returns its public URL.
 * `folder` groups files by type, e.g. "receipts" or "voice-notes".
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
      // NOTE: bucket is assumed private with objects served via CloudFront
      // or presigned URLs in production. If you want plain public URLs
      // instead, add ACL: 'public-read' here AND enable public access on
      // the bucket — not recommended for user-submitted receipt photos
      // since they may contain sensitive business data.
    })
  );

  return `https://${S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}
