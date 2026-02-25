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
  private mplusIntervalId: ReturnType<typeof setInterval> | null = null;
  private raidIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(client: Client) {
    this.client = client;
  }

  private getChannel(): TextChannel | undefined {
    return this.client.channels.cache.get(process.env.DISCORD_CHANNEL_ID!) as TextChannel | undefined;
  }

  start(): void {
    const mplusMinutes = parseInt(process.env.POLL_INTERVAL ?? '10', 10) || 10;
    const raidMinutes = parseInt(process.env.RAID_POLL_INTERVAL ?? '3', 10) || 3;
    console.log(`[Tracker] M+ toutes les ${mplusMinutes} minutes, Raids toutes les ${raidMinutes} minutes`);

    // Premières vérifications après 30s (laisser le temps aux données initiales)
    setTimeout(() => this.checkAllMythicPlus(), 30_000);
    setTimeout(() => this.checkAllRaids(), 30_000);

    this.mplusIntervalId = setInterval(
      () => this.checkAllMythicPlus(),
      mplusMinutes * 60 * 1000
    );

    this.raidIntervalId = setInterval(
      () => this.checkAllRaids(),
      raidMinutes * 60 * 1000
    );
  }

  stop(): void {
    if (this.mplusIntervalId) {
      clearInterval(this.mplusIntervalId);
      this.mplusIntervalId = null;
    }
    if (this.raidIntervalId) {
      clearInterval(this.raidIntervalId);
      this.raidIntervalId = null;
    }
  }

  async checkAllMythicPlus(): Promise<void> {
    const characters = store.getCharacters();
    if (characters.length === 0) return;

    console.log(`[Tracker] Vérification M+ de ${characters.length} personnage(s)...`);

    for (const char of characters) {
      try {
        await this.checkMythicPlus(char);
      } catch (err) {
        console.error(`[Tracker] Erreur M+ pour ${char.name}-${char.realm}:`, (err as Error).message);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log('[Tracker] Vérification M+ terminée.');
  }

  async checkAllRaids(): Promise<void> {
    const characters = store.getCharacters();
    if (characters.length === 0) return;

    console.log(`[Tracker] Vérification Raids de ${characters.length} personnage(s)...`);

    for (const char of characters) {
      try {
        await this.checkRaids(char);
      } catch (err) {
        console.error(`[Tracker] Erreur Raids pour ${char.name}-${char.realm}:`, (err as Error).message);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log('[Tracker] Vérification Raids terminée.');
  }

  async checkAll(): Promise<void> {
    await this.checkAllMythicPlus();
    await this.checkAllRaids();
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

      await this.announceMythicPlus(char, previousRating, profile, improvedRuns, char.bestRuns);
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
      let guildName: string | undefined;
      let guildEmblemUrl: string | undefined;

      try {
        const charInfo = await blizzard.getCharacterInfo(char.realm, char.name);
        if (charInfo?.guildName && charInfo?.guildRealm) {
          guildName = charInfo.guildName;
          const emblemUrl = await blizzard.getGuildEmblemUrl(charInfo.guildRealm, charInfo.guildName);
          if (emblemUrl) guildEmblemUrl = emblemUrl;
        }
      } catch (err) {
        console.error(`[Tracker] Impossible de récupérer la guilde pour ${char.name}-${char.realm}:`, (err as Error).message);
      }

      await this.announceRaidKills(char, newKills, guildName, guildEmblemUrl);
    }

    // Toujours sauvegarder TOUTE la progression (évite les re-alertes au prochain cycle)
    store.updateCharacter(char.name, char.realm, { raidKills: progression });
  }

  async simulate(): Promise<void> {
    const fakeImprovedRuns: MythicPlusRun[] = [
      {
        dungeonId: 501,
        dungeonName: 'The Stonevault',
        keystoneLevel: 12,
        duration: 1725000,  // 28:45
        completedInTime: true,
        rating: 245.3,
      },
      {
        dungeonId: 502,
        dungeonName: 'Ara-Kara, City of Echoes',
        keystoneLevel: 10,
        duration: 2190000,  // 36:30
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

    const fakeOldRuns: MythicPlusRun[] = [
      {
        dungeonId: 501,
        dungeonName: 'The Stonevault',
        keystoneLevel: 10,
        duration: 1900000,
        completedInTime: true,
        rating: 200.0,
      },
      {
        dungeonId: 502,
        dungeonName: 'Ara-Kara, City of Echoes',
        keystoneLevel: 8,
        duration: 2400000,
        completedInTime: false,
        rating: 135.2,
      },
    ];

    await this.announceMythicPlus(fakeChar, 2380.2, fakeProfile, fakeImprovedRuns, fakeOldRuns);

    // Raid kill : données réelles de Nithoam-Sargeras (guilde + emblème)
    let guildName: string | undefined;
    let guildEmblemUrl: string | undefined;
    const simChar: TrackedCharacter = {
      name: 'nithoam',
      realm: 'sargeras',
      lastRating: 0,
      raidKills: {},
    };

    try {
      const charInfo = await blizzard.getCharacterInfo(simChar.realm, simChar.name);
      if (charInfo?.guildName && charInfo?.guildRealm) {
        guildName = charInfo.guildName;
        const emblemUrl = await blizzard.getGuildEmblemUrl(charInfo.guildRealm, charInfo.guildName);
        if (emblemUrl) guildEmblemUrl = emblemUrl;
      }
    } catch (err) {
      console.error('[Simulate] Impossible de récupérer la guilde:', (err as Error).message);
    }

    await this.announceRaidKills(simChar, [
      { raidName: 'Liberation of Undermine', difficulty: 'heroic', boss: 'Vexie and the Geargrinders' },
      { raidName: 'Liberation of Undermine', difficulty: 'heroic', boss: 'Cauldron of Carnage' },
    ], guildName, guildEmblemUrl);
  }

  private async announceMythicPlus(
    char: TrackedCharacter,
    previousRating: number,
    profile: MythicPlusProfile,
    improvedRuns: MythicPlusRun[],
    oldRuns?: MythicPlusRun[]
  ): Promise<void> {
    const channel = this.getChannel();
    if (!channel) return;

    const ratingColor = profile.color
      ? (profile.color.r << 16) + (profile.color.g << 8) + profile.color.b
      : 0x00aff4;

    const oldByDungeon = new Map<string, MythicPlusRun>();
    if (oldRuns) {
      for (const run of oldRuns) oldByDungeon.set(run.dungeonName, run);
    }

    for (const run of improvedRuns) {
      const timeStr = formatDuration(run.duration);
      let timerPart: string;
      try {
        const parTime = run.dungeonId ? await blizzard.getDungeonTimerLimit(run.dungeonId) : 0;
        if (parTime > 0) {
          timerPart = `${timeStr} / ${formatDuration(parTime)} (${formatTimeDiff(run.duration, parTime)})`;
        } else {
          timerPart = `${timeStr} (${run.completedInTime ? 'dans les temps' : 'hors temps'})`;
        }
      } catch {
        timerPart = `${timeStr} (${run.completedInTime ? 'dans les temps' : 'hors temps'})`;
      }

      const oldRun = oldByDungeon.get(run.dungeonName);
      const oldScore = oldRun?.rating ?? 0;
      const ratingGain = Math.round((run.rating - oldScore) * 10) / 10;
      const newScore = Math.round((previousRating + ratingGain) * 10) / 10;

      const embed = new EmbedBuilder()
        .setTitle(`Mythic+ Rating Up!`)
        .setDescription(
          `**${capitalize(char.name)}**-${capitalize(char.realm)} a terminé un **+${run.keystoneLevel} ${run.dungeonName}** !`
        )
        .addFields(
          { name: 'Timer', value: timerPart, inline: false },
          { name: 'Ancien score', value: `${previousRating}`, inline: true },
          { name: 'Nouveau score', value: `**${newScore}**`, inline: true },
          { name: 'Gain', value: `+${ratingGain}`, inline: true },
        )
        .setColor(ratingColor)
        .setTimestamp();

      await channel.send({ embeds: [embed] });

      // Avancer previousRating pour le prochain donjon dans la même série
      previousRating = newScore;
    }
  }

  private async announceRaidKills(
    char: TrackedCharacter,
    newKills: NewKill[],
    guildName?: string,
    guildEmblemUrl?: string,
  ): Promise<void> {
    const channel = this.getChannel();
    if (!channel) return;

    for (const kill of newKills) {
      const color = DIFFICULTY_COLORS[kill.difficulty] ?? 0xffffff;
      const diffLabel = DIFFICULTY_LABELS[kill.difficulty] ?? kill.difficulty;

      const descParts = [`**${capitalize(char.name)}**-${capitalize(char.realm)}`];
      if (guildName) descParts.push(`<${guildName}>`);
      descParts.push('a vaincu pour la première fois :');

      const embed = new EmbedBuilder()
        .setTitle(`Nouveau Boss Kill !`)
        .setDescription(descParts.join(' '))
        .addFields({ name: `${kill.boss} (${diffLabel})`, value: kill.raidName })
        .setColor(color)
        .setTimestamp();

      if (guildEmblemUrl) embed.setThumbnail(guildEmblemUrl);

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

function formatTimeDiff(duration: number, parTime: number): string {
  const diffMs = duration - parTime;
  const sign = diffMs <= 0 ? '-' : '+';
  const absDiff = Math.abs(diffMs);
  const totalSeconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${sign}${minutes}:${seconds.toString().padStart(2, '0')}`;
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
