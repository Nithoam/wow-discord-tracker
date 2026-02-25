import axios from 'axios';
import type { RaidProgression } from './store';

const API_BASE = 'https://eu.api.blizzard.com';
const TOKEN_URL = 'https://oauth.battle.net/token';

let accessToken: string | null = null;
let tokenExpiresAt = 0;

export interface RatingColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface MythicPlusRun {
  dungeonId: number;
  dungeonName: string;
  keystoneLevel: number;
  duration: number;       // en millisecondes
  completedInTime: boolean;
  rating: number;         // contribution de cette run au score
}

export interface MythicPlusProfile {
  rating: number;
  color: RatingColor | null;
  bestRuns: MythicPlusRun[];
}

export interface CharacterInfo {
  name: string;
  realm: string;
  class: string;
  level: number;
  faction: string;
  guildName?: string;
  guildRealm?: string;
}

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt) {
    return accessToken;
  }

  const response = await axios.post(TOKEN_URL, 'grant_type=client_credentials', {
    auth: {
      username: process.env.BLIZZARD_CLIENT_ID!,
      password: process.env.BLIZZARD_CLIENT_SECRET!,
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  accessToken = response.data.access_token as string;
  // Refresh 60s before expiry
  tokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;
  return accessToken;
}

async function apiGet(path: string, namespace: string): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  const response = await axios.get(`${API_BASE}${path}`, {
    params: {
      namespace: `${namespace}-eu`,
      locale: 'fr_FR',
    },
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return response.data;
}

/**
 * Récupère le profil Mythic+ d'un personnage (saison en cours).
 * Retourne { rating, bestRuns } ou null si pas de données.
 */
export async function getMythicPlusProfile(realmSlug: string, characterName: string): Promise<MythicPlusProfile | null> {
  try {
    const data = await apiGet(
      `/profile/wow/character/${realmSlug}/${characterName.toLowerCase()}/mythic-keystone-profile`,
      'profile'
    ) as Record<string, any>;

    const currentSeason = data.current_period?.best_runs
      ? data.current_period
      : data.seasons?.[0];

    const rawRuns: any[] = currentSeason?.best_runs ?? [];
    const bestRuns: MythicPlusRun[] = rawRuns.map((run: any) => ({
      dungeonId: (run.dungeon?.id ?? 0) as number,
      dungeonName: (run.dungeon?.name ?? 'Unknown') as string,
      keystoneLevel: (run.keystone_level ?? 0) as number,
      duration: (run.duration ?? 0) as number,
      completedInTime: (run.is_completed_within_time ?? false) as boolean,
      rating: (run.map_rating?.rating ?? run.rating?.rating ?? 0) as number,
    }));

    return {
      rating: (data.current_mythic_rating?.rating ?? data.mythic_rating?.rating ?? 0) as number,
      color: (data.current_mythic_rating?.color ?? data.mythic_rating?.color ?? null) as RatingColor | null,
      bestRuns,
    };
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

export interface RaidProgressionResult {
  /** Progression complète (toutes extensions) — pour le stockage */
  progression: RaidProgression;
  /** Noms des raids de l'extension la plus récente — pour filtrer les alertes */
  currentExpansionRaids: string[];
}

/**
 * Récupère la progression raid d'un personnage.
 * Retourne toute la progression + la liste des raids de l'extension courante.
 */
export async function getRaidProgression(realmSlug: string, characterName: string): Promise<RaidProgressionResult> {
  try {
    const data = await apiGet(
      `/profile/wow/character/${realmSlug}/${characterName.toLowerCase()}/encounters/raids`,
      'profile'
    ) as Record<string, any>;

    const progression: RaidProgression = {};
    const currentExpansionRaids: string[] = [];
    const expansions: any[] = data.expansions ?? [];

    // Trouver l'extension la plus récente (plus grand id)
    let latestExpansion: any = null;
    let latestExpansionId = -1;
    for (const exp of expansions) {
      const expId: number = exp?.expansion?.id ?? 0;
      if (expId > latestExpansionId) {
        latestExpansionId = expId;
        latestExpansion = exp;
      }
    }

    // Collecter les noms de raids de l'extension courante
    if (latestExpansion) {
      for (const instance of latestExpansion.instances ?? []) {
        const name: string = instance.instance?.name ?? 'Unknown';
        currentExpansionRaids.push(name);
      }
    }

    // Traiter TOUTES les extensions pour le stockage complet
    for (const exp of expansions) {
      for (const instance of exp.instances ?? []) {
        const raidName: string = instance.instance?.name ?? 'Unknown';
        progression[raidName] = {};

        for (const mode of instance.modes ?? []) {
          const difficulty: string = mode.difficulty?.type?.toLowerCase() ?? 'normal';
          const killedBosses: string[] = (mode.progress?.encounters ?? [])
            .filter((e: any) => e.completed_count > 0)
            .map((e: any) => e.encounter?.name ?? 'Unknown');

          progression[raidName][difficulty] = killedBosses;
        }
      }
    }

    return { progression, currentExpansionRaids };
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return { progression: {}, currentExpansionRaids: [] };
    throw err;
  }
}

/**
 * Cache mémoire pour les timers de donjon M+ (ne change pas pendant une saison).
 */
const dungeonTimerCache = new Map<number, number>();

/**
 * Récupère le temps limite (par time) d'un donjon M+ en millisecondes.
 * Utilise keystone_upgrades[0].qualifying_duration (seuil +1 upgrade = timer du donjon).
 * Résultat caché en mémoire car statique par saison.
 */
export async function getDungeonTimerLimit(dungeonId: number): Promise<number> {
  const cached = dungeonTimerCache.get(dungeonId);
  if (cached !== undefined) return cached;

  const data = await apiGet(
    `/data/wow/mythic-keystone/dungeon/${dungeonId}`,
    'dynamic'
  ) as Record<string, any>;

  const upgrades: any[] = data.keystone_upgrades ?? [];
  const parTime: number = upgrades[0]?.qualifying_duration ?? 0;

  dungeonTimerCache.set(dungeonId, parTime);
  return parTime;
}

/**
 * Récupère les infos de base du personnage (classe, niveau, avatar).
 */
export async function getCharacterInfo(realmSlug: string, characterName: string): Promise<CharacterInfo | null> {
  try {
    const data = await apiGet(
      `/profile/wow/character/${realmSlug}/${characterName.toLowerCase()}`,
      'profile'
    ) as Record<string, any>;

    return {
      name: data.name as string,
      realm: (data.realm?.name ?? realmSlug) as string,
      class: (data.character_class?.name ?? 'Inconnu') as string,
      level: (data.level ?? 0) as number,
      faction: (data.faction?.name ?? 'Inconnu') as string,
      guildName: (data.guild?.name as string) ?? undefined,
      guildRealm: (data.guild?.realm?.slug as string) ?? undefined,
    };
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Cache mémoire pour les emblèmes de guilde (changent rarement).
 */
const guildEmblemCache = new Map<string, string | null>();

/**
 * Récupère l'URL de l'emblème d'une guilde via l'API guild crest.
 * Retourne null si la guilde n'a pas d'emblème ou en cas d'erreur.
 */
export async function getGuildEmblemUrl(realmSlug: string, guildName: string): Promise<string | null> {
  const guildSlug = guildName.toLowerCase().replace(/ /g, '-');
  const cacheKey = `${realmSlug}/${guildSlug}`;

  const cached = guildEmblemCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const data = await apiGet(
      `/data/wow/guild/${realmSlug}/${guildSlug}`,
      'profile'
    ) as Record<string, any>;

    const mediaHref: string | undefined = data.crest?.emblem?.media?.key?.href;
    if (!mediaHref) {
      guildEmblemCache.set(cacheKey, null);
      return null;
    }

    const token = await getAccessToken();
    const mediaResponse = await axios.get(mediaHref, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const url: string | undefined = mediaResponse.data?.assets?.[0]?.value;
    const result = url ?? null;
    guildEmblemCache.set(cacheKey, result);
    return result;
  } catch {
    guildEmblemCache.set(cacheKey, null);
    return null;
  }
}
