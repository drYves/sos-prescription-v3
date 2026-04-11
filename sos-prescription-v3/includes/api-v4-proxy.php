<?php

declare(strict_types=1);

defined('ABSPATH') || exit;

add_action('rest_api_init', static function (): void {
    register_rest_route('sosprescription/v4', '/medications/search', [
        'methods' => 'GET',
        'permission_callback' => '__return_true',
        'callback' => static function (WP_REST_Request $request) {
            $query = trim((string) $request->get_param('q'));
            $limit = (int) ($request->get_param('limit') ?? 20);
            $workerUrl = 'https://sos-v3-prod.osc-fr1.scalingo.io/api/v2/medications/search';
            $requestUrl = add_query_arg(
                [
                    'q' => $query,
                    'limit' => max(1, min(50, $limit)),
                ],
                $workerUrl
            );

            $response = wp_remote_get($requestUrl, [
                'timeout' => 15,
                'headers' => [
                    'Accept' => 'application/json',
                ],
            ]);

            if (is_wp_error($response)) {
                return new WP_Error(
                    'worker_unreachable',
                    'Moteur de recherche injoignable.',
                    ['status' => 500]
                );
            }

            $statusCode = (int) wp_remote_retrieve_response_code($response);
            $rawBody = wp_remote_retrieve_body($response);
            $decodedBody = json_decode($rawBody, true);

            if (json_last_error() !== JSON_ERROR_NONE) {
                return new WP_Error(
                    'worker_invalid_response',
                    'Réponse invalide du moteur de recherche.',
                    ['status' => 502]
                );
            }

            return new WP_REST_Response($decodedBody, $statusCode > 0 ? $statusCode : 502);
        },
    ]);
});
