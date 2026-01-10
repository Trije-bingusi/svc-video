import express from "express";
import client from "prom-client";
import pinoHttp from "pino-http";
import YAML from "yamljs";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import { apiReference } from "@scalar/express-api-reference";
import { initializeBlobServiceClient, generateSasUrl, deleteBlob, uploadBlob } from "./azureStorage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Gateway URL for constructing public video URLs
const GATEWAY_URL = env("GATEWAY_URL", "http://localhost:8081");

// Azure configuration
const AZURE_STORAGE_ACCOUNT = env("AZURE_STORAGE_ACCOUNT", "");
const AZURE_STORAGE_CONNECTION_STRING = env("AZURE_STORAGE_CONNECTION_STRING", "");
const AZURE_STORAGE_CONTAINER = env("AZURE_STORAGE_CONTAINER", "videos");
const USE_AZURE = AZURE_STORAGE_ACCOUNT !== "" || AZURE_STORAGE_CONNECTION_STRING !== "";

// Local storage configuration
const LOCAL_STORAGE_DIR = path.join(__dirname, "..", "local-storage");
if (!USE_AZURE) {
  // Create local storage directory if it doesn't exist
  if (!fs.existsSync(LOCAL_STORAGE_DIR)) {
    fs.mkdirSync(LOCAL_STORAGE_DIR, { recursive: true });
  }
}

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
  blobServiceClient = initializeBlobServiceClient(AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_CONNECTION_STRING);
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
        blobUrl = await uploadBlob(
          blobServiceClient,
          AZURE_STORAGE_CONTAINER,
          uniqueFilename,
          req.file.buffer,
          mimeType
        );
      } else {
        // For local development without Azure - save to disk
        const filePath = path.join(LOCAL_STORAGE_DIR, uniqueFilename);
        fs.writeFileSync(filePath, req.file.buffer);
        blobUrl = `${GATEWAY_URL}/api/videos/${uniqueFilename}`;
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

// Upload video - alternative endpoint path
app.post(
  "/api/uploads/:lectureId",
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
        blobUrl = await uploadBlob(
          blobServiceClient,
          AZURE_STORAGE_CONTAINER,
          uniqueFilename,
          req.file.buffer,
          mimeType
        );
      } else {
        // For local development without Azure - save to disk
        const filePath = path.join(LOCAL_STORAGE_DIR, uniqueFilename);
        fs.writeFileSync(filePath, req.file.buffer);
        blobUrl = `${GATEWAY_URL}/api/videos/${uniqueFilename}`;
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
      await deleteBlob(blobServiceClient, upload.blob_container, upload.blob_name);
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

// Generate SAS URL for secure video access
app.get("/api/uploads/:id/sas-url", async (req, res) => {
  try {
    const { id } = req.params;
    const expiresIn = Number(req.query.expiresIn) || 60; // Default 60 minutes

    const upload = await prisma.videoUpload.findUnique({
      where: { id },
    });

    if (!upload) {
      return res.status(404).json({ error: "Upload not found" });
    }

    if (!USE_AZURE) {
      // For local development, return the blob URL as is
      return res.json({ url: upload.blob_url, expiresIn: null });
    }

    // Generate SAS URL
    const sasUrl = await generateSasUrl(
      blobServiceClient,
      upload.blob_container,
      upload.blob_name,
      expiresIn
    );

    res.json({ url: sasUrl, expiresIn });
  } catch (error) {
    req.log.error(error, "Failed to generate SAS URL");
    res.status(500).json({ error: "Failed to generate SAS URL" });
  }
});

// ========== TRANSCRIPTION ENDPOINTS ==========

// POST /api/lectures/:lectureId/transcribe - Start transcription for a lecture
app.post("/api/lectures/:lectureId/transcribe", async (req, res) => {
  try {
    console.log(`[SVC-VIDEO] POST /api/lectures/:lectureId/transcribe`);
    const { lectureId } = req.params;
    const { language = "sl" } = req.body || {};
    console.log(`[SVC-VIDEO] lectureId = ${lectureId}, language = ${language}`);

    // Find the most recent video upload for this lecture
    const upload = await prisma.videoUpload.findFirst({
      where: { lecture_id: lectureId },
      orderBy: { created_at: "desc" },
    });

    if (!upload) {
      return res.status(404).json({ error: "No video found for this lecture" });
    }

    // Generate SAS URLs for transcription service
    let videoSasUrl, jsonUploadUrl, vttUploadUrl;

    if (USE_AZURE) {
      // Generate read SAS URL for video (120 minutes)
      videoSasUrl = await generateSasUrl(
        blobServiceClient,
        upload.blob_container,
        upload.blob_name,
        120,
        false // read permission
      );

      // Generate write SAS URLs for transcript outputs
      const baseName = upload.blob_name.replace(/\.[^.]+$/, "");
      jsonUploadUrl = await generateSasUrl(
        blobServiceClient,
        upload.blob_container,
        `${baseName}.json`,
        120,
        true // write permission
      );
      vttUploadUrl = await generateSasUrl(
        blobServiceClient,
        upload.blob_container,
        `${baseName}.vtt`,
        120,
        true // write permission
      );
    } else {
      // For local mode, use direct URLs
      videoSasUrl = upload.blob_url;
      const baseName = upload.blob_name.replace(/\.[^.]+$/, "");
      jsonUploadUrl = `${GATEWAY_URL}/api/videos/${baseName}.json`;
      vttUploadUrl = `${GATEWAY_URL}/api/videos/${baseName}.vtt`;
    }

    // Call transcription service through gateway (forward Authorization header)
    const authHeader = req.headers.authorization;
    const headers = { "Content-Type": "application/json" };
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }

    const response = await fetch(`${GATEWAY_URL}/api/transcriptions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        lecture_id: lectureId,
        video_url: videoSasUrl,
        video_blob_name: upload.blob_name,
        json_upload_url: jsonUploadUrl,
        vtt_upload_url: vttUploadUrl,
        language,
      }),
    });

    if (!response.ok) {
      throw new Error(`Transcription service error: ${response.statusText}`);
    }

    const result = await response.json();

    // Store the job_id in the video upload record
    await prisma.videoUpload.update({
      where: { id: upload.id },
      data: { transcription_job_id: result.job_id },
    });

    res.status(202).json(result);
  } catch (error) {
    req.log.error(error, "Failed to start transcription");
    res.status(500).json({ error: "Failed to start transcription" });
  }
});

// GET /api/lectures/:lectureId/transcription - Get transcription status for a lecture
app.get("/api/lectures/:lectureId/transcription", async (req, res) => {
  console.log(`[SVC-VIDEO] GET /api/lectures/:lectureId/transcription`);
  console.log(`[SVC-VIDEO] req.path = ${req.path}`);
  console.log(`[SVC-VIDEO] req.params =`, req.params);
  try {
    const { lectureId } = req.params;
    console.log(`[SVC-VIDEO] lectureId = ${lectureId}`);

    // Find the most recent video upload for this lecture
    const upload = await prisma.videoUpload.findFirst({
      where: { lecture_id: lectureId },
      orderBy: { created_at: "desc" },
    });

    if (!upload) {
      return res.status(404).json({ error: "No video found for this lecture" });
    }

    if (!upload.transcription_job_id) {
      return res.json({ status: "none" });
    }

    // Query transcription service for job status through gateway (forward Authorization header)
    const authHeader = req.headers.authorization;
    const headers = {};
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }

    const response = await fetch(
      `${GATEWAY_URL}/api/transcriptions/${upload.transcription_job_id}`,
      { headers }
    );

    if (!response.ok) {
      throw new Error(`Transcription service error: ${response.statusText}`);
    }

    const job = await response.json();
    const result = {
      job_id: job.job_id,
      status: job.status,
      error: job.error,
    };

    // If transcription is done, generate download SAS URLs
    if (job.status === "done" && USE_AZURE) {
      result.json_url = await generateSasUrl(
        blobServiceClient,
        upload.blob_container,
        job.transcript_json_blob,
        60 // 60 minutes for download
      );
      result.vtt_url = await generateSasUrl(
        blobServiceClient,
        upload.blob_container,
        job.transcript_vtt_blob,
        60
      );
    } else if (job.status === "done" && !USE_AZURE) {
      // For local mode
      result.json_url = `${GATEWAY_URL}/api/videos/${job.transcript_json_blob}`;
      result.vtt_url = `${GATEWAY_URL}/api/videos/${job.transcript_vtt_blob}`;
    }

    res.json(result);
  } catch (error) {
    req.log.error(error, "Failed to get transcription status");
    res.status(500).json({ error: "Failed to get transcription status" });
  }
});

// Serve video files from local storage
app.get("/api/videos/:filename", (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(LOCAL_STORAGE_DIR, filename);

    // Security: prevent directory traversal
    if (!filePath.startsWith(LOCAL_STORAGE_DIR)) {
      return res.status(403).json({ error: "Access denied" });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Stream the video file
    res.sendFile(filePath);
  } catch (error) {
    req.log.error(error, "Failed to serve video file");
    res.status(500).json({ error: "Failed to serve video file" });
  }
});

// Catch-all 404 handler
app.use((req, res) => {
  console.log(`[SVC-VIDEO] 404 NOT FOUND: ${req.method} ${req.path}`);
  console.log(`[SVC-VIDEO] Available routes were not matched`);
  res.status(404).json({ error: "Not Found", path: req.path, method: req.method });
});

app.listen(PORT, () => {
  console.log(`svc-video listening on port ${PORT}`);
  console.log(`API docs available at http://localhost:${PORT}/docs`);
  console.log(`Azure integration: ${USE_AZURE ? "enabled" : "disabled (local mode)"}`);
  console.log(`[SVC-VIDEO] Gateway URL: ${GATEWAY_URL}`);
});
