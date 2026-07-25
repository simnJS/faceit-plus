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
- **Quelle map bannir**, recommandée par un modèle entraîné sur des dizaines de
  milliers de vetos réels : pour chaque ban possible, il déroule la suite du veto
  et retient celui qui maximise l'avantage attendu sur la map finale. La
  recommandation se recalcule à chaque tour.
- **Map la plus probable** à l'arrivée, calculée exactement plutôt qu'estimée.
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

## Le modèle de veto

Les poids sont entraînés hors ligne (voir [`crawler/`](crawler/)) puis **embarqués
dans l'extension** — quelques kilo-octets. Aucun serveur, aucune latence, aucune
donnée qui sort du navigateur : la prédiction tourne entièrement chez vous.

Mesuré sur des matchs postérieurs à l'entraînement, jamais vus :

| | modèle | meilleure règle simple | hasard |
| --- | --- | --- | --- |
| prochain ban | ~55 % | ~33 % | ~27 % |
| map finalement jouée | ~34 % | ~26 % | ~15 % |

La découpe est temporelle et en trois jeux : entraînement, validation pour le
choix de l'époque, et un jeu de test consulté une seule fois — sans quoi le
chiffre publié serait le meilleur de vingt tirages plutôt qu'une mesure honnête.

## Sources de données

L'extension s'appuie sur les API internes de FACEIT (mêmes requêtes que le site, avec vos
cookies de session) pour les profils, l'historique et le veto. Le rang Premier, absent de
FACEIT, provient de csstats.gg avec Leetify en secours. Aucune donnée n'est envoyée à un
serveur tiers : tous les calculs sont faits dans le navigateur et mis en cache localement.

## Pile technique

[WXT](https://wxt.dev) (Manifest V3, builds Chrome et Firefox depuis une base unique),
TypeScript et React.
