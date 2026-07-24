# FACEIT+

Extension navigateur qui enrichit les salles de match FACEIT (CS2), sur Chrome et Firefox.

## Fonctionnalités

**Dans la salle de match**

- **Drapeaux de pays** à côté de chaque pseudo.
- **Rang CS2 Premier** affiché devant le niveau FACEIT, aux couleurs officielles des paliers.
- **K/D par map** sous chaque joueur, calé sur le pool du match : seule la map retenue est
  affichée une fois le veto terminé, un bouton déplie le pool complet.
- **Rôle estimé** (sniper, entry, support, clutcher, anchor, carry, rifler) avec le détail
  des scores au survol.

**Pendant le veto**

- **Winrate des deux équipes** sur chaque map, agrégé sur l'historique récent des joueurs.
- **Probabilité de ban** de chaque map, calculée depuis l'historique de veto du capitaine adverse.
- Les tuiles bannies sont estompées au fil des tours.

**Automatismes** (désactivés par défaut)

- **Acceptation automatique** du match, avec délai réglable et possibilité d'annuler.
- **Ban automatique de maps** quand vous êtes capitaine, soit selon un ordre de préférence,
  soit en bannissant la map où votre équipe a le pire winrate.

**Réglages** — un panneau accessible depuis la pastille en bas à droite de FACEIT permet
d'activer chaque fonctionnalité et de choisir la langue (français / anglais).

## Développement

```bash
npm install
npm run dev          # Chrome
npm run dev:firefox  # Firefox
```

Chargez ensuite `.output/chrome-mv3-dev` via `chrome://extensions` en mode développeur
(« Charger l'extension non empaquetée »). Les modifications de code sont ensuite appliquées
automatiquement ; seuls les changements de manifeste demandent un rechargement manuel.

```bash
npm run compile      # vérification TypeScript
npm run build        # build de production Chrome
npm run build:firefox
npm run zip          # archive prête pour les stores
```

## Sources de données

L'extension s'appuie sur les API internes de FACEIT (mêmes requêtes que le site, avec vos
cookies de session) pour les profils, l'historique et le veto. Le rang Premier, absent de
FACEIT, provient de csstats.gg avec Leetify en secours. Aucune donnée n'est envoyée à un
serveur tiers : tous les calculs sont faits dans le navigateur et mis en cache localement.

## Pile technique

[WXT](https://wxt.dev) (Manifest V3, builds Chrome et Firefox depuis une base unique),
TypeScript et React.
