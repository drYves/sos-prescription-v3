<?php
declare(strict_types=1);

namespace SosPrescription\Rest;

/**
 * Centralise les schémas d'arguments WP REST (validation/sanitization).
 *
 * Note: on garde une compatibilité V1 (payload simple) : patient + items + turnstileToken.
 * Les champs "flow" / "priority" / etc. seront ajoutés progressivement côté front.
 */
final class EndpointArgs
{
    public static function id(): array
    {
        return [
            'type' => 'integer',
            'required' => true,
            'minimum' => 1,
        ];
    }

    public static function list_prescriptions_v1(): array
    {
        return [
            'status' => [
                'type' => 'string',
                'required' => false,
            ],
            'limit' => [
                'type' => 'integer',
                'required' => false,
                'default' => 100,
                'minimum' => 1,
                'maximum' => 200,
            ],
            'offset' => [
                'type' => 'integer',
                'required' => false,
                'default' => 0,
                'minimum' => 0,
            ],
        ];
    }

    public static function create_prescription_v1(): array
    {
        return [
            'patient' => [
                'type' => 'object',
                'required' => true,
                'properties' => [
                    'fullname' => [
                        'type' => 'string',
                        'required' => true,
                        'minLength' => 2,
                        'maxLength' => 120,
                    ],
                    'birthdate' => [
                        'type' => 'string',
                        'required' => true,
                        // format libre V1 (front existant), on renforcera en V2 (YYYY-MM-DD)
                        'minLength' => 4,
                        'maxLength' => 40,
                    ],
                    'note' => [
                        'type' => 'string',
                        'required' => false,
                        'maxLength' => 2000,
                    ],
                ],
            ],
            'items' => [
                'type' => 'array',
                'required' => true,
                'minItems' => 1,
                'maxItems' => 10,
                'items' => [
                    'type' => 'object',
                    'required' => true,
                    'properties' => [
                        // Front actuel envoie cis en string; on accepte digits.
                        'cis' => [
                            'type' => ['string', 'null'],
                            'required' => false,
                            'pattern' => '^\\d+$',
                        ],
                        'cip13' => [
                            'type' => ['string', 'null'],
                            'required' => false,
                            'pattern' => '^\\d{13}$',
                        ],
                        'label' => [
                            'type' => 'string',
                            'required' => true,
                            'minLength' => 1,
                            'maxLength' => 255,
                        ],
                        'schedule' => [
                            'type' => 'object',
                            'required' => true,
                        ],
                        'quantite' => [
                            'type' => ['string', 'null'],
                            'required' => false,
                            'maxLength' => 255,
                        ],
                    ],
                ],
            ],
            // Historique : certaines versions du front envoient "turnstileToken" (camelCase)
            // et d'autres "turnstile_token" (snake_case). On accepte les deux et on laisse
            // le contrôleur retourner une erreur propre si le token est manquant/invalide.
            'turnstileToken' => [
                'type' => 'string',
                'required' => false,
                'minLength' => 10,
                'maxLength' => 4096,
            ],
            'turnstile_token' => [
                'type' => 'string',
                'required' => false,
                'minLength' => 10,
                'maxLength' => 4096,
            ],

            // Références Worker des preuves uploadées avant la création (mode zéro-trace).
            // On évite une validation schéma trop stricte ici, car le front peut envoyer
            // ponctuellement des "trous" (undefined -> null) avant son filtre final.
            'proof_artifact_ids' => [
                'type' => 'array',
                'required' => false,
                'maxItems' => 10,
                'validate_callback' => [self::class, 'validate_optional_string_id_array'],
                'sanitize_callback' => [self::class, 'sanitize_optional_string_id_array'],
            ],

            // Compat legacy : anciennes versions du front envoyaient evidence_file_ids.
            'evidence_file_ids' => [
                'type' => 'array',
                'required' => false,
                'maxItems' => 10,
                'items' => [
                    'type' => ['integer', 'string'],
                ],
            ],

            // Flux "sans preuve" : attestation sur l'honneur (case à cocher obligatoire côté UI)
            'attestation_no_proof' => [
                'type' => 'boolean',
                'required' => false,
            ],

            // Champs V2 (optionnels pour compatibilité)
            'flow' => [
                'type' => 'string',
                'required' => false,
            ],
            'priority' => [
                'type' => 'string',
                'required' => false,
            ],
            'client_request_id' => [
                'type' => 'string',
                'required' => false,
                'maxLength' => 64,
            ],

            // Consentement explicite (versionné) - optionnel dans le schéma (enforcement côté serveur)
            'consent' => [
                'type' => 'object',
                'required' => false,
                'properties' => [
                    'telemedicine' => ['type' => 'boolean', 'required' => false],
                    'truth' => ['type' => 'boolean', 'required' => false],
                    'cgu' => ['type' => 'boolean', 'required' => false],
                    'privacy' => ['type' => 'boolean', 'required' => false],
                    'timestamp' => ['type' => 'string', 'required' => false, 'maxLength' => 64],
                    'cgu_version' => ['type' => 'string', 'required' => false, 'maxLength' => 64],
                    'privacy_version' => ['type' => 'string', 'required' => false, 'maxLength' => 64],
                ],
            ],
        ];
    }

    public static function init_artifact_v1(): array
    {
        return [
            'purpose' => [
                'type' => 'string',
                'required' => true,
                'minLength' => 2,
                'maxLength' => 40,
            ],
            'kind' => [
                'type' => 'string',
                'required' => false,
                'minLength' => 4,
                'maxLength' => 32,
            ],
            'original_name' => [
                'type' => 'string',
                'required' => true,
                'minLength' => 1,
                'maxLength' => 255,
            ],
            'mime_type' => [
                'type' => 'string',
                'required' => true,
                'minLength' => 3,
                'maxLength' => 191,
            ],
            'size_bytes' => [
                'type' => 'integer',
                'required' => true,
                'minimum' => 1,
                'maximum' => 10485760,
            ],
            'prescription_id' => [
                'type' => 'integer',
                'required' => false,
                'minimum' => 1,
            ],
        ];
    }

    public static function upload_file_v1(): array
    {
        return [
            'purpose' => [
                'type' => 'string',
                'required' => true,
                'minLength' => 2,
                'maxLength' => 30,
            ],
            'prescription_id' => [
                'type' => 'integer',
                'required' => false,
                'minimum' => 1,
            ],
        ];
    }

    public static function list_messages_v1(): array
    {
        return [
            'limit' => [
                'type' => 'integer',
                'required' => false,
                'default' => 200,
                'minimum' => 1,
                'maximum' => 500,
            ],
            'offset' => [
                'type' => 'integer',
                'required' => false,
                'default' => 0,
                'minimum' => 0,
            ],
        ];
    }

    public static function create_message_v1(): array
    {
        return [
            'body' => [
                'type' => 'string',
                'required' => true,
                'minLength' => 1,
                'maxLength' => 8000,
            ],
            'attachments' => [
                'type' => 'array',
                'required' => false,
                'maxItems' => 10,
                'items' => [
                    'type' => 'integer',
                    'minimum' => 1,
                ],
            ],
        ];
    }

    public static function decision_v1(): array
    {
        return [
            'decision' => [
                'type' => 'string',
                'required' => true,
                'enum' => ['approved', 'rejected'],
            ],
            'reason' => [
                'type' => 'string',
                'required' => false,
                'maxLength' => 4000,
            ],
        ];
    }

    public static function update_status_v1(): array
    {
        return [
            'status' => [
                'type' => 'string',
                'required' => true,
                // MVP : on reste sur quelques statuts clairs.
                'enum' => ['pending', 'in_review', 'needs_info'],
            ],
        ];
    }

    public static function update_pricing_v1(): array
    {
        return [
            'standard_cents' => [
                'type' => 'integer',
                'required' => false,
                'minimum' => 0,
                'maximum' => 500000, // 5000.00€
            ],
            'express_cents' => [
                'type' => 'integer',
                'required' => false,
                'minimum' => 0,
                'maximum' => 500000,
            ],
            'standard_eur' => [
                'type' => 'number',
                'required' => false,
                'minimum' => 0,
                'maximum' => 5000,
            ],
            'express_eur' => [
                'type' => 'number',
                'required' => false,
                'minimum' => 0,
                'maximum' => 5000,
            ],
            'currency' => [
                'type' => 'string',
                'required' => false,
                'minLength' => 3,
                'maxLength' => 3,
            ],
        ];
    }

    /**
     * Accepte les tableaux optionnels d'IDs worker sans rejeter la requête si des
     * valeurs nulles / vides se glissent depuis le front. Le nettoyage final est
     * réalisé par sanitize_optional_string_id_array().
     *
     * @param mixed $value
     */
    public static function validate_optional_string_id_array($value, \WP_REST_Request $request, string $param): bool
    {
        if ($value === null || $value === '') {
            return true;
        }

        if (!is_array($value)) {
            return false;
        }

        return count($value) <= 10;
    }

    /**
     * @param mixed $value
     * @return array<int, string>
     */
    public static function sanitize_optional_string_id_array($value): array
    {
        if (!is_array($value)) {
            return [];
        }

        $out = [];
        foreach ($value as $raw) {
            if ($raw === null) {
                continue;
            }

            if (!is_scalar($raw)) {
                continue;
            }

            $id = trim((string) $raw);
            if ($id === '') {
                continue;
            }

            if (strlen($id) < 8 || strlen($id) > 64) {
                continue;
            }

            $out[] = $id;
            if (count($out) >= 10) {
                break;
            }
        }

        return array_values(array_unique($out));
    }
}
