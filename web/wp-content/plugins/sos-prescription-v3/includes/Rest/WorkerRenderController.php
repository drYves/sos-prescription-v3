<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SosPrescription\Core\Mls1Verifier;
use SosPrescription\Core\NdjsonLogger;
use SosPrescription\Core\NonceStore;
use SosPrescription\Core\ReqId;
use WP_Error;
use WP_REST_Request;
use WP_REST_Response;
use wpdb;

final class WorkerRenderController
{
    private string $jobsTable;
    private string $rxTable;
    private string $itemsTable;

    public function __construct(
        private wpdb $db,
        private NdjsonLogger $logger,
        private Mls1Verifier $verifier,
        private string $siteId
    ) {
        $this->jobsTable = $db->prefix . 'sosprescription_jobs';
        $this->rxTable = $db->prefix . 'sosprescription_prescriptions';
        $this->itemsTable = $db->prefix . 'sosprescription_prescription_items';
    }

    public static function register(): void
    {
        add_action('rest_api_init', static function (): void {
            $db = $GLOBALS['wpdb'];
            $siteId = getenv('ML_SITE_ID') ?: 'unknown_site';
            $env = getenv('SOSPRESCRIPTION_ENV') ?: 'prod';

            $logger = new NdjsonLogger('web', $siteId, $env);
            $nonceStore = new NonceStore($db, $siteId);
            $verifier = Mls1Verifier::fromEnv($nonceStore, $logger);
            $controller = new self($db, $logger, $verifier, $siteId);

            register_rest_route('sosprescription/v3', '/worker/render/rx/(?P<rx_id>\d+)', [
                'methods' => 'GET',
                'permission_callback' => '__return_true',
                'callback' => [$controller, 'handle'],
                'args' => [
                    'rx_id' => [
                        'validate_callback' => static fn($v): bool => is_numeric($v) && (int) $v > 0,
                    ],
                ],
            ]);

            add_filter('rest_pre_serve_request', [$controller, 'maybeServeHtml'], 10, 4);
        });
    }

    public function handle(WP_REST_Request $request): WP_REST_Response|WP_Error
    {
        $rxId = (int) $request->get_param('rx_id');
        if ($rxId <= 0) {
            return new WP_Error('ml_rx_invalid', 'Invalid rx_id', ['status' => 400]);
        }

        $jobCtx = $this->findJobContext($rxId);
        $reqId = ReqId::coalesce($jobCtx['req_id'] ?? null);
        $jobId = $jobCtx['job_id'] ?? null;

        $expectedPath = $this->expectedCanonicalPathForRx($rxId);

        if ($this->isDebugAllowed()) {
            $this->logger->warning('render.debug_access.granted', ['rx_id' => $rxId], $reqId);
        } else {
            $auth = $this->verifier->verifyCanonicalGet($request, $expectedPath, 'worker_render');
            if (is_wp_error($auth)) {
                $this->logger->warning('render.auth.denied', [
                    'rx_id' => $rxId,
                    'path' => $expectedPath,
                    'code' => $auth->get_error_code(),
                ], $reqId);
                return $auth;
            }
        }

        if (!$this->tableExists($this->rxTable)) {
            return new WP_Error('ml_rx_store_missing', 'Prescription store unavailable', ['status' => 503]);
        }

        $t0 = (int) floor(microtime(true) * 1000);
        $rx = $this->db->get_row(
            $this->db->prepare("SELECT * FROM `{$this->rxTable}` WHERE id = %d LIMIT 1", $rxId),
            ARRAY_A
        );
        if (!is_array($rx)) {
            $this->logger->warning('render.rx_not_found', ['rx_id' => $rxId], $reqId);
            return new WP_Error('ml_rx_not_found', 'Prescription not found', ['status' => 404]);
        }

        $items = [];
        if ($this->tableExists($this->itemsTable)) {
            $items = $this->db->get_results(
                $this->db->prepare("SELECT * FROM `{$this->itemsTable}` WHERE prescription_id = %d ORDER BY id ASC", $rxId),
                ARRAY_A
            );
            if (!is_array($items)) {
                $items = [];
            }
        }

        $html = $this->renderMedicalHtml($rxId, $reqId, $jobId, $rx, $items);
        $dt = ((int) floor(microtime(true) * 1000)) - $t0;

        $this->logger->info('render.responded', [
            'rx_id' => $rxId,
            'job_id' => $jobId,
            'items_count' => count($items),
            'duration_ms' => $dt,
        ], $reqId);

        $response = new WP_REST_Response($html, 200);
        $response->header('Content-Type', 'text/html; charset=utf-8');
        $response->header('Cache-Control', 'no-store, private, max-age=0');
        $response->header('Pragma', 'no-cache');
        $response->header('X-Robots-Tag', 'noindex, nofollow, noarchive');
        $response->header('X-Content-Type-Options', 'nosniff');
        $response->header('Referrer-Policy', 'no-referrer');
        $response->header('X-Frame-Options', 'DENY');
        $response->header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'unsafe-inline'; connect-src 'self'");

        return $response;
    }

    public function maybeServeHtml(bool $served, $result, WP_REST_Request $request, $server): bool
    {
        if ($served) {
            return true;
        }

        $route = $request->get_route();
        if (strpos($route, '/sosprescription/v3/worker/render/rx/') !== 0) {
            return false;
        }

        if (!($result instanceof WP_REST_Response)) {
            return false;
        }

        $headers = $result->get_headers();
        $ct = $headers['Content-Type'] ?? $headers['content-type'] ?? '';
        if (stripos((string) $ct, 'text/html') !== 0) {
            return false;
        }

        status_header($result->get_status());
        foreach ($headers as $name => $value) {
            header($name . ': ' . $value);
        }

        $body = $result->get_data();
        echo is_string($body) ? $body : '<!doctype html><html><body>Invalid response</body></html>';
        return true;
    }

    private function expectedCanonicalPathForRx(int $rxId): string
    {
        $base = parse_url(rest_url(), PHP_URL_PATH);
        $base = is_string($base) && $base !== '' ? rtrim($base, '/') : '/wp-json';
        return $base . '/sosprescription/v3/worker/render/rx/' . $rxId;
    }

    private function isDebugAllowed(): bool
    {
        return defined('SOSPRESCRIPTION_RENDER_DEBUG')
            && SOSPRESCRIPTION_RENDER_DEBUG === true
            && is_user_logged_in()
            && current_user_can('manage_options');
    }

    private function findJobContext(int $rxId): array
    {
        $sql = "
            SELECT job_id, req_id, status, locked_at, created_at
            FROM `{$this->jobsTable}`
            WHERE site_id = %s
              AND rx_id = %d
              AND job_type = 'PDF_GEN'
              AND status IN ('CLAIMED','PENDING','DONE')
            ORDER BY CASE WHEN status='CLAIMED' THEN 0 WHEN status='PENDING' THEN 1 ELSE 2 END ASC,
                     locked_at DESC,
                     created_at DESC
            LIMIT 1
        ";

        $row = $this->db->get_row($this->db->prepare($sql, $this->siteId, $rxId), ARRAY_A);
        if (!is_array($row)) {
            return [];
        }

        return [
            'job_id' => isset($row['job_id']) ? (string) $row['job_id'] : null,
            'req_id' => isset($row['req_id']) ? (string) $row['req_id'] : null,
        ];
    }

    private function tableExists(string $table): bool
    {
        $found = $this->db->get_var($this->db->prepare('SHOW TABLES LIKE %s', $table));
        return is_string($found) && $found === $table;
    }

    private function renderMedicalHtml(int $rxId, string $reqId, ?string $jobId, array $rx, array $items): string
    {
        $issuedAt = $rx['issued_at'] ?? $rx['created_at'] ?? '';
        $doctorName = $rx['doctor_name'] ?? $rx['prescriber_name'] ?? $rx['medecin_nom'] ?? '';
        $doctorRpps = $rx['doctor_rpps'] ?? $rx['rpps'] ?? '';
        $doctorAddress = $rx['doctor_address'] ?? $rx['prescriber_address'] ?? '';

        $patientFullname = $rx['patient_fullname']
            ?? trim((string) ($rx['patient_firstname'] ?? '') . ' ' . (string) ($rx['patient_lastname'] ?? ''));
        $patientDob = $rx['patient_birthdate'] ?? $rx['patient_dob'] ?? '';

        $itemsHtml = '';
        foreach ($items as $it) {
            if (!is_array($it)) {
                continue;
            }
            $label = (string) ($it['label'] ?? $it['drug_label'] ?? $it['name'] ?? 'Médicament');
            $poso = (string) ($it['posology'] ?? $it['instructions'] ?? $it['dosage'] ?? '');
            $qty = (string) ($it['quantity'] ?? $it['qty'] ?? '');

            $itemsHtml .= '<tr>';
            $itemsHtml .= '<td class="col-drug">' . esc_html($label) . '</td>';
            $itemsHtml .= '<td class="col-poso">' . esc_html($poso) . '</td>';
            $itemsHtml .= '<td class="col-qty">' . esc_html($qty) . '</td>';
            $itemsHtml .= '</tr>';
        }

        if ($itemsHtml === '') {
            $itemsHtml = '<tr><td colspan="3" class="muted">Aucune ligne trouvée.</td></tr>';
        }

        $metaReqId = esc_attr($reqId);
        $metaJobId = esc_attr((string) ($jobId ?? ''));
        $metaRxId = esc_attr((string) $rxId);

        $html = '<!doctype html>';
        $html .= '<html lang="fr">';
        $html .= '<head>';
        $html .= '<meta charset="utf-8">';
        $html .= '<meta name="viewport" content="width=device-width, initial-scale=1">';
        $html .= '<meta name="ml:req_id" content="' . $metaReqId . '">';
        $html .= '<meta name="ml:job_id" content="' . $metaJobId . '">';
        $html .= '<meta name="ml:rx_id" content="' . $metaRxId . '">';
        $html .= '<title>' . esc_html('Ordonnance #' . $rxId) . '</title>';
        $html .= '<style>';
        $html .= '@page { size: A4; margin: 0; }';
        $html .= 'html, body { margin: 0; padding: 0; }';
        $html .= 'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #111; font-size: 11pt; line-height: 1.35; }';
        $html .= '.page { padding: 12mm 12mm; }';
        $html .= '.header { display: flex; justify-content: space-between; gap: 10mm; padding-bottom: 4mm; border-bottom: 1px solid #000; }';
        $html .= '.block { width: 50%; }';
        $html .= '.h1 { font-size: 16pt; font-weight: 700; margin: 0 0 2mm 0; }';
        $html .= '.meta { font-size: 9pt; color: #333; margin-top: 2mm; }';
        $html .= '.label { font-weight: 700; }';
        $html .= '.muted { color: #555; }';
        $html .= 'table { width: 100%; border-collapse: collapse; margin-top: 6mm; }';
        $html .= 'th, td { border: 1px solid #000; padding: 2.5mm 2mm; vertical-align: top; }';
        $html .= 'th { font-weight: 700; background: #f3f3f3; }';
        $html .= '.col-drug { width: 45%; }';
        $html .= '.col-poso { width: 40%; }';
        $html .= '.col-qty { width: 15%; text-align: right; white-space: nowrap; }';
        $html .= '.footer { margin-top: 8mm; font-size: 8.5pt; color: #444; border-top: 1px solid #000; padding-top: 3mm; }';
        $html .= '</style>';
        $html .= '</head>';
        $html .= '<body>';
        $html .= "\n<!-- req_id: {$metaReqId} job_id: {$metaJobId} -->\n";
        $html .= '<div class="page">';
        $html .= '<div class="header">';
        $html .= '<div class="block">';
        $html .= '<div class="h1">Ordonnance</div>';
        if ($issuedAt !== '') {
            $html .= '<div class="meta"><span class="label">Date :</span> ' . esc_html((string) $issuedAt) . '</div>';
        }
        if ($doctorName !== '') {
            $html .= '<div class="meta"><span class="label">Prescripteur :</span> ' . esc_html((string) $doctorName) . '</div>';
        }
        if ($doctorRpps !== '') {
            $html .= '<div class="meta"><span class="label">RPPS :</span> ' . esc_html((string) $doctorRpps) . '</div>';
        }
        if ($doctorAddress !== '') {
            $html .= '<div class="meta"><span class="label">Adresse :</span> ' . esc_html((string) $doctorAddress) . '</div>';
        }
        $html .= '</div>';
        $html .= '<div class="block">';
        if ($patientFullname !== '') {
            $html .= '<div class="meta"><span class="label">Patient :</span> ' . esc_html((string) $patientFullname) . '</div>';
        } else {
            $html .= '<div class="meta muted">Patient : (non renseigné)</div>';
        }
        if ($patientDob !== '') {
            $html .= '<div class="meta"><span class="label">Naissance :</span> ' . esc_html((string) $patientDob) . '</div>';
        }
        $html .= '<div class="meta"><span class="label">Référence :</span> #' . esc_html((string) $rxId) . '</div>';
        $html .= '</div>';
        $html .= '</div>';
        $html .= '<table><thead><tr><th>Médicament</th><th>Posologie</th><th>Qté</th></tr></thead><tbody>' . $itemsHtml . '</tbody></table>';
        $html .= '<div class="footer">Document généré par SOS Prescription v3 — <span class="muted">req_id=' . esc_html($reqId) . '</span></div>';
        $html .= '</div>';
        $html .= '<div data-ml-pdf-ready="1" style="display:none"></div>';
        $html .= '<script>window.__ML_PDF_READY__ = true;</script>';
        $html .= '</body>';
        $html .= '</html>';

        return $html;
    }
}
