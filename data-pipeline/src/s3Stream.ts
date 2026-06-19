import * as zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

export async function openS3GunzipStream(
  s3Key: string,
  s3Bucket: string,
): Promise<AsyncIterable<Buffer>> {
  const region = process.env.AWS_REGION || 'ap-southeast-3';
  const endpoint = process.env.AWS_S3_ENDPOINT;
  const forcePathStyle = process.env.AWS_S3_FORCE_PATH_STYLE === 'true';

  const s3 = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle } : {}),
  });

  const response = await s3.send(
    new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }),
  );

  const body = response.Body as Readable;
  const gunzip = zlib.createGunzip();
  body.pipe(gunzip);
  return gunzip;
}
