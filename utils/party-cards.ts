// "Player" cards for FACEIT groups — the same React component is reused on
// every page where a team is assembled:
//   • /matchmaking            (the 5 slots of the queue)
//   • /club/{id}/parties      (the club's open groups)
//   • creating / editing a group
//
// Structure (styled-components: the `-sc-xxxxx` hashes change on every FACEIT
// deploy, the semantic prefixes are stable):
//
//   div[Draggable__DraggableStyled … styles__Container]      <- the card
//     div[styles__Container]  > avatar
//     div[styles__Container]  > span[styles__Nickname] + flag/verified badge
//     div[Tag__Container]     > svg(level) + span[styles__EloText]   <- badge anchor
//
// We start from the ELO (the most specific landmark: the page's other
// `Tag__Container` elements — "CS2", "EU", "French"… — don't contain one) then
// walk up one level to find the card and read the nickname from it.

export interface PartyCard {
  /** Card container (flex column: avatar, nickname, level+ELO). */
  card: HTMLElement;
  /** Full FACEIT nickname — the on-screen ellipsis is purely CSS. */
  nickname: string;
  /** "Level + ELO" pill: the Premier badge gets placed right after it. */
  anchor: HTMLElement;
}

/**
 * Player cards present in the page. Room cards (`ListContentPlayer`) are
 * excluded: they have their own badge slot, handled separately.
 */
export function findPartyCards(): PartyCard[] {
  const found: PartyCard[] = [];
  for (const elo of document.querySelectorAll<HTMLElement>('[class*="EloText"]')) {
    const anchor = elo.closest<HTMLElement>('[class*="Tag__Container"]');
    const card = anchor?.parentElement;
    if (!anchor || !card) continue;
    if (card.closest('[class*="ListContentPlayer"]')) continue; // room card
    const nickname = card.querySelector<HTMLElement>('[class*="Nickname"]')?.textContent?.trim();
    if (!nickname) continue;
    found.push({ card, nickname, anchor });
  }
  return found;
}

/**
 * True if the element is in the viewport or just next to it. A club page can
 * easily list dozens of groups: we only resolve Premier (~2 network requests
 * per player, serialized on the csstats side) for what the user can actually see.
 */
export function isNearViewport(el: HTMLElement, margin = 400): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false; // hidden / detached
  return rect.bottom > -margin && rect.top < window.innerHeight + margin;
}
