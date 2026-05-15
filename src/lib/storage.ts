import * as Minio from "minio";
import { AppError } from "./errors";

// ─────────────────────────────────────────
// MinIO Client (S3-Compatible Storage)
// All story media, NFT images, etc stored here
// ─────────────────────────────────────────
class StorageService {
  private client: Minio.Client;

  // Bucket names
  public readonly BUCKETS = {
    STORIES: "stories",
    STORIES_THUMBNAILS: "stories-thumbnails",
    STORIES_TEMP: "stories-temp",      // raw uploads before processing
    PROFILES: "profiles",
    NFT: "nft-media",
    DOCUMENTS: "documents",
  } as const;

  constructor() {
    this.client = new Minio.Client({
      endPoint: process.env.MINIO_ENDPOINT || "localhost",
      port: parseInt(process.env.MINIO_PORT || "9000"),
      useSSL: process.env.MINIO_USE_SSL === "true",
      accessKey: process.env.MINIO_ROOT_USER || "telegram_minio",
      secretKey: process.env.MINIO_ROOT_PASSWORD || "minio_secret_password",
    });
  }

  // ─────────────────────────────────────
  // INITIALIZE BUCKETS
  // Call once on server startup
  // ─────────────────────────────────────
  async initialize(): Promise<void> {
    for (const bucket of Object.values(this.BUCKETS)) {
      const exists = await this.client.bucketExists(bucket);
      if (!exists) {
        await this.client.makeBucket(bucket, "us-east-1");
        console.log(`✅ Created bucket: ${bucket}`);

        // Set bucket policy for stories (public read for CDN)
        if (bucket === this.BUCKETS.STORIES) {
          await this.client.setBucketPolicy(
            bucket,
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { AWS: ["*"] },
                  Action: ["s3:GetObject"],
                  Resource: [`arn:aws:s3:::${bucket}/*`],
                },
              ],
            })
          );
        }
      }
    }
    console.log("✅ Storage buckets initialized");
  }

  // ─────────────────────────────────────
  // UPLOAD FILE
  // ─────────────────────────────────────
  async uploadFile(
    bucket: string,
    objectName: string,
    buffer: Buffer,
    mimeType: string,
    metadata?: Record<string, string>
  ): Promise<string> {
    await this.client.putObject(
      bucket,
      objectName,
      buffer,
      buffer.length,
      {
        "Content-Type": mimeType,
        ...metadata,
      }
    );

    return this.getPublicUrl(bucket, objectName);
  }

  // ─────────────────────────────────────
  // GET SIGNED URL (time-limited access)
  // For private content (paid stories, etc)
  // ─────────────────────────────────────
  async getSignedUrl(
    bucket: string,
    objectName: string,
    expirySeconds: number = 3600
  ): Promise<string> {
    return this.client.presignedGetObject(
      bucket,
      objectName,
      expirySeconds
    );
  }

  // ─────────────────────────────────────
  // DELETE FILE
  // ─────────────────────────────────────
  async deleteFile(bucket: string, objectName: string): Promise<void> {
    await this.client.removeObject(bucket, objectName);
  }

  // ─────────────────────────────────────
  // DELETE MULTIPLE FILES
  // ─────────────────────────────────────
  async deleteFiles(
    bucket: string,
    objectNames: string[]
  ): Promise<void> {
    await this.client.removeObjects(bucket, objectNames);
  }

  // ─────────────────────────────────────
  // GET PUBLIC URL
  // ─────────────────────────────────────
  getPublicUrl(bucket: string, objectName: string): string {
    const endpoint = process.env.MINIO_ENDPOINT || "localhost";
    const port = process.env.MINIO_PORT || "9000";
    const ssl = process.env.MINIO_USE_SSL === "true";
    const protocol = ssl ? "https" : "http";
    return `${protocol}://${endpoint}:${port}/${bucket}/${objectName}`;
  }

  // ─────────────────────────────────────
  // CHECK IF FILE EXISTS
  // ─────────────────────────────────────
  async fileExists(bucket: string, objectName: string): Promise<boolean> {
    try {
      await this.client.statObject(bucket, objectName);
      return true;
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────
  // GET FILE SIZE
  // ─────────────────────────────────────
  async getFileSize(
    bucket: string,
    objectName: string
  ): Promise<number> {
    const stat = await this.client.statObject(bucket, objectName);
    return stat.size;
  }
}

export const storageService = new StorageService();
