#!/usr/bin/env node
/**
 * Test search options and caching
 */

import { TranscriptParser } from './lib/transcript-parser.js';

const parser = new TranscriptParser();

// Use environment variable or auto-detect transcript
const projectPath = process.env.TEST_PROJECT_PATH || process.cwd();
const transcripts = await parser.listTranscripts(projectPath);

if (transcripts.length === 0) {
  console.log('No transcripts found. Skipping options tests.');
  console.log('Set TEST_PROJECT_PATH to a project with transcripts.');
  process.exit(0);
}

const transcriptPath = transcripts[0].path;

console.log('Testing search options and caching...');
console.log(`Transcript: ${transcriptPath}\n`);

// Test 1: Cache performance
console.log('Test 1: Cache Performance');
console.log('First parse (cold):');
const start1 = Date.now();
const data1 = await parser.parseTranscript(transcriptPath);
const time1 = Date.now() - start1;
console.log(`  Parsed ${data1.messages.length} messages in ${time1}ms`);

console.log('Second parse (cached):');
const start2 = Date.now();
const data2 = await parser.parseTranscript(transcriptPath);
const time2 = Date.now() - start2;
console.log(`  Parsed ${data2.messages.length} messages in ${time2}ms`);
const speedup = time2 === 0 ? 'Infinity' : (time1 / time2).toFixed(1);
console.log(`  Speedup: ${speedup}x faster\n`);

// Test 2: Search with default (simulating recent 10)
console.log('Test 2: Search Results');
const searchResults = parser.searchMessages(data1, 'daemon');
console.log(`  Found ${searchResults.length} matches for "daemon"`);
if (searchResults.length > 0) {
  console.log(`  Best match score: ${searchResults[0].score.toFixed(2)}`);
  console.log(`  Match types: ${searchResults[0].matches.map(m => m.type).join(', ')}`);
}
console.log();

// Test 3: Fuzzy search still works
console.log('Test 3: Fuzzy Search with Cache');
const fuzzyResults = parser.searchMessages(data1, 'daemom');
console.log(`  Found ${fuzzyResults.length} matches for typo "daemom"`);
if (fuzzyResults.length > 0) {
  console.log(`  Best match score: ${fuzzyResults[0].score.toFixed(2)}`);
  console.log(`  Match types: ${fuzzyResults[0].matches.map(m => m.type).join(', ')}`);
}

console.log('\n✅ Options and caching test complete');
