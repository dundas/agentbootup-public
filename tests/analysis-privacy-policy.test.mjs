import { expect, test } from 'bun:test';
import { buildDenylist } from '../lib/daemon/redaction-denylist.js';
import { redactContent } from '../lib/runtime-adapters/redaction.js';
import { ANALYSIS_POLICY_STATE, createAnalysisPrivacyPolicy, sanitizeAnalysisText } from '../lib/analysis/privacy-policy.js';

const syntheticDenylistValue = 'AGENTBOOTUP_SYNTHETIC_DENYLIST_VALUE_7c62a4';
const policySnapshot = () => buildDenylist([], {
  environment: {},
  explicitValues: new Set([syntheticDenylistValue]),
  agentbootupRoot: null,
});

function transcriptSyncDecision(content, snapshot = policySnapshot()) {
  return redactContent(content, {
    format: 'text',
    denylist: snapshot.values,
    sourceMap: snapshot.sourceMap,
    derivedDenylist: snapshot.derivedValues,
    derivedSourceMap: snapshot.derivedSourceMap,
  });
}

const cases = [
  ['clean text', 'ordinary implementation notes', false],
  ['exact denylist value', `value=${syntheticDenylistValue}`, false],
  ['sensitive JSON key', '{"api_key":"AGENTBOOTUP_SYNTHETIC_KEY_83d7b1"}', false],
  ['stringified JSON', 'payload={"authorization":"Bearer AGENTBOOTUP_SYNTHETIC_AUTH_74ac20"}', false],
  ['authorization header', 'Authorization: Bearer AGENTBOOTUP_SYNTHETIC_HEADER_0f3cb6', false],
  ['URL userinfo', 'https://user:AGENTBOOTUP_SYNTHETIC_URL_SECRET_19ae1d@example.test/path', true],
  ['private-key marker', '-----BEGIN PRIVATE KEY-----\nAGENTBOOTUP_SYNTHETIC_KEY_MATERIAL\n-----END PRIVATE KEY-----', true],
  ['malformed suspicious content', '{"token":"AGENTBOOTUP_SYNTHETIC_MALFORMED_9bc311"', false],
];

for (const [label, content, expectBlocked] of cases) {
  test(`analysis policy matches transcript-sync decision for ${label}`, () => {
    const snapshot = policySnapshot();
    const policy = createAnalysisPrivacyPolicy([], { snapshot });
    const sync = transcriptSyncDecision(content, snapshot);
    const analysis = sanitizeAnalysisText(content, policy);

    expect(policy.state).toBe(ANALYSIS_POLICY_STATE.usable);
    expect(analysis.state === ANALYSIS_POLICY_STATE.inputUnprovable).toBe(sync.blocked);
    expect(sync.blocked).toBe(expectBlocked);
    expect(analysis.code ?? null).toBe(sync.blocked ? 'analysis_input_unprovable' : null);
    if (!sync.blocked) expect(analysis.cleanContent).toBe(sync.cleanContent);
  });
}

test('policy values and source maps are not exposed by the analysis policy handle', () => {
  const policy = createAnalysisPrivacyPolicy([], { snapshot: policySnapshot() });

  expect(policy).toEqual({ state: ANALYSIS_POLICY_STATE.usable });
  expect(Object.isFrozen(policy)).toBe(true);
  expect(JSON.stringify(policy)).not.toContain(syntheticDenylistValue);
});

test('forged usable policy handles are rejected before sanitization', () => {
  const forged = Object.freeze({ state: ANALYSIS_POLICY_STATE.usable });

  expect(sanitizeAnalysisText('ordinary text', forged)).toEqual({
    state: ANALYSIS_POLICY_STATE.unavailable,
    code: 'analysis_policy_unavailable',
  });
});

test('failed or stale policy becomes a stable non-secret unavailable result', () => {
  const failed = createAnalysisPrivacyPolicy([], { snapshot: { state: 'failed', health: {} } });
  const stale = createAnalysisPrivacyPolicy([], {
    snapshot: { ...policySnapshot(), health: { redaction_denylist_stale: true } },
  });

  expect(failed).toEqual({ state: ANALYSIS_POLICY_STATE.unavailable, code: 'analysis_policy_unavailable' });
  expect(stale).toEqual({ state: ANALYSIS_POLICY_STATE.unavailable, code: 'analysis_policy_unavailable' });
  expect(sanitizeAnalysisText('ordinary text', failed)).toEqual({
    state: ANALYSIS_POLICY_STATE.unavailable,
    code: 'analysis_policy_unavailable',
  });
});
