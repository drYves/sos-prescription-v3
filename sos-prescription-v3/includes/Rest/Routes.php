<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

final class Routes
{
    public static function register(): void
    {
        $med = new MedicationController();
        $imp = new ImportController();
        $rx  = new PrescriptionController();
        $log = new LogController();
        $pricing = new PricingController();
        $files = new FilesController();
        $messages = new MessagesController();
        $payments = new PaymentsController();

        register_rest_route('sosprescription/v1', '/medications/search', [
            'methods' => 'GET',
            'callback' => [$med, 'search'],
            'permission_callback' => [$med, 'permissions_check_logged_in_nonce'],
            'args' => [
                'q' => ['type' => 'string', 'required' => true],
                'limit' => ['type' => 'integer', 'required' => false],
            ],
        ]);

        register_rest_route('sosprescription/v1', '/medications/table', [
            'methods' => 'GET',
            'callback' => [$med, 'table'],
            'permission_callback' => [$med, 'permissions_check_logged_in_nonce'],
            'args' => [
                'q' => ['type' => 'string', 'required' => false],
                'page' => ['type' => 'integer', 'required' => false],
                'perPage' => ['type' => 'integer', 'required' => false],
            ],
        ]);

        register_rest_route('sosprescription/v1', '/import/upload', [
            'methods' => 'POST',
            'callback' => [$imp, 'upload_zip'],
            'permission_callback' => [$imp, 'permissions_check_manage_data'],
        ]);

        register_rest_route('sosprescription/v1', '/import/step', [
            'methods' => 'POST',
            'callback' => [$imp, 'step'],
            'permission_callback' => [$imp, 'permissions_check_manage_data'],
        ]);

        register_rest_route('sosprescription/v1', '/import/status', [
            'methods' => 'GET',
            'callback' => [$imp, 'status'],
            'permission_callback' => [$imp, 'permissions_check_manage_data'],
        ]);

        register_rest_route('sosprescription/v1', '/import/reset', [
            'methods' => 'POST',
            'callback' => [$imp, 'reset'],
            'permission_callback' => [$imp, 'permissions_check_manage_data'],
        ]);

        // Tarifs
        register_rest_route('sosprescription/v1', '/pricing', [
            'methods' => 'GET',
            'callback' => [$pricing, 'get_public'],
            'permission_callback' => [$pricing, 'permissions_check_public'],
        ]);

        register_rest_route('sosprescription/v1', '/pricing/admin', [
            'methods' => 'GET',
            'callback' => [$pricing, 'get_admin'],
            'permission_callback' => [$pricing, 'permissions_check_manage'],
        ]);

        register_rest_route('sosprescription/v1', '/pricing/admin', [
            'methods' => 'POST',
            'callback' => [$pricing, 'update_admin'],
            'permission_callback' => [$pricing, 'permissions_check_manage'],
            'args' => EndpointArgs::update_pricing_v1(),
        ]);

        register_rest_route('sosprescription/v1', '/prescriptions', [
            'methods' => 'POST',
            'callback' => [$rx, 'create'],
            'permission_callback' => [$rx, 'permissions_check_logged_in_nonce'],
            'args' => EndpointArgs::create_prescription_v1(),
        ]);

        register_rest_route('sosprescription/v1', '/prescriptions', [
            'methods' => 'GET',
            'callback' => [$rx, 'list'],
            'permission_callback' => [$rx, 'permissions_check_logged_in_nonce'],
            'args' => EndpointArgs::list_prescriptions_v1(),
        ]);

        register_rest_route('sosprescription/v1', '/prescriptions/(?P<id>\d+)', [
            'methods' => 'GET',
            'callback' => [$rx, 'get_one'],
            'permission_callback' => [$rx, 'permissions_check_logged_in_nonce'],
            'args' => [
                'id' => EndpointArgs::id(),
            ],
        ]);

        register_rest_route('sosprescription/v1', '/prescriptions/(?P<id>\d+)/decision', [
            'methods' => 'POST',
            'callback' => [$rx, 'decision'],
            'permission_callback' => [$rx, 'permissions_check_validate'],
            'args' => array_merge(
                ['id' => EndpointArgs::id()],
                EndpointArgs::decision_v1()
            ),
        ]);

        // Console médecin : assignation et mise à jour de statut (triage).
        register_rest_route('sosprescription/v1', '/prescriptions/(?P<id>\d+)/assign', [
            'methods' => 'POST',
            'callback' => [$rx, 'assign'],
            'permission_callback' => [$rx, 'permissions_check_validate'],
            'args' => [
                'id' => EndpointArgs::id(),
            ],
        ]);

        register_rest_route('sosprescription/v1', '/prescriptions/(?P<id>\d+)/status', [
            'methods' => 'POST',
            'callback' => [$rx, 'update_status'],
            'permission_callback' => [$rx, 'permissions_check_validate'],
            'args' => array_merge(
                ['id' => EndpointArgs::id()],
                EndpointArgs::update_status_v1()
            ),
        ]);

        register_rest_route('sosprescription/v1', '/prescriptions/(?P<id>\d+)/print', [
            'methods' => 'GET',
            'callback' => [$rx, 'print_view'],
            'permission_callback' => [$rx, 'permissions_check_logged_in_nonce'],
            'args' => [
                'id' => EndpointArgs::id(),
            ],
        ]);

        // Génération serveur d'ordonnance PDF (attachée en tant que fichier purpose=rx_pdf)
        register_rest_route('sosprescription/v1', '/prescriptions/(?P<id>\d+)/rx-pdf', [
            'methods' => 'POST',
            'callback' => [$rx, 'generate_rx_pdf'],
            'permission_callback' => [$rx, 'permissions_check_validate'],
            'args' => [
                'id' => EndpointArgs::id(),
            ],
        ]);

        // Callback Worker -> WordPress pour synchroniser le shadow record local après génération PDF.
        register_rest_route('sosprescription/v1', '/prescriptions/worker/(?P<job_id>[A-Fa-f0-9\-]{36})/callback', [
            'methods' => 'POST',
            'callback' => [$rx, 'worker_pdf_callback'],
            'permission_callback' => '__return_true',
            'args' => [
                'job_id' => [
                    'required' => true,
                    'sanitize_callback' => static function ($value) {
                        return is_string($value) ? trim($value) : '';
                    },
                ],
            ],
        ]);

        // Logs frontend (télémétrie de debug)
        register_rest_route('sosprescription/v1', '/logs/frontend', [
            'methods' => 'POST',
            'callback' => [$log, 'frontend'],
            'permission_callback' => [$log, 'permissions_check_logged_in_nonce'],
        ]);

        // Fichiers (pièces justificatives)
        register_rest_route('sosprescription/v1', '/files', [
            'methods' => 'POST',
            'callback' => [$files, 'upload'],
            'permission_callback' => [$files, 'permissions_check_logged_in_nonce'],
            'args' => EndpointArgs::upload_file_v1(),
        ]);

        register_rest_route('sosprescription/v1', '/files/(?P<id>\d+)', [
            'methods' => 'GET',
            'callback' => [$files, 'get_one'],
            'permission_callback' => [$files, 'permissions_check_logged_in_nonce'],
            'args' => [
                'id' => EndpointArgs::id(),
            ],
        ]);

        register_rest_route('sosprescription/v1', '/files/(?P<id>\d+)/download', [
            'methods' => 'GET',
            'callback' => [$files, 'download'],
            'permission_callback' => [$files, 'permissions_check_logged_in_nonce'],
            'args' => [
                'id' => EndpointArgs::id(),
            ],
        ]);


        // Messagerie patient/médecin (asynchrone)
        register_rest_route('sosprescription/v1', '/prescriptions/(?P<id>\d+)/messages', [
            'methods' => 'GET',
            'callback' => [$messages, 'list'],
            'permission_callback' => [$messages, 'permissions_check_logged_in_nonce'],
            'args' => array_merge(
                ['id' => EndpointArgs::id()],
                EndpointArgs::list_messages_v1()
            ),
        ]);

        register_rest_route('sosprescription/v1', '/prescriptions/(?P<id>\d+)/messages', [
            'methods' => 'POST',
            'callback' => [$messages, 'create'],
            'permission_callback' => [$messages, 'permissions_check_logged_in_nonce'],
            'args' => array_merge(
                ['id' => EndpointArgs::id()],
                EndpointArgs::create_message_v1()
            ),
        ]);

        // Paiements (Stripe)
        register_rest_route('sosprescription/v1', '/payments/config', [
            'methods' => 'GET',
            'callback' => [$payments, 'get_config'],
            'permission_callback' => [$payments, 'permissions_check_logged_in_nonce'],
        ]);

        register_rest_route('sosprescription/v1', '/prescriptions/(?P<id>\d+)/payment/intent', [
            'methods' => 'POST',
            'callback' => [$payments, 'create_intent'],
            'permission_callback' => [$payments, 'permissions_check_logged_in_nonce'],
            'args' => [
                'id' => EndpointArgs::id(),
            ],
        ]);

        register_rest_route('sosprescription/v1', '/prescriptions/(?P<id>\d+)/payment/confirm', [
            'methods' => 'POST',
            'callback' => [$payments, 'confirm_intent'],
            'permission_callback' => [$payments, 'permissions_check_logged_in_nonce'],
            'args' => [
                'id' => EndpointArgs::id(),
            ],
        ]);

        // Endpoint webhook Stripe (pas de nonce) : signature obligatoire.
        register_rest_route('sosprescription/v1', '/stripe/webhook', [
            'methods' => 'POST',
            'callback' => [$payments, 'stripe_webhook'],
            'permission_callback' => [$payments, 'permissions_check_public'],
        ]);

        // Verification pharmacien (/v/{token}) : confirmer la délivrance (code 6 chiffres).
        register_rest_route('sosprescription/v1', '/verify/(?P<token>[a-f0-9]{16,64})/deliver', [
            'methods' => 'POST',
            'callback' => [VerificationController::class, 'deliver'],
            'permission_callback' => '__return_true',
            'args' => [
                'token' => [
                    'required' => true,
                    'sanitize_callback' => static function ($value) {
                        return is_string($value) ? trim($value) : '';
                    },
                ],
                'code' => [
                    'required' => true,
                    'sanitize_callback' => static function ($value) {
                        return is_string($value) ? trim($value) : '';
                    },
                ],
            ],
        ]);

    }
}
