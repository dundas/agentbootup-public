import { decodeAndValidateIdentifier } from './route-params';
import { HttpError } from '../errors';

export function decodeAndValidateBrainId(raw: string): string {
  const id = decodeAndValidateIdentifier(raw, 'brainId', 128);
  // Brain IDs use alphanumeric, underscore, dash, and dot-as-separator
  // (for agent ID convention e.g. mech-browse.gm). Dots must separate
  // non-empty segments — leading, trailing, and consecutive dots are rejected.
  // Length is enforced by decodeAndValidateIdentifier upstream (128 max).
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(id)) {
    throw new HttpError(400, 'invalid_request', 'brainId must use alphanumeric, underscore, dash, or dot-separated segments only');
  }
  return id;
}
