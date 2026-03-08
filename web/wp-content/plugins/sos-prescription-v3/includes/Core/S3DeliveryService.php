<?php
declare(strict_types=1);

namespace SosPrescription\Core;

use Aws\Exception\AwsException;
use Aws\S3\S3Client;
use RuntimeException;

final class S3DeliveryService
{
    public function __construct(
        private S3Client $s3,
        private NdjsonLogger $logger,
        private string $bucketPdf
    ) {
    }

    public static function fromEnv(NdjsonLogger $logger): self
    {
        $client = new S3Client([
            'version' => 'latest',
            'region' => getenv('S3_REGION') ?: 'eu-west-3',
            'endpoint' => getenv('S3_ENDPOINT') ?: '',
            'use_path_style_endpoint' => in_array(getenv('S3_FORCE_PATH_STYLE'), ['1', 'true'], true),
            'credentials' => [
                'key' => getenv('S3_ACCESS_KEY_ID') ?: '',
                'secret' => getenv('S3_SECRET_ACCESS_KEY') ?: '',
            ],
        ]);

        $bucket = getenv('S3_BUCKET_PDF');
        if (!$bucket) {
            throw new RuntimeException('Missing S3_BUCKET_PDF');
        }

        return new self($client, $logger, $bucket);
    }

    public function presignGetPdfUrl(string $s3KeyRef, ?string $reqId = null): string
    {
        if ($s3KeyRef === '' || str_starts_with($s3KeyRef, 'http') || strlen($s3KeyRef) > 1024) {
            throw new RuntimeException('Invalid S3 key');
        }

        try {
            $cmd = $this->s3->getCommand('GetObject', ['Bucket' => $this->bucketPdf, 'Key' => $s3KeyRef]);
            $request = $this->s3->createPresignedRequest($cmd, '+60 seconds');
            $this->logger->info('s3.presign.ok', ['s3_key_ref' => $s3KeyRef, 'ttl_s' => 60], $reqId);
            return (string) $request->getUri();
        } catch (AwsException) {
            throw new RuntimeException('Presign failed');
        }
    }

    public function redirectToPresignedUrl(string $s3KeyRef, ?string $reqId = null): void
    {
        wp_redirect($this->presignGetPdfUrl($s3KeyRef, $reqId), 302);
        exit;
    }
}
