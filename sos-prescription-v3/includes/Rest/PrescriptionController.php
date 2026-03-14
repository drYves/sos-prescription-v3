<?php
// includes/Rest/PrescriptionController.php

namespace SOSPrescription\Rest;

use SOSPrescription\Repositories\JobRepository;
use SOSPrescription\Services\RxPdfGenerator;

defined('ABSPATH') || exit;

class PrescriptionController extends \WP_REST_Controller
{
    /** @var \wpdb */
    protected $wpdb;

    /** @var JobRepository */
    protected $jobs;

    /** @var RxPdfGenerator */
    protected $rx_pdf_generator;

    /** @var string */
    protected $namespace = 'sosprescription/v1';

    /** @var string */
    protected $rest_base = 'prescriptions';

    /** @var array<string, array<string, string>> */
    protected $column_cache = array();

    public function __construct($rx_pdf_generator = null, $jobs = null, $wpdb = null)
    {
        if ($wpdb instanceof \wpdb) {
            $this->wpdb = $wpdb;
        } else {
            global $wpdb;
            $this->wpdb = $wpdb;
        }

        $this->jobs             = $jobs instanceof JobRepository ? $jobs : new JobRepository($this->wpdb);
        $this->rx_pdf_generator = $rx_pdf_generator instanceof RxPdfGenerator
            ? $rx_pdf_generator
            : new RxPdfGenerator($this->jobs, $this->wpdb);
    }

    public function register_routes()
    {
        \register_rest_route(
            $this->namespace,
            '/' . $this->rest_base,
            array(
                array(
                    'methods'             => \WP_REST_Server::READABLE,
                    'callback'            => array($this, 'get_items'),
                    'permission_callback' => array($this, 'permissions_read'),
                    'args'                => $this->get_collection_params(),
                ),
                array(
                    'methods'             => \WP_REST_Server::CREATABLE,
                    'callback'            => array($this, 'create_item'),
                    'permission_callback' => array($this, 'permissions_write'),
                ),
            )
        );

        \register_rest_route(
            $this->namespace,
            '/' . $this->rest_base . '/(?P<id>\d+)',
            array(
                array(
                    'methods'             => \WP_REST_Server::READABLE,
                    'callback'            => array($this, 'get_item'),
                    'permission_callback' => array($this, 'permissions_read'),
                ),
                array(
                    'methods'             => \WP_REST_Server::EDITABLE,
                    'callback'            => array($this, 'update_item'),
                    'permission_callback' => array($this, 'permissions_write'),
                ),
            )
        );

        \register_rest_route(
            $this->namespace,
            '/' . $this->rest_base . '/(?P<id>\d+)/decision',
            array(
                array(
                    'methods'             => \WP_REST_Server::CREATABLE,
                    'callback'            => array($this, 'decide'),
                    'permission_callback' => array($this, 'permissions_write'),
                ),
            )
        );

        \register_rest_route(
            $this->namespace,
            '/' . $this->rest_base . '/(?P<id>\d+)/rx-pdf',
            array(
                array(
                    'methods'             => \WP_REST_Server::READABLE,
                    'callback'            => array($this, 'get_rx_pdf'),
                    'permission_callback' => array($this, 'permissions_read'),
                ),
                array(
                    'methods'             => \WP_REST_Server::CREATABLE,
                    'callback'            => array($this, 'generate_rx_pdf'),
                    'permission_callback' => array($this, 'permissions_write'),
                ),
            )
        );

        \register_rest_route(
            $this->namespace,
            '/' . $this->rest_base . '/(?P<id>\d+)/pdf-status',
            array(
                array(
                    'methods'             => \WP_REST_Server::READABLE,
                    'callback'            => array($this, 'get_pdf_status'),
                    'permission_callback' => array($this, 'permissions_read'),
                ),
            )
        );
    }

    public function permissions_read()
    {
        $capability = (string) \apply_filters('sosprescription_rest_read_capability', 'read');

        if (\current_user_can($capability)) {
            return true;
        }

        return new \WP_Error(
            'rest_forbidden',
            'Vous n’avez pas l’autorisation de consulter les prescriptions.',
            array('status' => \rest_authorization_required_code())
        );
    }

    public function permissions_write()
    {
        $capability = (string) \apply_filters('sosprescription_rest_write_capability', 'edit_posts');

        if (\current_user_can($capability)) {
            return true;
        }

        return new \WP_Error(
            'rest_forbidden',
            'Vous n’avez pas l’autorisation de modifier les prescriptions.',
            array('status' => \rest_authorization_required_code())
        );
    }

    public function get_collection_params()
    {
        return array(
            'page' => array(
                'description'       => 'Page courante.',
                'type'              => 'integer',
                'default'           => 1,
                'sanitize_callback' => 'absint',
            ),
            'per_page' => array(
                'description'       => 'Nombre d’éléments par page.',
                'type'              => 'integer',
                'default'           => 20,
                'sanitize_callback' => 'absint',
            ),
            'status' => array(
                'description'       => 'Filtre sur le statut.',
                'type'              => 'string',
                'sanitize_callback' => 'sanitize_text_field',
            ),
            'search' => array(
                'description'       => 'Recherche libre.',
                'type'              => 'string',
                'sanitize_callback' => 'sanitize_text_field',
            ),
            'with_items' => array(
                'description'       => 'Inclure les lignes de prescription.',
                'type'              => 'boolean',
                'default'           => false,
                'sanitize_callback' => array($this, 'sanitize_boolean'),
            ),
        );
    }

    public function get_items($request)
    {
        $table = $this->get_prescriptions_table();
        if ($table === '') {
            return new \WP_Error(
                'sosprescription_prescriptions_table_missing',
                'La table des prescriptions est introuvable.',
                array('status' => 500)
            );
        }

        $columns     = array_keys($this->get_table_columns($table));
        $page        = max(1, (int) $request->get_param('page'));
        $per_page    = max(1, min(100, (int) $request->get_param('per_page')));
        $status      = (string) $request->get_param('status');
        $search      = (string) $request->get_param('search');
        $with_items  = $this->truthy($request->get_param('with_items'));
        $where_parts = array('1=1');
        $args        = array();

        $status_col = $this->first_existing_column($columns, array('status', 'state', 'rx_status'));
        if ($status !== '' && $status_col !== '') {
            $where_parts[] = "`{$status_col}` = %s";
            $args[]        = $status;
        }

        if ($search !== '') {
            $search_cols = array_filter(array(
                $this->first_existing_column($columns, array('rx_uid', 'uid', 'reference', 'code')),
                $this->first_existing_column($columns, array('patient_fullname', 'patient_name')),
            ));

            if (!empty($search_cols)) {
                $like_parts = array();
                $needle     = '%' . $this->wpdb->esc_like($search) . '%';

                foreach ($search_cols as $search_col) {
                    $like_parts[] = "`{$search_col}` LIKE %s";
                    $args[]       = $needle;
                }

                $where_parts[] = '(' . implode(' OR ', $like_parts) . ')';
            }
        }

        $where_sql = implode(' AND ', $where_parts);
        $order_col = $this->first_existing_column($columns, array('updated_at', 'created_at', 'id'));
        if ($order_col === '') {
            $order_col = 'id';
        }

        $count_sql = "SELECT COUNT(*) FROM `{$table}` WHERE {$where_sql}";
        $total     = (int) $this->wpdb->get_var($this->prepare_query($count_sql, $args));
        $offset    = ($page - 1) * $per_page;

        $rows_sql = "SELECT * FROM `{$table}` WHERE {$where_sql} ORDER BY `{$order_col}` DESC LIMIT %d OFFSET %d";
        $rows     = $this->wpdb->get_results($this->prepare_query($rows_sql, array_merge($args, array($per_page, $offset))), ARRAY_A);

        $data = array();
        foreach ((array) $rows as $row) {
            $data[] = $this->prepare_item_array($row, $with_items);
        }

        $response = new \WP_REST_Response($data, 200);
        $response->header('X-WP-Total', (string) $total);
        $response->header('X-WP-TotalPages', (string) max(1, (int) ceil($total / $per_page)));

        return $response;
    }

    public function get_item($request)
    {
        $prescription_id = (int) $request['id'];
        $row             = $this->fetch_prescription_row($prescription_id);

        if (empty($row)) {
            return new \WP_Error(
                'sosprescription_prescription_not_found',
                'Prescription introuvable.',
                array('status' => 404)
            );
        }

        return new \WP_REST_Response($this->prepare_item_array($row, true), 200);
    }

    public function create_item($request)
    {
        $table = $this->get_prescriptions_table();
        if ($table === '') {
            return new \WP_Error(
                'sosprescription_prescriptions_table_missing',
                'La table des prescriptions est introuvable.',
                array('status' => 500)
            );
        }

        $body    = $this->get_request_body($request);
        $columns = array_keys($this->get_table_columns($table));
        $data    = $this->build_prescription_row_data($body, $columns, $table, false);

        if (empty($data)) {
            return new \WP_Error(
                'sosprescription_empty_payload',
                'Aucune donnée exploitable à enregistrer.',
                array('status' => 400)
            );
        }

        $inserted = $this->wpdb->insert($table, $data, $this->build_formats($table, $data));
        if ($inserted === false) {
            return new \WP_Error(
                'sosprescription_insert_failed',
                $this->wpdb->last_error !== '' ? $this->wpdb->last_error : 'Échec de création de la prescription.',
                array('status' => 500)
            );
        }

        $prescription_id = (int) $this->wpdb->insert_id;
        $items           = $this->extract_items_payload($body);

        if (!empty($items)) {
            $this->sync_items($prescription_id, $items);
        }

        $row    = $this->fetch_prescription_row($prescription_id);
        $req_id = $this->build_req_id();

        $dispatch = $this->rx_pdf_generator->generate(
            $prescription_id,
            array(
                'source' => 'rest_create',
                'req_id' => $req_id,
            )
        );

        if (\is_wp_error($dispatch)) {
            return new \WP_REST_Response(
                array(
                    'id'           => $prescription_id,
                    'req_id'       => $req_id,
                    'prescription' => $this->prepare_item_array($row, true),
                    'pdf'          => $this->build_degraded_pdf_state($dispatch, $req_id),
                    'message'      => 'Prescription créée. PDF en attente de reprise.',
                ),
                202
            );
        }

        return new \WP_REST_Response(
            array(
                'id'           => $prescription_id,
                'req_id'       => $req_id,
                'prescription' => $this->prepare_item_array($row, true),
                'verification' => isset($dispatch['verification']) ? $dispatch['verification'] : array(),
                'dispatch'     => isset($dispatch['dispatch']) ? $dispatch['dispatch'] : array(),
                'pdf'          => isset($dispatch['pdf']) ? $dispatch['pdf'] : array('status' => 'pending'),
                'message'      => 'Prescription créée. PDF en cours de génération.',
            ),
            202
        );
    }

    public function update_item($request)
    {
        $prescription_id = (int) $request['id'];
        $table           = $this->get_prescriptions_table();

        if ($table === '') {
            return new \WP_Error(
                'sosprescription_prescriptions_table_missing',
                'La table des prescriptions est introuvable.',
                array('status' => 500)
            );
        }

        $existing = $this->fetch_prescription_row($prescription_id);
        if (empty($existing)) {
            return new \WP_Error(
                'sosprescription_prescription_not_found',
                'Prescription introuvable.',
                array('status' => 404)
            );
        }

        $body    = $this->get_request_body($request);
        $columns = array_keys($this->get_table_columns($table));
        $data    = $this->build_prescription_row_data($body, $columns, $table, true);

        if (!empty($data)) {
            $updated = $this->wpdb->update(
                $table,
                $data,
                array('id' => $prescription_id),
                $this->build_formats($table, $data),
                array('%d')
            );

            if ($updated === false) {
                return new \WP_Error(
                    'sosprescription_update_failed',
                    $this->wpdb->last_error !== '' ? $this->wpdb->last_error : 'Échec de mise à jour de la prescription.',
                    array('status' => 500)
                );
            }
        }

        if (array_key_exists('items', $body) || array_key_exists('medications', $body)) {
            $this->sync_items($prescription_id, $this->extract_items_payload($body));
        }

        $row = $this->fetch_prescription_row($prescription_id);

        return new \WP_REST_Response($this->prepare_item_array($row, true), 200);
    }

    public function decide($request)
    {
        $prescription_id = (int) $request['id'];
        $row             = $this->fetch_prescription_row($prescription_id);

        if (empty($row)) {
            return new \WP_Error(
                'sosprescription_prescription_not_found',
                'Prescription introuvable.',
                array('status' => 404)
            );
        }

        $body     = $this->get_request_body($request);
        $decision = isset($body['decision']) ? (string) $body['decision'] : (string) $request->get_param('decision');
        $decision = strtolower(trim($decision));

        if (!in_array($decision, array('approved', 'rejected'), true)) {
            return new \WP_Error(
                'sosprescription_invalid_decision',
                'La décision doit être "approved" ou "rejected".',
                array('status' => 400)
            );
        }

        $table   = $this->get_prescriptions_table();
        $columns = array_keys($this->get_table_columns($table));
        $updates = $this->build_decision_updates($decision, $body, $columns);

        if (!empty($updates)) {
            $updated = $this->wpdb->update(
                $table,
                $updates,
                array('id' => $prescription_id),
                $this->build_formats($table, $updates),
                array('%d')
            );

            if ($updated === false) {
                return new \WP_Error(
                    'sosprescription_decision_update_failed',
                    $this->wpdb->last_error !== '' ? $this->wpdb->last_error : 'Échec de mise à jour de la décision.',
                    array('status' => 500)
                );
            }
        }

        $row    = $this->fetch_prescription_row($prescription_id);
        $req_id = $this->build_req_id();

        if ($decision === 'approved') {
            $dispatch = $this->rx_pdf_generator->generate(
                $prescription_id,
                array(
                    'source' => 'doctor_approval',
                    'req_id' => $req_id,
                )
            );

            if (\is_wp_error($dispatch)) {
                return new \WP_REST_Response(
                    array(
                        'id'           => $prescription_id,
                        'decision'     => $decision,
                        'req_id'       => $req_id,
                        'prescription' => $this->prepare_item_array($row, true),
                        'pdf'          => $this->build_degraded_pdf_state($dispatch, $req_id),
                        'message'      => 'Validation enregistrée. PDF temporairement indisponible.',
                    ),
                    202
                );
            }

            $pdf_state = isset($dispatch['pdf']) ? $dispatch['pdf'] : array('status' => 'pending');

            return new \WP_REST_Response(
                array(
                    'id'           => $prescription_id,
                    'decision'     => $decision,
                    'req_id'       => $req_id,
                    'prescription' => $this->prepare_item_array($row, true),
                    'verification' => isset($dispatch['verification']) ? $dispatch['verification'] : array(),
                    'dispatch'     => isset($dispatch['dispatch']) ? $dispatch['dispatch'] : array(),
                    'pdf'          => $pdf_state,
                    'message'      => $this->message_for_pdf_state($pdf_state),
                ),
                $pdf_state['status'] === 'done' ? 200 : 202
            );
        }

        return new \WP_REST_Response(
            array(
                'id'           => $prescription_id,
                'decision'     => $decision,
                'req_id'       => $req_id,
                'prescription' => $this->prepare_item_array($row, true),
                'pdf'          => $this->jobs->get_public_state_for_rx_id($prescription_id),
            ),
            200
        );
    }

    public function generate_rx_pdf($request)
    {
        $prescription_id = (int) $request['id'];
        $req_id          = $this->build_req_id();

        $dispatch = $this->rx_pdf_generator->generate(
            $prescription_id,
            array(
                'source' => 'manual_dispatch',
                'req_id' => $req_id,
            )
        );

        if (\is_wp_error($dispatch)) {
            return new \WP_REST_Response(
                array(
                    'ok'              => false,
                    'mode'            => 'stateless',
                    'req_id'          => $req_id,
                    'prescription_id' => $prescription_id,
                    'pdf'             => $this->build_degraded_pdf_state($dispatch, $req_id),
                    'message'         => 'Le PDF n’a pas pu être mis en file immédiatement.',
                ),
                202
            );
        }

        $status_code = (isset($dispatch['pdf']['status']) && $dispatch['pdf']['status'] === 'done') ? 200 : 202;

        return new \WP_REST_Response($dispatch, $status_code);
    }

    public function get_pdf_status($request)
    {
        $prescription_id = (int) $request['id'];

        return new \WP_REST_Response(
            array(
                'prescription_id' => $prescription_id,
                'pdf'             => $this->jobs->get_public_state_for_rx_id($prescription_id),
            ),
            200
        );
    }

    public function get_rx_pdf($request)
    {
        $prescription_id = (int) $request['id'];
        $done_job        = $this->jobs->get_latest_done_by_rx_id($prescription_id);

        if (!empty($done_job)) {
            $download_url = $this->build_presigned_s3_url_from_job($done_job, 60);

            if (\is_wp_error($download_url)) {
                return $download_url;
            }

            return new \WP_REST_Response(
                array(
                    'prescription_id' => $prescription_id,
                    'pdf'             => $this->jobs->public_projection($done_job),
                    'download_url'    => $download_url,
                    'expires_in'      => 60,
                ),
                200
            );
        }

        $auto_dispatch = true;
        if ($request->offsetExists('dispatch')) {
            $auto_dispatch = $this->truthy($request->get_param('dispatch'));
        }

        if ($auto_dispatch) {
            $dispatch = $this->rx_pdf_generator->generate(
                $prescription_id,
                array(
                    'source' => 'download_probe',
                    'req_id' => $this->build_req_id(),
                )
            );

            if (\is_wp_error($dispatch)) {
                return new \WP_REST_Response(
                    array(
                        'prescription_id' => $prescription_id,
                        'pdf'             => $this->build_degraded_pdf_state($dispatch, $this->build_req_id()),
                        'message'         => 'PDF temporairement indisponible.',
                    ),
                    202
                );
            }

            return new \WP_REST_Response(
                array(
                    'prescription_id' => $prescription_id,
                    'pdf'             => $dispatch['pdf'],
                    'dispatch'        => $dispatch['dispatch'],
                    'message'         => 'PDF en cours de génération.',
                ),
                202
            );
        }

        return new \WP_REST_Response(
            array(
                'prescription_id' => $prescription_id,
                'pdf'             => $this->jobs->get_public_state_for_rx_id($prescription_id),
                'message'         => 'PDF en cours de génération.',
            ),
            202
        );
    }

    protected function get_prescriptions_table()
    {
        $candidates = array(
            $this->wpdb->prefix . 'sosprescription_prescriptions',
            $this->wpdb->prefix . 'sosprescription_prescription',
            $this->wpdb->prefix . 'sosprescription_rx',
        );

        foreach ($candidates as $table) {
            if ($this->table_exists($table)) {
                return $table;
            }
        }

        return '';
    }

    protected function get_items_table()
    {
        $candidates = array(
            $this->wpdb->prefix . 'sosprescription_prescription_items',
            $this->wpdb->prefix . 'sosprescription_items',
            $this->wpdb->prefix . 'sosprescription_medications',
            $this->wpdb->prefix . 'sosprescription_prescription_lines',
        );

        foreach ($candidates as $table) {
            if ($this->table_exists($table)) {
                $columns = array_keys($this->get_table_columns($table));
                if ($this->first_existing_column($columns, array('prescription_id', 'rx_id')) !== '') {
                    return $table;
                }
            }
        }

        return '';
    }

    protected function fetch_prescription_row($prescription_id)
    {
        $table = $this->get_prescriptions_table();

        if ($table === '') {
            return null;
        }

        $sql = $this->wpdb->prepare(
            "SELECT * FROM `{$table}` WHERE `id` = %d LIMIT 1",
            (int) $prescription_id
        );

        $row = $this->wpdb->get_row($sql, ARRAY_A);

        return $row ? $this->decode_jsonish_row($row) : null;
    }

    protected function fetch_items_for_prescription($prescription_id)
    {
        $table = $this->get_items_table();
        if ($table === '') {
            return array();
        }

        $columns = array_keys($this->get_table_columns($table));
        $fk_col  = $this->first_existing_column($columns, array('prescription_id', 'rx_id'));
        if ($fk_col === '') {
            return array();
        }

        $order_col = $this->first_existing_column($columns, array('line_no', 'position', 'sort_order', 'id'));
        $order_sql = $order_col !== '' ? " ORDER BY `{$order_col}` ASC, `id` ASC" : '';

        $sql = $this->wpdb->prepare(
            "SELECT * FROM `{$table}` WHERE `{$fk_col}` = %d{$order_sql}",
            (int) $prescription_id
        );

        $rows   = $this->wpdb->get_results($sql, ARRAY_A);
        $result = array();

        foreach ((array) $rows as $row) {
            $result[] = $this->decode_jsonish_row($row);
        }

        return $result;
    }

    protected function prepare_item_array(array $row, $include_items = true)
    {
        $row = $this->decode_jsonish_row($row);

        if (isset($row['id'])) {
            $row['id'] = (int) $row['id'];
        }

        if ($include_items && !empty($row['id'])) {
            $row['items'] = $this->fetch_items_for_prescription((int) $row['id']);
        }

        if (!empty($row['id'])) {
            $row['pdf'] = $this->jobs->get_public_state_for_rx_id((int) $row['id']);
        }

        return $row;
    }

    protected function build_prescription_row_data(array $body, array $columns, $table, $is_update)
    {
        $body = $this->normalize_request_body($body);

        $data    = array();
        $blocked = array('id');

        foreach ($body as $key => $value) {
            if (in_array($key, $blocked, true)) {
                continue;
            }

            if (!in_array($key, $columns, true)) {
                continue;
            }

            $data[$key] = $this->prepare_db_value($table, $key, $value);
        }

        if (!$is_update) {
            $status_col = $this->first_existing_column($columns, array('status', 'state', 'rx_status'));
            if ($status_col !== '' && !isset($data[$status_col])) {
                $data[$status_col] = 'draft';
            }
        }

        $created_at_col = $this->first_existing_column($columns, array('created_at'));
        $updated_at_col = $this->first_existing_column($columns, array('updated_at'));

        if (!$is_update && $created_at_col !== '' && !isset($data[$created_at_col])) {
            $data[$created_at_col] = gmdate('Y-m-d H:i:s');
        }

        if ($updated_at_col !== '') {
            $data[$updated_at_col] = gmdate('Y-m-d H:i:s');
        }

        return $data;
    }

    protected function build_decision_updates($decision, array $body, array $columns)
    {
        $now     = gmdate('Y-m-d H:i:s');
        $user_id = max(0, (int) \get_current_user_id());
        $updates = array();

        $status_col = $this->first_existing_column($columns, array('status', 'state', 'rx_status'));
        if ($status_col !== '') {
            $updates[$status_col] = $decision;
        }

        $decision_col = $this->first_existing_column($columns, array('decision', 'approval_decision', 'validation_decision'));
        if ($decision_col !== '' && !isset($updates[$decision_col])) {
            $updates[$decision_col] = $decision;
        }

        if ($decision === 'approved') {
            $at_col = $this->first_existing_column($columns, array('approved_at', 'validated_at', 'decision_at'));
            $by_col = $this->first_existing_column($columns, array('approved_by', 'validated_by', 'decision_by'));
        } else {
            $at_col = $this->first_existing_column($columns, array('rejected_at', 'decision_at'));
            $by_col = $this->first_existing_column($columns, array('rejected_by', 'decision_by'));
        }

        if ($at_col !== '') {
            $updates[$at_col] = $now;
        }

        if ($by_col !== '') {
            $updates[$by_col] = $user_id;
        }

        $note = '';
        foreach (array('note', 'reason', 'comment', 'decision_note') as $candidate) {
            if (!empty($body[$candidate]) && is_scalar($body[$candidate])) {
                $note = (string) $body[$candidate];
                break;
            }
        }

        if ($note !== '') {
            $note_col = $this->first_existing_column($columns, array('decision_note', 'decision_reason', 'note'));
            if ($note_col !== '') {
                $updates[$note_col] = $note;
            }
        }

        $updated_at_col = $this->first_existing_column($columns, array('updated_at'));
        if ($updated_at_col !== '') {
            $updates[$updated_at_col] = $now;
        }

        return $updates;
    }

    protected function sync_items($prescription_id, array $items)
    {
        $table = $this->get_items_table();
        if ($table === '') {
            return;
        }

        $columns = array_keys($this->get_table_columns($table));
        $fk_col  = $this->first_existing_column($columns, array('prescription_id', 'rx_id'));
        if ($fk_col === '') {
            return;
        }

        $this->wpdb->delete($table, array($fk_col => (int) $prescription_id), array('%d'));

        $created_at_col = $this->first_existing_column($columns, array('created_at'));
        $updated_at_col = $this->first_existing_column($columns, array('updated_at'));
        $line_no_col    = $this->first_existing_column($columns, array('line_no', 'position', 'sort_order'));
        $raw_col        = $this->first_existing_column($columns, array('raw', 'payload', 'data'));

        foreach ($items as $index => $item) {
            if (!is_array($item)) {
                continue;
            }

            $row             = $this->normalize_item_payload($item);
            $insert          = array();
            $insert[$fk_col] = (int) $prescription_id;

            if ($line_no_col !== '') {
                $insert[$line_no_col] = isset($row[$line_no_col]) ? (int) $row[$line_no_col] : ($index + 1);
            }

            foreach ($row as $key => $value) {
                if (!in_array($key, $columns, true)) {
                    continue;
                }

                if (in_array($key, array('id', $fk_col, $line_no_col), true)) {
                    continue;
                }

                $insert[$key] = $this->prepare_db_value($table, $key, $value);
            }

            if ($raw_col !== '' && !isset($insert[$raw_col])) {
                $insert[$raw_col] = \wp_json_encode($item, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            }

            if ($created_at_col !== '') {
                $insert[$created_at_col] = gmdate('Y-m-d H:i:s');
            }

            if ($updated_at_col !== '') {
                $insert[$updated_at_col] = gmdate('Y-m-d H:i:s');
            }

            $this->wpdb->insert($table, $insert, $this->build_formats($table, $insert));
        }
    }

    protected function normalize_request_body(array $body)
    {
        if (isset($body['prescription']) && is_array($body['prescription'])) {
            $body = array_merge($body, $body['prescription']);
        }

        if (!isset($body['items']) && isset($body['medications']) && is_array($body['medications'])) {
            $body['items'] = $body['medications'];
        }

        if (isset($body['patient']) && is_array($body['patient'])) {
            $patient = $body['patient'];

            if (!isset($body['patient_fullname']) && !empty($patient['fullname'])) {
                $body['patient_fullname'] = $patient['fullname'];
            }
            if (!isset($body['patient_name']) && !empty($patient['fullname'])) {
                $body['patient_name'] = $patient['fullname'];
            }
            if (!isset($body['patient_birthdate']) && !empty($patient['birthdate'])) {
                $body['patient_birthdate'] = $patient['birthdate'];
            }
            if (!isset($body['patient_birthdate_precision']) && !empty($patient['birthdate_precision'])) {
                $body['patient_birthdate_precision'] = $patient['birthdate_precision'];
            }
            if (!isset($body['patient_note']) && !empty($patient['note'])) {
                $body['patient_note'] = $patient['note'];
            }
        }

        if (!isset($body['rx_uid']) && !empty($body['uid'])) {
            $body['rx_uid'] = $body['uid'];
        }

        return $body;
    }

    protected function normalize_item_payload(array $item)
    {
        if (!isset($item['denomination']) && !empty($item['label'])) {
            $item['denomination'] = $item['label'];
        }

        if (!isset($item['posologie']) && !empty($item['dosage'])) {
            $item['posologie'] = $item['dosage'];
        }

        if (!isset($item['quantite']) && !empty($item['quantity'])) {
            $item['quantite'] = $item['quantity'];
        }

        return $item;
    }

    protected function extract_items_payload(array $body)
    {
        if (!empty($body['items']) && is_array($body['items'])) {
            return $body['items'];
        }

        if (!empty($body['medications']) && is_array($body['medications'])) {
            return $body['medications'];
        }

        return array();
    }

    protected function get_request_body($request)
    {
        $body = $request->get_json_params();
        if (empty($body)) {
            $body = $request->get_body_params();
        }
        if (empty($body)) {
            $body = $request->get_params();
        }

        return is_array($body) ? $body : array();
    }

    protected function build_formats($table, array $data)
    {
        $formats = array();

        foreach ($data as $column => $value) {
            $formats[] = $this->guess_format($table, $column);
        }

        return $formats;
    }

    protected function guess_format($table, $column)
    {
        $type = $this->get_column_type($table, $column);

        if (preg_match('/(bigint|int|tinyint|smallint|mediumint)/', $type)) {
            return '%d';
        }

        return '%s';
    }

    protected function prepare_db_value($table, $column, $value)
    {
        $type = $this->get_column_type($table, $column);

        if (is_array($value) || is_object($value)) {
            return \wp_json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        }

        if ($value === null) {
            if (preg_match('/(bigint|int|tinyint|smallint|mediumint)/', $type)) {
                return 0;
            }

            return '';
        }

        if (is_bool($value)) {
            if (preg_match('/(bigint|int|tinyint|smallint|mediumint)/', $type)) {
                return $value ? 1 : 0;
            }

            return $value ? '1' : '0';
        }

        if (preg_match('/(bigint|int|tinyint|smallint|mediumint)/', $type)) {
            return (int) $value;
        }

        if (preg_match('/(decimal|float|double)/', $type)) {
            return (string) $value;
        }

        $value = (string) $value;

        if (preg_match('/text/', $type)) {
            return \sanitize_textarea_field($value);
        }

        return \sanitize_text_field($value);
    }

    protected function get_column_type($table, $column)
    {
        $columns = $this->get_table_columns($table);

        return isset($columns[$column]) ? $columns[$column] : 'text';
    }

    protected function get_table_columns($table)
    {
        if (isset($this->column_cache[$table])) {
            return $this->column_cache[$table];
        }

        $columns = array();
        $rows    = $this->wpdb->get_results("SHOW FULL COLUMNS FROM `{$table}`", ARRAY_A);

        foreach ((array) $rows as $row) {
            if (!empty($row['Field'])) {
                $columns[$row['Field']] = !empty($row['Type']) ? strtolower((string) $row['Type']) : 'text';
            }
        }

        $this->column_cache[$table] = $columns;

        return $columns;
    }

    protected function first_existing_column(array $columns, array $candidates)
    {
        foreach ($candidates as $candidate) {
            if (in_array($candidate, $columns, true)) {
                return $candidate;
            }
        }

        return '';
    }

    protected function table_exists($table)
    {
        $sql = $this->wpdb->prepare('SHOW TABLES LIKE %s', $table);

        return (string) $this->wpdb->get_var($sql) === (string) $table;
    }

    protected function decode_jsonish_row(array $row)
    {
        foreach ($row as $key => $value) {
            if (is_string($value)) {
                $trimmed = trim($value);
                if ($trimmed !== '' && (($trimmed[0] === '{' && substr($trimmed, -1) === '}') || ($trimmed[0] === '[' && substr($trimmed, -1) === ']'))) {
                    $decoded = json_decode($trimmed, true);
                    if (json_last_error() === JSON_ERROR_NONE) {
                        $row[$key] = $decoded;
                    }
                }
            }
        }

        return $row;
    }

    protected function prepare_query($sql, array $args = array())
    {
        if (empty($args)) {
            return $sql;
        }

        return $this->wpdb->prepare($sql, $args);
    }

    protected function build_req_id()
    {
        try {
            return 'req_' . bin2hex(random_bytes(8));
        } catch (\Exception $e) {
            return 'req_' . md5((string) \wp_rand() . microtime(true));
        }
    }

    protected function build_degraded_pdf_state($error, $req_id)
    {
        return array(
            'status'       => 'degraded',
            'job_id'       => 0,
            'req_id'       => (string) $req_id,
            'can_download' => false,
            's3_ready'     => false,
            'error'        => array(
                'code'    => $error instanceof \WP_Error ? $error->get_error_code() : 'unknown_error',
                'message' => $error instanceof \WP_Error ? $error->get_error_message() : 'Erreur inconnue',
            ),
        );
    }

    protected function message_for_pdf_state(array $pdf_state)
    {
        $status = isset($pdf_state['status']) ? (string) $pdf_state['status'] : 'pending';

        if ($status === 'done') {
            return 'Validation enregistrée. PDF disponible.';
        }

        if ($status === 'failed') {
            return 'Validation enregistrée. Le PDF est indisponible pour le moment.';
        }

        if ($status === 'degraded') {
            return 'Validation enregistrée. Service PDF ralenti ; le document sera disponible sous peu.';
        }

        return 'Validation enregistrée. PDF en cours de génération.';
    }

    protected function sanitize_boolean($value)
    {
        return $this->truthy($value);
    }

    protected function truthy($value)
    {
        if (is_bool($value)) {
            return $value;
        }

        if (is_numeric($value)) {
            return (int) $value === 1;
        }

        $value = strtolower(trim((string) $value));

        return in_array($value, array('1', 'true', 'yes', 'y', 'on'), true);
    }

    protected function build_presigned_s3_url_from_job(array $job, $ttl = 60)
    {
        $ttl = max(1, min(604800, (int) $ttl));

        $filtered = \apply_filters('sosprescription_presign_s3_url', null, $job, $ttl);
        if (is_string($filtered) && $filtered !== '') {
            return $filtered;
        }

        $key      = !empty($job['s3_key_ref']) ? (string) $job['s3_key_ref'] : '';
        $bucket   = !empty($job['s3_bucket']) ? (string) $job['s3_bucket'] : $this->get_env_or_constant('SOSPRESCRIPTION_S3_BUCKET');
        $region   = !empty($job['s3_region']) ? (string) $job['s3_region'] : $this->get_env_or_constant('SOSPRESCRIPTION_S3_REGION', $this->get_env_or_constant('AWS_REGION'));
        $endpoint = $this->get_env_or_constant('SOSPRESCRIPTION_S3_ENDPOINT', $this->get_env_or_constant('AWS_ENDPOINT_URL_S3'));

        if ($key === '' || $bucket === '' || $region === '') {
            return new \WP_Error(
                'sosprescription_s3_config_missing',
                'Configuration S3 incomplète pour la présignature.',
                array('status' => 500)
            );
        }

        $credentials = $this->resolve_s3_credentials();
        if (\is_wp_error($credentials)) {
            return $credentials;
        }

        $amz_date = gmdate('Ymd\THis\Z');
        $date     = gmdate('Ymd');
        $scope    = $date . '/' . $region . '/s3/aws4_request';

        $use_path_style = ($endpoint !== '' || strpos($bucket, '.') !== false);

        if ($endpoint !== '') {
            $parsed    = wp_parse_url($endpoint);
            $scheme    = !empty($parsed['scheme']) ? $parsed['scheme'] : 'https';
            $host      = !empty($parsed['host']) ? $parsed['host'] : '';
            $base_path = !empty($parsed['path']) ? rtrim($parsed['path'], '/') : '';

            if ($host === '') {
                return new \WP_Error(
                    'sosprescription_s3_endpoint_invalid',
                    'Endpoint S3 invalide.',
                    array('status' => 500)
                );
            }

            $canonical_uri = $base_path . '/' . $this->aws_uri_encode($bucket) . '/' . $this->aws_uri_encode_path($key);
            $url_base      = $scheme . '://' . $host;
        } elseif ($use_path_style) {
            $host          = 's3.' . $region . '.amazonaws.com';
            $canonical_uri = '/' . $this->aws_uri_encode($bucket) . '/' . $this->aws_uri_encode_path($key);
            $url_base      = 'https://' . $host;
        } else {
            $host          = $bucket . '.s3.' . $region . '.amazonaws.com';
            $canonical_uri = '/' . $this->aws_uri_encode_path($key);
            $url_base      = 'https://' . $host;
        }

        $query = array(
            'X-Amz-Algorithm'     => 'AWS4-HMAC-SHA256',
            'X-Amz-Credential'    => $credentials['access_key'] . '/' . $scope,
            'X-Amz-Date'          => $amz_date,
            'X-Amz-Expires'       => (string) $ttl,
            'X-Amz-SignedHeaders' => 'host',
        );

        if (!empty($credentials['session_token'])) {
            $query['X-Amz-Security-Token'] = $credentials['session_token'];
        }

        $canonical_query   = $this->aws_build_query($query);
        $canonical_headers = 'host:' . $host . "\n";
        $signed_headers    = 'host';
        $canonical_request = "GET\n{$canonical_uri}\n{$canonical_query}\n{$canonical_headers}\n{$signed_headers}\nUNSIGNED-PAYLOAD";

        $string_to_sign = "AWS4-HMAC-SHA256\n{$amz_date}\n{$scope}\n" . hash('sha256', $canonical_request);
        $signing_key    = $this->aws_signing_key($credentials['secret_key'], $date, $region, 's3');
        $signature      = hash_hmac('sha256', $string_to_sign, $signing_key);

        return $url_base . $canonical_uri . '?' . $canonical_query . '&X-Amz-Signature=' . $signature;
    }

    protected function resolve_s3_credentials()
    {
        $access_key = $this->get_env_or_constant('SOSPRESCRIPTION_S3_ACCESS_KEY', $this->get_env_or_constant('AWS_ACCESS_KEY_ID'));
        $secret_key = $this->get_env_or_constant('SOSPRESCRIPTION_S3_SECRET_KEY', $this->get_env_or_constant('AWS_SECRET_ACCESS_KEY'));
        $session    = $this->get_env_or_constant('SOSPRESCRIPTION_S3_SESSION_TOKEN', $this->get_env_or_constant('AWS_SESSION_TOKEN'));

        if ($access_key === '' || $secret_key === '') {
            return new \WP_Error(
                'sosprescription_s3_credentials_missing',
                'Identifiants S3 manquants pour la présignature.',
                array('status' => 500)
            );
        }

        return array(
            'access_key'    => $access_key,
            'secret_key'    => $secret_key,
            'session_token' => $session,
        );
    }

    protected function get_env_or_constant($name, $default = '')
    {
        if (defined($name)) {
            $value = constant($name);
            if (is_string($value) && $value !== '') {
                return $value;
            }
        }

        $env = getenv($name);
        if (is_string($env) && $env !== '') {
            return $env;
        }

        return $default;
    }

    protected function aws_signing_key($secret, $date, $region, $service)
    {
        $k_date    = hash_hmac('sha256', $date, 'AWS4' . $secret, true);
        $k_region  = hash_hmac('sha256', $region, $k_date, true);
        $k_service = hash_hmac('sha256', $service, $k_region, true);

        return hash_hmac('sha256', 'aws4_request', $k_service, true);
    }

    protected function aws_build_query(array $params)
    {
        ksort($params);

        $pairs = array();
        foreach ($params as $key => $value) {
            $pairs[] = $this->aws_uri_encode($key) . '=' . $this->aws_uri_encode((string) $value);
        }

        return implode('&', $pairs);
    }

    protected function aws_uri_encode_path($value)
    {
        $segments = explode('/', ltrim((string) $value, '/'));
        $encoded  = array();

        foreach ($segments as $segment) {
            $encoded[] = $this->aws_uri_encode($segment);
        }

        return implode('/', $encoded);
    }

    protected function aws_uri_encode($value)
    {
        return str_replace('%7E', '~', rawurlencode((string) $value));
    }
}
