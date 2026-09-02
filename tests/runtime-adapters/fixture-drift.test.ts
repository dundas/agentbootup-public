import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { classifyFilesystemEntries } from '../../lib/runtime-adapters/classifier.js';
import {
  serializeFixtureDriftReport,
  validateRuntimeAdapterFixtures,
} from '../../lib/runtime-adapters/fixture-drift.js';

const fixtureRoot = path.resolve(import.meta.dir, 'fixtures');
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function zipWithEmptyMembers(names: string[]) {
  return zipWithMembers(names.map((name) => ({ name })));
}

function testCrc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipWithMembers(entries: Array<{ name: string; content?: Buffer; host?: number; mode?: number; dosAttributes?: number }>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const { name, content = Buffer.alloc(0), host = 0, mode, dosAttributes = 0 } of entries) {
    const encoded = Buffer.from(name, 'utf8');
    const crc = testCrc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(encoded.length, 26);
    locals.push(local, encoded, content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((host << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(encoded.length, 28); central.writeUInt32LE(mode == null ? dosAttributes : ((mode << 16) | dosAttributes) >>> 0, 38); central.writeUInt32LE(localOffset, 42);
    centrals.push(central, encoded);
    localOffset += local.length + encoded.length + content.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

function tarGzipWithEmptyMembers(names: string[]) {
  const headers = names.map((name) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii'); header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii'); header.write('00000000000\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii'); header.fill(0x20, 148, 156); header.write(name.endsWith('/') ? '5' : '0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0');
    header.write(`${checksum}\0 `, 148, 8, 'ascii');
    return header;
  });
  return gzipSync(Buffer.concat([...headers, Buffer.alloc(1024)]));
}

async function replaceNativeArchive(copy: string, relative: string, artifact: string, bytes: Buffer, names: string[]) {
  await fs.writeFile(path.join(copy, relative, artifact), bytes);
  const metadataPath = path.join(copy, relative, 'fixture.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.artifacts[artifact] = digest(bytes);
  metadata.native_archive_integrity.members = names.length;
  metadata.native_archive_integrity.membership_sha256 = digest(Buffer.from(`${[...names].sort().join('\n')}\n`)).slice(7);
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

describe('real and synthetic fixture drift', () => {
  test('requires an explicit absolute external fixture root', async () => {
    await expect(validateRuntimeAdapterFixtures({ fixture_root: 'tests/runtime-adapters/fixtures' })).rejects.toThrow(/absolute fixture directory/i);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-root-link-'));
    const linked = path.join(temp, 'linked-fixtures');
    try {
      await fs.symlink(fixtureRoot, linked);
      await expect(validateRuntimeAdapterFixtures({ fixture_root: linked })).rejects.toThrow(/must not be a symlink/i);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });
  test('validates exact pins, tree/artifact integrity, source accounting, archive membership, and privacy', async () => {
    const first = await validateRuntimeAdapterFixtures({ fixture_root: fixtureRoot });
    const second = await validateRuntimeAdapterFixtures({ fixture_root: fixtureRoot });
    expect(first.ok).toBe(true);
    expect(first.errors).toEqual([]);
    expect(first.fixtures.map((item: any) => item.runtime_family)).toEqual(['circle_agent', 'hermes', 'openclaw', 'synthetic_security']);
    expect(first.fixtures.find((item: any) => item.runtime_family === 'hermes')).toMatchObject({
      runtime_version: '0.18.2',
      qualification_scope: 'legacy_regression_only',
    });
    expect(first.fixtures.every((item: any) => item.accounted_sources === item.discovered_sources)).toBe(true);
    expect(first.fixtures.filter((item: any) => item.native_archive).every((item: any) => item.native_archive.members > 0)).toBe(true);
    expect(serializeFixtureDriftReport(first)).toBe(serializeFixtureDriftReport(second));
    expect(serializeFixtureDriftReport(first)).not.toMatch(/\/Users\/|\/home\/[^<]|[A-Za-z]:\\Users\\/);
  });

  test('keeps the Hermes 0.18.2 fixture historical and rejects identity or disposition drift', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-hermes-legacy-'));
    const copy = path.join(temp, 'fixtures');
    try {
      await fs.cp(fixtureRoot, copy, { recursive: true });
      const metadataPath = path.join(copy, 'hermes/0.18.2-darwin-arm64-real/fixture.json');
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      delete metadata.qualification_scope;
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      let report = await validateRuntimeAdapterFixtures({ fixture_root: copy });
      expect(report.ok).toBe(false);
      expect(report.errors.join('\n')).toMatch(/qualification_scope|legacy_regression_only/i);

      metadata.qualification_scope = 'legacy_regression_only';
      metadata.runtime_version = '0.19.0';
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      report = await validateRuntimeAdapterFixtures({ fixture_root: copy });
      expect(report.ok).toBe(false);
      expect(report.errors.join('\n')).toMatch(/legacy regression fixture identity drifted/i);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  test('fails closed with actionable errors for unknown additions and drift', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-drift-'));
    const copy = path.join(temp, 'fixtures');
    try {
      await fs.cp(fixtureRoot, copy, { recursive: true });
      await fs.writeFile(path.join(copy, 'hermes/0.18.2-darwin-arm64-real/root/new-durable-state.bin'), 'unknown\n');
      const metadataPath = path.join(copy, 'openclaw/2026.6.6-darwin-arm64-real/fixture.json');
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      metadata.runtime_version = 'latest';
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      const report = await validateRuntimeAdapterFixtures({ fixture_root: copy });
      expect(report.ok).toBe(false);
      expect(report.errors.join('\n')).toMatch(/unknown fixture addition.*new-durable-state\.bin/i);
      expect(report.errors.join('\n')).toMatch(/openclaw.*no configured evidence lane/i);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });

  test('fails drift when the Circle fixture renames either canonical missing pin', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-circle-pins-'));
    const copy = path.join(temp, 'fixtures');
    try {
      await fs.cp(fixtureRoot, copy, { recursive: true });
      const metadataPath = path.join(copy, 'circle-agent/0.1.0-linux-amd64-sanitized/fixture.json');
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      metadata.missing_exact_pins = ['platform.os_version', 'platform.runtime_version'];
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      const report = await validateRuntimeAdapterFixtures({ fixture_root: copy });
      expect(report.ok).toBe(false);
      expect(report.errors.join('\n')).toMatch(/identically name missing exact Linux\/Bun pins/i);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });

  test('accounts empty directories and rejects links, unlisted native artifacts, and large binary secrets', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-entry-drift-'));
    const copy = path.join(temp, 'fixtures');
    try {
      await fs.cp(fixtureRoot, copy, { recursive: true });
      const hermes = path.join(copy, 'hermes/0.18.2-darwin-arm64-real');
      await fs.mkdir(path.join(hermes, 'root/empty-durable'));
      await fs.symlink('/etc/passwd', path.join(hermes, 'root/external-link'));
      await fs.writeFile(path.join(hermes, 'native/unlisted.zip'), Buffer.from('not-an-archive'));
      const binary = Buffer.alloc(2_100_000);
      binary.write('x-api-key: sk-proj-abcdefghijklmnopqrstuvwxyz123456', 2_050_000, 'ascii');
      await fs.writeFile(path.join(hermes, 'root/large-binary.bin'), binary);
      const report = await validateRuntimeAdapterFixtures({ fixture_root: copy });
      expect(report.ok).toBe(false);
      const errors = report.errors.join('\n');
      expect(errors).toMatch(/empty_directory.*empty-durable/i);
      expect(errors).toMatch(/symlink.*external-link/i);
      expect(errors).toMatch(/unlisted native artifact.*unlisted\.zip/i);
      expect(errors).toMatch(/large-binary\.bin.*raw secret/i);
      const hermesReport = report.fixtures.find((item: any) => item.runtime_family === 'hermes');
      expect(hermesReport.discovered_sources).toBeGreaterThan(hermesReport.accounted_sources);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });

  test('rejects structurally forged ZIP and TAR evidence even when the declared digest is updated', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-archive-drift-'));
    const copy = path.join(temp, 'fixtures');
    try {
      await fs.cp(fixtureRoot, copy, { recursive: true });
      const zipPath = path.join(copy, 'hermes/0.18.2-darwin-arm64-real/native/hermes-backup.zip');
      const zip = Buffer.from(await fs.readFile(zipPath));
      let eocd = zip.length - 22;
      while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
      const central = zip.readUInt32LE(eocd + 16);
      zip.writeUInt16LE(99, central + 10);
      await fs.writeFile(zipPath, zip);
      const hermesMetadataPath = path.join(copy, 'hermes/0.18.2-darwin-arm64-real/fixture.json');
      const hermesMetadata = JSON.parse(await fs.readFile(hermesMetadataPath, 'utf8'));
      hermesMetadata.artifacts['native/hermes-backup.zip'] = digest(zip);
      await fs.writeFile(hermesMetadataPath, `${JSON.stringify(hermesMetadata, null, 2)}\n`);

      const tarPath = path.join(copy, 'openclaw/2026.6.6-darwin-arm64-real/native/openclaw-backup.tar.gz');
      const tar = gunzipSync(await fs.readFile(tarPath));
      tar[148] ^= 1;
      const forgedTar = gzipSync(tar);
      await fs.writeFile(tarPath, forgedTar);
      const openMetadataPath = path.join(copy, 'openclaw/2026.6.6-darwin-arm64-real/fixture.json');
      const openMetadata = JSON.parse(await fs.readFile(openMetadataPath, 'utf8'));
      openMetadata.artifacts['native/openclaw-backup.tar.gz'] = digest(forgedTar);
      await fs.writeFile(openMetadataPath, `${JSON.stringify(openMetadata, null, 2)}\n`);

      const report = await validateRuntimeAdapterFixtures({ fixture_root: copy });
      expect(report.errors.join('\n')).toMatch(/unsupported ZIP compression method 99/i);
      expect(report.errors.join('\n')).toMatch(/TAR.*header checksum mismatch/i);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });

  test('rejects ZIP bit-3 declarations when no data descriptor is present', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-zip-bit3-'));
    const copy = path.join(temp, 'fixtures');
    try {
      await fs.cp(fixtureRoot, copy, { recursive: true });
      const zipPath = path.join(copy, 'hermes/0.18.2-darwin-arm64-real/native/hermes-backup.zip');
      const zip = Buffer.from(await fs.readFile(zipPath));
      let eocd = zip.length - 22;
      while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
      const central = zip.readUInt32LE(eocd + 16);
      const local = zip.readUInt32LE(central + 42);
      zip.writeUInt16LE(zip.readUInt16LE(central + 8) | 0x0008, central + 8);
      zip.writeUInt16LE(zip.readUInt16LE(local + 6) | 0x0008, local + 6);
      await fs.writeFile(zipPath, zip);
      const metadataPath = path.join(copy, 'hermes/0.18.2-darwin-arm64-real/fixture.json');
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      metadata.artifacts['native/hermes-backup.zip'] = digest(zip);
      await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      const report = await validateRuntimeAdapterFixtures({ fixture_root: copy });
      expect(report.errors.join('\n')).toMatch(/ZIP data descriptors are unsupported/i);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });

  test('rejects declared ZIP symlinks, special files, and DOS device members after rehashing', async () => {
    const required = ['state.db', '.env', 'auth.json', 'profiles/research/profile.yaml', 'skills/fixture-skill/SKILL.md'];
    const cases = [
      { entry: { name: 'link', content: Buffer.from('state.db'), host: 3, mode: 0o120777 }, pattern: /unsupported UNIX ZIP member type symlink/i },
      { entry: { name: 'pipe', host: 3, mode: 0o010644 }, pattern: /unsupported UNIX ZIP member type FIFO/i },
      { entry: { name: 'device', host: 0, dosAttributes: 0x40 }, pattern: /unsupported DOS ZIP member attributes 0x40/i },
      { entry: { name: 'dos-host-unix-mode', host: 0, mode: 0o120777 }, pattern: /unsupported DOS ZIP member attributes 0xa1ff0000/i },
      { entry: { name: 'ntfs-device', host: 10, dosAttributes: 0x40 }, pattern: /unsupported NTFS ZIP device attribute/i },
      { entry: { name: 'vfat-volume', host: 14, dosAttributes: 0x08 }, pattern: /unsupported VFAT ZIP volume-label attribute/i },
      { entry: { name: 'ntfs-reparse', host: 10, dosAttributes: 0x400 }, pattern: /unsupported NTFS ZIP reparse-point attribute/i },
      { entry: { name: 'ntfs-reserved-virtual', host: 10, dosAttributes: 0x00010000 }, pattern: /unsupported NTFS ZIP member attributes 0x10000/i },
      { entry: { name: 'vfat-ambiguous-ea-recall', host: 14, dosAttributes: 0x00040000 }, pattern: /unsupported VFAT ZIP member attributes 0x40000/i },
      { entry: { name: 'vfat-unknown', host: 14, dosAttributes: 0x00800000 }, pattern: /unsupported VFAT ZIP member attributes 0x800000/i },
      { entry: { name: 'ntfs-normal-combination', host: 10, dosAttributes: 0xa0 }, pattern: /ambiguous NTFS ZIP normal attribute combination/i },
      { entry: { name: 'vfat-pinned-unpinned', host: 14, dosAttributes: 0x00180000 }, pattern: /ambiguous VFAT ZIP pinned\/unpinned attributes/i },
      { entry: { name: 'vfat-host-unix-mode', host: 14, mode: 0o120777 }, pattern: /unsupported VFAT ZIP member attributes 0xa1ff0000/i },
      { entry: { name: 'unknown-host-type', host: 42, dosAttributes: 0x20 }, pattern: /unsupported ZIP creator host 42 with declared external attributes/i },
    ];
    for (const { entry, pattern } of cases) {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-zip-special-'));
      const copy = path.join(temp, 'fixtures');
      try {
        await fs.cp(fixtureRoot, copy, { recursive: true });
        const entries = [...required.map((name) => ({ name })), entry];
        const zip = zipWithMembers(entries);
        await replaceNativeArchive(copy, 'hermes/0.18.2-darwin-arm64-real', 'native/hermes-backup.zip', zip, entries.map(({ name }) => name));
        const errors = (await validateRuntimeAdapterFixtures({ fixture_root: copy })).errors.join('\n');
        expect(errors).toMatch(pattern);
        expect(errors).not.toMatch(/artifact integrity mismatch|native archive membership evidence drifted/i);
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
    }
  });

  test('enforces declared ZIP directory type, terminal slash, and empty-payload consistency', async () => {
    const required = ['state.db', '.env', 'auth.json', 'profiles/research/profile.yaml', 'skills/fixture-skill/SKILL.md'];
    const cases = [
      { entry: { name: 'declared-directory', host: 3, mode: 0o040755 }, pattern: /declared directory type conflicts with its terminal slash/i },
      { entry: { name: 'declared-file/', host: 3, mode: 0o100644 }, pattern: /declared regular type conflicts with its terminal slash/i },
      { entry: { name: 'payload-directory/', content: Buffer.from('x'), host: 3, mode: 0o040755 }, pattern: /directory member .* must not contain payload bytes/i },
      { entry: { name: 'dos-directory', host: 0, dosAttributes: 0x10 }, pattern: /declared directory type conflicts with its terminal slash/i },
      { entry: { name: 'ntfs-directory', host: 10, dosAttributes: 0x10 }, pattern: /declared directory type conflicts with its terminal slash/i },
      { entry: { name: 'vfat-file/', host: 14, dosAttributes: 0x20 }, pattern: /declared regular type conflicts with its terminal slash/i },
      { entry: { name: 'ntfs-payload-directory/', content: Buffer.from('x'), host: 10, dosAttributes: 0x10 }, pattern: /directory member .* must not contain payload bytes/i },
    ];
    for (const { entry, pattern } of cases) {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-zip-type-mismatch-'));
      const copy = path.join(temp, 'fixtures');
      try {
        await fs.cp(fixtureRoot, copy, { recursive: true });
        const entries = [...required.map((name) => ({ name })), entry];
        const zip = zipWithMembers(entries);
        await replaceNativeArchive(copy, 'hermes/0.18.2-darwin-arm64-real', 'native/hermes-backup.zip', zip, entries.map(({ name }) => name));
        const errors = (await validateRuntimeAdapterFixtures({ fixture_root: copy })).errors.join('\n');
        expect(errors).toMatch(pattern);
        expect(errors).not.toMatch(/artifact integrity mismatch|native archive membership evidence drifted/i);
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
    }
  });

  test('accepts declared regular files and directories while retaining unspecified-attribute compatibility', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-valid-zip-types-'));
    const copy = path.join(temp, 'fixtures');
    try {
      await fs.cp(fixtureRoot, copy, { recursive: true });
      const entries = [
        { name: 'state.db', host: 3, mode: 0o100600 },
        { name: '.env', host: 3, mode: 0o100600 },
        { name: 'auth.json', host: 3, mode: 0o100600 },
        { name: 'profiles/', host: 3, mode: 0o040755 },
        { name: 'profiles/research/profile.yaml' },
        { name: 'skills/fixture-skill/SKILL.md', host: 0, dosAttributes: 0x20 },
        { name: 'unknown-host-unspecified', host: 42 },
      ];
      const zip = zipWithMembers(entries);
      await replaceNativeArchive(copy, 'hermes/0.18.2-darwin-arm64-real', 'native/hermes-backup.zip', zip, entries.map(({ name }) => name));
      const errors = (await validateRuntimeAdapterFixtures({ fixture_root: copy })).errors.join('\n');
      expect(errors).toBe('');
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });

  test('accepts explicitly allowed Windows attributes from NTFS and VFAT creator hosts', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-windows-zip-types-'));
    const copy = path.join(temp, 'fixtures');
    try {
      await fs.cp(fixtureRoot, copy, { recursive: true });
      const entries = [
        { name: 'state.db', host: 10, dosAttributes: 0x00022a20 },
        { name: '.env', host: 14, dosAttributes: 0x80 },
        { name: 'auth.json', host: 10, dosAttributes: 0x6000 },
        { name: 'profiles/', host: 10, dosAttributes: 0x00008810 },
        { name: 'profiles/research/', host: 14, dosAttributes: 0x00024011 },
        { name: 'profiles/research/profile.yaml', host: 14, dosAttributes: 0x00081120 },
        { name: 'skills/', host: 14, dosAttributes: 0x00102010 },
        { name: 'skills/fixture-skill/SKILL.md', host: 10, dosAttributes: 0x00402022 },
      ];
      const zip = zipWithMembers(entries);
      await replaceNativeArchive(copy, 'hermes/0.18.2-darwin-arm64-real', 'native/hermes-backup.zip', zip, entries.map(({ name }) => name));
      expect((await validateRuntimeAdapterFixtures({ fixture_root: copy })).errors).toEqual([]);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });

  test('rejects ZIP and TAR members that collide only after combined Unicode normalization and case folding', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-combined-collision-'));
    const copy = path.join(temp, 'fixtures');
    try {
      await fs.cp(fixtureRoot, copy, { recursive: true });
      const collisionNames = ['CAFE\u0301.txt', 'caf\u00e9.txt'];

      const zip = zipWithEmptyMembers(collisionNames);
      const zipPath = path.join(copy, 'hermes/0.18.2-darwin-arm64-real/native/hermes-backup.zip');
      await fs.writeFile(zipPath, zip);
      const hermesMetadataPath = path.join(copy, 'hermes/0.18.2-darwin-arm64-real/fixture.json');
      const hermesMetadata = JSON.parse(await fs.readFile(hermesMetadataPath, 'utf8'));
      hermesMetadata.artifacts['native/hermes-backup.zip'] = digest(zip);
      await fs.writeFile(hermesMetadataPath, `${JSON.stringify(hermesMetadata, null, 2)}\n`);

      const tar = tarGzipWithEmptyMembers(collisionNames);
      const tarPath = path.join(copy, 'openclaw/2026.6.6-darwin-arm64-real/native/openclaw-backup.tar.gz');
      await fs.writeFile(tarPath, tar);
      const openMetadataPath = path.join(copy, 'openclaw/2026.6.6-darwin-arm64-real/fixture.json');
      const openMetadata = JSON.parse(await fs.readFile(openMetadataPath, 'utf8'));
      openMetadata.artifacts['native/openclaw-backup.tar.gz'] = digest(tar);
      await fs.writeFile(openMetadataPath, `${JSON.stringify(openMetadata, null, 2)}\n`);

      const errors = (await validateRuntimeAdapterFixtures({ fixture_root: copy })).errors.join('\n');
      expect(errors).toMatch(/hermes.*archive member path collision/i);
      expect(errors).toMatch(/openclaw.*archive member path collision/i);
      expect(errors.match(/archive member path collision/gi)).toHaveLength(2);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });

  test('archive member grammar rejects backslashes and internal empties while accepting one directory marker', async () => {
    const cases = [
      { names: ['dir\\file'], pattern: /unsafe archive member.*backslash|unsafe archive member/i },
      { names: ['dir//file'], pattern: /empty segment/i },
      { names: ['dir//'], pattern: /empty segment/i },
      { names: ['dir///'], pattern: /empty segment/i },
      { names: ['dir', 'dir/'], pattern: /archive member path collision/i },
    ];
    for (const { names, pattern } of cases) {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-member-grammar-'));
      const copy = path.join(temp, 'fixtures');
      try {
        await fs.cp(fixtureRoot, copy, { recursive: true });
        const archives = [
          { family: 'hermes', relative: 'hermes/0.18.2-darwin-arm64-real', artifact: 'native/hermes-backup.zip', bytes: zipWithEmptyMembers(names) },
          { family: 'openclaw', relative: 'openclaw/2026.6.6-darwin-arm64-real', artifact: 'native/openclaw-backup.tar.gz', bytes: tarGzipWithEmptyMembers(names) },
        ];
        for (const archive of archives) {
          await fs.writeFile(path.join(copy, archive.relative, archive.artifact), archive.bytes);
          const metadataPath = path.join(copy, archive.relative, 'fixture.json');
          const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
          metadata.artifacts[archive.artifact] = digest(archive.bytes);
          await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
        }
        const errors = (await validateRuntimeAdapterFixtures({ fixture_root: copy })).errors.join('\n');
        expect(errors).toMatch(pattern);
        expect(errors.match(pattern)?.length ?? 0).toBeGreaterThanOrEqual(1);
        expect(errors).toMatch(/hermes: native archive .*cannot be inspected/i);
        expect(errors).toMatch(/openclaw: native archive .*cannot be inspected/i);
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
    }

    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-directory-marker-'));
    const copy = path.join(temp, 'fixtures');
    try {
      await fs.cp(fixtureRoot, copy, { recursive: true });
      const zipNames = ['dir/', 'state.db', '.env', 'auth.json', 'profiles/research/profile.yaml', 'skills/fixture-skill/SKILL.md'];
      const tarNames = ['dir/', 'backup/manifest.json', 'backup/payload/posix/private/tmp/agentbootup-openclaw-home/.openclaw/state/openclaw.sqlite', 'backup/workspace/.git/HEAD', 'backup/workspace-research/.git/HEAD'];
      const archives = [
        { relative: 'hermes/0.18.2-darwin-arm64-real', artifact: 'native/hermes-backup.zip', bytes: zipWithEmptyMembers(zipNames) },
        { relative: 'openclaw/2026.6.6-darwin-arm64-real', artifact: 'native/openclaw-backup.tar.gz', bytes: tarGzipWithEmptyMembers(tarNames) },
      ];
      for (const archive of archives) {
        await fs.writeFile(path.join(copy, archive.relative, archive.artifact), archive.bytes);
        const metadataPath = path.join(copy, archive.relative, 'fixture.json');
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
        metadata.artifacts[archive.artifact] = digest(archive.bytes);
        metadata.native_archive_integrity.members = archive.relative.startsWith('hermes') ? zipNames.length : tarNames.length;
        metadata.native_archive_integrity.membership_sha256 = digest(Buffer.from(`${(archive.relative.startsWith('hermes') ? zipNames : tarNames).sort().join('\n')}\n`)).slice(7);
        await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      }
      const errors = (await validateRuntimeAdapterFixtures({ fixture_root: copy })).errors.join('\n');
      expect(errors).not.toMatch(/archive member .*cannot be inspected|archive member path collision|empty segment/i);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });

  test('rejects file-and-descendant extraction conflicts in both ZIP and TAR entry orders', async () => {
    for (const conflictingNames of [['dir', 'dir/file'], ['dir/file', 'dir']]) {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-member-namespace-'));
      const copy = path.join(temp, 'fixtures');
      try {
        await fs.cp(fixtureRoot, copy, { recursive: true });
        const zipNames = [...conflictingNames, 'state.db', '.env', 'auth.json', 'profiles/research/profile.yaml', 'skills/fixture-skill/SKILL.md'];
        const tarNames = [...conflictingNames, 'backup/manifest.json', 'backup/payload/posix/private/tmp/agentbootup-openclaw-home/.openclaw/state/openclaw.sqlite', 'backup/workspace/.git/HEAD', 'backup/workspace-research/.git/HEAD'];
        const zip = zipWithEmptyMembers(zipNames);
        const tar = tarGzipWithEmptyMembers(tarNames);
        await replaceNativeArchive(copy, 'hermes/0.18.2-darwin-arm64-real', 'native/hermes-backup.zip', zip, zipNames);
        await replaceNativeArchive(copy, 'openclaw/2026.6.6-darwin-arm64-real', 'native/openclaw-backup.tar.gz', tar, tarNames);

        const errors = (await validateRuntimeAdapterFixtures({ fixture_root: copy })).errors.join('\n');
        expect(errors).toMatch(/hermes: native archive .*archive member namespace conflict/i);
        expect(errors).toMatch(/openclaw: native archive .*archive member namespace conflict/i);
        expect(errors.match(/archive member namespace conflict/gi)).toHaveLength(2);
        expect(errors).not.toMatch(/artifact integrity mismatch|native archive membership evidence drifted/i);
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
    }
  });

  test('accepts explicit directory members with descendants before or after implicit discovery', async () => {
    for (const directoryNames of [['dir/', 'dir/file'], ['dir/file', 'dir/']]) {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-valid-member-namespace-'));
      const copy = path.join(temp, 'fixtures');
      try {
        await fs.cp(fixtureRoot, copy, { recursive: true });
        const zipNames = [...directoryNames, 'state.db', '.env', 'auth.json', 'profiles/research/profile.yaml', 'skills/fixture-skill/SKILL.md'];
        const tarNames = [...directoryNames, 'backup/manifest.json', 'backup/payload/posix/private/tmp/agentbootup-openclaw-home/.openclaw/state/openclaw.sqlite', 'backup/workspace/.git/HEAD', 'backup/workspace-research/.git/HEAD'];
        const zip = zipWithEmptyMembers(zipNames);
        const tar = tarGzipWithEmptyMembers(tarNames);
        await replaceNativeArchive(copy, 'hermes/0.18.2-darwin-arm64-real', 'native/hermes-backup.zip', zip, zipNames);
        await replaceNativeArchive(copy, 'openclaw/2026.6.6-darwin-arm64-real', 'native/openclaw-backup.tar.gz', tar, tarNames);

        const errors = (await validateRuntimeAdapterFixtures({ fixture_root: copy })).errors.join('\n');
        expect(errors).not.toMatch(/archive member .*cannot be inspected|archive member path collision|archive member namespace conflict|artifact integrity mismatch|native archive membership evidence drifted/i);
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
    }
  });

  test('lstats metadata and synthetic fixtures before reading and never inspects symlinked native artifacts', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-links-'));
    const copy = path.join(temp, 'fixtures');
    try {
      await fs.cp(fixtureRoot, copy, { recursive: true });
      const fixtureJson = path.join(copy, 'circle-agent/0.1.0-linux-amd64-sanitized/fixture.json');
      await fs.rm(fixtureJson); await fs.symlink('/etc/passwd', fixtureJson);
      const cases = path.join(copy, 'synthetic/security/cases.json');
      await fs.rm(cases); await fs.symlink('/etc/passwd', cases);
      const archive = path.join(copy, 'hermes/0.18.2-darwin-arm64-real/native/hermes-backup.zip');
      await fs.rm(archive); await fs.symlink('/etc/passwd', archive);
      const report = await validateRuntimeAdapterFixtures({ fixture_root: copy });
      const errors = report.errors.join('\n');
      expect(errors).toMatch(/fixture\.json.*regular non-symlink/i);
      expect(errors).toMatch(/synthetic_security cases\.json.*regular non-symlink/i);
      expect(errors).toMatch(/native artifact.*unsupported kind symlink/i);
      expect(errors).not.toMatch(/hermes.*archive.*cannot be inspected/i);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });

  test('rejects uncontained metadata locators, scans expected-class values, and keeps observed accounting honest', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-fixture-locators-'));
    const copy = path.join(temp, 'fixtures');
    try {
      await fs.cp(fixtureRoot, copy, { recursive: true });
      const circlePath = path.join(copy, 'circle-agent/0.1.0-linux-amd64-sanitized/fixture.json');
      const circle = JSON.parse(await fs.readFile(circlePath, 'utf8'));
      circle.database.path = '/etc/passwd';
      circle.database.schema_source = '../schema.sql';
      circle.tree_integrity.files[0] = 'C:\\temp\\agentbootup.json';
      await fs.writeFile(circlePath, `${JSON.stringify(circle, null, 2)}\n`);
      const hermesPath = path.join(copy, 'hermes/0.18.2-darwin-arm64-real/fixture.json');
      const hermes = JSON.parse(await fs.readFile(hermesPath, 'utf8'));
      hermes.artifacts['/tmp/forged.zip'] = hermes.artifacts['native/hermes-backup.zip'];
      hermes.expected_classes.portable_core.push('root/sk-proj-abcdefghijklmnopqrstuvwxyz123456');
      hermes.tree_integrity.files = hermes.tree_integrity.files.filter((entry: string) => entry !== 'root/skills/fixture-skill/SKILL.md');
      await fs.writeFile(hermesPath, `${JSON.stringify(hermes, null, 2)}\n`);
      const report = await validateRuntimeAdapterFixtures({ fixture_root: copy });
      expect(report.errors.join('\n')).toMatch(/locator must be a normalized contained relative path/i);
      expect(report.errors.join('\n')).toMatch(/expected_classes.*raw secret/i);
      const hermesReport = report.fixtures.find((entry: any) => entry.runtime_family === 'hermes');
      expect(hermesReport.accounted_sources).toBeLessThanOrEqual(hermesReport.discovered_sources);
      expect(report.errors.join('\n')).toMatch(/unknown fixture addition.*root\/skills\/fixture-skill\/SKILL\.md/i);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  });

  test('materializes every declarative security case through the classifier without duplicating unit cases', async () => {
    const cases = await Bun.file(path.join(fixtureRoot, 'synthetic/security/cases.json')).json();
    const roots = [
      { id: 'runtime', kind: 'runtime', source_path: '/fixture/runtime', real_path: '/fixture/runtime' },
      { id: 'provider', kind: 'external_provider', source_path: '/fixture-provider', real_path: '/fixture-provider', provider: 'fixture', ownership: 'provider_owned', approved_destination_class: 'external_state', containment_policy: 'realpath_within_root', restoration_requirements: ['provider_available'] },
    ];
    const rules = [
      { logical_root: 'runtime', relative_path: 'auth.json', state_class: 'secret', semantic_role: 'durable' },
      { logical_root: 'runtime', path_prefix: 'node_modules', state_class: 'reproducible', semantic_role: 'durable' },
      { logical_root: 'runtime', path_prefix: '.cache', state_class: 'cache', semantic_role: 'durable' },
      { logical_root: 'runtime', relative_path: 'gateway.pid', state_class: 'machine_local', semantic_role: 'pid' },
      { logical_root: 'runtime', relative_path: 'approvals/pending.json', state_class: 'machine_local', semantic_role: 'pending_approval' },
      { logical_root: 'runtime', relative_path: 'memory/provider', state_class: 'portable_core', semantic_role: 'durable' },
      { logical_root: 'provider', path_prefix: 'team', state_class: 'external_state', semantic_role: 'durable' },
    ];
    const metadata = { durability: 'potentially_durable', semantic_role: 'durable', size_bytes: 0, checksum: { policy: 'metadata_only' }, sensitivity: 'ordinary', provenance: { source: 'synthetic-security-fixture' }, reason: 'Declarative security fixture.' };
    const outcomes = cases.cases.map((fixture: any) => {
      const semantic_role = fixture.id === 'pid-file' ? 'pid' : fixture.id === 'pending-approval' ? 'pending_approval' : fixture.id === 'socket' ? 'live_harness_state' : 'durable';
      const kind = fixture.kind === 'device' ? 'device' : fixture.kind === 'hardlink' ? 'hardlink' : fixture.kind;
      const entry: any = { item_id: fixture.id, logical_root: 'runtime', relative_path: fixture.path, real_path: `/fixture/runtime/${fixture.path}`, kind, ...metadata, semantic_role, durability: semantic_role === 'durable' ? 'potentially_durable' : 'non_durable' };
      if (fixture.id === 'declared-external-symlink') Object.assign(entry, { link_target: '/fixture-provider/team', real_path: '/fixture-provider/team', follow: true });
      else if (fixture.kind === 'symlink') entry.link_target = fixture.target;
      try {
        const [classified] = classifyFilesystemEntries([entry], { logical_roots: roots, target_semantics: { case_sensitive: false, unicode_normalization: 'NFC' }, rules });
        return [fixture.id, classified.state_class];
      } catch {
        return [fixture.id, 'manual_review'];
      }
    });
    expect(outcomes).toEqual(cases.cases.map((fixture: any) => [fixture.id, fixture.expected]));
  });
});

describe('cross-platform Windows fail-closed baseline', () => {
  test.each([
    'C:\\Users\\fixture\\state.db', 'C:state.db', '\\\\server\\share\\state', '//server/share/state',
    '..\\escape', '../escape', 'CON', 'con.txt', 'AUX.log', 'COM1.data', 'LPT9',
    'state.', 'state ', 'state:ads',
  ])('rejects Windows-sensitive path %j before an explicit portable capture rule can admit it', (candidate) => {
    const metadata = { item_id: `windows:${candidate}`, durability: 'potentially_durable', semantic_role: 'durable', size_bytes: 0, checksum: { policy: 'metadata_only' }, sensitivity: 'ordinary', provenance: { source: 'windows-baseline' }, reason: 'Windows baseline fixture.' };
    const roots = [{ id: 'runtime', kind: 'runtime', source_path: '/fixture/runtime', real_path: '/fixture/runtime' }];
    expect(() => classifyFilesystemEntries([{ ...metadata, logical_root: 'runtime', relative_path: candidate, kind: 'file' }], {
      logical_roots: roots, target_semantics: { case_sensitive: false, unicode_normalization: 'NFC' },
      rules: [{ logical_root: 'runtime', relative_path: candidate, state_class: 'portable_core', semantic_role: 'durable' }],
    })).toThrow(/absolute|drive-relative|portable forward|traversal|empty segment|Windows-reserved/i);
  });

  test.each([
    ['case-only', 'memory/Note.md', 'memory/note.md'],
    ['NFC', 'memory/café.md', 'memory/cafe\u0301.md'],
  ])('batch-marks %s collision groups manual review with evidence', (_kind, left, right) => {
    const roots = [{ id: 'runtime', kind: 'runtime', source_path: '/fixture/runtime', real_path: '/fixture/runtime' }];
    const metadata = { durability: 'potentially_durable', semantic_role: 'durable', size_bytes: 0, checksum: { policy: 'metadata_only' }, sensitivity: 'ordinary', provenance: { source: 'windows-baseline' }, reason: 'Collision baseline.' };
    const classified = classifyFilesystemEntries([
      { ...metadata, item_id: 'left', logical_root: 'runtime', relative_path: left, real_path: `/fixture/runtime/${left}`, kind: 'file' },
      { ...metadata, item_id: 'right', logical_root: 'runtime', relative_path: right, real_path: `/fixture/runtime/${right}`, kind: 'file' },
    ], {
      logical_roots: roots, target_semantics: { case_sensitive: false, unicode_normalization: 'NFC' },
      rules: [
        { logical_root: 'runtime', relative_path: left, state_class: 'portable_core', semantic_role: 'durable' },
        { logical_root: 'runtime', relative_path: right, state_class: 'portable_core', semantic_role: 'durable' },
      ],
    });
    expect(classified).toHaveLength(2);
    expect(classified.every((item: any) => item.state_class === 'manual_review')).toBe(true);
    expect(classified.every((item: any) => /collision/i.test(item.reason_code))).toBe(true);
  });
});
