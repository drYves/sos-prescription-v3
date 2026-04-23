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
                'requestIdleTitle' => 'Lien d’accès sécurisé',
                'requestSendingTitle' => 'Préparation du lien sécurisé',
                'requestSendingBody' => 'Nous préparons votre lien d’accès sécurisé.',
                'requestSuccessTitle' => 'Lien d’accès envoyé',
                'requestSuccessBody' => 'Vérifiez votre e-mail pour ouvrir votre dossier.',
                'requestErrorTitle' => 'Envoi temporairement indisponible',
                'requestErrorBody' => 'Le lien d’accès n’a pas pu être envoyé pour le moment.',
                'requestNotFoundTitle' => 'Aucun dossier trouvé avec cet e-mail',
                'requestNotFoundBody' => 'Si vous n\'avez pas encore de dossier, démarrez une nouvelle demande.',
                'requestNotFoundAction' => 'Démarrer une demande',
                'verifyLoadingTitle' => 'Vérification du lien',
                'verifyLoadingBody' => 'Nous confirmons votre accès sécurisé…',
                'verifySuccessTitle' => 'Session prête',
                'verifySuccessBody' => 'Votre session sécurisée est prête. Redirection en cours…',
                'verifyInvalidTitle' => 'Lien expiré ou déjà utilisé',
                'verifyInvalidBody' => 'Demandez un nouveau lien pour rouvrir votre dossier.',
                'verifyErrorTitle' => 'Vérification impossible',
                'verifyErrorBody' => 'La vérification du lien est temporairement indisponible.',
                'missingTokenTitle' => 'Lien incomplet',
                'missingTokenBody' => 'Le lien sécurisé est incomplet.',
                'submitLabelBusy' => 'Envoi…',
                'magicSlowHint' => 'Merci de laisser cette page ouverte, la vérification prend un peu plus de temps que prévu.',
                'magicInvalidTitle' => 'Lien expiré ou invalide',
                'magicInvalidBody' => 'Ce lien n’est plus utilisable. Vous pouvez demander un nouveau lien pour reprendre votre dossier.',
                'magicInvalidHint' => 'Le nouveau lien sera envoyé à la même adresse e-mail.',
                'magicResendButton' => 'Demander un nouveau lien',
                'magicResendSending' => 'Nouvel envoi en cours…',
                'magicResendSuccessTitle' => 'Lien d’accès envoyé',
                'magicResendSuccessBody' => 'Un nouveau lien vient d’être envoyé. Vérifiez votre e-mail pour reprendre votre dossier.',
                'magicResendErrorTitle' => 'Envoi impossible',
                'magicResendErrorBody' => 'Le nouveau lien n’a pas pu être envoyé pour le moment.',
                'magicTechnicalTitle' => 'Connexion temporairement indisponible',
                'magicTechnicalBody' => 'Merci de réessayer dans quelques instants.',
                'magicReturnHomeLabel' => 'Retour à l’accueil',
                'magicMissingEmailTitle' => 'Confirmez votre adresse e-mail',
                'magicMissingEmailBody' => 'Saisissez l’adresse e-mail du dossier pour recevoir un nouveau lien.',
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
        $content .= '<div class="sp-auth-entry sp-auth-entry--patient sp-auth-surface sp-app-stack sp-stack">';
        $content .= '<header class="sp-auth-entry__header sp-app-header sp-app-header--compact">';
        $content .= '<p class="sp-app-header__eyebrow">Espace patient sécurisé</p>';
        $content .= '<h1 class="sp-app-header__title">Accédez à votre dossier ou démarrez une demande</h1>';
        $content .= '<p class="sp-app-header__subtitle">Le lien d’accès est réservé aux patients qui ont déjà un dossier. Pour une première demande, commencez simplement le parcours public.</p>';
        $content .= '</header>';
        $content .= '<div class="sp-auth-entry__grid sp-app-grid sp-app-grid--two">';

        $content .= '<article class="sp-auth-entry__panel sp-auth-entry__panel--existing sp-app-card sp-card">';
        $content .= '<div class="sp-auth-entry__panel-body sp-app-stack sp-stack" data-sp-auth-surface="1">';
        $content .= '<p class="sp-auth-entry__eyebrow sp-app-header__eyebrow">J’ai déjà un dossier</p>';
        $content .= '<div class="sp-app-stack sp-stack sp-app-stack--compact">';
        $content .= '<h2 class="sp-panel__title">Recevoir un lien d’accès</h2>';
        $content .= '<p class="sp-auth-entry__text">Saisissez l’adresse e-mail utilisée pour votre dernière demande afin d’ouvrir votre espace patient.</p>';
        $content .= '</div>';
        $content .= '<form class="sp-auth-entry__form sp-app-stack sp-stack" method="post" novalidate data-sp-auth-request-form="1" data-sp-auth-screen="patient" data-sp-auth-variant="patient-entry">';
        $content .= '<div class="sp-app-field sp-field">';
        $content .= '<label class="sp-app-field__label sp-field__label" for="sp-auth-email-patient">Adresse e-mail</label>';
        $content .= '<input class="sp-app-input sp-input" id="sp-auth-email-patient" name="email" type="email" autocomplete="email" inputmode="email" required />';
        $content .= '<p class="sp-field__help sp-app-field__hint">Utilisez la même adresse e-mail que celle de votre dossier.</p>';
        $content .= '</div>';
        $content .= '<div class="sp-auth-entry__actions">';
        $content .= '<button type="submit" class="sp-app-button sp-app-button--primary sp-button sp-button--primary" data-sp-auth-submit="1">Recevoir mon lien</button>';
        $content .= '</div>';
        $content .= '</form>';
        $content .= self::render_facts([
            'Même e-mail que votre dossier',
            'Sans mot de passe',
            'Lien valable 15 minutes',
        ]);
        $content .= '<div class="sp-auth-entry__status sp-app-notice sp-alert sp-app-notice--info sp-alert--info" role="status" aria-live="polite" data-sp-auth-feedback="idle">';
        $content .= '<p class="sp-app-notice__title sp-alert__title">Lien d’accès sécurisé</p>';
        $content .= '<p class="sp-alert__body">Aucun mot de passe à mémoriser. Le lien reste valable 15 minutes.</p>';
        $content .= '</div>';
        $content .= '<div class="sp-auth-entry__fallback sp-app-notice sp-app-notice--warning" hidden data-sp-auth-unknown-email="1">';
        $content .= '<p class="sp-app-notice__title">Aucun dossier trouvé avec cet e-mail</p>';
        $content .= '<p>Si vous n\'avez pas encore de dossier, démarrez une nouvelle demande.</p>';
        $content .= '<div class="sp-auth-entry__actions">';
        $content .= '<a class="sp-app-button sp-app-button--secondary sp-button sp-button--secondary" href="' . $startUrl . '">Démarrer une demande</a>';
        $content .= '</div>';
        $content .= '</div>';
        $content .= '</div>';
        $content .= '</article>';

        $content .= '<article class="sp-auth-entry__panel sp-auth-entry__panel--new sp-app-card sp-card">';
        $content .= '<div class="sp-auth-entry__panel-body sp-app-stack sp-stack">';
        $content .= '<p class="sp-auth-entry__eyebrow sp-app-header__eyebrow">Première demande</p>';
        $content .= '<div class="sp-app-stack sp-stack sp-app-stack--compact">';
        $content .= '<h2 class="sp-panel__title">Démarrer un nouveau parcours</h2>';
        $content .= '<p class="sp-auth-entry__text">Commencez votre demande d’ordonnance. Votre espace patient sera créé automatiquement à la fin du parcours.</p>';
        $content .= '</div>';
        $content .= '<div class="sp-auth-entry__panel-note">Vous retrouverez ensuite vos documents, votre suivi et votre messagerie dans ce même espace patient.</div>';
        $content .= '<div class="sp-auth-entry__actions">';
        $content .= '<a class="sp-app-button sp-app-button--secondary sp-button sp-button--secondary" href="' . $startUrl . '">Démarrer une demande</a>';
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
        $context = self::get_request_screen_context($screen);

        $content = '';
        $content .= '<div class="sp-auth-entry sp-auth-entry--' . esc_attr(sanitize_html_class($screen)) . ' sp-auth-entry--guarded sp-auth-surface sp-auth-surface--' . esc_attr(sanitize_html_class($screen)) . ' sp-auth-surface--guarded sp-app-stack sp-stack">';
        $content .= '<article class="sp-auth-entry__panel sp-auth-entry__panel--secure sp-app-card sp-card">';
        $content .= '<div class="sp-auth-entry__panel-body sp-app-stack sp-stack" data-sp-auth-surface="1">';
        $content .= '<header class="sp-auth-entry__header sp-app-stack sp-stack sp-app-stack--compact">';
        $content .= '<p class="sp-auth-entry__eyebrow sp-app-header__eyebrow">' . esc_html($context['eyebrow']) . '</p>';
        $content .= '<h1>' . esc_html($title) . '</h1>';
        $content .= '<p class="sp-auth-entry__text">' . esc_html($message) . '</p>';
        $content .= '</header>';
        $content .= '<form class="sp-auth-entry__form sp-form sp-app-stack sp-stack" method="post" novalidate data-sp-auth-request-form="1" data-sp-auth-screen="' . esc_attr($screen) . '">';
        $content .= '<div class="sp-field sp-app-field">';
        $content .= '<label class="sp-field__label sp-app-field__label" for="sp-auth-email-' . esc_attr($screen) . '">Adresse e-mail</label>';
        $content .= '<input class="sp-input sp-app-input" id="sp-auth-email-' . esc_attr($screen) . '" name="email" type="email" autocomplete="email" inputmode="email" required />';
        $content .= '<p class="sp-field__help sp-app-field__hint">' . esc_html($context['hint']) . '</p>';
        $content .= '</div>';
        $content .= '<div class="sp-auth-entry__actions">';
        $content .= '<button type="submit" class="sp-button sp-button--primary sp-app-button sp-app-button--primary" data-sp-auth-submit="1">' . esc_html($submitLabel) . '</button>';
        $content .= '</div>';
        $content .= '</form>';
        $content .= '<div class="sp-auth-entry__status sp-alert sp-alert--info" role="status" aria-live="polite" data-sp-auth-feedback="idle">';
        $content .= '<p class="sp-alert__title">Lien d’accès sécurisé</p>';
        $content .= '<p class="sp-alert__body">Aucun mot de passe à mémoriser. Le lien reste valable 15 minutes.</p>';
        $content .= '</div>';
        $content .= self::render_facts($context['facts']);
        $content .= '</div>';
        $content .= '</article>';
        $content .= '</div>';

        return ScreenFrame::screen($screen, $content, [], ['sp-ui', 'sp-page-shell', 'sp-app-container']);
    }

    public static function render_verify_screen(): string
    {
        $content = '';
        $content .= '<div class="sp-auth-entry sp-auth-entry--verify sp-auth-entry--guarded sp-auth-surface sp-auth-surface--verify sp-auth-surface--guarded sp-app-stack sp-stack">';
        $content .= '<article class="sp-auth-entry__panel sp-auth-entry__panel--secure sp-app-card sp-card">';
        $content .= '<div class="sp-auth-entry__panel-body sp-app-stack sp-stack" data-sp-auth-verify="1">';
        $content .= '<header class="sp-auth-entry__header sp-app-stack sp-stack sp-app-stack--compact">';
        $content .= '<p class="sp-auth-entry__eyebrow sp-app-header__eyebrow">Session sécurisée</p>';
        $content .= '<h1>Vérification de votre lien</h1>';
        $content .= '<p class="sp-auth-entry__text">Nous confirmons votre accès avant d’ouvrir votre session sécurisée.</p>';
        $content .= '</header>';
        $content .= '<div class="sp-auth-entry__status sp-alert sp-alert--info" role="status" aria-live="polite" data-sp-auth-feedback="verify">';
        $content .= '<p class="sp-alert__title">Connexion en cours</p>';
        $content .= '<p class="sp-alert__body">Cette étape prend généralement quelques secondes.</p>';
        $content .= '</div>';
        $content .= self::render_facts([
            'Lien temporaire',
            'Session sécurisée',
            'Redirection automatique',
        ]);
        $content .= '<div class="sp-auth-entry__actions">';
        $content .= '<a class="sp-button sp-button--secondary sp-app-button sp-app-button--secondary" href="' . esc_url(home_url('/')) . '">Retour à l’accueil</a>';
        $content .= '</div>';
        $content .= '</div>';
        $content .= '</article>';
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

    /**
     * @param list<string> $facts
     */
    private static function render_facts(array $facts): string
    {
        if ($facts === []) {
            return '';
        }

        $content = '<div class="sp-auth-entry__facts" aria-label="Repères de connexion">';

        foreach ($facts as $fact) {
            $content .= '<span class="sp-auth-entry__fact">' . esc_html($fact) . '</span>';
        }

        $content .= '</div>';

        return $content;
    }

    /**
     * @return array{eyebrow:string,hint:string,facts:list<string>}
     */
    private static function get_request_screen_context(string $screen): array
    {
        return match ($screen) {
            'console' => [
                'eyebrow' => 'Console médecin sécurisée',
                'hint' => 'Utilisez l’adresse e-mail associée à votre accès console SOS Prescription.',
                'facts' => [
                    'Sans mot de passe',
                    'Lien valable 15 minutes',
                    'Accès réservé au compte professionnel',
                ],
            ],
            'doctor-account' => [
                'eyebrow' => 'Compte médecin sécurisé',
                'hint' => 'Utilisez l’adresse e-mail associée à votre compte SOS Prescription.',
                'facts' => [
                    'Sans mot de passe',
                    'Lien valable 15 minutes',
                    'Données professionnelles sécurisées',
                ],
            ],
            default => [
                'eyebrow' => 'Accès médecin sécurisé',
                'hint' => 'Utilisez l’adresse e-mail associée à votre compte SOS Prescription.',
                'facts' => [
                    'Sans mot de passe',
                    'Lien valable 15 minutes',
                    'Connexion sécurisée',
                ],
            ],
        };
    }
}
