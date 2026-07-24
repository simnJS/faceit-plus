# Crawler FACEIT

Outil autonome qui constitue une base de vetos, destinée à entraîner un modèle de
prédiction de map plus fin que l'heuristique actuelle de l'extension.

Aucune dépendance : Node 22+ suffit (SQLite est intégré).

## Clé d'API

Le crawler utilise l'**API officielle** pour la découverte des joueurs et des
matchs. Une clé gratuite s'obtient sur [developers.faceit.com](https://developers.faceit.com) :
créer une application, puis générer une clé « server side ».

La séquence de bans n'étant pas exposée par l'API officielle, elle est lue sur
l'endpoint public de veto — sans clé, mais soumise au même limiteur de débit.

## Utilisation

Copier `.env.example` en `.env` à la racine et y renseigner la clé, puis :

```bash
npm run crawl
```

Le `.env` est chargé automatiquement (`FACEIT_API_KEY` et `FACEIT_SEED`) et il est
exclu du dépôt. Les options s'ajoutent après `--` :

```bash
npm run crawl -- --max-matches 50000 --rps 3
```

Le crawl fonctionne en **boule de neige** : il part de la graine, récupère ses
matchs, puis les dix joueurs de chaque match rejoignent la file d'attente. La
couverture s'étend d'elle-même à toutes les tranches d'elo.

Options utiles :

| Option | Rôle |
| --- | --- |
| `--seed <pseudo>` | point de départ, répétable (inutile une fois la base amorcée) |
| `--max-matches <n>` | s'arrête après avoir ajouté n matchs |
| `--max-depth <n>` | limite l'éloignement par rapport aux graines |
| `--per-player <n>` | matchs récupérés par joueur (max 100) |
| `--rps <n>` | requêtes par seconde, 3 par défaut |

Le crawl est **reprenable** : l'état vit dans la base, relancer la commande
continue là où on s'est arrêté. `Ctrl+C` termine proprement le joueur en cours.

## Jeu d'entraînement

```bash
node crawler/export.mjs --out crawler/dataset.jsonl
```

Produit **une ligne par décision de ban** : l'état du veto avant la décision
(maps restantes, numéro du tour, camp et capitaine qui bannit, elo et niveau
moyens des deux équipes, région, date) et la map effectivement bannie, qui est la
cible à prédire.

C'est le format adapté à un modèle de politique : on apprend à prédire *le
prochain ban*, puis on déroule le modèle dans la simulation Monte-Carlo déjà
présente dans l'extension pour obtenir la map finale.

## Volume

Un veto représente environ six lignes. Quelques dizaines de milliers de matchs
suffisent largement à entraîner un modèle à sept classes — l'ordre de grandeur
utile se compte en dizaines de milliers, pas en millions.

## Bonne conduite

Une seule adresse IP, un débit modéré, pas de rotation de proxy ni de
contournement de protection : `--rps 3` reste très en dessous des limites et
n'inquiète personne. Si un `429` survient, le client attend et réessaie tout seul.
Inutile d'aller plus vite : le facteur limitant est le volume total à collecter
une bonne fois, pas le débit instantané.
