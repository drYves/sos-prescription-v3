<?php
declare(strict_types=1);

namespace SOSPrescription\Core;

use RuntimeException;
use wpdb;

final class PdfAccessService
{
    private string $jobsTable;
    private string $rxTable;

    public function __construct(
        private wpdb $db,
        private NdjsonLogger $logger,
        private JobDispatcher $dispatcher,
        private S3DeliveryService $s3Delivery,
        private string $siteId
    ) {
        $this->jobsTable = $db->prefix . 'sosprescription_jobs';
        $this->rxTable = $db->prefix . 'sosprescription_prescriptions';
    }

    public function getOrEnqueuePdfForRx(int $rxId, ?string $reqId = null): array
    {
        $reqId = ReqId::coalesce($reqId);
        $row = $this->db->get_row($this->db->prepare("SELECT job_id,s3_key_ref FROM `{$this->jobsTable}` WHERE site_id=%s AND rx_id=%d AND job_type='PDF_GEN' AND status='DONE' AND s3_key_ref IS NOT NULL AND s3_key_ref<>'' ORDER BY completed_at DESC LIMIT 1", $this->siteId, $rxId), ARRAY_A);
        if (is_array($row) && !empty($row['s3_key_ref'])) {
            return ['action' => 'redirect', 's3_key_ref' => $row['s3_key_ref'], 'req_id' => $reqId];
        }

        $exists = $this->db->get_var($this->db->prepare("SELECT id FROM `{$this->rxTable}` WHERE id=%d LIMIT 1", $rxId));
        if (!$exists) {
            throw new RuntimeException('Prescription not found');
        }

        $enqueue = $this->dispatcher->dispatch_pdf_generation($rxId, $reqId);
        return ['action' => 'enqueue', 'job_id' => $enqueue['job_id'] ?? null, 'req_id' => $reqId];
    }

    public function handleDownload(int $rxId, ?string $reqId = null): array
    {
        $result = $this->getOrEnqueuePdfForRx($rxId, $reqId);
        if ($result['action'] === 'redirect') {
            $this->s3Delivery->redirectToPresignedUrl($result['s3_key_ref'], $result['req_id']);
        }

        return $result;
    }
}
