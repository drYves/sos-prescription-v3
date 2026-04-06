<?php

declare(strict_types=1);

namespace SosPrescription\UI;

use SOSPrescription\UI\ScreenFrame;

defined('ABSPATH') || exit;

final class AuthMagicLinkUi
{
    private static bool $assetsEnqueued = false;

    private function __construct()
    {
    }

    public static function enqueue_assets(): void
    {
        if (self::$assetsEnqueued) {
            return;
        }

        self::$assetsEnqueued = true;

        if (!function_exists('wp_enqueue_script')) {
            return;
        }

        wp_enqueue_script(
            'sosprescription-auth-magic-link',
            SOSPRESCRIPTION_URL . 'assets/auth-magic-link.js',
            [],
            SOSPRESCRIPTION_VERSION,
            true
        );

        $config = [
            'requestLinkEndpoint' => esc_url_raw(rest_url('sosprescription/v4/auth/request-link')),
            'verifyLinkEndpoint' => esc_url_raw(rest_url('sosprescription/v4/auth/verify-link')),
            'redirects' => [
                'patient' => esc_url_raw(home_url('/espace-patient/')),
                'doctor' => esc_url_raw(home_url('/compte-medecin/')),
                'default' => esc_url_raw(home_url('/')),
            ],
            'strings' => [
                'requestIdleTitle' => 'Recevez un lien de connexion sécurisé par e-mail.',
                'requestSendingTitle' => 'Envoi en cours…',
                'requestSendingBody' => 'Nous préparons votre lien de connexion sécurisé.',
                'requestSuccessTitle' => 'Lien de connexion envoyé',
                'requestSuccessBody' => 'Un lien de connexion vous a été envoyé par e-mail.',
                'requestErrorTitle' => 'Envoi impossible',
                'requestErrorBody' => 'Le lien de connexion n’a pas pu être envoyé pour le moment.',
                'verifyLoadingTitle' => 'Vérification du lien',
                'verifyLoadingBody' => 'Connexion sécurisée en cours…',
                'verifySuccessTitle' => 'Connexion établie',
                'verifySuccessBody' => 'Votre session sécurisée est prête. Redirection en cours…',
                'verifyInvalidTitle' => 'Lien invalide ou expiré',
                'verifyInvalidBody' => 'Le lien de connexion est invalide, expiré ou déjà utilisé.',
                'verifyErrorTitle' => 'Vérification impossible',
                'verifyErrorBody' => 'La connexion sécurisée est temporairement indisponible.',
                'missingTokenTitle' => 'Lien incomplet',
                'missingTokenBody' => 'Le token de connexion est manquant dans l’URL.',
                'submitLabelBusy' => 'Envoi…',
            ],
        ];

        wp_add_inline_script(
            'sosprescription-auth-magic-link',
            'window.SOSPrescriptionAuthMagicLink = ' . wp_json_encode($config, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ';',
            'before'
        );
    }

    public static function render_request_screen(
        string $screen,
        string $title,
        string $message,
        string $submitLabel = 'Recevoir un lien de connexion'
    ): string {
        $content = '';
        $content .= '<div class="sp-card">';
        $content .= '<div class="sp-stack">';
        $content .= '<div class="sp-stack">';
        $content .= '<h1>' . esc_html($title) . '</h1>';
        $content .= '<p>' . esc_html($message) . '</p>';
        $content .= '</div>';
        $content .= '<div class="sp-alert sp-alert--info" role="status" aria-live="polite" data-sp-auth-feedback="idle">';
        $content .= '<p class="sp-alert__title">Connexion sans mot de passe</p>';
        $content .= '<p class="sp-alert__body">Recevez un lien de connexion sécurisé valable 15 minutes.</p>';
        $content .= '</div>';
        $content .= '<form class="sp-form" method="post" novalidate data-sp-auth-request-form="1" data-sp-auth-screen="' . esc_attr($screen) . '">';
        $content .= '<div class="sp-field">';
        $content .= '<label class="sp-field__label" for="sp-auth-email-' . esc_attr($screen) . '">Adresse e-mail</label>';
        $content .= '<input class="sp-input" id="sp-auth-email-' . esc_attr($screen) . '" name="email" type="email" autocomplete="email" inputmode="email" required />';
        $content .= '<p class="sp-field__help">Utilisez l’adresse e-mail associée à votre compte SOS Prescription.</p>';
        $content .= '</div>';
        $content .= '<div class="sp-stack">';
        $content .= '<button type="submit" class="sp-button sp-button--primary" data-sp-auth-submit="1">' . esc_html($submitLabel) . '</button>';
        $content .= '</div>';
        $content .= '</form>';
        $content .= '</div>';
        $content .= '</div>';

        return ScreenFrame::screen($screen, $content, [], ['sp-ui']);
    }

    public static function render_verify_screen(): string
    {
        $content = '';
        $content .= '<div class="sp-card">';
        $content .= '<div class="sp-stack" data-sp-auth-verify="1">';
        $content .= '<div class="sp-stack">';
        $content .= '<h1>Connexion sécurisée</h1>';
        $content .= '<p>Nous vérifions votre lien magique et ouvrons votre session WordPress sécurisée.</p>';
        $content .= '</div>';
        $content .= '<div class="sp-alert sp-alert--info" role="status" aria-live="polite" data-sp-auth-feedback="verify">';
        $content .= '<p class="sp-alert__title">Vérification du lien</p>';
        $content .= '<p class="sp-alert__body">Connexion sécurisée en cours…</p>';
        $content .= '</div>';
        $content .= '<div class="sp-stack">';
        $content .= '<a class="sp-button sp-button--secondary" href="' . esc_url(home_url('/')) . '">Retour à l’accueil</a>';
        $content .= '</div>';
        $content .= '</div>';
        $content .= '</div>';

        return ScreenFrame::screen('verify', $content, [], ['sp-ui']);
    }
}
