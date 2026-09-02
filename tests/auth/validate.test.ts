/**
 * Tests for lib/auth/validate.js — URL validation used at daemon start and doctor.
 */
import { test, expect } from 'bun:test';
import { isValidServerUrl, isPlausibleServerUrl, apiUrl } from '../../lib/auth/validate.js';

test('isValidServerUrl accepts https and http', () => {
  expect(isValidServerUrl('https://example.com')).toBe(true);
  expect(isValidServerUrl('http://localhost:8080')).toBe(true);
});

test('isValidServerUrl rejects non-http schemes', () => {
  expect(isValidServerUrl('file:///etc/passwd')).toBe(false);
  expect(isValidServerUrl('data:text/plain,foo')).toBe(false);
});

test('isPlausibleServerUrl rejects port 0 (WO-1)', () => {
  expect(isPlausibleServerUrl('http://localhost:0')).toBe(false);
  expect(isPlausibleServerUrl('https://agentbootup.fly.dev:0')).toBe(false);
});

test('isPlausibleServerUrl accepts valid targets', () => {
  expect(isPlausibleServerUrl('https://example.com')).toBe(true);
  expect(isPlausibleServerUrl('http://localhost:8080')).toBe(true);
  expect(isPlausibleServerUrl('https://agentbootup.fly.dev')).toBe(true);
});

test('apiUrl appends endpoint to base', () => {
  expect(apiUrl('https://host', '/v1/brains')).toBe('https://host/v1/brains');
  expect(apiUrl('https://host/', '/v1/brains')).toBe('https://host/v1/brains');
});
