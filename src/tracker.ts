import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import * as blizzard from './blizzard';
import * as store from './store';
import type { TrackedCharacter } from './store';
import type { MythicPlusProfile, MythicPlusRun } from './blizzard';

const DIFFICULTY_LABELS: Record<string, string> = {
  normal: 'Normal',
  heroic: 'Héroïque',
  mythic: 'Mythique',
};

const DIFFICULTY_COLORS: Record<string, number> = {
  normal: 0x1eff00,   // Vert
  heroic: 0xa335ee,   // Violet
  mythic: 0xff8000,   // Orange
};

interface NewKill {
  raidName: string;
  difficulty: string;
  boss: string;
}

export default class Tracker {
  private client: Client;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(client: Client) {
    this.client = client;
  }

  private getChannel(): TextChannel | undefined {
    return this.client.channels.cache.get(process.env.DISCORD_CHANNEL_ID!) as TextChannel | undefined;
  }

  start(): void {
    const intervalMinutes = parseInt(process.env.POLL_INTERVAL ?? '10', 10) || 10;
    console.log(`[Tracker] Vérification toutes les ${intervalMinutes} minutes`);

    // Première vérification après 30s (laisser le temps aux données initiales)
    setTimeout(() => this.checkAll(), 30_000);

    this.intervalId = setInterval(
      () => this.checkAll(),
      intervalMinutes * 60 * 1000
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async checkAll(): Promise<void> {
    const characters = store.getCharacters();
    if (characters.length === 0) return;

    console.log(`[Tracker] Vérification de ${characters.length} personnage(s)...`);

    for (const char of characters) {
      try {
        await this.checkCharacter(char);
      } catch (err) {
        console.error(`[Tracker] Erreur pour ${char.name}-${char.realm}:`, (err as Error).message);
      }

      // Pause entre chaque personnage pour ne pas surcharger l'API
      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log('[Tracker] Vérification terminée.');
  }

  private async checkCharacter(char: TrackedCharacter): Promise<void> {
    await this.checkMythicPlus(char);
    await this.checkRaids(char);
  }

  private async checkMythicPlus(char: TrackedCharacter): Promise<void> {
    const profile = await blizzard.getMythicPlusProfile(char.realm, char.name);
    if (!profile) return;

    const currentRating = Math.round(profile.rating * 10) / 10;
    const previousRating = char.lastRating || 0;

    if (currentRating > previousRating && previousRating > 0) {
      const gain = Math.round((currentRating - previousRating) * 10) / 10;

      // Trouver les runs améliorées
      const improvedRuns = findImprovedRuns(char.bestRuns, profile.bestRuns);

      await this.announceMythicPlus(char, currentRating, previousRating, gain, profile, improvedRuns);
    }

    // Toujours mettre à jour le rating et les bestRuns (même au premier check)
    store.updateCharacter(char.name, char.realm, { lastRating: currentRating, bestRuns: profile.bestRuns });
  }

  private async checkRaids(char: TrackedCharacter): Promise<void> {
    const result = await blizzard.getRaidProgression(char.realm, char.name);
    const { progression, currentExpansionRaids } = result;
    if (Object.keys(progression).length === 0) return;

    const previousKills = char.raidKills || {};
    const newKills: NewKill[] = [];

    // Ne chercher des nouveaux kills que dans les raids de l'extension courante
    for (const raidName of currentExpansionRaids) {
      const modes = progression[raidName];
      if (!modes) continue;

      // Ignorer les raids pas encore suivis (première détection)
      if (!previousKills[raidName]) continue;

      for (const [difficulty, bosses] of Object.entries(modes)) {
        const prevBosses = previousKills[raidName]?.[difficulty] ?? [];

        for (const boss of bosses) {
          if (!prevBosses.includes(boss)) {
            newKills.push({ raidName, difficulty, boss });
          }
        }
      }
    }

    if (newKills.length > 0 && Object.keys(previousKills).length > 0) {
      await this.announceRaidKills(char, newKills);
    }

    // Toujours sauvegarder TOUTE la progression (évite les re-alertes au prochain cycle)
    store.updateCharacter(char.name, char.realm, { raidKills: progression });
  }

  async simulate(): Promise<void> {
    const fakeImprovedRuns: MythicPlusRun[] = [
      {
        dungeonName: 'The Stonevault',
        keystoneLevel: 12,
        duration: 1725000,  // 28:45
        completedInTime: true,
        rating: 245.3,
      },
      {
        dungeonName: 'Ara-Kara, City of Echoes',
        keystoneLevel: 10,
        duration: 2100000,  // 35:00
        completedInTime: false,
        rating: 180.5,
      },
    ];

    const fakeChar: TrackedCharacter = {
      name: 'Thrallion',
      realm: 'hyjal',
      lastRating: 0,
      raidKills: {},
    };

    const fakeProfile: MythicPlusProfile = {
      rating: 2450.8,
      color: { r: 0xff, g: 0x80, b: 0x00, a: 1 },
      bestRuns: fakeImprovedRuns,
    };

    await this.announceMythicPlus(fakeChar, 2450.8, 2380.2, 70.6, fakeProfile, fakeImprovedRuns);

    await this.announceRaidKills(fakeChar, [
      { raidName: 'Liberation of Undermine', difficulty: 'heroic', boss: 'Vexie and the Geargrinders' },
      { raidName: 'Liberation of Undermine', difficulty: 'heroic', boss: 'Cauldron of Carnage' },
    ]);
  }

  private async announceMythicPlus(
    char: TrackedCharacter,
    currentRating: number,
    previousRating: number,
    gain: number,
    profile: MythicPlusProfile,
    improvedRuns: MythicPlusRun[]
  ): Promise<void> {
    const channel = this.getChannel();
    if (!channel) return;

    const ratingColor = profile.color
      ? (profile.color.r << 16) + (profile.color.g << 8) + profile.color.b
      : 0x00aff4;

    const embed = new EmbedBuilder()
      .setTitle(`Mythic+ Rating Up!`)
      .setDescription(
        `**${capitalize(char.name)}**-${capitalize(char.realm)} a gagné **+${gain}** points de cote Mythic+ !`
      )
      .addFields(
        { name: 'Ancien score', value: `${previousRating}`, inline: true },
        { name: 'Nouveau score', value: `**${currentRating}**`, inline: true },
        { name: 'Gain', value: `+${gain}`, inline: true }
      )
      .setColor(ratingColor)
      .setTimestamp();

    if (improvedRuns.length > 0) {
      const runLines = improvedRuns.map((run) => {
        const timeStr = formatDuration(run.duration);
        const inTime = run.completedInTime ? 'dans les temps' : 'hors temps';
        return `+${run.keystoneLevel} ${run.dungeonName} — ${timeStr} (${inTime})`;
      });
      embed.addFields({ name: 'Donjon(s) amélioré(s)', value: runLines.join('\n') });
    }

    await channel.send({ embeds: [embed] });
  }

  private async announceRaidKills(char: TrackedCharacter, newKills: NewKill[]): Promise<void> {
    const channel = this.getChannel();
    if (!channel) return;

    // Grouper par raid et difficulté
    const grouped: Record<string, { bosses: string[]; difficulty: string }> = {};
    for (const kill of newKills) {
      const key = `${kill.raidName} (${DIFFICULTY_LABELS[kill.difficulty] ?? kill.difficulty})`;
      if (!grouped[key]) {
        grouped[key] = { bosses: [], difficulty: kill.difficulty };
      }
      grouped[key].bosses.push(kill.boss);
    }

    for (const [raidLabel, data] of Object.entries(grouped)) {
      const color = DIFFICULTY_COLORS[data.difficulty] ?? 0xffffff;
      const bossLines = data.bosses.map((b) => `- ${b}`).join('\n');

      const embed = new EmbedBuilder()
        .setTitle(`Nouveau(x) Boss Kill(s) !`)
        .setDescription(
          `**${capitalize(char.name)}**-${capitalize(char.realm)} a vaincu pour la première fois :`
        )
        .addFields({ name: raidLabel, value: bossLines })
        .setColor(color)
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    }
  }
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function findImprovedRuns(oldRuns: MythicPlusRun[] | undefined, newRuns: MythicPlusRun[]): MythicPlusRun[] {
  if (!oldRuns || oldRuns.length === 0) return [];

  const oldByDungeon = new Map<string, MythicPlusRun>();
  for (const run of oldRuns) {
    oldByDungeon.set(run.dungeonName, run);
  }

  const improved: MythicPlusRun[] = [];
  for (const run of newRuns) {
    const old = oldByDungeon.get(run.dungeonName);
    if (!old || run.rating > old.rating) {
      improved.push(run);
    }
  }

  return improved;
}
