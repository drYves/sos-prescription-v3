<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

add_action('rest_api_init', function () {
    register_rest_route('sosprescription/v4', '/medications/search', [
        'methods' => 'GET',
        'permission_callback' => '__return_true', // Endpoint public
        'callback' => function ($request) {
            $query = $request->get_param('q');
            $limit = $request->get_param('limit') ?: 20;

            // Cible : Le Worker Node.js sur Scalingo
            $worker_url = 'https://sos-v3-prod.osc-fr1.scalingo.io/api/v2/medications/search';
            
            $request_url = add_query_arg([
                'q' => urlencode($query),
                'limit' => intval($limit)
            ], $worker_url);

            $response = wp_remote_get($request_url, ['timeout' => 15]);

            if (is_wp_error($response)) {
                return new WP_Error('worker_unreachable', 'Le moteur de recherche est injoignable.', ['status' => 500]);
            }

            $body = wp_remote_retrieve_body($response);
            $status = wp_remote_retrieve_response_code($response);
            
            return new WP_REST_Response(json_decode($body), $status);
        }
    ]);
});
