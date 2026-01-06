import express from "express";
import client from "prom-client";
import pinoHttp from "pino-http";
import YAML from "yamljs";
import multer from "multer";
import { PrismaClient } from "@prisma/client";
import { apiReference } from "@scalar/express-api-reference";
import { BlobServiceClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";

function env(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") {
    if (fallback === undefined) {
      throw new Error(`Missing env: ${name}`);
    }
    return fallback;
  }
  return raw;
}

const PORT = Number(env("PORT", "3000"));
const DATABASE_URL = env(
  "DATABASE_URL",
  "postgres://postgres:postgres@localhost:5432/video_upload"
);

// Azure configuration
const AZURE_STORAGE_ACCOUNT = env("AZURE_STORAGE_ACCOUNT", "");
const AZURE_STORAGE_CONNECTION_STRING = env("AZURE_STORAGE_CONNECTION_STRING", "");
const AZURE_STORAGE_CONTAINER = env("AZURE_STORAGE_CONTAINER", "videos");
const USE_AZURE = AZURE_STORAGE_ACCOUNT !== "" || AZURE_STORAGE_CONNECTION_STRING !== "";

const prisma = new PrismaClient();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024, // 5GB limit
  },
  fileFilter: (_req, file, cb) => {
    // Accept video files only
    const allowedMimeTypes = [
      "video/mp4",
      "video/mpeg",
      "video/quicktime",
      "video/x-msvideo",
      "video/x-matroska",
      "video/webm",
    ];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only video files are allowed"));
    }
  },
});

// Initialize Azure Blob Service Client
let blobServiceClient;
if (USE_AZURE) {
  if (AZURE_STORAGE_CONNECTION_STRING) {
    blobServiceClient = BlobServiceClient.fromConnectionString(
      AZURE_STORAGE_CONNECTION_STRING
    );
  } else {
    const credential = new DefaultAzureCredential();
    const accountUrl = `https://${AZURE_STORAGE_ACCOUNT}.blob.core.windows.net`;
    blobServiceClient = new BlobServiceClient(accountUrl, credential);
  }
}

const app = express();
app.use(express.json());

// Scalar API reference
const openapi = YAML.load("./openapi.yaml");
app.get("/openapi.json", (_req, res) => res.json(openapi));
app.use(
  "/docs",
  apiReference({
    spec: { url: "/openapi.json" },
    theme: "default",
    darkMode: true,
  })
);

app.use(pinoHttp());

// Prometheus metrics
client.collectDefaultMetrics();
const videoUploadCounter = new client.Counter({
  name: "svc_video_upload_video_uploaded_total",
  help: "Total number of videos uploaded",
});

const videoUploadSizeGauge = new client.Gauge({
  name: "svc_video_upload_video_size_bytes",
  help: "Size of uploaded videos in bytes",
});

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

// Health endpoints
app.get("/healthz", (_req, res) => res.send("OK"));
app.get("/readyz", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.send("READY");
  } catch {
    res.status(500).send("NOT READY");
  }
});

// Video upload endpoints

// Get all uploads for a lecture
app.get("/api/lectures/:lectureId/uploads", async (req, res) => {
  try {
    const { lectureId } = req.params;
    const uploads = await prisma.videoUpload.findMany({
      where: { lecture_id: lectureId },
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        lecture_id: true,
        filename: true,
        original_filename: true,
        file_size: true,
        mime_type: true,
        blob_url: true,
        encoding_status: true,
        hls_url: true,
        duration: true,
        resolution: true,
        created_at: true,
        updated_at: true,
      },
    });
    res.json(uploads);
  } catch (error) {
    req.log.error(error, "Failed to fetch uploads");
    res.status(500).json({ error: "Failed to fetch uploads" });
  }
});

// Get specific upload
app.get("/api/uploads/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const upload = await prisma.videoUpload.findUnique({
      where: { id },
    });
    if (!upload) {
      return res.status(404).json({ error: "Upload not found" });
    }
    res.json(upload);
  } catch (error) {
    req.log.error(error, "Failed to fetch upload");
    res.status(500).json({ error: "Failed to fetch upload" });
  }
});

// Upload video
app.post(
  "/api/lectures/:lectureId/upload",
  upload.single("video"),
  async (req, res) => {
    try {
      const { lectureId } = req.params;
      const userId = req.headers["x-user-sub"] || null;

      if (!req.file) {
        return res.status(400).json({ error: "No video file provided" });
      }

      const originalFilename = req.file.originalname;
      const fileSize = req.file.size;
      const mimeType = req.file.mimetype;

      // Generate unique filename
      const timestamp = Date.now();
      const uniqueFilename = `${lectureId}_${timestamp}_${originalFilename}`;

      let blobUrl;
      let blobContainer = AZURE_STORAGE_CONTAINER;
      let blobName = uniqueFilename;

      if (USE_AZURE) {
        // Upload to Azure Blob Storage
        const containerClient = blobServiceClient.getContainerClient(
          AZURE_STORAGE_CONTAINER
        );

        // Ensure container exists
        await containerClient.createIfNotExists({
          access: "blob", // public read access
        });

        const blockBlobClient = containerClient.getBlockBlobClient(uniqueFilename);

        // Upload buffer to blob
        await blockBlobClient.uploadData(req.file.buffer, {
          blobHTTPHeaders: {
            blobContentType: mimeType,
          },
        });

        blobUrl = blockBlobClient.url;
      } else {
        // For local development without Azure
        blobUrl = `http://localhost:${PORT}/local-storage/${uniqueFilename}`;
        blobContainer = "local";
      }

      // Save to database
      const videoUpload = await prisma.videoUpload.create({
        data: {
          lecture_id: lectureId,
          user_id: userId,
          filename: uniqueFilename,
          original_filename: originalFilename,
          file_size: fileSize,
          mime_type: mimeType,
          blob_url: blobUrl,
          blob_container: blobContainer,
          blob_name: blobName,
          encoding_status: "completed", // In real scenario, this would be 'pending'
        },
      });

      videoUploadCounter.inc();
      videoUploadSizeGauge.set(fileSize);

      req.log.info(
        { videoUploadId: videoUpload.id, lectureId, fileSize },
        "Video uploaded successfully"
      );

      res.status(201).json(videoUpload);
    } catch (error) {
      req.log.error(error, "Failed to upload video");
      res.status(500).json({ error: "Failed to upload video" });
    }
  }
);

// Delete upload
app.delete("/api/uploads/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const upload = await prisma.videoUpload.findUnique({
      where: { id },
    });

    if (!upload) {
      return res.status(404).json({ error: "Upload not found" });
    }

    // Delete from Azure Blob Storage
    if (USE_AZURE) {
      const containerClient = blobServiceClient.getContainerClient(
        upload.blob_container
      );
      const blockBlobClient = containerClient.getBlockBlobClient(upload.blob_name);
      await blockBlobClient.deleteIfExists();
    }

    // Delete from database
    await prisma.videoUpload.delete({
      where: { id },
    });

    res.json({ message: "Upload deleted successfully" });
  } catch (error) {
    req.log.error(error, "Failed to delete upload");
    res.status(500).json({ error: "Failed to delete upload" });
  }
});

// Update encoding status (would be called by Azure Media Services webhook)
app.patch("/api/uploads/:id/encoding-status", async (req, res) => {
  try {
    const { id } = req.params;
    const { encoding_status, hls_url, duration, resolution } = req.body;

    const upload = await prisma.videoUpload.update({
      where: { id },
      data: {
        encoding_status,
        hls_url,
        duration,
        resolution,
      },
    });

    res.json(upload);
  } catch (error) {
    req.log.error(error, "Failed to update encoding status");
    res.status(500).json({ error: "Failed to update encoding status" });
  }
});

app.listen(PORT, () => {
  console.log(`svc-video-upload listening on port ${PORT}`);
  console.log(`API docs available at http://localhost:${PORT}/docs`);
  console.log(`Azure integration: ${USE_AZURE ? "enabled" : "disabled (local mode)"}`);
});
