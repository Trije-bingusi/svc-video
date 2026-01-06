# svc-video-upload

Microservice for uploading and managing video files with **Azure Blob Storage** integration for the _eUčilnica+_ platform.

## Overview

This service handles:

- **Video file uploads** via multipart/form-data
- **Storage in Azure Blob Storage** (or local storage for development)
- **Metadata tracking** in PostgreSQL
- **Integration with Azure Media Services** (optional, for encoding)
- **Prometheus metrics** for monitoring
- **Health and readiness checks**

## Architecture

```
Client → svc-gateway → svc-video-upload → Azure Blob Storage
                    ↓
                PostgreSQL
```

The service stores video metadata in PostgreSQL and the actual video files in Azure Blob Storage.

## Tech Stack

- **Node.js 22** + **Express**
- **Prisma** ORM with PostgreSQL
- **Azure SDK**:
  - `@azure/storage-blob` for Blob Storage
  - `@azure/identity` for authentication
  - `@azure/arm-mediaservices` for Media Services (optional)
- **Multer** for file upload handling
- **Prometheus** metrics via `prom-client`
- **Scalar** for API documentation
- **Docker** for containerization

## Getting Started

### Prerequisites

- Node.js 22+
- PostgreSQL 16+
- Azure Storage Account (for production)
- Docker & Docker Compose (optional)

### Environment Variables

Create a `.env` file:

```bash
# Server
PORT=3000

# Database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/video_upload

# Azure Blob Storage
AZURE_STORAGE_ACCOUNT=your-storage-account
AZURE_STORAGE_CONNECTION_STRING=your-connection-string
AZURE_STORAGE_CONTAINER=videos

# Azure Media Services (optional)
AZURE_SUBSCRIPTION_ID=your-subscription-id
AZURE_RESOURCE_GROUP=your-resource-group
AZURE_MEDIA_SERVICES_ACCOUNT=your-media-services-account
```

**For local development**, you can leave Azure variables empty. The service will run in local mode.

### Installation

```bash
npm install
```

### Database Setup

```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate:dev
```

### Running Locally

```bash
npm start
```

The service will be available at `http://localhost:3000`.

### Running with Docker

```bash
docker compose up --build
```

This starts both the service and a PostgreSQL database.

## API Endpoints

### Health & Monitoring

- `GET /healthz` – liveness check
- `GET /readyz` – readiness check (verifies DB connection)
- `GET /metrics` – Prometheus metrics
- `GET /docs` – Scalar API documentation
- `GET /openapi.json` – OpenAPI specification

### Video Uploads

#### Get uploads for a lecture

```http
GET /api/lectures/:lectureId/uploads
```

Returns all video uploads for a specific lecture.

#### Upload a video

```http
POST /api/lectures/:lectureId/upload
Content-Type: multipart/form-data

video: [binary file]
```

Uploads a video file to Azure Blob Storage and saves metadata to the database.

**Headers:**
- `x-user-sub` (optional) – User ID from authentication token

**Response:**
```json
{
  "id": "uuid",
  "lecture_id": "lecture-uuid",
  "user_id": "user-uuid",
  "filename": "unique-filename.mp4",
  "original_filename": "original.mp4",
  "file_size": 12345678,
  "mime_type": "video/mp4",
  "blob_url": "https://account.blob.core.windows.net/videos/file.mp4",
  "encoding_status": "completed",
  "created_at": "2026-01-06T12:00:00Z"
}
```

#### Get specific upload

```http
GET /api/uploads/:id
```

Returns details of a specific upload.

#### Delete upload

```http
DELETE /api/uploads/:id
```

Deletes the video from Azure Blob Storage and the database.

#### Update encoding status

```http
PATCH /api/uploads/:id/encoding-status
Content-Type: application/json

{
  "encoding_status": "completed",
  "hls_url": "https://streaming.endpoint/manifest.m3u8",
  "duration": 3600,
  "resolution": "1920x1080"
}
```

Updates the encoding status (typically called by Azure Media Services webhook).

## Database Schema

```prisma
model VideoUpload {
  id                String   @id @default(uuid())
  lecture_id        String
  user_id           String?
  filename          String
  original_filename String
  file_size         Int
  mime_type         String
  blob_url          String
  blob_container    String
  blob_name         String
  ams_asset_name    String?
  ams_job_name      String?
  encoding_status   String?  @default("pending")
  hls_url           String?
  duration          Int?
  resolution        String?
  created_at        DateTime @default(now())
  updated_at        DateTime @updatedAt
}
```

## Metrics

The service exposes Prometheus metrics:

- `svc_video_upload_video_uploaded_total` – Total number of videos uploaded
- `svc_video_upload_video_size_bytes` – Size of uploaded videos in bytes
- Default Node.js metrics (memory, CPU, etc.)

## Azure Integration

### Blob Storage

The service uses Azure Blob Storage to store video files. It supports two authentication methods:

1. **Connection String** (recommended for development):
   ```bash
   AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
   ```

2. **Managed Identity** (recommended for production):
   ```bash
   AZURE_STORAGE_ACCOUNT=mystorageaccount
   ```

### Media Services (Optional)

For video encoding and adaptive streaming, you can integrate with Azure Media Services:

1. Upload the video to Blob Storage
2. Create an AMS asset from the blob
3. Submit an encoding job
4. Update the encoding status via webhook

## Development

### Project Structure

```
svc-video-upload/
├── src/
│   └── app.js           # Main Express application
├── prisma/
│   ├── schema.prisma    # Database schema
│   └── migrations/      # Database migrations
├── openapi.yaml         # API specification
├── Dockerfile           # Container image
├── docker-compose.yml   # Local development setup
├── package.json
└── README.md
```

### Adding to rso-platform

To integrate this service into the main platform:

1. Create a new Git repository:
   ```bash
   cd svc-video-upload
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/Trije-bingusi/svc-video-upload.git
   git push -u origin main
   ```

2. Add as submodule in `rso-platform`:
   ```bash
   cd rso-platform
   git submodule add https://github.com/Trije-bingusi/svc-video-upload.git
   ```

3. Update `rso-platform/docker-compose.yml` to include this service

4. Update `svc-gateway` to proxy `/api/videos/*` requests to this service

## Troubleshooting

### "Only video files are allowed"

The service only accepts video MIME types: `video/mp4`, `video/mpeg`, `video/quicktime`, `video/x-msvideo`, `video/x-matroska`, `video/webm`.

### Database connection fails

Check that `DATABASE_URL` is correct and PostgreSQL is running:
```bash
docker compose up db
```

### Azure authentication fails

For local development, use connection string authentication. For production, ensure the service principal or managed identity has:
- `Storage Blob Data Contributor` role on the storage account
- Appropriate permissions for Media Services (if used)

## License

ISC
