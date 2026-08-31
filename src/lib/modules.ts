/**
 * The module registry.
 *
 * Every house runs differently — some split money and never formalize chores,
 * some do the opposite. A household enables the components it wants; the
 * database only stores which keys are on (see `household_modules`), so shipping
 * a new module is a change to this file plus its routes, never a migration.
 *
 * Keys are a stable contract: once a key ships, renaming it orphans every
 * household that toggled it. Add a new key and migrate instead.
 */

export type ModuleKey = 'chores' | 'expenses' | 'kiosk';

export type ModuleDef = {
  key: ModuleKey;
  name: string;
  /** One line, written for the admin deciding whether their house needs it. */
  tagline: string;
  emoji: string;
  defaultEnabled: boolean;
  /** Tab-bar / rail entry. Omit for modules with no page of their own. */
  nav?: { href: string; label: string; icon: 'Chores' | 'Money' | 'Chart' };
  /** Route prefixes that 404 when the module is off. */
  routes: string[];
  /** Turning this off hides data rather than deleting it — say so in the UI. */
  reversible: true;
};

export const MODULES: ModuleDef[] = [
  {
    key: 'chores',
    name: 'Chores',
    tagline: 'A fixed rotation per chore, scheduled or on-demand. The fridge chart, counted.',
    emoji: '🧹',
    defaultEnabled: true,
    nav: { href: '/chores', label: 'Chores', icon: 'Chores' },
    routes: ['/chores'],
    reversible: true,
  },
  {
    key: 'expenses',
    name: 'Shared costs',
    tagline: 'Split expenses, scan receipts, and settle up in the fewest transfers.',
    emoji: '💸',
    defaultEnabled: true,
    nav: { href: '/expenses', label: 'Money', icon: 'Money' },
    routes: ['/expenses'],
    reversible: true,
  },
  {
    key: 'kiosk',
    name: 'Wall display',
    tagline: 'A always-on view for a tablet in the kitchen. No login, refreshes itself.',
    emoji: '📺',
    defaultEnabled: true,
    routes: ['/kiosk'],
    reversible: true,
  },
];

export const MODULE_BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

export const DEFAULT_MODULES: ModuleKey[] = MODULES.filter((m) => m.defaultEnabled).map((m) => m.key);

export function isEnabled(enabled: string[], key: ModuleKey): boolean {
  return enabled.includes(key);
}

/** Nav entries for the modules this household actually runs, in registry order. */
export function navFor(enabled: string[]) {
  return MODULES.filter((m) => m.nav && enabled.includes(m.key)).map((m) => ({
    ...m.nav!,
    key: m.key,
  }));
}

/** Which module owns a path, if any. Longest prefix wins. */
export function moduleForPath(pathname: string): ModuleDef | null {
  let best: ModuleDef | null = null;
  let bestLength = 0;
  for (const mod of MODULES) {
    for (const route of mod.routes) {
      if ((pathname === route || pathname.startsWith(`${route}/`)) && route.length > bestLength) {
        best = mod;
        bestLength = route.length;
      }
    }
  }
  return best;
}
