BIBLE TECHNIQUE ET DOCTRINE UI — SOS PRESCRIPTION V7
I. Préambule : Le Paradigme V7
La version 7 acte la fin de la "semi-séparation" et des conflits de rendu. L'interface est désormais qualifiée de Medical-Grade (lisible, rassurante) et d'architecture Diesel-Grade (robuste, encapsulée).
Règle d'or : Une surface métier = un propriétaire visuel unique.

II. Cartographie des Couches
Le Thème Enfant (gp-sos-prescription) : Pose le cadre (routage, templates, header/footer, tokens globaux). Interdiction de cibler les internes de l'app.

Le Bridge (plugin-bridge.css) : Raccorde le shell aux racines applicatives (largeurs max, rythme).

L'Application (sos-prescription-v3) : Dessine le métier. Tout le CSS est local au plugin.

III. Doctrine CSS
Sanctuarisation : Chaque écran possède une racine stricte (#sosprescription-root-form, .sp-patient-console, etc.).

Interdiction du ciblage par rôle : Les classes sp-user-* sur <body> sont diagnostiques, pas des bases de style.

Encapsulation : Utilisation de namespaces locaux (ex: sp-doctor-account__*).

IV. Inventaire des Composants
Boutons : Neutres et massifs. Couleurs d'action réservées aux validations.

Guards : Stéthoscope en SVG inline, deux icônes de réassurance en pied.

Badges : Une puce OU une icône, jamais les deux.

V. Patterns par Surface
Tunnel ([sosprescription_form]) : Lecture linéaire, suppression du bouton Modifier en étape 2.

Espace Patient ([sosprescription_patient]) : Plan B (Bandeau de réassurance horizontal robuste).

Compte Médecin ([sosprescription_doctor_account]) : Architecture premium empilée verticalement.

Console Médecin ([sosprescription_admin]) : Unification de l'inbox et de la session active en colonne gauche.

VI. Règles de Non-Régression
Ne jamais utiliser app-skin.css pour styler un composant React.

Ne jamais ajouter de condition CSS basée sur l'URL ou le rôle global.

Pour toute extension : créer une nouvelle racine, un fichier CSS dédié, et respecter l'encapsulation.

---

# Annexes détaillées

## 1. Objet et portée

Cette bible sert de référence durable pour la couche visuelle de SOS Prescription. Elle documente à la fois le design system applicatif, les frontières entre thème, bridge et application, les règles d’encapsulation, les composants partagés, les variantes de shell et les patterns d’écran.

Objectifs :

- comprendre l’architecture visuelle actuelle ;
- éviter les collisions futures ;
- transmettre les règles de construction ;
- sécuriser les prochaines évolutions ;
- maintenir une doctrine claire entre thème enfant et app métier.

## 2. Cartographie opérationnelle des couches

### 2.1 Thème enfant — `gp-sos-prescription`

Le thème enfant possède :

- le routage WordPress et le choix des templates ;
- le cadre de page, le header, le footer et les variantes de shell ;
- les tokens globaux du shell ;
- les pages publiques et éditoriales ;
- la couture externe des pages applicatives.

Le thème ne possède pas :

- les composants métier internes ;
- les boutons, inputs, tabs, modales et cards internes d’un shortcode ;
- les surfaces React ou JS déjà sanctuarisées.

### 2.2 Bridge — `plugin-bridge.css`

Le bridge est un adaptateur léger. Il sert à :

- raccorder les racines applicatives au shell ;
- harmoniser les largeurs maximales et le rythme externe ;
- maintenir quelques compatibilités legacy strictement nécessaires ;
- fournir une couture visuelle minimale entre le shell et le plugin.

Le bridge ne doit pas :

- repeindre les composants métier ;
- réinterpréter le DOM interne des écrans ;
- recréer un deuxième design system parallèle à l’application.

### 2.3 Application — `sos-prescription-v3`

L’application possède :

- le rendu complet des surfaces métier ;
- le CSS local du plugin ;
- les états, variantes et composants internes ;
- la logique React, JS et PHP liée aux shortcodes et aux écrans sécurisés.

### 2.4 Shells et shortcodes

Surfaces shortcode sanctuarisées :

- `[sosprescription_form]` → tunnel de demande d’ordonnance ;
- `[sosprescription_patient]` → espace patient ;
- `[sosprescription_admin]` → console médecin ;
- `[sosprescription_doctor_account]` → compte médecin ;
- `[sosprescription_bdpm_table]` → référentiel médicaments ;
- guards / auth → surfaces sécurisées premium.

## 3. Doctrine CSS détaillée

### 3.1 Namespaces et encapsulation

Toute surface métier doit exposer une racine stable et locale. Exemples :

- `#sosprescription-root-form` ;
- `.sp-patient-console` ;
- `.sosprescription-doctor` ;
- `.sp-plugin-root--doctor-account` ;
- `.sosprescription-bdpm` ;
- `.sp-plugin-guard` ;
- `.sp-auth-entry`.

À l’intérieur d’une surface, le namespace local prime. Exemples :

- `sp-doctor-account__*` ;
- `sp-patient-hero__*` ;
- `dc-*` pour la console legacy ;
- `sp-bdpm-*` pour le référentiel.

### 3.2 Interdictions

Il est interdit de :

- piloter un composant via `body.sp-user-*` ;
- conditionner un rendu sur l’URL ;
- réutiliser `app-skin.css` pour styler un composant React ;
- ajouter une rustine globale quand une racine locale existe déjà.

### 3.3 Tokens et responsabilités

Les tokens globaux du shell peuvent être consommés par l’application, mais les sélecteurs du thème ne doivent plus descendre dans les internals métier.

Le thème fournit le vocabulaire global. L’application le convertit en rendu local.

## 4. Inventaire des composants partagés

### 4.1 Boutons

- boutons neutres, massifs et lisibles ;
- couleurs d’action réservées aux validations ou CTA principaux ;
- pas d’effet parasite, pas de soulignement old school, pas de micro-ornements incohérents.

### 4.2 Inputs, selects et textareas

- référence visuelle issue du champ de recherche BDPM ;
- visibilité nette au repos ;
- focus lisible et accessible ;
- états alignés par composant, jamais par rôle global.

### 4.3 Cards et surfaces

- surface, bordure, rayon, ombre et respiration doivent être portés par la racine locale ;
- éviter les effets “boîte dans la boîte” ;
- une hiérarchie simple vaut mieux qu’une accumulation de panneaux.

### 4.4 Stepper, badges et widgets

- stepper : géométrie homogène et lecture linéaire ;
- badges : une puce ou une icône, jamais les deux ;
- widgets : même contrat visuel pour patient et médecin ;
- guards : structure secure-entry avec stéthoscope inline et deux icônes de réassurance en pied.

### 4.5 Tabs, modales, composeurs, tables

- tabs : actives, lisibles, sans effet “kit UI” décoratif ;
- modales : centrage net, structure interne propre, footer clair ;
- composeurs : actions stables, alignement simple, lecture immédiate ;
- tables : densité maîtrisée, colonnes qui ne cassent pas la lecture.

### 4.6 Blocs documentaires

Les blocs de consentement, de vérification, de sécurité et les notices doivent rester secondaires face à l’action principale. Leur rôle est d’éclairer, pas de concurrencer l’interface.

## 5. Patterns par surface

### 5.1 Home

Le thème possède l’écran public. Il gère :

- marketing ;
- CTA publics ;
- variantes d’accueil ;
- composants d’information non métier.

### 5.2 Demande d’ordonnance

Le tunnel est un territoire applicatif souverain. Doctrine :

- lecture linéaire ;
- composants internes gérés par l’application ;
- suppression des redondances et des faux raccourcis ;
- logique avancée cachée tant qu’elle n’est pas utile.

### 5.3 Espace patient

Doctrine :

- Plan B validé pour le hero ;
- colonne de demandes stable et scrollable ;
- profil patient et widgets maîtrisés localement ;
- pas de dépendance au body multi-rôles.

### 5.4 Console médecin

Doctrine :

- colonne gauche unifiée autour de la session et de l’inbox ;
- modales et composeurs portés localement ;
- état statutaire et lecture clinique avant la décoration.

### 5.5 Compte médecin

Doctrine :

- architecture premium empilée verticalement ;
- session, profil, conformité, signature et gestion clairement hiérarchisés ;
- fin du paradigme `.wrap` legacy.

### 5.6 BDPM

Doctrine :

- tableau premium, pas administratif ;
- méta limitée au strict utile ;
- champ de recherche comme référence d’input ;
- hiérarchie de badges sobre et lisible.

### 5.7 Pages légales

Les pages légales restent du ressort du thème public. Elles sont hors périmètre des composants métier sanctuarisés et ne doivent pas servir de laboratoire CSS pour l’application.

## 6. Règles de non-régression

Ne plus jamais faire :

- un patch local qui suppose qu’un utilisateur n’a qu’un seul rôle ;
- une correction visuelle portée par le thème sur un composant React ;
- un doublon visuel entre shell, bridge et app ;
- une nouvelle couche de rustines sans clarification de propriété.

Doit rester sanctuarisé :

- tunnel ;
- espace patient ;
- console médecin ;
- compte médecin ;
- BDPM ;
- guards / auth.

À tester avant livraison :

- hover / focus / actif du logo et des CTA ;
- stepper et progression du tunnel ;
- états de guards ;
- hero patient ;
- widgets patient / médecin ;
- modales et composeurs ;
- compte médecin ;
- absence de régression liée au cumul des rôles.

## 7. Doctrine d’intégration future

### 7.1 Ajouter un nouvel écran

1. définir une racine locale stable ;
2. lui attribuer un propriétaire visuel unique ;
3. créer un fichier CSS dédié si la surface le mérite ;
4. exposer uniquement les tokens nécessaires ;
5. éviter tout emprunt opportuniste à une autre surface.

### 7.2 Ajouter un nouveau composant

1. décider s’il appartient au thème, au bridge ou à l’application ;
2. le nommer avec un namespace local cohérent ;
3. lui donner un contrat clair de variantes et d’états ;
4. le tester dans un contexte multi-rôles.

### 7.3 Éviter qu’un patch local recasse le reste

- corriger à la racine locale, jamais depuis un contournement global ;
- vérifier la propriété du DOM avant d’écrire du CSS ;
- supprimer les anciennes rustines devenues obsolètes ;
- documenter les décisions structurantes dans cette bible.
