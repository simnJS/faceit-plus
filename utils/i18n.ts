// Traductions de FACEIT+ (français / anglais).
// La langue suit le réglage utilisateur ; en mode « auto » elle est déduite de
// l'URL FACEIT (/fr/, /en/…) puis de la langue du navigateur.

export type Lang = 'fr' | 'en';
export type LangSetting = 'auto' | Lang;

const MESSAGES = {
  fr: {
    'panel.title': 'Réglages',
    'panel.close': 'Fermer',
    'section.display': 'Affichage',
    'section.autoAccept': 'Acceptation automatique',
    'section.autoVeto': 'Ban automatique de maps',
    'section.language': 'Langue',
    'display.flags': 'Drapeaux de pays',
    'display.flags.hint': 'À côté des pseudos',
    'display.premier': 'Rang CS2 Premier',
    'display.premier.hint': 'Devant le niveau FACEIT',
    'display.mapStats': 'K/D par map',
    'display.mapStats.hint': 'Sous chaque joueur',
    'display.vetoStats': 'Stats de veto',
    'display.vetoStats.hint': 'Winrate et ban rate sur les tuiles',
    'display.roles': 'Rôle estimé',
    'role.tooltip': 'Rôle estimé sur {matches} matchs',
    'role.notEnough': 'Pas assez de matchs pour estimer le rôle',
    'role.unknown': 'INCONNU',
    'display.vetoAdvice': 'Conseil de veto',
    'display.smurf': 'Comptes suspects',
    'veto.banAdvice': 'À BANNIR',
    'veto.banAdviceTooltip': 'Meilleur ban : ils ont {delta} points de winrate de plus que vous ici',
    'veto.likely': 'PROBABLE {p}%',
    'veto.likelyTooltip': 'Map la plus susceptible d’être jouée, d’après les bans restants',
    'smurf.badge': 'SMURF ?',
    'smurf.tooltip':
      'Combinaison inhabituelle : compte de {age}, {matches} matchs, {winrate}% de victoires, {kd} K/D, {hs}% HS',
    'smurf.gap': ' — soit {gap} de K/D au-dessus du niveau {level}',
    'smurf.days': '{n} j',
    'smurf.months': '{n} mois',
    'smurf.years': '{n} ans',
    'smurf.unknownAge': 'date inconnue',
    'common.enable': 'Activer',
    'common.delay': 'Délai',
    'common.seconds': 's',
    'autoAccept.hint': 'Accepte le match dès que le pop-up apparaît.',
    'autoVeto.hint': 'Ne s’applique que si vous êtes capitaine.',
    'autoVeto.mode.order': 'Ordre choisi',
    'autoVeto.mode.winrate': 'Pire winrate',
    'autoVeto.order.hint': 'La première map de la liste est bannie en premier.',
    'autoVeto.winrate.hint': 'Bannit la map où votre équipe a le plus mauvais winrate.',
    'lang.auto': 'Auto',
    'toast.matchReady': 'Match prêt',
    'toast.accepting': 'Acceptation dans {s} s…',
    'toast.autoBan': 'Ban automatique',
    'toast.banning': 'Ban de {map} dans {s} s…',
    'toast.cancel': 'Annuler',
    'veto.team1': 'Équipe 1',
    'veto.team2': 'Équipe 2',
    'veto.winrateTooltip': '{team} · winrate sur {games} matchs cumulés',
    'veto.banRateTooltip': 'Probabilité que le capitaine adverse bannisse cette map',
    'map.kdTooltip': '{map} · K/D sur {games} matchs',
    'map.notEnough': '{map} · pas assez de matchs',
    'map.banned': '{map} · bannie au veto',
    'map.expand': 'Voir toutes les maps du pool',
    'map.collapse': 'Masquer les maps bannies',
    'map.collapseLabel': 'Réduire',
  },
  en: {
    'panel.title': 'Settings',
    'panel.close': 'Close',
    'section.display': 'Display',
    'section.autoAccept': 'Auto accept',
    'section.autoVeto': 'Auto map ban',
    'section.language': 'Language',
    'display.flags': 'Country flags',
    'display.flags.hint': 'Next to nicknames',
    'display.premier': 'CS2 Premier rank',
    'display.premier.hint': 'Before the FACEIT level',
    'display.mapStats': 'K/D per map',
    'display.mapStats.hint': 'Under each player',
    'display.vetoStats': 'Veto stats',
    'display.vetoStats.hint': 'Winrate and ban rate on tiles',
    'display.roles': 'Estimated role',
    'role.tooltip': 'Role estimated over {matches} matches',
    'role.notEnough': 'Not enough matches to estimate the role',
    'role.unknown': 'UNKNOWN',
    'display.vetoAdvice': 'Veto advice',
    'display.smurf': 'Suspicious accounts',
    'veto.banAdvice': 'BAN THIS',
    'veto.banAdviceTooltip': 'Best ban: they are {delta} winrate points ahead of you here',
    'veto.likely': 'LIKELY {p}%',
    'veto.likelyTooltip': 'Most likely map to be played, based on the remaining bans',
    'smurf.badge': 'SMURF?',
    'smurf.tooltip':
      'Unusual combination: {age} old account, {matches} matches, {winrate}% win rate, {kd} K/D, {hs}% HS',
    'smurf.gap': ' — that is {gap} K/D above what level {level} implies',
    'smurf.days': '{n}d',
    'smurf.months': '{n} months',
    'smurf.years': '{n} years',
    'smurf.unknownAge': 'unknown date',
    'common.enable': 'Enable',
    'common.delay': 'Delay',
    'common.seconds': 's',
    'autoAccept.hint': 'Accepts the match as soon as the pop-up shows up.',
    'autoVeto.hint': 'Only applies when you are the captain.',
    'autoVeto.mode.order': 'Chosen order',
    'autoVeto.mode.winrate': 'Worst winrate',
    'autoVeto.order.hint': 'The first map in the list gets banned first.',
    'autoVeto.winrate.hint': 'Bans the map where your team has the worst winrate.',
    'lang.auto': 'Auto',
    'toast.matchReady': 'Match ready',
    'toast.accepting': 'Accepting in {s}s…',
    'toast.autoBan': 'Auto ban',
    'toast.banning': 'Banning {map} in {s}s…',
    'toast.cancel': 'Cancel',
    'veto.team1': 'Team 1',
    'veto.team2': 'Team 2',
    'veto.winrateTooltip': '{team} · winrate over {games} combined matches',
    'veto.banRateTooltip': 'Odds the enemy captain bans this map',
    'map.kdTooltip': '{map} · K/D over {games} matches',
    'map.notEnough': '{map} · not enough matches',
    'map.banned': '{map} · banned in veto',
    'map.expand': 'Show every map in the pool',
    'map.collapse': 'Hide banned maps',
    'map.collapseLabel': 'Collapse',
  },
} as const;

export type MessageKey = keyof (typeof MESSAGES)['fr'];
export type Translator = (key: MessageKey, params?: Record<string, string | number>) => string;

/** Langue déduite de l'URL FACEIT puis du navigateur. */
export function detectLang(): Lang {
  const fromPath = location.pathname.match(/^\/([a-z]{2})\//)?.[1];
  if (fromPath === 'fr') return 'fr';
  if (fromPath && fromPath !== 'fr') return 'en';
  return navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function resolveLang(setting: LangSetting): Lang {
  return setting === 'auto' ? detectLang() : setting;
}

export function createTranslator(setting: LangSetting): Translator {
  const lang = resolveLang(setting);
  return (key, params) => {
    let text: string = MESSAGES[lang][key] ?? MESSAGES.en[key] ?? key;
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replace(`{${name}}`, String(value));
      }
    }
    return text;
  };
}
