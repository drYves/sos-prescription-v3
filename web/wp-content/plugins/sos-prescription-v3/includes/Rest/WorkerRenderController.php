<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SosPrescription\Core\ReqId;
use WP_REST_Request;
use WP_REST_Response;

final class WorkerRenderController
{
    public static function register(): void
    {
        add_action('rest_api_init', static function (): void {
            register_rest_route('sosprescription/v3', '/worker/render/(?P<job_id>[a-zA-Z0-9\-]+)', [
                'methods' => 'GET',
                'permission_callback' => '__return_true',
                'callback' => [self::class, 'handle'],
            ]);
        });
    }

    public static function handle(WP_REST_Request $request): WP_REST_Response
    {
        $jobId = (string) $request['job_id'];
        $html = sprintf('<!doctype html><html><head><meta charset="utf-8"><title>SOS Prescription</title></head><body><main><h1>Prescription</h1><p>job_id: %s</p><p>req_id: %s</p></main></body></html>', esc_html($jobId), esc_html(ReqId::new()));

        return new WP_REST_Response(['html' => $html], 200);
    }
}
