import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';

// S3 Configuration
const AWS_REGION = process.env.AWS_REGION || 'ap-southeast-3';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_SESSION_TOKEN = process.env.AWS_SESSION_TOKEN;
const S3_BUCKET = process.env.AWS_S3_BUCKET || 'mna-files';
// Optional custom endpoint for server→S3 operations (upload/download/delete).
// Set to `http://localhost:9000` (host dev) or `http://minio:9000` (docker
// network). Omit to use real AWS S3.
const AWS_S3_ENDPOINT = process.env.AWS_S3_ENDPOINT;
// Optional separate endpoint used ONLY when generating presigned URLs. These
// URLs end up in the browser, so they must be reachable from there. In docker
// dev the server can reach `http://minio:9000` but the browser cannot — it
// needs `http://localhost:9000`. Fall back to AWS_S3_ENDPOINT if unset (same
// address works for both in host dev and real AWS).
const AWS_S3_PUBLIC_ENDPOINT = process.env.AWS_S3_PUBLIC_ENDPOINT ?? AWS_S3_ENDPOINT;
// MinIO (and most S3-alike servers) require path-style addressing —
// `http://host/bucket/key` instead of `http://bucket.host/key`.
const AWS_S3_FORCE_PATH_STYLE = process.env.AWS_S3_FORCE_PATH_STYLE === 'true';

type ClientKind = 'internal' | 'presigner';

/**
 * Build an RFC 6266 Content-Disposition header value that preserves non-ASCII
 * filenames (e.g. Chinese/Korean) for the browser save dialog. Embedding raw
 * Unicode in the legacy `filename=` parameter breaks AWS presigned URL
 * signatures, so we emit an ASCII-only fallback alongside the RFC 5987
 * `filename*=UTF-8''…` form, which modern browsers prefer.
 */
export function buildContentDisposition(fileName: string): string {
  const asciiFallback = fileName
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function createS3Client(kind: ClientKind = 'internal'): S3Client {
  const endpoint = kind === 'presigner' ? AWS_S3_PUBLIC_ENDPOINT : AWS_S3_ENDPOINT;
  const hasExplicitCredentials = AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY;

  if (endpoint && !hasExplicitCredentials) {
    throw new Error('AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.');
  }

  return new S3Client({
    region: AWS_REGION,
    ...(hasExplicitCredentials
      ? {
          credentials: {
            accessKeyId: AWS_ACCESS_KEY_ID,
            secretAccessKey: AWS_SECRET_ACCESS_KEY,
            ...(AWS_SESSION_TOKEN ? { sessionToken: AWS_SESSION_TOKEN } : {}),
          },
        }
      : {}),
    ...(endpoint && { endpoint }),
    // If an explicit endpoint is set (MinIO/LocalStack), default to path-style
    // unless explicitly overridden.
    forcePathStyle: endpoint ? AWS_S3_FORCE_PATH_STYLE || true : AWS_S3_FORCE_PATH_STYLE,
  });
}

/**
 * Upload a file to S3
 * @param fileBuffer - The file content as a Buffer or Uint8Array
 * @param key - The S3 object key (path)
 * @param contentType - The MIME type of the file
 * @returns The S3 object key
 */
export async function uploadFile(
  fileBuffer: Buffer | Uint8Array,
  key: string,
  contentType: string,
  bucket: string = S3_BUCKET,
  contentEncoding?: string,
): Promise<string> {
  const s3Client = createS3Client();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
    ...(contentEncoding ? { ContentEncoding: contentEncoding } : {}),
  });

  await s3Client.send(command);
  return key;
}

/**
 * Delete a file from S3
 * @param key - The S3 object key (path)
 */
export async function deleteFile(key: string, bucket: string = S3_BUCKET): Promise<void> {
  const s3Client = createS3Client();

  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  await s3Client.send(command);
}

/**
 * Generate a pre-signed URL for accessing a file
 * @param key - The S3 object key (path)
 * @param expiresIn - URL expiration time in seconds (default: 1 hour)
 * @param fileName - Optional original file name to force download with that name
 * @returns The pre-signed URL
 */
export async function getSignedUrl(
  key: string,
  expiresIn: number = 3600,
  fileName?: string
): Promise<string> {
  const s3Client = createS3Client('presigner');

  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ResponseContentDisposition: fileName ? buildContentDisposition(fileName) : undefined,
  });

  return awsGetSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Generate a pre-signed URL for uploading a file
 * @param key - The S3 object key (path)
 * @param contentType - The MIME type of the file
 * @param expiresIn - URL expiration time in seconds (default: 15 minutes)
 * @returns The pre-signed URL
 */
export async function getUploadSignedUrl(
  key: string,
  contentType: string,
  expiresIn: number = 900
): Promise<string> {
  const s3Client = createS3Client('presigner');

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ContentType: contentType,
  });

  return awsGetSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Download a file from S3
 * @param key - The S3 object key (path)
 * @returns The file content as a Buffer
 */
export async function downloadFile(key: string, bucket: string = S3_BUCKET): Promise<Buffer> {
  const s3Client = createS3Client();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  const response = await s3Client.send(command);
  const stream = response.Body as Readable;

  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Generate a unique S3 key for a file
 * @param fileName - The original file name
 * @returns A unique S3 key
 */
export function generateMeetingNoteKey(fileName: string): string {
  const timestamp = Date.now();
  const uuid = crypto.randomUUID();
  // Sanitize file name and create key
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `meeting-notes/${uuid}_${timestamp}_${sanitizedFileName}`;
}

/**
 * Generate a unique S3 key for a deal document
 * @param dealId - The deal (company) id
 * @param fileName - The original file name
 * @returns A unique S3 key under deal-documents/{dealId}/...
 */
export function generateDealDocumentKey(dealId: string, fileName: string): string {
  const timestamp = Date.now();
  const uuid = crypto.randomUUID();
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `deal-documents/${dealId}/${uuid}_${timestamp}_${sanitizedFileName}`;
}

/** Prefix under which all copilot chat attachments live for a workspace. */
export function chatAttachmentPrefix(workspaceId: string): string {
  return `chat-attachments/${workspaceId}/`;
}

/**
 * Generate a unique S3 key for a copilot chat attachment. Scoped by workspace
 * so a request can only ever reference (or delete) keys under its own tenant's
 * prefix. These files are transient composer attachments — they are NOT the
 * Smart Files `files` table and never enter the extraction pipeline.
 * @param workspaceId - The active workspace id
 * @param fileName - The original file name
 * @returns A unique S3 key under chat-attachments/{workspaceId}/...
 */
export function generateChatAttachmentKey(workspaceId: string, fileName: string): string {
  const timestamp = Date.now();
  const uuid = crypto.randomUUID();
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${chatAttachmentPrefix(workspaceId)}${uuid}_${timestamp}_${sanitizedFileName}`;
}
