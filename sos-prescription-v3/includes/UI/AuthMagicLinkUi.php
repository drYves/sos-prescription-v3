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

        self::enqueue_styles();

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
            'draftResendEndpoint' => esc_url_raw(rest_url('sosprescription/v4/submissions/draft/resend')),
            'magicRedirectPageUrl' => esc_url_raw(home_url('/connexion-securisee/')),
            'requestStartUrl' => esc_url_raw(home_url('/demande-ordonnance/')),
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
                'requestNotFoundTitle' => 'E-mail non reconnu ?',
                'requestNotFoundBody' => 'Si vous n\'avez pas encore passé de commande, commencez par ici.',
                'requestNotFoundAction' => 'Commencer une demande',
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
                'magicSlowHint' => 'Merci de patienter, la connexion sécurisée prend un peu plus de temps que prévu.',
                'magicInvalidTitle' => 'Lien invalide',
                'magicInvalidBody' => 'Ce lien n’est plus valide ou a expiré. Vous pouvez demander un nouveau lien pour reprendre votre dossier.',
                'magicInvalidHint' => 'Le nouveau lien sera envoyé à la même adresse e-mail lorsqu’elle est disponible.',
                'magicResendButton' => 'Demander un nouveau lien',
                'magicResendSending' => 'Nouvel envoi en cours…',
                'magicResendSuccessTitle' => 'Lien de connexion envoyé',
                'magicResendSuccessBody' => 'Un nouveau lien vient de vous être envoyé. Vérifiez votre e-mail pour reprendre votre dossier.',
                'magicResendErrorTitle' => 'Envoi impossible',
                'magicResendErrorBody' => 'Le nouveau lien n’a pas pu être envoyé pour le moment.',
                'magicTechnicalTitle' => 'Connexion temporairement indisponible',
                'magicTechnicalBody' => 'Merci de réessayer dans quelques instants.',
                'magicReturnHomeLabel' => 'Retour à l’accueil',
                'magicMissingEmailTitle' => 'Adresse e-mail nécessaire',
                'magicMissingEmailBody' => 'Merci de saisir votre adresse e-mail pour recevoir un nouveau lien.',
                'magicEmailLabel' => 'Adresse e-mail',
                'magicEmailPlaceholder' => 'vous@exemple.fr',
                'magicEmailSubmit' => 'Recevoir un nouveau lien',
                'magicEmailInvalid' => 'Merci de renseigner une adresse e-mail valide.',
            ],
        ];

        wp_add_inline_script(
            'sosprescription-auth-magic-link',
            'window.SOSPrescriptionAuthMagicLink = ' . wp_json_encode($config, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . ';',
            'before'
        );
    }

    public static function render_patient_request_screen(): string
    {
        $startUrl = esc_url(home_url('/demande-ordonnance/'));

        $content = '';
        $content .= '<div class="sp-auth-entry sp-app-stack sp-stack">';
        $content .= '<header class="sp-auth-entry__header sp-app-header sp-app-header--compact">';
        $content .= '<p class="sp-app-header__eyebrow">Espace patient sécurisé</p>';
        $content .= '<h1 class="sp-app-header__title">Choisissez votre parcours</h1>';
        $content .= '<p class="sp-app-header__subtitle">Accédez à un dossier existant ou démarrez une nouvelle demande d’ordonnance.</p>';
        $content .= '</header>';
        $content .= '<div class="sp-auth-entry__grid sp-app-grid sp-app-grid--two">';

        $content .= '<article class="sp-auth-entry__panel sp-auth-entry__panel--existing sp-app-card sp-card">';
        $content .= '<div class="sp-auth-entry__panel-body sp-app-stack sp-stack" data-sp-auth-surface="1">';
        $content .= '<p class="sp-auth-entry__eyebrow sp-app-header__eyebrow">Déjà patient ?</p>';
        $content .= '<div class="sp-app-stack sp-stack sp-app-stack--compact">';
        $content .= '<h2 class="sp-panel__title">Accédez à votre espace</h2>';
        $content .= '<p class="sp-auth-entry__text">Si vous avez déjà passé une commande sur notre plateforme, saisissez votre e-mail pour recevoir un lien de connexion sécurisé.</p>';
        $content .= '</div>';
        $content .= '<form class="sp-auth-entry__form sp-app-stack sp-stack" method="post" novalidate data-sp-auth-request-form="1" data-sp-auth-screen="patient" data-sp-auth-variant="patient-entry">';
        $content .= '<div class="sp-app-field sp-field">';
        $content .= '<label class="sp-app-field__label sp-field__label" for="sp-auth-email-patient">Adresse e-mail</label>';
        $content .= '<input class="sp-app-input sp-input" id="sp-auth-email-patient" name="email" type="email" autocomplete="email" inputmode="email" required />';
        $content .= '</div>';
        $content .= '<div class="sp-auth-entry__actions">';
        $content .= '<button type="submit" class="sp-app-button sp-app-button--primary sp-button sp-button--primary" data-sp-auth-submit="1">Recevoir mon lien</button>';
        $content .= '</div>';
        $content .= '</form>';
        $content .= '<div class="sp-auth-entry__status sp-app-notice sp-alert sp-app-notice--info sp-alert--info" role="status" aria-live="polite" data-sp-auth-feedback="idle">';
        $content .= '<p class="sp-app-notice__title sp-alert__title">Connexion sans mot de passe</p>';
        $content .= '<p class="sp-alert__body">Recevez un lien de connexion sécurisé valable 15 minutes.</p>';
        $content .= '</div>';
        $content .= '<div class="sp-auth-entry__fallback sp-app-notice sp-app-notice--warning" hidden data-sp-auth-unknown-email="1">';
        $content .= '<p class="sp-app-notice__title">E-mail non reconnu ?</p>';
        $content .= '<p>Si vous n\'avez pas encore passé de commande, commencez par ici.</p>';
        $content .= '<div class="sp-auth-entry__actions">';
        $content .= '<a class="sp-app-button sp-app-button--secondary sp-button sp-button--secondary" href="' . $startUrl . '">Commencer une demande</a>';
        $content .= '</div>';
        $content .= '</div>';
        $content .= '</div>';
        $content .= '</article>';

        $content .= '<article class="sp-auth-entry__panel sp-auth-entry__panel--new sp-app-card sp-card">';
        $content .= '<div class="sp-auth-entry__panel-body sp-app-stack sp-stack">';
        $content .= '<p class="sp-auth-entry__eyebrow sp-app-header__eyebrow">Nouveau sur la plateforme ?</p>';
        $content .= '<div class="sp-app-stack sp-stack sp-app-stack--compact">';
        $content .= '<h2 class="sp-panel__title">Nouvelle demande d’ordonnance</h2>';
        $content .= '<p class="sp-auth-entry__text">C’est votre première fois ? L’accès à votre espace patient sera généré automatiquement à la fin de votre demande.</p>';
        $content .= '</div>';
        $content .= '<div class="sp-auth-entry__actions">';
        $content .= '<a class="sp-app-button sp-app-button--secondary sp-button sp-button--secondary" href="' . $startUrl . '">Commencer une demande</a>';
        $content .= '</div>';
        $content .= '</div>';
        $content .= '</article>';

        $content .= '</div>';
        $content .= '</div>';

        return ScreenFrame::screen('patient', $content, [], ['sp-ui', 'sp-page-shell', 'sp-app-container']);
    }

    public static function render_request_screen(
        string $screen,
        string $title,
        string $message,
        string $submitLabel = 'Recevoir un lien de connexion'
    ): string {
        $content = '';
        $content .= '<div class="sp-card sp-app-card">';
        $content .= '<div class="sp-stack sp-app-stack" data-sp-auth-surface="1">';
        $content .= '<div class="sp-stack sp-app-stack sp-app-stack--compact">';
        $content .= '<h1>' . esc_html($title) . '</h1>';
        $content .= '<p>' . esc_html($message) . '</p>';
        $content .= '</div>';
        $content .= '<div class="sp-alert sp-alert--info" role="status" aria-live="polite" data-sp-auth-feedback="idle">';
        $content .= '<p class="sp-alert__title">Connexion sans mot de passe</p>';
        $content .= '<p class="sp-alert__body">Recevez un lien de connexion sécurisé valable 15 minutes.</p>';
        $content .= '</div>';
        $content .= '<form class="sp-form sp-app-stack sp-stack" method="post" novalidate data-sp-auth-request-form="1" data-sp-auth-screen="' . esc_attr($screen) . '">';
        $content .= '<div class="sp-field sp-app-field">';
        $content .= '<label class="sp-field__label sp-app-field__label" for="sp-auth-email-' . esc_attr($screen) . '">Adresse e-mail</label>';
        $content .= '<input class="sp-input sp-app-input" id="sp-auth-email-' . esc_attr($screen) . '" name="email" type="email" autocomplete="email" inputmode="email" required />';
        $content .= '<p class="sp-field__help sp-app-field__hint">Utilisez l’adresse e-mail associée à votre compte SOS Prescription.</p>';
        $content .= '</div>';
        $content .= '<div class="sp-auth-entry__actions">';
        $content .= '<button type="submit" class="sp-button sp-button--primary sp-app-button sp-app-button--primary" data-sp-auth-submit="1">' . esc_html($submitLabel) . '</button>';
        $content .= '</div>';
        $content .= '</form>';
        $content .= '</div>';
        $content .= '</div>';

        return ScreenFrame::screen($screen, $content, [], ['sp-ui', 'sp-page-shell', 'sp-app-container']);
    }

    public static function render_verify_screen(): string
    {
        $content = '';
        $content .= '<div class="sp-card sp-app-card">';
        $content .= '<div class="sp-stack sp-app-stack" data-sp-auth-verify="1">';
        $content .= '<div class="sp-stack sp-app-stack sp-app-stack--compact">';
        $content .= '<h1>Connexion sécurisée</h1>';
        $content .= '<p>Nous vérifions votre lien de connexion et ouvrons votre session sécurisée.</p>';
        $content .= '</div>';
        $content .= '<div class="sp-alert sp-alert--info" role="status" aria-live="polite" data-sp-auth-feedback="verify">';
        $content .= '<p class="sp-alert__title">Vérification du lien</p>';
        $content .= '<p class="sp-alert__body">Connexion sécurisée en cours…</p>';
        $content .= '</div>';
        $content .= '<div class="sp-auth-entry__actions">';
        $content .= '<a class="sp-button sp-button--secondary sp-app-button sp-app-button--secondary" href="' . esc_url(home_url('/')) . '">Retour à l’accueil</a>';
        $content .= '</div>';
        $content .= '</div>';
        $content .= '</div>';

        return ScreenFrame::screen('verify', $content, [], ['sp-ui', 'sp-page-shell', 'sp-app-container']);
    }

    private static function enqueue_styles(): void
    {
        if (!defined('SOSPRESCRIPTION_URL')) {
            return;
        }

        wp_enqueue_style(
            'sosprescription-ui-kit',
            SOSPRESCRIPTION_URL . 'assets/ui-kit.css',
            [],
            defined('SOSPRESCRIPTION_VERSION') ? SOSPRESCRIPTION_VERSION : null
        );

        if (!defined('SOSPRESCRIPTION_PATH')) {
            return;
        }

        $buildPath = SOSPRESCRIPTION_PATH . 'build/form.css';
        if (!file_exists($buildPath)) {
            return;
        }

        wp_enqueue_style(
            'sosprescription-auth-surface',
            SOSPRESCRIPTION_URL . 'build/form.css',
            ['sosprescription-ui-kit'],
            (string) filemtime($buildPath)
        );
    }
}
