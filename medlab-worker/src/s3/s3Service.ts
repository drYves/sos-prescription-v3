import { PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const region = process.env['S3_REGION'];
    if (!region) {
      throw new Error('Missing S3_REGION');
    }

    const config: S3ClientConfig = {
      region,
      forcePathStyle: ['1', 'true'].includes(process.env['S3_FORCE_PATH_STYLE'] ?? ''),
      credentials: {
        accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? '',
        secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? '',
      },
    };

    const endpoint = process.env['S3_ENDPOINT'];
    if (endpoint) config.endpoint = endpoint;

    this.client = new S3Client(config);
    this.bucket = process.env['S3_BUCKET_PDF'] ?? '';
  }

  async uploadPdf(key: string, body: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/pdf', ServerSideEncryption: 'AES256' }));
  }
}
