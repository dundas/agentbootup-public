const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isTranscriptRedactionDisabled(env = process.env) {
  return TRUE_VALUES.has(String(env.AGENTBOOTUP_REDACT_DISABLE || '').trim().toLowerCase());
}

export function checkTranscriptRedactionHealth(env = process.env) {
  if (isTranscriptRedactionDisabled(env)) {
    return {
      state: 'fail',
      severity: 'error',
      category: 'redaction_disabled',
      message: 'redaction_disabled: transcript redaction emergency switch is active; all transcript pushes are fail-closed',
    };
  }
  return {
    state: 'pass',
    severity: 'info',
    category: 'redaction_disabled',
    message: 'transcript redaction is enabled',
  };
}

export function checkTranscriptRedactionDisabled(env = process.env) {
  const check = checkTranscriptRedactionHealth(env);
  if (check.state === 'pass') return null;
  const { state: _state, ...issue } = check;
  return issue;
}
