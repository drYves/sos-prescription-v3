<?php
declare(strict_types=1);

namespace SOSPrescription\Core;

use wpdb;

final class NonceStore
{
    private wpdb $db;
    private string $table;
    private string $siteId;

    public function __construct(wpdb $db, string $siteId)
    {
        $this->db = $db;
        $this->siteId = $siteId;
        $this->table = $db->prefix . 'sosprescription_nonces';
    }

    public function checkAndStore(string $scope, string $nonce, int $tsMs, int $ttlSeconds, ?string $reqId = null): bool
    {
        $ttlSeconds = max(30, min(300, $ttlSeconds));
        $scope = substr($scope, 0, 64);
        $nonce = substr($nonce, 0, 64);

        $sql = "INSERT INTO `{$this->table}` (site_id, scope, nonce, ts_ms, expires_at, req_id) VALUES (%s, %s, %s, %d, DATE_ADD(NOW(3), INTERVAL %d SECOND), %s)";
        $prepared = $this->db->prepare($sql, $this->siteId, $scope, $nonce, $tsMs, $ttlSeconds, $reqId);
        $res = $this->db->query($prepared);

        return $res === 1;
    }

    public function purgeExpired(int $limit = 5000): int
    {
        $limit = max(100, min(20000, $limit));
        $prepared = $this->db->prepare("DELETE FROM `{$this->table}` WHERE expires_at < NOW(3) LIMIT %d", $limit);
        $res = $this->db->query($prepared);
        return is_int($res) ? $res : 0;
    }
}
