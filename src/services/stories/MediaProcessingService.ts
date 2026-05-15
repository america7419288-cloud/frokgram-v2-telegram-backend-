import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
import { createWriteStream, createReadStream, unlinkSync, mkdirSync, readFileSync } from "fs";
import { join, basename, dirname } from "path";
import { tmpdir } from "os";
import { storageService } from "../../lib/storage";
import { AppError } from "../../lib/errors";

// ─────────────────────────────────────────
// Media Validation Config
// ─────────────────────────────────────────
const MEDIA_CONFIG = {
  // Image limits
  IMAGE: {
    MAX_SIZE_MB_FREE: 10,
    MAX_SIZE_MB_PREMIUM: 50,
    ALLOWED_TYPES: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    MAX_WIDTH: 4096,
    MAX_HEIGHT: 4096,
  },
  // Video limits
  VIDEO: {
    MAX_DURATION_SEC_FREE: 15,
    MAX_DURATION_SEC_PREMIUM: 60,
    MAX_SIZE_MB_FREE: 50,
    MAX_SIZE_MB_PREMIUM: 500,
    ALLOWED_TYPES: ["video/mp4", "video/quicktime", "video/webm"],
  },
  // Output qualities
  QUALITIES: {
    "360p": { width: 640, height: 360, bitrate: "500k" },
    "480p": { width: 854, height: 480, bitrate: "1000k" },
    "720p": { width: 1280, height: 720, bitrate: "2500k" },
    "1080p": { width: 1920, height: 1080, bitrate: "5000k" },
  },
  THUMBNAIL: {
    WIDTH: 320,
    HEIGHT: 568,
    QUALITY: 80,
  },
} as const;

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────
export interface MediaMetadata {
  width: number;
  height: number;
  durationSec?: number;
  fileSizeMb: number;
  mimeType: string;
  codec?: string;
}

export interface ProcessedMedia {
  thumbnailUrl: string;
  variants: Array<{
    quality: string;
    url: string;
    width: number;
    height: number;
    fileSizeMb: number;
    bitrate?: number;
  }>;
  metadata: MediaMetadata;
}

// ─────────────────────────────────────────
// Media Processing Service
// ─────────────────────────────────────────
export class MediaProcessingService {
  private tempDir: string;

  constructor() {
    this.tempDir = join(tmpdir(), "story_processing");
    mkdirSync(this.tempDir, { recursive: true });
  }

  // ─────────────────────────────────────
  // VALIDATE MEDIA BEFORE UPLOAD
  // ─────────────────────────────────────
  validateMedia(
    file: Express.Multer.File,
    isPremium: boolean
  ): void {
    const sizeMb = file.size / (1024 * 1024);
    const mimeType = file.mimetype;

    const isImage = mimeType.startsWith("image/");
    const isVideo = mimeType.startsWith("video/");

    if (!isImage && !isVideo) {
      throw new AppError(
        "UNSUPPORTED_MEDIA_TYPE",
        "Only images and videos are supported for stories",
        400,
        { mimeType }
      );
    }

    if (isImage) {
      if (!(MEDIA_CONFIG.IMAGE.ALLOWED_TYPES as readonly string[]).includes(mimeType)) {
        throw new AppError(
          "UNSUPPORTED_IMAGE_TYPE",
          `Supported image types: ${MEDIA_CONFIG.IMAGE.ALLOWED_TYPES.join(", ")}`,
          400
        );
      }
      const maxSize = isPremium
        ? MEDIA_CONFIG.IMAGE.MAX_SIZE_MB_PREMIUM
        : MEDIA_CONFIG.IMAGE.MAX_SIZE_MB_FREE;
      if (sizeMb > maxSize) {
        throw new AppError(
          "FILE_TOO_LARGE",
          `Image must be under ${maxSize}MB`,
          400,
          { maxSizeMb: maxSize, actualSizeMb: sizeMb.toFixed(2) }
        );
      }
    }

    if (isVideo) {
      if (!(MEDIA_CONFIG.VIDEO.ALLOWED_TYPES as readonly string[]).includes(mimeType)) {
        throw new AppError(
          "UNSUPPORTED_VIDEO_TYPE",
          `Supported video types: ${MEDIA_CONFIG.VIDEO.ALLOWED_TYPES.join(", ")}`,
          400
        );
      }
      const maxSize = isPremium
        ? MEDIA_CONFIG.VIDEO.MAX_SIZE_MB_PREMIUM
        : MEDIA_CONFIG.VIDEO.MAX_SIZE_MB_FREE;
      if (sizeMb > maxSize) {
        throw new AppError(
          "FILE_TOO_LARGE",
          `Video must be under ${maxSize}MB`,
          400,
          { maxSizeMb: maxSize, actualSizeMb: sizeMb.toFixed(2) }
        );
      }
    }
  }

  // ─────────────────────────────────────
  // PROCESS IMAGE
  // Resize, optimize, generate thumbnail
  // ─────────────────────────────────────
  async processImage(
    buffer: Buffer,
    storyId: string,
    _isPremium: boolean
  ): Promise<ProcessedMedia> {
    // Get image metadata
    const imageInfo = await sharp(buffer).metadata();
    const width = imageInfo.width || 0;
    const height = imageInfo.height || 0;
    const fileSizeMb = buffer.length / (1024 * 1024);

    const variants: ProcessedMedia["variants"] = [];

    // Generate thumbnail
    const thumbnailBuffer = await sharp(buffer)
      .resize(
        MEDIA_CONFIG.THUMBNAIL.WIDTH,
        MEDIA_CONFIG.THUMBNAIL.HEIGHT,
        { fit: "cover", position: "center" }
      )
      .webp({ quality: MEDIA_CONFIG.THUMBNAIL.QUALITY })
      .toBuffer();

    const thumbnailKey = `${storyId}/thumbnail.webp`;
    const thumbnailUrl = await storageService.uploadFile(
      storageService.BUCKETS.STORIES_THUMBNAILS,
      thumbnailKey,
      thumbnailBuffer,
      "image/webp"
    );

    // Generate optimized full version
    const fullBuffer = await sharp(buffer)
      .resize(1080, 1920, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();

    const fullKey = `${storyId}/full.webp`;
    const fullUrl = await storageService.uploadFile(
      storageService.BUCKETS.STORIES,
      fullKey,
      fullBuffer,
      "image/webp"
    );

    variants.push({
      quality: "original",
      url: fullUrl,
      width,
      height,
      fileSizeMb: fullBuffer.length / (1024 * 1024),
    });

    // Generate medium quality version
    const mediumBuffer = await sharp(buffer)
      .resize(540, 960, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    const mediumKey = `${storyId}/medium.webp`;
    const mediumUrl = await storageService.uploadFile(
      storageService.BUCKETS.STORIES,
      mediumKey,
      mediumBuffer,
      "image/webp"
    );

    variants.push({
      quality: "medium",
      url: mediumUrl,
      width: 540,
      height: 960,
      fileSizeMb: mediumBuffer.length / (1024 * 1024),
    });

    return {
      thumbnailUrl,
      variants,
      metadata: {
        width,
        height,
        fileSizeMb,
        mimeType: "image/webp",
      },
    };
  }

  // ─────────────────────────────────────
  // PROCESS VIDEO
  // Transcode to multiple qualities
  // ─────────────────────────────────────
  async processVideo(
    buffer: Buffer,
    storyId: string,
    isPremium: boolean
  ): Promise<ProcessedMedia> {
    // Write buffer to temp file
    const inputPath = join(this.tempDir, `${storyId}_input.mp4`);
    const thumbnailPath = join(this.tempDir, `${storyId}_thumb.jpg`);

    await this.writeBufferToFile(buffer, inputPath);

    try {
      // Get video metadata
      const metadata = await this.getVideoMetadata(inputPath);

      // Validate duration
      const maxDuration = isPremium
        ? MEDIA_CONFIG.VIDEO.MAX_DURATION_SEC_PREMIUM
        : MEDIA_CONFIG.VIDEO.MAX_DURATION_SEC_FREE;

      if (metadata.durationSec && metadata.durationSec > maxDuration) {
        throw new AppError(
          "VIDEO_TOO_LONG",
          `Video must be under ${maxDuration} seconds. ${!isPremium ? "Upgrade to Premium for 60s videos!" : ""}`,
          400,
          { maxDuration, actualDuration: metadata.durationSec }
        );
      }

      // Generate thumbnail from first frame
      await this.generateVideoThumbnail(inputPath, thumbnailPath);
      const thumbnailBuffer = readFileSync(thumbnailPath);

      // Optimize thumbnail with sharp
      const optimizedThumbBuffer = await sharp(thumbnailBuffer)
        .resize(
          MEDIA_CONFIG.THUMBNAIL.WIDTH,
          MEDIA_CONFIG.THUMBNAIL.HEIGHT,
          { fit: "cover" }
        )
        .webp({ quality: 80 })
        .toBuffer();

      const thumbKey = `${storyId}/thumbnail.webp`;
      const thumbnailUrl = await storageService.uploadFile(
        storageService.BUCKETS.STORIES_THUMBNAILS,
        thumbKey,
        optimizedThumbBuffer,
        "image/webp"
      );

      // Determine which qualities to generate
      const qualityKeys = isPremium
        ? ["360p", "480p", "720p", "1080p"]
        : ["360p", "480p", "720p"];

      const variants: ProcessedMedia["variants"] = [];

      // Transcode to each quality
      for (const quality of qualityKeys) {
        const qualityConfig =
          MEDIA_CONFIG.QUALITIES[quality as keyof typeof MEDIA_CONFIG.QUALITIES];
        const outputPath = join(
          this.tempDir,
          `${storyId}_${quality}.mp4`
        );

        await this.transcodeVideo(
          inputPath,
          outputPath,
          qualityConfig.width,
          qualityConfig.height,
          qualityConfig.bitrate
        );

        const outputBuffer = readFileSync(outputPath);
        const variantKey = `${storyId}/${quality}.mp4`;
        const variantUrl = await storageService.uploadFile(
          storageService.BUCKETS.STORIES,
          variantKey,
          outputBuffer,
          "video/mp4"
        );

        variants.push({
          quality,
          url: variantUrl,
          width: qualityConfig.width,
          height: qualityConfig.height,
          fileSizeMb: outputBuffer.length / (1024 * 1024),
          bitrate: parseInt(qualityConfig.bitrate),
        });

        // Clean up temp file
        try { unlinkSync(outputPath); } catch {}
      }

      return {
        thumbnailUrl,
        variants,
        metadata: {
          ...metadata,
          fileSizeMb: buffer.length / (1024 * 1024),
        },
      };
    } finally {
      // Always clean up temp files
      try { unlinkSync(inputPath); } catch {}
      try { unlinkSync(thumbnailPath); } catch {}
    }
  }

  // ─────────────────────────────────────
  // PRIVATE: Get video metadata via ffprobe
  // ─────────────────────────────────────
  private getVideoMetadata(inputPath: string): Promise<MediaMetadata> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) return reject(err);

        const videoStream = metadata.streams.find(
          (s) => s.codec_type === "video"
        );

        resolve({
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
          durationSec: Math.floor(metadata.format.duration || 0),
          fileSizeMb: (metadata.format.size || 0) / (1024 * 1024),
          mimeType: "video/mp4",
          codec: videoStream?.codec_name,
        });
      });
    });
  }

  // ─────────────────────────────────────
  // PRIVATE: Generate video thumbnail
  // ─────────────────────────────────────
  private generateVideoThumbnail(
    inputPath: string,
    outputPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .screenshots({
          timestamps: ["00:00:01"], // 1 second in
          filename: basename(outputPath),
          folder: dirname(outputPath),
          size: "640x?",
        })
        .on("end", () => resolve())
        .on("error", reject);
    });
  }

  // ─────────────────────────────────────
  // PRIVATE: Transcode video to quality
  // ─────────────────────────────────────
  private transcodeVideo(
    inputPath: string,
    outputPath: string,
    width: number,
    height: number,
    bitrate: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec("libx264")
        .audioCodec("aac")
        .size(`${width}x${height}`)
        .videoBitrate(bitrate)
        .outputOptions([
          "-preset fast",
          "-movflags +faststart",  // web streaming optimization
          "-crf 23",               // quality factor
          "-profile:v baseline",
          "-level 3.0",
        ])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", reject)
        .run();
    });
  }

  // ─────────────────────────────────────
  // PRIVATE: Write buffer to file
  // ─────────────────────────────────────
  private writeBufferToFile(
    buffer: Buffer,
    filePath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = createWriteStream(filePath);
      stream.write(buffer);
      stream.end();
      stream.on("finish", resolve);
      stream.on("error", reject);
    });
  }
}

export const mediaProcessingService = new MediaProcessingService();
