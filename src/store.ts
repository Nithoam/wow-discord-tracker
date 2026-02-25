import fs from 'fs';
import path from 'path';
import type { MythicPlusRun } from './blizzard';

export interface RaidProgression {
  [raidName: string]: {
    [difficulty: string]: string[];
  };
}

export interface TrackedCharacter {
  name: string;
  realm: string;
  lastRating: number;
  raidKills: RaidProgression;
  bestRuns?: MythicPlusRun[];
}

interface TrackedData {
  characters: TrackedCharacter[];
}

const DATA_FILE = path.join(__dirname, '..', 'data', 'tracked.json');

function getDefaultData(): TrackedData {
  return { characters: [] };
}

function load(): TrackedData {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw) as TrackedData;
  } catch {
    return getDefaultData();
  }
}

function save(data: TrackedData): void {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export function addCharacter(name: string, realm: string): boolean {
  const data = load();
  const realmSlug = realm.toLowerCase().replace(/\s+/g, '-');
  const exists = data.characters.some(
    (c) => c.name.toLowerCase() === name.toLowerCase() && c.realm === realmSlug
  );

  if (exists) return false;

  data.characters.push({
    name: name.toLowerCase(),
    realm: realmSlug,
    lastRating: 0,
    raidKills: {},
  });
  save(data);
  return true;
}

export function removeCharacter(name: string, realm: string): boolean {
  const data = load();
  const realmSlug = realm.toLowerCase().replace(/\s+/g, '-');
  const before = data.characters.length;

  data.characters = data.characters.filter(
    (c) => !(c.name.toLowerCase() === name.toLowerCase() && c.realm === realmSlug)
  );

  if (data.characters.length === before) return false;

  save(data);
  return true;
}

export function getCharacters(): TrackedCharacter[] {
  return load().characters;
}

export function updateCharacter(name: string, realm: string, updates: Partial<TrackedCharacter>): boolean {
  const data = load();
  const realmSlug = realm.toLowerCase().replace(/\s+/g, '-');
  const char = data.characters.find(
    (c) => c.name.toLowerCase() === name.toLowerCase() && c.realm === realmSlug
  );

  if (!char) return false;

  Object.assign(char, updates);
  save(data);
  return true;
}
