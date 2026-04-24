/*
 * SOS Prescription – V4.3 Monolith Build
 *
 * Objectif:
 * - Produire 3 bundles "classiques" (pas ESM) en IIFE, sans code-splitting.
 * - Noms stables, sans hash (cache-busting via SOSPRESCRIPTION_VERSION côté WP).
 * - Aucun manifest Vite utilisé.
 *
 * Sorties attendues:
 *   build/admin.js (+ build/admin.css si CSS importée)
 *   build/form.js  (+ build/form.css  si CSS importée)
 *   build/pocLocaleIsland.js
 */

import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = __dirname;
const OUT_DIR = path.resolve(ROOT_DIR, 'build');

/**
 * Entrées supportées.
 * @type {readonly ['admin','form','pocLocaleIsland']}
 */
const SUPPORTED_ENTRIES = ['admin', 'form', 'pocLocaleIsland'];

/**
 * Parse CLI args.
 * - `node build.mjs` => build admin + form (avec clean)
 * - `node build.mjs admin` => build admin (sans clean par défaut)
 * - `node build.mjs form`  => build form  (sans clean par défaut)
 * - `node build.mjs pocLocaleIsland` => build îlot POC locale (sans clean par défaut)
 * - `node build.mjs --clean` => clean seulement
 */
const argv = process.argv.slice(2);
const requestedEntry = argv.find((arg) => SUPPORTED_ENTRIES.includes(arg)) ?? null;
const cleanOnly = argv.includes('--clean') && !requestedEntry;
const shouldClean = argv.includes('--clean') || requestedEntry === null;

const entriesToBuild = requestedEntry ? [requestedEntry] : [...SUPPORTED_ENTRIES];

function info(message) {
  // eslint-disable-next-line no-console
  console.log(`[MonolithBuild] ${message}`);
}

function warn(message) {
  // eslint-disable-next-line no-console
  console.warn(`[MonolithBuild] ${message}`);
}

function fatal(message, error) {
  // eslint-disable-next-line no-console
  console.error(`[MonolithBuild] ${message}`);
  if (error) {
    // eslint-disable-next-line no-console
    console.error(error);
  }
  process.exit(1);
}

async function ensureOutDir() {
  await fs.mkdir(OUT_DIR, { recursive: true });
}

async function ensureIndexPhp() {
  const indexPath = path.join(OUT_DIR, 'index.php');
  try {
    await fs.access(indexPath);
  } catch {
    await fs.writeFile(indexPath, "<?php\n// Silence is golden.\n", 'utf8');
  }
}

async function cleanOutDirKeepingIndexPhp() {
  await ensureOutDir();
  const entries = await fs.readdir(OUT_DIR, { withFileTypes: true });
  await Promise.all(
    entries.map(async (dirent) => {
      if (dirent.name === 'index.php') {
        return;
      }
      const targetPath = path.join(OUT_DIR, dirent.name);
      await fs.rm(targetPath, { recursive: true, force: true });
    }),
  );
  await ensureIndexPhp();
}

async function assertEntryExists(entryName) {
  const entryPath = path.resolve(ROOT_DIR, 'src', 'entries', `${entryName}.tsx`);
  try {
    await fs.access(entryPath);
  } catch {
    throw new Error(`Entrée introuvable: ${path.relative(ROOT_DIR, entryPath)}`);
  }
  return entryPath;
}

function getGlobalName(entryName) {
  // Le nom est requis par IIFE en mode "lib".
  // Il n'est pas utilisé par notre logique (nous attachons explicitement à window).
  if (entryName === 'admin') return 'SosPrescriptionAdminBundle';
  if (entryName === 'pocLocaleIsland') return 'SosPrescriptionPocLocaleIslandBundle';
  return 'SosPrescriptionFormBundle';
}

function createViteConfig(entryName, entryPath) {
  /** @type {import('vite').UserConfig} */
  const config = {
    root: ROOT_DIR,
    clearScreen: false,
    logLevel: 'info',
    plugins: [react()],
    define: {
      'process.env.NODE_ENV': JSON.stringify('production')
    },

    build: {
      outDir: OUT_DIR,
      emptyOutDir: false,
      sourcemap: false,

      // Important: un seul fichier CSS par entrée.
      cssCodeSplit: false,

      // Par défaut Vite 8 utilise Oxc/LightningCSS; `true` garde le minifier par défaut.
      minify: true,

      // IMPORTANT: mode library pour compiler à partir d'un entry JS/TS, sans HTML.
      lib: {
        entry: entryPath,
        name: getGlobalName(entryName),
        formats: ['iife'],
        fileName: () => `${entryName}.js`,
        cssFileName: entryName
      },

      // Rolldown (Vite 8) – réglages "diesel-grade".
      // NOTE: `build.rollupOptions` est un alias déprécié; on cible l'API Rolldown.
      rolldownOptions: {
        // Désactivation du tree-shaking pour éviter toute élimination accidentelle
        // de nos assignations globales (bridge) et side-effects.
        treeshake: false,
        output: {
          // Verrou: pas de chunks dynamiques.
          inlineDynamicImports: true,

          // Verrou: pas de hash dans les assets.
          // On place les assets non-CSS sous un sous-dossier par entry pour éviter
          // les collisions entre admin et form.
          assetFileNames: (assetInfo) => {
            const name = String(assetInfo?.name || '');
            if (name.endsWith('.css')) {
              return `${entryName}.css`;
            }
            return `assets/${entryName}/[name][extname]`;
          }
        }
      }
    }
  };

  return config;
}

async function buildEntry(entryName) {
  if (!SUPPORTED_ENTRIES.includes(entryName)) {
    throw new Error(`Entrée invalide: ${entryName}`);
  }

  const entryPath = await assertEntryExists(entryName);
  info(`Build IIFE: ${entryName} → build/${entryName}.js`);

  await viteBuild(createViteConfig(entryName, entryPath));
}

async function main() {
  if (cleanOnly) {
    info('Clean requested (no build).');
    await cleanOutDirKeepingIndexPhp();
    info('Clean OK.');
    return;
  }

  if (shouldClean) {
    info('Cleaning build/ (keeping index.php)…');
    await cleanOutDirKeepingIndexPhp();
  } else {
    await ensureOutDir();
    await ensureIndexPhp();
  }

  for (const entryName of entriesToBuild) {
    await buildEntry(entryName);
  }

  info('Build terminé.');
}

main().catch((err) => {
  const message = err && typeof err.message === 'string' ? err.message : 'Erreur inconnue';
  warn(message);
  fatal('Build échoué.', err);
});
