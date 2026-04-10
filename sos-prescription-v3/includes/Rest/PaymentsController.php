<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

use SosPrescription\Repositories\PrescriptionRepository;
use SosPrescription\Services\Logger;
use SosPrescription\Services\Pricing;
use SosPrescription\Services\StripeClient;
use SosPrescription\Services\StripeConfig;
use SosPrescription\Services\Notifications;
use SosPrescription\Services\AccessPolicy;
use SosPrescription\Services\Audit;
use SosPrescription\Services\RestGuard;
use WP_Error;
use WP_REST_Request;

final class PaymentsController
{
    private PrescriptionRepository $repo;

    public function __construct()
    {
        $this->repo = new PrescriptionRepository();
    }

    public function permissions_check_logged_in_nonce(WP_REST_Request $request): bool|WP_Error
    {
        $ok = RestGuard::require_logged_in($request);
        if (is_wp_error($ok)) {
            return $ok;
        }

        return RestGuard::require_wp_rest_nonce($request);
    }

    public function permissions_check_public(WP_REST_Request $request): bool
    {
        // Webhook Stripe : la sécurité repose sur la signature.
        return true;
    }

    public function get_config(WP_REST_Request $request)
    {
        $cfg = StripeConfig::get();

        return rest_ensure_response([
            'enabled' => (bool) $cfg['enabled'],
            'publishable_key' => (string) $cfg['publishable_key'],
            'provider' => 'stripe',
            'capture_method' => 'manual',
        ]);
    }

    public function create_intent(WP_REST_Request $request)
    {
        $scope = strtolower(trim((string) $request->get_header('X-Sos-Scope')));
        $t0 = microtime(true);

        if (!StripeClient::is_enabled()) {
            return new WP_Error('sosprescription_payments_disabled', 'Paiement désactivé ou Stripe non configuré.', ['status' => 400]);
        }

        $id = (int) $request->get_param('id');
        if ($id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

		// Autorisation : patient propriétaire OU admin (pas besoin d'ouverture côté médecin).
		$current_user_id = (int) get_current_user_id();
		$can_manage_all = AccessPolicy::is_admin();

        // On récupère l'owner quoi qu'il arrive : utile pour notifier le patient même si un admin déclenche l'action.
        $owner = $this->repo->get_owner_user_id($id);

		if (!$can_manage_all) {
            if ($owner === null || (int) $owner !== (int) $current_user_id) {
                return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
            }
        }

        $row = $this->repo->get_payment_fields($id);
        if ($row === null) {
            return new WP_Error('sosprescription_not_found', 'Prescription introuvable.', ['status' => 404]);
        }

        if (in_array($row['status'], ['approved', 'rejected'], true)) {
            return new WP_Error('sosprescription_payment_not_allowed', 'Paiement impossible : demande déjà décidée.', ['status' => 400]);
        }

        $this->mark_payment_pending_if_possible($id, $row);
        $row['status'] = 'payment_pending';

        $params = $request->get_json_params();
        if (!is_array($params)) {
            $params = [];
        }

        $priority = isset($params['priority']) ? strtolower(trim((string) $params['priority'])) : strtolower(trim((string) $row['priority']));
        if ($priority !== 'express') {
            $priority = 'standard';
        }

        // Persist the chosen priority on the prescription (useful for triage).
        $this->repo->update_priority($id, $priority);

        $pricing = Pricing::get();
        $amount = $priority === 'express' ? (int) $pricing['express_cents'] : (int) $pricing['standard_cents'];
        $currency = (string) $pricing['currency'];
        if ($currency === '') {
            $currency = 'EUR';
        }

        if ($amount < 50) {
            // En dessous de 0,50€ : probablement une config. Stripe refuse généralement < 50 cents.
            return new WP_Error('sosprescription_bad_pricing', 'Tarif invalide. Vérifiez la configuration des tarifs.', ['status' => 400]);
        }

        $existing_intent = $row['payment_intent_id'];
        if (is_string($existing_intent) && $existing_intent !== '') {
            $pi = StripeClient::retrieve_payment_intent($existing_intent);
            if (is_wp_error($pi)) {
                return $pi;
            }

            // Sync DB avec le statut Stripe.
            $pi_status = isset($pi['status']) ? (string) $pi['status'] : null;
            $pi_amount = isset($pi['amount']) ? (int) $pi['amount'] : null;
            $pi_cur = isset($pi['currency']) ? strtoupper((string) $pi['currency']) : null;

            $this->repo->update_payment_fields($id, [
                'payment_provider' => 'stripe',
                'payment_intent_id' => $existing_intent,
                'payment_status' => $pi_status,
                'amount_cents' => $pi_amount,
                'currency' => $pi_cur,
            ]);

            // Si le montant a changé et que le PI n'est pas confirmé, on le remplace.
            $replaceable = in_array($pi_status, ['requires_payment_method', 'requires_confirmation'], true);
            if ($replaceable && $pi_amount !== null && $pi_amount !== $amount) {
                $cancel = StripeClient::cancel_payment_intent($existing_intent);
                if (is_wp_error($cancel)) {
                    return $cancel;
                }
                // On passe à la création d'un nouveau PI.
                $existing_intent = null;
            } else {
                if ($scope !== '') {
                    Logger::log_shortcode($scope, 'info', 'api_payment_intent_reuse', [
                        'prescription_id' => $id,
                        'pi' => $existing_intent,
                        'status' => $pi_status,
                        'ms' => (int) round((microtime(true) - $t0) * 1000),
                    ]);
                }

                return rest_ensure_response([
                    'provider' => 'stripe',
                    'payment_intent_id' => (string) ($pi['id'] ?? $existing_intent),
                    'client_secret' => isset($pi['client_secret']) ? (string) $pi['client_secret'] : null,
                    'status' => $pi_status,
                    'amount_cents' => $pi_amount,
                    'currency' => $pi_cur,
                    'priority' => $priority,
                    'publishable_key' => StripeClient::publishable_key(),
                ]);
            }
        }

        // Crée un nouveau PI
        $metadata = [
            'prescription_id' => (string) $id,
            'uid' => (string) $row['uid'],
            'flow' => (string) $row['flow'],
            'priority' => $priority,
            'site' => (string) home_url(),
        ];

        $idempotency_key = 'sosprescription_pi_' . $id . '_' . $amount . '_' . strtolower($currency);

        $pi = StripeClient::create_payment_intent($amount, $currency, $metadata, $idempotency_key);
        if (is_wp_error($pi)) {
            return $pi;
        }

        $pi_id = isset($pi['id']) ? (string) $pi['id'] : '';
        $pi_status = isset($pi['status']) ? (string) $pi['status'] : null;
        $pi_amount = isset($pi['amount']) ? (int) $pi['amount'] : $amount;
        $pi_cur = isset($pi['currency']) ? strtoupper((string) $pi['currency']) : strtoupper($currency);

        $snapshot = [
            'version' => 1,
            'selected_priority' => $priority,
            'amount_cents' => $pi_amount,
            'currency' => $pi_cur,
            'pricing' => $pricing,
            'created_at' => current_time('mysql'),
            'provider' => 'stripe',
            'capture_method' => 'manual',
        ];

        $this->repo->update_payment_fields($id, [
            'payment_provider' => 'stripe',
            'payment_intent_id' => $pi_id,
            'payment_status' => $pi_status,
            'amount_cents' => $pi_amount,
            'currency' => $pi_cur,
            'pricing_snapshot' => $snapshot,
        ]);

		Audit::log('payment_intent_create', 'prescription', $id, $id, [
			'pi' => $pi_id,
			'status' => $pi_status,
			'amount_cents' => $pi_amount,
			'currency' => $pi_cur,
			'priority' => $priority,
		]);

        if ($scope !== '') {
            Logger::log_shortcode($scope, 'info', 'api_payment_intent_created', [
                'prescription_id' => $id,
                'pi' => $pi_id,
                'status' => $pi_status,
                'amount' => $pi_amount,
                'currency' => $pi_cur,
                'ms' => (int) round((microtime(true) - $t0) * 1000),
            ]);
        }

        return rest_ensure_response([
            'provider' => 'stripe',
            'payment_intent_id' => $pi_id,
            'client_secret' => isset($pi['client_secret']) ? (string) $pi['client_secret'] : null,
            'status' => $pi_status,
            'amount_cents' => $pi_amount,
            'currency' => $pi_cur,
            'priority' => $priority,
            'publishable_key' => StripeClient::publishable_key(),
        ]);
    }

    public function confirm_intent(WP_REST_Request $request)
    {
        $id = (int) $request->get_param('id');
        if ($id < 1) {
            return new WP_Error('sosprescription_bad_id', 'ID invalide.', ['status' => 400]);
        }

        if (!StripeClient::is_enabled()) {
            return new WP_Error('sosprescription_payments_disabled', 'Paiement désactivé ou Stripe non configuré.', ['status' => 400]);
        }

		// Autorisation : patient propriétaire OU admin.
		$current_user_id = (int) get_current_user_id();
		$can_manage_all = AccessPolicy::is_admin();

        // On récupère l'owner quoi qu'il arrive : utile pour notifier le patient même si un admin déclenche l'action.
        $owner = $this->repo->get_owner_user_id($id);

        if (!$can_manage_all) {
            if ($owner === null || (int) $owner !== (int) $current_user_id) {
                return new WP_Error('sosprescription_forbidden', 'Accès refusé.', ['status' => 403]);
            }
        }

        $params = $request->get_json_params();
        if (!is_array($params)) {
            $params = [];
        }

        $pi_id = isset($params['payment_intent_id']) ? trim((string) $params['payment_intent_id']) : '';
        if ($pi_id === '') {
            return new WP_Error('sosprescription_bad_intent', 'payment_intent_id requis.', ['status' => 400]);
        }

        $row = $this->repo->get_payment_fields($id);
        if ($row === null) {
            return new WP_Error('sosprescription_not_found', 'Prescription introuvable.', ['status' => 404]);
        }

        $stored = $row['payment_intent_id'];
        if (is_string($stored) && $stored !== '' && $stored !== $pi_id) {
            return new WP_Error('sosprescription_intent_mismatch', 'PaymentIntent ne correspond pas à cette prescription.', ['status' => 400]);
        }

        $pi = StripeClient::retrieve_payment_intent($pi_id);
        if (is_wp_error($pi)) {
            return $pi;
        }

        $pi_status = isset($pi['status']) ? (string) $pi['status'] : null;
        $pi_amount = isset($pi['amount']) ? (int) $pi['amount'] : null;
        $pi_cur = isset($pi['currency']) ? strtoupper((string) $pi['currency']) : null;

        $this->repo->update_payment_fields($id, [
            'payment_provider' => 'stripe',
            'payment_intent_id' => $pi_id,
            'payment_status' => $pi_status,
            'amount_cents' => $pi_amount,
            'currency' => $pi_cur,
        ]);

        // Si le paiement est autorisé (requires_capture) ou déjà capturé,
        // on passe la demande en "pending" afin qu'elle entre dans la file de traitement.
        if (in_array($pi_status, ['requires_capture', 'succeeded'], true)) {
            $was_payment_pending = isset($row['status']) && (string) $row['status'] === 'payment_pending';
            $ok_status = $this->repo->set_status_if_current($id, 'payment_pending', 'pending');

            // Notification patient (sans données de santé) : uniquement si on vient de sortir de payment_pending.
            if ($was_payment_pending && $ok_status && $owner !== null) {
                Notifications::patient_payment_confirmed($id, (int) $owner);
            }
        }

		Audit::log('payment_intent_confirm', 'prescription', $id, $id, [
			'pi_id' => (string) ($pi_id ?? ''),
			'pi_status' => (string) ($pi_status ?? ''),
			'amount_cents' => (int) ($pi_amount ?? 0),
			'currency' => (string) ($pi_cur ?? ''),
		]);

        return rest_ensure_response([
            'ok' => true,
            'status' => $pi_status,
            'amount_cents' => $pi_amount,
            'currency' => $pi_cur,
            'next_action' => isset($pi['next_action']) ? $pi['next_action'] : null,
        ]);
    }

    private function mark_payment_pending_if_possible(int $id, array $row): void
    {
        $currentStatus = isset($row['status']) ? strtolower(trim((string) $row['status'])) : '';
        if ($currentStatus === 'payment_pending') {
            return;
        }

        if ($currentStatus === 'pending') {
            $this->repo->set_status_if_current($id, 'pending', 'payment_pending');
            return;
        }

        if ($currentStatus === 'in_review') {
            $this->repo->set_status_if_current($id, 'in_review', 'payment_pending');
            return;
        }

        if ($currentStatus === 'needs_info') {
            $this->repo->set_status_if_current($id, 'needs_info', 'payment_pending');
        }
    }

    public function stripe_webhook(WP_REST_Request $request)
    {
        $payload = (string) $request->get_body();
        $sig = (string) $request->get_header('stripe-signature');

        $secret = StripeClient::webhook_secret();
        if ($secret === '') {
            return new WP_Error('sosprescription_webhook_not_configured', 'Webhook secret non configuré.', ['status' => 400]);
        }

        $ok = StripeClient::verify_webhook_signature($payload, $sig, $secret, 300);
        if (!$ok) {
            return new WP_Error('sosprescription_webhook_bad_sig', 'Signature webhook invalide.', ['status' => 400]);
        }

        $event = json_decode($payload, true);
        if (!is_array($event)) {
            return new WP_Error('sosprescription_webhook_bad_payload', 'Payload webhook invalide.', ['status' => 400]);
        }

        $type = isset($event['type']) ? (string) $event['type'] : '';
        $obj = $event['data']['object'] ?? null;
        if (!is_array($obj)) {
            return rest_ensure_response(['ok' => true]);
        }

        if (($obj['object'] ?? '') !== 'payment_intent') {
            return rest_ensure_response(['ok' => true]);
        }

        $pi_id = isset($obj['id']) ? (string) $obj['id'] : '';
        $pi_status = isset($obj['status']) ? (string) $obj['status'] : null;
        $pi_amount = isset($obj['amount']) ? (int) $obj['amount'] : null;
        $pi_cur = isset($obj['currency']) ? strtoupper((string) $obj['currency']) : null;

        if ($pi_id !== '') {
            $presc_id = $this->repo->find_id_by_payment_intent($pi_id);
            if ($presc_id !== null) {
                $before = $this->repo->get_payment_fields((int) $presc_id);

                $this->repo->update_payment_fields((int) $presc_id, [
                    'payment_status' => $pi_status,
                    'amount_cents' => $pi_amount,
                    'currency' => $pi_cur,
                ]);

                // Même logique que confirm_intent : si Stripe signale que l'argent est capturable,
                // on bascule la demande de payment_pending -> pending.
                if (in_array($pi_status, ['requires_capture', 'succeeded'], true)) {
                    $was_payment_pending = is_array($before) && isset($before['status']) && (string) $before['status'] === 'payment_pending';
                    $ok_status = $this->repo->set_status_if_current((int) $presc_id, 'payment_pending', 'pending');

                    if ($was_payment_pending && $ok_status) {
                        $owner = $this->repo->get_owner_user_id((int) $presc_id);
                        if ($owner !== null) {
                            Notifications::patient_payment_confirmed((int) $presc_id, (int) $owner);
                        }
                    }
                }
            }

            Logger::log('runtime', 'info', 'stripe_webhook_payment_intent', [
                'type' => $type,
                'payment_intent_id' => $pi_id,
                'status' => $pi_status,
                'amount' => $pi_amount,
                'currency' => $pi_cur,
                'prescription_id' => $presc_id ?? null,
            ]);
        }

        return rest_ensure_response(['ok' => true]);
    }
}
