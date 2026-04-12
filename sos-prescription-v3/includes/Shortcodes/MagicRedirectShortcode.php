<?php

declare(strict_types=1);

namespace SosPrescription\Shortcodes;

use SosPrescription\UI\AuthMagicLinkUi;

defined('ABSPATH') || exit;

final class MagicRedirectShortcode
{
    public static function register(): void
    {
        add_shortcode('sosprescription_magic_redirect', [self::class, 'render']);
    }

    /**
     * @param array<string, mixed> $atts
     */
    public static function render(array $atts = []): string
    {
        AuthMagicLinkUi::enqueue_assets();

        ob_start();
        ?>
<section class="sp-magic-redirect" aria-live="polite" data-sp-magic-redirect="1">
  <div class="sp-magic-redirect__wrap">
    <p class="sp-magic-redirect__eyebrow">
      <span class="sp-magic-redirect__dot" aria-hidden="true"></span>
      <span>MÉDECINS INSCRITS À L’ORDRE</span>
      <span class="sp-magic-redirect__sep" aria-hidden="true">•</span>
      <span>DONNÉES SÉCURISÉES HDS</span>
    </p>

    <div class="sp-magic-redirect__card">
      <div class="sp-magic-redirect__spinner" aria-hidden="true"></div>

      <h1 class="sp-magic-redirect__title">Connexion sécurisée en cours</h1>
      <p class="sp-magic-redirect__text">
        Nous vous redirigeons vers votre dossier pour finaliser votre demande.
      </p>

      <p class="sp-magic-redirect__hint">
        Cette opération peut prendre quelques secondes.
      </p>
    </div>
  </div>
</section>

<style>
  .sp-magic-redirect {
    min-height: 70vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 20px;
    background:
      radial-gradient(circle at top, rgba(39, 106, 245, 0.08), transparent 38%),
      linear-gradient(180deg, #f7faff 0%, #eef4ff 100%);
  }

  .sp-magic-redirect__wrap {
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
  }

  .sp-magic-redirect__eyebrow {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 10px;
    margin: 0 0 18px;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #35507a;
  }

  .sp-magic-redirect__dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: #18a957;
    box-shadow: 0 0 0 6px rgba(24, 169, 87, 0.12);
  }

  .sp-magic-redirect__sep {
    opacity: 0.45;
  }

  .sp-magic-redirect__card {
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid rgba(40, 87, 164, 0.10);
    border-radius: 28px;
    box-shadow:
      0 16px 40px rgba(28, 55, 90, 0.08),
      0 2px 10px rgba(28, 55, 90, 0.04);
    padding: 40px 32px;
    text-align: center;
    backdrop-filter: blur(6px);
  }

  .sp-magic-redirect__spinner {
    width: 52px;
    height: 52px;
    margin: 0 auto 22px;
    border-radius: 999px;
    border: 4px solid rgba(39, 106, 245, 0.14);
    border-top-color: #2a67f6;
    animation: sp-magic-spin 0.9s linear infinite;
  }

  .sp-magic-redirect__title {
    margin: 0 0 12px;
    font-size: clamp(1.9rem, 4vw, 2.6rem);
    line-height: 1.08;
    letter-spacing: -0.02em;
    color: #0f2747;
  }

  .sp-magic-redirect__text {
    margin: 0 auto;
    max-width: 540px;
    font-size: 1.02rem;
    line-height: 1.65;
    color: #35507a;
  }

  .sp-magic-redirect__hint {
    margin: 16px 0 0;
    font-size: 0.92rem;
    color: #6a7e9f;
  }

  @keyframes sp-magic-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .sp-magic-redirect__icon {
    width: 56px;
    height: 56px;
    margin: 0 auto 22px;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.4rem;
    font-weight: 800;
    color: #2a67f6;
    background: rgba(42, 103, 246, 0.10);
    box-shadow: inset 0 0 0 1px rgba(42, 103, 246, 0.08);
  }

  .sp-magic-redirect__icon--error {
    color: #c23b3b;
    background: rgba(194, 59, 59, 0.10);
    box-shadow: inset 0 0 0 1px rgba(194, 59, 59, 0.10);
  }

  .sp-magic-redirect__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 12px;
    margin: 22px 0 0;
  }

  .sp-magic-redirect__button {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 0 22px;
    border-radius: 999px;
    border: 0;
    background: #2a67f6;
    color: #fff;
    font-weight: 700;
    font-size: 0.98rem;
    text-decoration: none;
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
    box-shadow: 0 12px 24px rgba(42, 103, 246, 0.18);
  }

  .sp-magic-redirect__button:hover {
    transform: translateY(-1px);
    text-decoration: none;
    color: #fff;
  }

  .sp-magic-redirect__button:disabled {
    opacity: 0.7;
    cursor: wait;
    transform: none;
  }

  .sp-magic-redirect__button--secondary {
    background: rgba(42, 103, 246, 0.08);
    color: #214a96;
    box-shadow: inset 0 0 0 1px rgba(42, 103, 246, 0.10);
  }

  .sp-magic-redirect__button--secondary:hover {
    color: #214a96;
  }

  .sp-magic-redirect__field {
    margin: 22px auto 0;
    max-width: 460px;
    text-align: left;
  }

  .sp-magic-redirect__label {
    display: block;
    margin: 0 0 8px;
    font-weight: 700;
    color: #21456f;
  }

  .sp-magic-redirect__input {
    width: 100%;
    min-height: 50px;
    padding: 0 16px;
    border-radius: 16px;
    border: 1px solid rgba(40, 87, 164, 0.14);
    background: #fff;
    color: #0f2747;
    font-size: 1rem;
    box-sizing: border-box;
  }

  .sp-magic-redirect__input:focus {
    outline: none;
    border-color: rgba(42, 103, 246, 0.55);
    box-shadow: 0 0 0 4px rgba(42, 103, 246, 0.12);
  }

  @media (max-width: 640px) {
    .sp-magic-redirect__card {
      padding: 30px 20px;
      border-radius: 22px;
    }

    .sp-magic-redirect__eyebrow {
      gap: 8px;
      font-size: 0.72rem;
    }

    .sp-magic-redirect__actions {
      flex-direction: column;
    }

    .sp-magic-redirect__button {
      width: 100%;
    }
  }
</style>
        <?php

        return (string) ob_get_clean();
    }
}
