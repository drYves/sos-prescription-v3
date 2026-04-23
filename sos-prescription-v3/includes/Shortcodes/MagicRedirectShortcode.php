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
      <span>Connexion sécurisée</span>
      <span class="sp-magic-redirect__sep" aria-hidden="true">•</span>
      <span>Lien temporaire</span>
    </p>

    <div class="sp-magic-redirect__card">
      <div class="sp-magic-redirect__spinner" aria-hidden="true"></div>

      <h1 class="sp-magic-redirect__title">Ouverture de votre session</h1>
      <p class="sp-magic-redirect__text">
        Nous vérifions votre lien sécurisé avant de vous rediriger vers votre dossier.
      </p>

      <p class="sp-magic-redirect__hint">
        Cette opération peut prendre quelques secondes. Merci de laisser cette page ouverte.
      </p>
    </div>
  </div>
</section>

<style>
  .sp-magic-redirect {
    min-height: 66vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: clamp(1rem, 0.9rem + 0.45vw, 1.5rem) 0;
    background: transparent;
  }

  .sp-magic-redirect__wrap {
    width: min(100%, 42rem);
    margin: 0 auto;
    display: grid;
    gap: clamp(0.75rem, 0.68rem + 0.28vw, 1rem);
  }

  .sp-magic-redirect__eyebrow {
    display: inline-flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 0.6rem;
    margin: 0;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--sp-shell-color-text-3, #64748b);
  }

  .sp-magic-redirect__dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 999px;
    background: var(--sp-shell-color-success, #159f6e);
    box-shadow: 0 0 0 0.35rem color-mix(in srgb, var(--sp-shell-color-success, #159f6e) 16%, transparent);
  }

  .sp-magic-redirect__sep {
    opacity: 0.42;
  }

  .sp-magic-redirect__card {
    background: var(--sp-widget-surface, linear-gradient(
      180deg,
      color-mix(in srgb, var(--sp-shell-color-surface, #ffffff) 97%, #ffffff 3%),
      color-mix(in srgb, var(--sp-shell-color-surface-alt, #f6f8fb) 18%, var(--sp-shell-color-surface, #ffffff) 82%)
    ));
    border: 1px solid var(--sp-widget-border, color-mix(in srgb, var(--sp-shell-color-text-1, #111827) 10%, transparent));
    border-radius: var(--sp-widget-radius, calc(var(--sp-shell-radius-xl, 22px) - 2px));
    box-shadow: var(--sp-widget-shadow, 0 14px 34px rgba(15, 23, 42, 0.05));
    padding: clamp(1.6rem, 1.35rem + 0.75vw, 2.2rem) clamp(1.1rem, 0.95rem + 0.5vw, 1.6rem);
    text-align: center;
  }

  .sp-magic-redirect__spinner {
    width: 3rem;
    height: 3rem;
    margin: 0 auto 1rem;
    border-radius: 999px;
    border: 4px solid color-mix(in srgb, var(--sp-shell-color-accent, #0f6cbd) 12%, transparent);
    border-top-color: var(--sp-shell-color-accent, #0f6cbd);
    animation: sp-magic-spin 0.9s linear infinite;
  }

  .sp-magic-redirect__title {
    margin: 0 0 0.7rem;
    font-size: clamp(1.6rem, 1.35rem + 1vw, 2.15rem);
    line-height: 1.08;
    letter-spacing: -0.02em;
    color: var(--sp-shell-color-text-1, #111827);
  }

  .sp-magic-redirect__text {
    margin: 0 auto;
    max-width: 34rem;
    font-size: 1rem;
    line-height: 1.65;
    color: var(--sp-shell-color-text-2, #334155);
  }

  .sp-magic-redirect__hint {
    margin: 0.85rem 0 0;
    font-size: 0.93rem;
    line-height: 1.55;
    color: var(--sp-shell-color-text-3, #64748b);
  }

  @keyframes sp-magic-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .sp-magic-redirect__icon {
    width: 3.25rem;
    height: 3.25rem;
    margin: 0 auto 1rem;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.15rem;
    font-weight: 800;
    color: var(--sp-shell-color-accent, #0f6cbd);
    background: color-mix(in srgb, var(--sp-shell-color-accent-soft, #eef6ff) 84%, white 16%);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sp-shell-color-accent, #0f6cbd) 10%, transparent);
  }

  .sp-magic-redirect__icon--error {
    color: var(--sp-shell-color-danger-ink, #9f1f1f);
    background: color-mix(in srgb, var(--sp-shell-color-danger-soft, #fef2f2) 88%, white 12%);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sp-shell-color-danger, #c03a3a) 12%, transparent);
  }

  .sp-magic-redirect__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.75rem;
    margin: 1.1rem 0 0;
  }

  .sp-magic-redirect__button {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.9rem;
    padding: 0.7rem 1.2rem;
    border-radius: 999px;
    border: 1px solid var(--sp-shell-color-accent, #0f6cbd);
    background: var(--sp-shell-color-accent, #0f6cbd);
    color: #fff;
    font-weight: 700;
    font-size: 0.96rem;
    line-height: 1.15;
    text-decoration: none;
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
    box-shadow: 0 10px 22px color-mix(in srgb, var(--sp-shell-color-accent, #0f6cbd) 18%, transparent);
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
    border-color: color-mix(in srgb, var(--sp-shell-color-text-1, #111827) 10%, transparent);
    background: color-mix(in srgb, var(--sp-shell-color-surface-alt, #f8fafc) 86%, white 14%);
    color: var(--sp-shell-color-text-2, #334155);
    box-shadow: none;
  }

  .sp-magic-redirect__button--secondary:hover {
    color: var(--sp-shell-color-text-1, #111827);
  }

  .sp-magic-redirect__field {
    margin: 1.1rem auto 0;
    max-width: 28rem;
    text-align: left;
  }

  .sp-magic-redirect__label {
    display: block;
    margin: 0 0 0.5rem;
    font-weight: 700;
    color: var(--sp-shell-color-text-2, #334155);
  }

  .sp-magic-redirect__input {
    width: 100%;
    min-height: 3rem;
    padding: 0 0.95rem;
    border-radius: 1rem;
    border: 1px solid color-mix(in srgb, var(--sp-shell-color-text-1, #111827) 12%, transparent);
    background: #fff;
    color: var(--sp-shell-color-text-1, #111827);
    font-size: 1rem;
    box-sizing: border-box;
  }

  .sp-magic-redirect__input:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--sp-shell-color-accent, #0f6cbd) 42%, transparent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--sp-shell-color-accent, #0f6cbd) 14%, transparent);
  }

  @media (max-width: 640px) {
    .sp-magic-redirect__wrap {
      gap: 0.7rem;
    }

    .sp-magic-redirect__card {
      padding: 1.3rem 1rem;
    }

    .sp-magic-redirect__eyebrow {
      gap: 0.45rem;
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
